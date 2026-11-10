use std::collections::BTreeMap;
use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use serde_json::{Value, json};

const TIMEOUT: Duration = Duration::from_secs(30);

struct Worker {
    child: Child,
    stdin: Option<ChildStdin>,
    responses: mpsc::Receiver<Value>,
}

impl Worker {
    fn spawn(root: &Path) -> Self {
        Self::spawn_with_budget(root, 4096)
    }

    fn spawn_with_budget(root: &Path, budget: usize) -> Self {
        let home = root.join("isolated-home");
        std::fs::create_dir_all(&home).unwrap();
        let mut command = Command::new(env!("CARGO_BIN_EXE_codey-fastctx"));
        command
            .arg("--codey-fastctx-native")
            .current_dir(root)
            .env("HOME", &home)
            .env("USERPROFILE", &home)
            .env("CODEX_HOME", home.join(".codex"))
            .env("CODEY_APP_STATE_DIR", home.join("codey-state"))
            .env("FASTCTX_TEST_RUNTIME_EVENT_LOG", root.join("runtime.log"))
            .env("FASTCTX_TOKEN_BUDGET", budget.to_string())
            .env("FASTCTX_READ_TOKEN_BUDGET", budget.to_string())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x0800_0000);
        }
        let mut child = command.spawn().unwrap();
        let stdin = child.stdin.take();
        let stdout = child.stdout.take().unwrap();
        let (sender, responses) = mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let value: Value = serde_json::from_str(&line.unwrap()).unwrap();
                if sender.send(value).is_err() {
                    return;
                }
            }
        });
        Self {
            child,
            stdin,
            responses,
        }
    }

    fn send(&mut self, value: Value) {
        let stdin = self.stdin.as_mut().unwrap();
        serde_json::to_writer(&mut *stdin, &value).unwrap();
        stdin.write_all(b"\n").unwrap();
        stdin.flush().unwrap();
    }

    fn receive(&self) -> Value {
        self.responses
            .recv_timeout(TIMEOUT)
            .expect("native worker response timed out")
    }

    fn call(&mut self, id: &str, name: &str, arguments: Value) -> Value {
        self.send(
            json!({"id":id,"method":"tools/call","params":{"name":name,"arguments":arguments}}),
        );
        let response = self.receive();
        assert_eq!(response["id"], id, "{response}");
        response
    }

    fn finish(&mut self) {
        self.stdin.take();
        let deadline = Instant::now() + TIMEOUT;
        loop {
            if let Some(status) = self.child.try_wait().unwrap() {
                assert!(status.success(), "worker failed with {status}");
                return;
            }
            assert!(
                Instant::now() < deadline,
                "native worker did not exit after EOF"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
    }
}

impl Drop for Worker {
    fn drop(&mut self) {
        self.stdin.take();
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn text(response: &Value) -> String {
    response["result"]["content"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|item| item["text"].as_str())
        .collect::<Vec<_>>()
        .join("\n")
}

#[test]
fn native_entry_exposes_portable_schemas_and_file_results() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("工作目录");
    std::fs::create_dir(&root).unwrap();
    std::fs::write(root.join("sample.txt"), "alpha\nbeta 世界\nthird\n").unwrap();
    let mut native = Worker::spawn(&root);
    native.send(json!({"id":"list","method":"tools/list","params":{}}));
    let listed = native.receive();
    let tools = listed["result"]["tools"].as_array().unwrap();
    let mut names = tools
        .iter()
        .map(|tool| tool["name"].as_str().unwrap())
        .collect::<Vec<_>>();
    names.sort_unstable();
    assert_eq!(names, ["glob", "grep", "inspect_local_file", "replace"]);
    for tool in tools {
        assert_portable_tool_schema(&tool["inputSchema"]);
    }
    for (id, name, arguments) in [
        (
            "read",
            "inspect_local_file",
            json!({"file_path":root.join("sample.txt"),"limit":1}),
        ),
        (
            "grep",
            "grep",
            json!({"pattern":"beta","path":root.join("sample.txt"),"output_mode":"content"}),
        ),
        ("glob", "glob", json!({"pattern":["*.txt"]})),
        (
            "preview",
            "replace",
            json!({"path":root.join("sample.txt"),"pattern":"alpha","replacement":"changed","dry_run":true}),
        ),
    ] {
        let actual = native.call(id, name, arguments);
        assert_eq!(actual["result"]["isError"], false, "{actual}");
        let content = text(&actual);
        assert!(
            content.contains(if id == "read" {
                "Partial:"
            } else {
                "Complete:"
            }),
            "{actual}"
        );
        match id {
            "read" => assert!(
                content.contains("alpha") && !content.contains("third"),
                "{actual}"
            ),
            "grep" => assert!(content.contains("beta 世界"), "{actual}"),
            "glob" => assert!(content.contains("sample.txt"), "{actual}"),
            _ => {}
        }
    }
    assert_eq!(
        std::fs::read_to_string(root.join("sample.txt")).unwrap(),
        "alpha\nbeta 世界\nthird\n"
    );
    native.finish();
    assert!(
        !root.join("runtime.log").exists(),
        "native calls must not spawn a runtime host"
    );
}

#[test]
fn native_repeated_reads_keep_the_host_token_budget() {
    const BUDGET: usize = 24_000;
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("entropy.txt");
    let body = (0_u64..2_000)
        .map(|line| {
            format!(
                "{line:04} {:016x} {:016x} {:016x} {:016x}\n",
                line.wrapping_mul(0x9e3779b97f4a7c15),
                line.wrapping_mul(0xbf58476d1ce4e5b9),
                line.wrapping_mul(0x94d049bb133111eb),
                line.wrapping_mul(0xd1342543de82ef95),
            )
        })
        .collect::<String>();
    std::fs::write(&path, body).unwrap();
    let mut worker = Worker::spawn_with_budget(temp.path(), BUDGET);
    for id in ["read-first", "read-again", "read-third"] {
        let response = worker.call(
            id,
            "inspect_local_file",
            json!({"file_path":path,"limit":2_000}),
        );
        assert_eq!(response["result"]["isError"], false, "{response}");
        let output = text(&response);
        let tokens = fastctx::budget::estimate_tokens(&output);
        assert!(tokens > 13_600 && tokens <= BUDGET, "{tokens} tokens");
        assert!(output.contains("Partial:"), "{output}");
    }
    worker.finish();
}

fn assert_portable_tool_schema(value: &Value) {
    let object = value
        .as_object()
        .unwrap_or_else(|| panic!("schema node must be an object: {value}"));
    for forbidden in [
        "$ref",
        "$defs",
        "oneOf",
        "anyOf",
        "allOf",
        "const",
        "$schema",
        "additionalProperties",
        "format",
    ] {
        assert!(
            !object.contains_key(forbidden),
            "unsupported schema {forbidden}: {value}"
        );
    }
    if let Some(kind) = object.get("type") {
        assert!(kind.is_string(), "{value}");
        assert_ne!(kind.as_str(), Some("null"), "{value}");
    }
    if let Some(properties) = object.get("properties").and_then(Value::as_object) {
        for property in properties.values() {
            assert_portable_tool_schema(property);
        }
    }
    if let Some(items) = object.get("items") {
        assert_portable_tool_schema(items);
    }
}

#[test]
fn native_replace_is_applied_once_and_errors_do_not_break_the_worker() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("sample.txt");
    std::fs::write(&path, "a").unwrap();
    let mut worker = Worker::spawn(temp.path());
    let response = worker.call(
        "write",
        "replace",
        json!({"path":path,"pattern":"a","replacement":"aa","max_replacements":1}),
    );
    assert_eq!(response["result"]["isError"], false, "{response}");
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "aa");
    for (id, name, arguments) in [
        ("unknown", "bash", json!({"command":"echo should-not-run"})),
        ("invalid", "grep", json!({"pattern":12})),
        (
            "missing",
            "inspect_local_file",
            json!({"file_path":temp.path().join("absent.txt")}),
        ),
    ] {
        let response = worker.call(id, name, arguments);
        assert!(
            response.get("error").is_some() || response["result"]["isError"] == true,
            "{response}"
        );
    }
    worker.send(json!({"id":"cancel-missing","method":"cancel","params":{"requestId":"absent"}}));
    assert_eq!(worker.receive()["result"]["status"], "notRunning");
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "aa");
    worker.finish();
}

#[test]
fn native_inspection_returns_image_content() {
    let temp = tempfile::tempdir().unwrap();
    std::fs::write(
        temp.path().join("image.png"),
        include_bytes!("../../../backend/icons/Codey.png"),
    )
    .unwrap();
    let mut worker = Worker::spawn(temp.path());
    let response = worker.call(
        "image",
        "inspect_local_file",
        json!({"file_path":temp.path().join("image.png")}),
    );
    let image = response["result"]["content"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["type"] == "image")
        .expect("image content was lost");
    assert_eq!(image["mimeType"], "image/png");
    assert!(!image["data"].as_str().unwrap().is_empty());
    worker.finish();
}

#[test]
fn native_search_cancellation_keeps_the_connection_usable() {
    let temp = tempfile::tempdir().unwrap();
    std::fs::write(
        temp.path().join("large.txt"),
        "a repeated line for a cancellable search\n".repeat(300_000),
    )
    .unwrap();
    let mut worker = Worker::spawn(temp.path());
    worker.send(json!({"id":"search","method":"tools/call","params":{"name":"grep","arguments":{"pattern":"will-never-match","path":temp.path().join("large.txt")}}}));
    worker.send(json!({"id":"cancel","method":"cancel","params":{"requestId":"search"}}));
    let mut results = BTreeMap::new();
    for _ in 0..2 {
        let response = worker.receive();
        results.insert(response["id"].as_str().unwrap().to_owned(), response);
    }
    assert_eq!(
        results["cancel"]["result"]["status"],
        "cancellationRequested"
    );
    assert_eq!(results["search"]["result"]["isError"], true);
    assert!(
        text(&results["search"])
            .to_ascii_lowercase()
            .contains("cancel")
    );
    let response = worker.call("after", "glob", json!({"pattern":["large.txt"]}));
    assert_eq!(response["result"]["isError"], false, "{response}");
    worker.finish();
}

#[test]
fn native_write_cancellation_is_not_acknowledged_and_eof_waits_for_the_write() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("write.txt");
    std::fs::write(&path, "a\n".repeat(100_000)).unwrap();
    let mut worker = Worker::spawn(temp.path());
    worker.send(json!({"id":"write","method":"tools/call","params":{"name":"replace","arguments":{"path":path,"pattern":"a","replacement":"aa"}}}));
    worker.send(json!({"id":"cancel-write","method":"cancel","params":{"requestId":"write"}}));
    worker.stdin.take();
    let mut results = BTreeMap::new();
    for _ in 0..2 {
        let response = worker.receive();
        results.insert(response["id"].as_str().unwrap().to_owned(), response);
    }
    assert_eq!(
        results["cancel-write"]["result"]["status"],
        "notCancellable"
    );
    assert_eq!(results["write"]["result"]["isError"], false);
    worker.finish();
    assert_eq!(
        std::fs::read_to_string(path).unwrap(),
        "aa\n".repeat(100_000)
    );
}

#[test]
fn native_rejects_invalid_envelopes_without_executing_them() {
    let temp = tempfile::tempdir().unwrap();
    let mut worker = Worker::spawn(temp.path());
    for request in [
        json!({"id":"", "method":"tools/list"}),
        json!({"id":"oversized".repeat(40), "method":"tools/list"}),
        json!({"id":"unknown-field", "method":"tools/list", "cwd":"arbitrary"}),
    ] {
        worker.send(request);
        let response = worker.receive();
        assert!(response["id"].is_null(), "{response}");
        assert!(
            response["error"]["message"]
                .as_str()
                .unwrap()
                .contains("Invalid")
        );
    }
    for request in [
        json!({"id":"method", "method":"initialize"}),
        json!({"id":"list-params", "method":"tools/list", "params":{"unexpected":true}}),
        json!({"id":"cancel-params", "method":"cancel", "params":{"requestId":12}}),
    ] {
        let id = request["id"].clone();
        worker.send(request);
        let response = worker.receive();
        assert_eq!(response["id"], id);
        assert!(response["error"].is_object(), "{response}");
    }
    worker.send(json!({"id":"still-usable", "method":"tools/list"}));
    assert_eq!(
        worker.receive()["result"]["tools"]
            .as_array()
            .unwrap()
            .len(),
        4
    );
    worker.finish();
}

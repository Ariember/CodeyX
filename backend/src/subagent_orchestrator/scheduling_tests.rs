use super::*;
use serde_json::json;
use tempfile::tempdir;

fn spawn(root: &Path, session: &str, task: &str, role: &str, workspace: &str) {
    let input =
        json!({"task_name": task, "agent_type": role, "message": "Complete the assigned task"});
    assert_eq!(
        pre_spawn_with_workspace_and_turn(
            root,
            "runtime",
            session,
            Some(&input),
            RootHookContext::new(Some(workspace), 0, 10),
        )
        .unwrap(),
        None
    );
    post_spawn(
        root,
        "runtime",
        session,
        Some(&input),
        Some(&json!({"agent_id": task})),
        11,
    )
    .unwrap();
}

fn tool(root: &Path, session: &str, task: &str, name: &str) -> Result<Option<String>> {
    authorize_child_tool_with_context(
        root,
        "runtime",
        session,
        ChildToolContext {
            agent_id: task,
            agent_type: None,
            transcript_path: None,
            tool_name: name,
            tool_input: None,
        },
        20,
    )
}

#[test]
fn terminal_usage_is_attributed_per_agent_not_from_batch_or_output() {
    let temp = tempdir().unwrap();
    spawn(
        temp.path(),
        "session",
        "reader_a",
        "codey_quick_scan",
        "/repo",
    );
    spawn(
        temp.path(),
        "session",
        "reader_b",
        "codey_quick_scan",
        "/repo",
    );
    let response = json!({"usage":{"input_tokens":999}, "agents":[
        {"agent_id":"reader_a", "task_name":"/root/reader_a", "status":"completed", "turn_id":"a",
            "usage":{"input_tokens":11,"output_tokens":4}, "output":{"usage":{"input_tokens":888}}},
        {"agent_id":"reader_b", "status":"completed", "turn_id":"b",
            "usage":{"inputTokens":23,"outputTokens":5}}
    ]});
    observe_status_response(
        temp.path(),
        "runtime",
        "session",
        Some(&response),
        false,
        30,
    )
    .unwrap();
    let ledger = LedgerStore::open(temp.path(), "session")
        .unwrap()
        .load("runtime", "session", 31)
        .unwrap()
        .unwrap();
    assert_eq!(
        ledger.reservations["reader_a"]
            .token_usage
            .as_ref()
            .unwrap()
            .input_tokens,
        11
    );
    assert_eq!(
        ledger.reservations["reader_b"]
            .token_usage
            .as_ref()
            .unwrap()
            .input_tokens,
        23
    );
    let trace = fs::read_to_string(crate::subagent::telemetry::trace_file(temp.path())).unwrap();
    let completions: Vec<SubagentTraceEvent> = trace
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .filter(|event: &SubagentTraceEvent| event.event == TraceEventKind::Completed)
        .collect();
    assert_eq!(completions.len(), 2);
    assert_eq!(
        completions
            .iter()
            .map(|event| event.usage.as_ref().unwrap().input_tokens)
            .sum::<u64>(),
        34
    );
}

#[test]
fn terminal_usage_rejects_ambiguous_identity_turns_and_unscoped_totals() {
    let temp = tempdir().unwrap();
    spawn(
        temp.path(),
        "session",
        "reader_a",
        "codey_quick_scan",
        "/repo",
    );
    spawn(
        temp.path(),
        "session",
        "reader_b",
        "codey_quick_scan",
        "/repo",
    );
    let ledger = LedgerStore::open(temp.path(), "session")
        .unwrap()
        .load("runtime", "session", 12)
        .unwrap()
        .unwrap();
    for response in [
        json!({"usage":{"input_tokens":99},"agents":[{"agent_id":"reader_a","status":"completed"}]}),
        json!({"agent_id":"reader_a","task_name":"reader_b","status":"completed","turn_id":"a","usage":{"input_tokens":1}}),
        json!({"agent_id":"unknown","status":"completed","turn_id":"a","usage":{"input_tokens":1}}),
        json!({"agents":[
            {"agent_id":"reader_a","status":"completed","turn_id":"a","usage":{"input_tokens":1}},
            {"agent_id":"reader_a","status":"completed","turn_id":"b","usage":{"input_tokens":2}}
        ]}),
    ] {
        assert!(collect_terminal_task_usage(&response, &ledger).is_empty());
    }
}

#[test]
fn every_role_can_read_in_the_same_workspace() {
    let temp = tempdir().unwrap();
    for (index, role) in crate::config::SUBAGENT_ROLE_IDS.into_iter().enumerate() {
        let session = format!("session-{index}");
        let task = format!("task_{index}");
        spawn(temp.path(), &session, &task, role, "/repo");
        for name in [
            "mcp__codey_fastctx__grep",
            "functions.view_image",
            "web.run",
            "read_mcp_resource",
        ] {
            assert_eq!(
                tool(temp.path(), &session, &task, name).unwrap(),
                None,
                "{role} {name}"
            );
        }
    }
}

#[test]
fn review_and_writer_run_concurrently_in_the_same_workspace() {
    let temp = tempdir().unwrap();
    spawn(
        temp.path(),
        "writer-session",
        "writer",
        "codey_worker",
        "/repo",
    );
    assert_eq!(
        tool(temp.path(), "writer-session", "writer", "apply_patch").unwrap(),
        None
    );
    spawn(
        temp.path(),
        "review-session",
        "review",
        "codey_deep_research",
        "/repo/src",
    );
    for name in [
        "mcp__codey_fastctx__inspect_local_file",
        "mcp__codey_fastctx__glob",
        "view_image",
        "functions.exec",
        "functions.exec_command",
        "functions.write_stdin",
        "apply_patch",
        "mcp__unknown__read",
        "mcp__cua_repl__js",
        "grep",
    ] {
        assert_eq!(
            tool(temp.path(), "review-session", "review", name).unwrap(),
            None,
            "{name}"
        );
    }
}

#[test]
fn same_session_review_and_writer_obey_concurrency() {
    let temp = tempdir().unwrap();
    spawn(temp.path(), "session", "writer", "codey_worker", "/repo");
    spawn(
        temp.path(),
        "session",
        "review",
        "codey_quick_scan",
        "/repo",
    );
    let third = json!({"task_name":"third", "agent_type":"codey_worker", "message":"Work"});
    assert!(
        pre_spawn(temp.path(), "runtime", "session", Some(&third), 2, 12)
            .unwrap()
            .unwrap()
            .contains(CONCURRENCY_LIMIT_ERROR_CODE)
    );
    assert_eq!(
        tool(temp.path(), "session", "writer", "apply_patch").unwrap(),
        None
    );
    assert_eq!(
        tool(temp.path(), "session", "review", "apply_patch").unwrap(),
        None
    );
}

#[test]
fn writers_in_different_sessions_share_the_workspace_without_exclusion() {
    let temp = tempdir().unwrap();
    spawn(
        temp.path(),
        "writer-a-session",
        "writer_a",
        "codey_worker",
        "/repo",
    );
    spawn(
        temp.path(),
        "writer-b-session",
        "writer_b",
        "codey_worker",
        "/repo",
    );
    for (session, task) in [
        ("writer-a-session", "writer_a"),
        ("writer-b-session", "writer_b"),
    ] {
        for name in [
            "apply_patch",
            "functions.exec",
            "exec_command",
            "mcp__codey_fastctx__replace",
        ] {
            assert_eq!(
                tool(temp.path(), session, task, name).unwrap(),
                None,
                "{session} {task} {name}"
            );
        }
    }
}

#[test]
fn unbound_or_fenced_attempts_cannot_use_tools() {
    let temp = tempdir().unwrap();
    assert!(
        tool(temp.path(), "session", "unbound", "apply_patch")
            .unwrap()
            .is_some()
    );
    spawn(
        temp.path(),
        "session",
        "review",
        "codey_quick_scan",
        "/repo",
    );
    pre_interrupt_agent(
        temp.path(),
        "runtime",
        "session",
        Some(&json!({"target":"review"})),
        22,
    )
    .unwrap();
    assert!(
        tool(temp.path(), "session", "review", "apply_patch")
            .unwrap()
            .is_some()
    );
}

#[test]
fn custom_read_only_role_cannot_write_through_commands_unknown_or_visual_tools() {
    let temp = tempdir().unwrap();
    let root = temp.path().join(crate::subagent_gate::STATE_DIRECTORY);
    let mut role = crate::config::SubagentRoleConfig::new("review-model", "high");
    role.access = crate::config::SubagentAccess::ReadOnly;
    role.name = "审查".into();
    role.description = "审查代码".into();
    role.developer_instructions = "报告证据".into();
    let mut roles = crate::config::default_subagent_roles();
    roles.insert("reviewer".into(), role);
    crate::subagent_gate::commit_runtime_subagent_policy(
        temp.path(),
        &roles,
        &Default::default(),
        4,
    )
    .unwrap();
    spawn(&root, "session", "review", "reviewer", "/repo");
    for name in [
        "read_file",
        "mcp__codey_fastctx__grep",
        "mcp__codey_fastctx__glob",
        "functions.view_image",
        "web.run",
    ] {
        assert_eq!(
            tool(&root, "session", "review", name).unwrap(),
            None,
            "{name}"
        );
    }
    for name in [
        "apply_patch",
        "mcp__codey_fastctx__replace",
        "functions.exec",
        "functions.exec_command",
        "functions.write_stdin",
        "mcp__unknown__read",
        "mcp__cua_repl__js",
        "mcp__codex_app__open_in_codex",
    ] {
        assert!(
            tool(&root, "session", "review", name).unwrap().is_some(),
            "{name}"
        );
    }
    // Saving a broader role does not elevate an already-running attempt.
    roles.get_mut("reviewer").unwrap().access = crate::config::SubagentAccess::ReadWrite;
    crate::subagent_gate::commit_runtime_subagent_policy(
        temp.path(),
        &roles,
        &Default::default(),
        4,
    )
    .unwrap();
    assert!(
        tool(&root, "session", "review", "apply_patch")
            .unwrap()
            .is_some()
    );
    spawn(&root, "session", "writer", "reviewer", "/repo");
    assert_eq!(
        tool(&root, "session", "writer", "apply_patch").unwrap(),
        None
    );
    roles.remove("reviewer");
    crate::subagent_gate::commit_runtime_subagent_policy(
        temp.path(),
        &roles,
        &Default::default(),
        4,
    )
    .unwrap();
    assert_eq!(
        tool(&root, "session", "writer", "apply_patch").unwrap(),
        None
    );
    assert!(
        tool(&root, "session", "review", "apply_patch")
            .unwrap()
            .is_some()
    );
}

#[test]
fn configured_concurrency_replaces_the_old_two_agent_limit() {
    let temp = tempdir().unwrap();
    let root = temp.path().join(crate::subagent_gate::STATE_DIRECTORY);
    crate::subagent_gate::commit_runtime_subagent_policy(
        temp.path(),
        &crate::config::default_subagent_roles(),
        &Default::default(),
        4,
    )
    .unwrap();
    for index in 0..4 {
        spawn(
            &root,
            "session",
            &format!("worker_{index}"),
            "codey_worker",
            "/repo",
        );
    }
    let next = json!({"task_name":"overflow", "agent_type":"codey_worker", "message":"Work"});
    let reason = pre_spawn(&root, "runtime", "session", Some(&next), 0, 20)
        .unwrap()
        .unwrap();
    assert!(reason.contains("并发上限 4"));
}

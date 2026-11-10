use super::*;
use tokio::io::BufReader;

fn environment() -> BTreeMap<String, String> {
    std::env::vars().collect()
}

async fn fixture(manager: &Manager, cwd: &Path) -> Arc<Worker> {
    let config = json!({"command":"node","args":[concat!(env!("CARGO_MANIFEST_DIR"), "/src/fastctx_native/fixture.cjs")]});
    let worker = Worker::start_config(&config, cwd, &environment())
        .await
        .unwrap();
    manager
        .inner
        .workers
        .lock()
        .await
        .insert(cwd.to_path_buf(), Arc::clone(&worker));
    worker
}

fn request(id: &str, args: Value) -> CallRequest {
    CallRequest {
        request_id: id.into(),
        thread_id: "thread-1".into(),
        tool: "grep".into(),
        arguments: args,
    }
}

#[test]
fn completed_call_records_are_bounded_and_retained_after_completion() {
    let manager = Manager::default();
    for index in 0..MAX_CALLS {
        manager
            .reserve(&format!("call-{index}"), "thread", true)
            .unwrap();
    }
    assert!(manager.reserve("overflow", "thread", true).is_err());
    let record = manager.inner.calls.lock().unwrap()["call-0"].clone();
    *record.completed.lock().unwrap() = Some(Instant::now());
    assert!(manager.reserve("call-0", "thread", true).is_err());
    *record.completed.lock().unwrap() = Some(Instant::now() - CALL_RETENTION);
    assert!(manager.reserve("call-0", "thread", true).is_ok());
    assert_eq!(manager.inner.calls.lock().unwrap().len(), MAX_CALLS);
}

#[test]
fn completed_reads_can_exceed_the_ledger_capacity_without_replaying_duplicate_ids() {
    let manager = Manager::default();
    for index in 0..MAX_CALLS + 64 {
        let record = manager
            .reserve(&format!("read-{index}"), "thread", true)
            .unwrap();
        *record.completed.lock().unwrap() = Some(Instant::now());
    }
    assert_eq!(manager.inner.calls.lock().unwrap().len(), MAX_CALLS);
    assert!(
        manager
            .reserve(&format!("read-{}", MAX_CALLS + 63), "thread", true)
            .is_err()
    );
}

#[test]
fn completed_writes_keep_their_replay_protection_when_the_ledger_is_full() {
    let manager = Manager::default();
    for index in 0..MAX_CALLS {
        let record = manager
            .reserve(&format!("write-{index}"), "thread", false)
            .unwrap();
        *record.completed.lock().unwrap() = Some(Instant::now());
    }
    assert!(manager.reserve("overflow-read", "thread", true).is_err());
    assert!(manager.reserve("overflow-write", "thread", false).is_err());
    assert!(manager.reserve("write-0", "thread", false).is_err());
    assert_eq!(manager.inner.calls.lock().unwrap().len(), MAX_CALLS);
}

#[tokio::test]
async fn native_admission_queues_bursts_without_exceeding_engine_capacity() {
    let temp = tempfile::tempdir().unwrap();
    let cwd = temp.path().canonicalize().unwrap();
    let manager = Manager::default();
    let worker = fixture(&manager, &cwd).await;
    let mut calls = tokio::task::JoinSet::new();
    for index in 0..64 {
        let manager = manager.clone();
        let cwd = cwd.clone();
        calls.spawn(async move {
            manager
                .call(
                    Path::new("unused"),
                    &cwd,
                    &environment(),
                    request(
                        &format!("burst-{index}"),
                        json!({"delay":20,"maxInFlight":MAX_ACTIVE_CALLS}),
                    ),
                )
                .await
        });
    }
    while let Some(result) = tokio::time::timeout(Duration::from_secs(5), calls.join_next())
        .await
        .unwrap()
    {
        assert_eq!(result.unwrap().unwrap()["isError"], false);
    }
    assert_eq!(worker.admitted.available_permits(), MAX_ADMITTED_CALLS);
    assert_eq!(worker.running.available_permits(), MAX_ACTIVE_CALLS);
    assert!(worker.pending.lock().unwrap().is_empty());
    worker.close().await;
}

#[tokio::test]
async fn bounded_queue_cancellation_and_worker_failure_release_admission() {
    let temp = tempfile::tempdir().unwrap();
    let cwd = temp.path().canonicalize().unwrap();
    let manager = Manager::default();
    let worker = fixture(&manager, &cwd).await;
    let blocked = worker
        .running
        .acquire_many(MAX_ACTIVE_CALLS as u32)
        .await
        .unwrap();
    let mut calls = Vec::new();
    for index in 0..MAX_ADMITTED_CALLS {
        let manager = manager.clone();
        let cwd = cwd.clone();
        calls.push(tokio::spawn(async move {
            let mut request = request(&format!("queued-{index}"), json!({}));
            if index == 0 {
                request.tool = "replace".into();
            }
            manager
                .call(Path::new("unused"), &cwd, &environment(), request)
                .await
        }));
    }
    for _ in 0..200 {
        if worker.admitted.available_permits() == 0 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    assert_eq!(worker.admitted.available_permits(), 0);
    assert!(worker.pending.lock().unwrap().is_empty());
    assert!(
        manager
            .call(
                Path::new("unused"),
                &cwd,
                &environment(),
                request("overflow", json!({}))
            )
            .await
            .unwrap_err()
            .contains("等待队列已满")
    );
    assert_eq!(
        manager.cancel("queued-0", "thread-1").await.unwrap()["status"],
        "cancellationRequested"
    );
    assert!(
        tokio::time::timeout(Duration::from_secs(5), calls.remove(0))
            .await
            .unwrap()
            .unwrap()
            .unwrap_err()
            .contains("执行前取消")
    );
    assert_eq!(worker.admitted.available_permits(), 1);
    *worker.last_used.lock().unwrap() = Instant::now() - IDLE;
    manager.inner.release_idle().await;
    assert!(!worker.stopped.load(Ordering::Acquire));
    worker.fail("fixture worker failed");
    for call in calls {
        assert!(
            tokio::time::timeout(Duration::from_secs(5), call)
                .await
                .unwrap()
                .unwrap()
                .is_err()
        );
    }
    drop(blocked);
    assert_eq!(worker.admitted.available_permits(), MAX_ADMITTED_CALLS);
    assert_eq!(worker.running.available_permits(), MAX_ACTIVE_CALLS);
    worker.close().await;
}

#[tokio::test]
async fn cancellation_winning_dispatch_never_sends_the_queued_write() {
    let temp = tempfile::tempdir().unwrap();
    let cwd = temp.path().canonicalize().unwrap();
    let manager = Manager::default();
    let worker = fixture(&manager, &cwd).await;
    let blocked = worker
        .running
        .acquire_many(MAX_ACTIVE_CALLS as u32)
        .await
        .unwrap();
    let owner = manager.clone();
    let work_cwd = cwd.clone();
    let call = tokio::spawn(async move {
        // The fixture exits if this cancelled request ever reaches it.
        let mut request = request("dispatch-race", json!({"exit":true}));
        request.tool = "replace".into();
        owner
            .call(Path::new("unused"), &work_cwd, &environment(), request)
            .await
    });
    for _ in 0..100 {
        if worker.admitted.available_permits() < MAX_ADMITTED_CALLS {
            break;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    assert_eq!(worker.admitted.available_permits(), MAX_ADMITTED_CALLS - 1);
    let record = manager.inner.calls.lock().unwrap()["dispatch-race"].clone();
    let dispatch = record.dispatch.lock().await;
    let cancellation = manager.cancel("dispatch-race", "thread-1");
    tokio::pin!(cancellation);
    assert!(futures_util::poll!(&mut cancellation).is_pending());
    drop(blocked);
    for _ in 0..100 {
        if worker.running.available_permits() == MAX_ACTIVE_CALLS - 1 {
            break;
        }
        tokio::task::yield_now().await;
    }
    assert_eq!(worker.running.available_permits(), MAX_ACTIVE_CALLS - 1);
    drop(dispatch);
    assert_eq!(
        cancellation.await.unwrap()["status"],
        "cancellationRequested"
    );
    assert!(call.await.unwrap().unwrap_err().contains("执行前取消"));
    assert!(worker.pending.lock().unwrap().is_empty());
    assert!(!worker.stopped.load(Ordering::Acquire));
    assert!(
        manager
            .call(
                Path::new("unused"),
                &cwd,
                &environment(),
                request("after-race", json!({}))
            )
            .await
            .is_ok()
    );
    worker.close().await;
}

#[tokio::test]
async fn queued_write_deadline_completes_before_the_call_can_be_sent() {
    let temp = tempfile::tempdir().unwrap();
    let cwd = temp.path().canonicalize().unwrap();
    let manager = Manager::default();
    let worker = fixture(&manager, &cwd).await;
    let blocked = worker
        .running
        .acquire_many(MAX_ACTIVE_CALLS as u32)
        .await
        .unwrap();
    let owner = manager.clone();
    let work_cwd = cwd.clone();
    let call = tokio::spawn(async move {
        let mut request = request("queued-write", json!({}));
        request.tool = "replace".into();
        owner
            .call(Path::new("unused"), &work_cwd, &environment(), request)
            .await
    });
    for _ in 0..100 {
        if worker.admitted.available_permits() < MAX_ADMITTED_CALLS {
            break;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    assert_eq!(worker.admitted.available_permits(), MAX_ADMITTED_CALLS - 1);
    tokio::time::pause();
    tokio::time::advance(CALL_TIMEOUT).await;
    tokio::time::resume();
    assert!(
        tokio::time::timeout(Duration::from_secs(5), call)
            .await
            .unwrap()
            .unwrap()
            .unwrap_err()
            .contains("超时")
    );
    for _ in 0..100 {
        if worker.admitted.available_permits() == MAX_ADMITTED_CALLS {
            break;
        }
        tokio::task::yield_now().await;
    }
    assert_eq!(worker.admitted.available_permits(), MAX_ADMITTED_CALLS);
    assert!(
        manager.inner.calls.lock().unwrap()["queued-write"]
            .completed
            .lock()
            .unwrap()
            .is_some()
    );
    assert!(worker.pending.lock().unwrap().is_empty());
    drop(blocked);
    worker.close().await;
}

#[tokio::test]
async fn framing_rejects_invalid_truncated_and_oversized_responses() {
    for bytes in [b"broken\n".as_slice(), b"{\"id\":1}".as_slice()] {
        assert!(read_message(&mut BufReader::new(bytes)).await.is_err());
    }
    let bytes = vec![b'x'; MAX_FRAME + 1];
    assert!(
        read_message(&mut BufReader::new(bytes.as_slice()))
            .await
            .is_err()
    );
    assert!(
        read_message(&mut BufReader::new(b"".as_slice()))
            .await
            .unwrap()
            .is_none()
    );
}

#[tokio::test]
async fn native_pool_reuses_same_cwd_and_keeps_directories_isolated() {
    let temp = tempfile::tempdir().unwrap();
    let first = temp.path().join("目录 first");
    let second = temp.path().join("second");
    std::fs::create_dir_all(&first).unwrap();
    std::fs::create_dir_all(&second).unwrap();
    let first = first.canonicalize().unwrap();
    let second = second.canonicalize().unwrap();
    let manager = Manager::default();
    let first_worker = fixture(&manager, &first).await;
    let second_worker = fixture(&manager, &second).await;
    let result = manager
        .call(
            Path::new("unused"),
            &first,
            &environment(),
            request("first", json!({})),
        )
        .await
        .unwrap();
    assert_eq!(
        PathBuf::from(result["content"][0]["text"].as_str().unwrap())
            .canonicalize()
            .unwrap(),
        first
    );
    let result = manager
        .call(
            Path::new("unused"),
            &second,
            &environment(),
            request("second", json!({})),
        )
        .await
        .unwrap();
    assert_eq!(
        PathBuf::from(result["content"][0]["text"].as_str().unwrap())
            .canonicalize()
            .unwrap(),
        second
    );
    assert!(Arc::ptr_eq(
        &manager
            .worker(Path::new("unused"), &first, &environment())
            .await
            .unwrap(),
        &first_worker
    ));
    first_worker.close().await;
    second_worker.close().await;
}

#[tokio::test]
async fn cancellation_is_bound_to_thread_and_duplicate_calls_are_not_replayed() {
    let temp = tempfile::tempdir().unwrap();
    let cwd = temp.path().canonicalize().unwrap();
    let manager = Manager::default();
    let worker = fixture(&manager, &cwd).await;
    let owner = manager.clone();
    let work_cwd = cwd.clone();
    let call = tokio::spawn(async move {
        owner
            .call(
                Path::new("unused"),
                &work_cwd,
                &environment(),
                request("slow", json!({"delay":30000})),
            )
            .await
    });
    for _ in 0..100 {
        if worker.pending.lock().unwrap().contains_key("slow") {
            break;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    assert!(manager.cancel("slow", "other-thread").await.is_err());
    assert!(
        manager
            .call(
                Path::new("unused"),
                &cwd,
                &environment(),
                request("slow", json!({}))
            )
            .await
            .unwrap_err()
            .contains("未重试")
    );
    assert_eq!(
        manager.cancel("slow", "thread-1").await.unwrap()["status"],
        "cancellationRequested"
    );
    assert_eq!(call.await.unwrap().unwrap()["isError"], true);
    assert_eq!(
        manager.cancel("slow", "thread-1").await.unwrap()["status"],
        "notRunning"
    );
    assert!(
        manager
            .call(
                Path::new("unused"),
                &cwd,
                &environment(),
                request("slow", json!({}))
            )
            .await
            .is_err()
    );
    worker.close().await;
}

#[tokio::test]
async fn cancellation_still_works_when_the_request_queue_is_full() {
    let temp = tempfile::tempdir().unwrap();
    let cwd = temp.path().canonicalize().unwrap();
    let manager = Manager::default();
    let worker = fixture(&manager, &cwd).await;
    let mut responses = Vec::new();
    for index in 0..32 {
        responses.push(
            worker
                .send(
                    format!("busy-{index}"),
                    "tools/call",
                    json!({"name":"grep","arguments":{"delay":30000}}),
                )
                .await
                .unwrap(),
        );
    }
    assert_eq!(worker.pending.lock().unwrap().len(), 32);
    assert!(
        worker
            .request("overflow".into(), "tools/list", json!({}))
            .await
            .is_err()
    );
    assert_eq!(
        worker.cancel("busy-0").await.unwrap()["status"],
        "cancellationRequested"
    );
    assert_eq!(receive(responses.remove(0)).await.unwrap()["isError"], true);
    assert_eq!(worker.pending.lock().unwrap().len(), 31);
    assert!(!worker.stopped.load(Ordering::Acquire));
    worker.close().await;
}

#[tokio::test]
async fn worker_exit_fails_pending_calls_and_missing_binary_is_reported() {
    let temp = tempfile::tempdir().unwrap();
    let cwd = temp.path().canonicalize().unwrap();
    let manager = Manager::default();
    let worker = fixture(&manager, &cwd).await;
    let outcome = tokio::time::timeout(
        Duration::from_secs(5),
        manager.call(
            Path::new("unused"),
            &cwd,
            &environment(),
            request("exit", json!({"exit":true})),
        ),
    )
    .await
    .unwrap();
    assert!(outcome.unwrap_err().contains("未重试"));
    assert!(worker.stopped.load(Ordering::Acquire));
    assert_eq!(worker.admitted.available_permits(), MAX_ADMITTED_CALLS);
    assert_eq!(worker.running.available_permits(), MAX_ACTIVE_CALLS);
    assert!(
        Worker::start(&cwd.join("missing-native-worker"), &cwd, &environment())
            .await
            .is_err()
    );
}

#[tokio::test]
async fn search_deadline_cleans_pending_calls_but_keeps_unconfirmed_writes_owned() {
    let temp = tempfile::tempdir().unwrap();
    let cwd = temp.path().canonicalize().unwrap();
    let manager = Manager::default();
    let worker = fixture(&manager, &cwd).await;
    let mut calls = Vec::new();
    for (id, tool) in [("expired-search", "grep"), ("ongoing-write", "replace")] {
        let manager = manager.clone();
        let cwd = cwd.clone();
        calls.push(tokio::spawn(async move {
            let mut request = request(id, json!({"delay":30000}));
            request.tool = tool.into();
            manager
                .call(Path::new("unused"), &cwd, &environment(), request)
                .await
        }));
    }
    for _ in 0..100 {
        if worker.pending.lock().unwrap().len() == 2 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    assert_eq!(worker.pending.lock().unwrap().len(), 2);
    // Flush both requests before advancing time so stdio startup cannot time out instead.
    worker
        .request("before-deadline".into(), "tools/list", json!({}))
        .await
        .unwrap();
    tokio::time::pause();
    tokio::time::advance(CALL_TIMEOUT).await;
    tokio::time::resume();
    for call in calls {
        assert!(
            tokio::time::timeout(Duration::from_secs(5), call)
                .await
                .unwrap()
                .unwrap()
                .unwrap_err()
                .contains("超时")
        );
    }
    assert!(
        !worker
            .pending
            .lock()
            .unwrap()
            .contains_key("expired-search")
    );
    assert!(worker.pending.lock().unwrap().contains_key("ongoing-write"));
    let records = manager.inner.calls.lock().unwrap().clone();
    assert!(
        records["expired-search"]
            .completed
            .lock()
            .unwrap()
            .is_some()
    );
    assert!(records["ongoing-write"].completed.lock().unwrap().is_none());
    assert_eq!(worker.admitted.available_permits(), MAX_ADMITTED_CALLS - 1);
    assert_eq!(worker.running.available_permits(), MAX_ACTIVE_CALLS - 1);
    *worker.last_used.lock().unwrap() = Instant::now() - IDLE;
    manager.inner.release_idle().await;
    assert!(!worker.stopped.load(Ordering::Acquire));
    assert_eq!(manager.inner.workers.lock().await.len(), 1);
    assert!(
        manager
            .call(
                Path::new("unused"),
                &cwd,
                &environment(),
                request("unrelated-call", json!({}))
            )
            .await
            .is_ok()
    );
    worker
        .pending
        .lock()
        .unwrap()
        .remove("ongoing-write")
        .unwrap()
        .send(Ok(json!({"content":[],"isError":false})))
        .unwrap();
    for _ in 0..100 {
        if records["ongoing-write"].completed.lock().unwrap().is_some() {
            break;
        }
        tokio::task::yield_now().await;
    }
    assert!(records["ongoing-write"].completed.lock().unwrap().is_some());
    worker.close().await;
}

#[tokio::test]
async fn abandoned_metadata_response_frees_its_pending_slot() {
    let temp = tempfile::tempdir().unwrap();
    let cwd = temp.path().canonicalize().unwrap();
    let manager = Manager::default();
    let worker = fixture(&manager, &cwd).await;
    let pending_worker = Arc::clone(&worker);
    let task = tokio::spawn(async move {
        pending_worker
            .request(
                "abandoned".into(),
                "tools/call",
                json!({"name":"grep","arguments":{"delay":30000}}),
            )
            .await
    });
    for _ in 0..100 {
        if worker.pending.lock().unwrap().contains_key("abandoned") {
            break;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    assert!(worker.pending.lock().unwrap().contains_key("abandoned"));
    task.abort();
    assert!(task.await.unwrap_err().is_cancelled());
    assert!(worker.pending.lock().unwrap().is_empty());
    assert!(!worker.stopped.load(Ordering::Acquire));
    worker.close().await;
}

#[tokio::test]
async fn idle_release_preserves_active_workers_and_closes_idle_workers() {
    let temp = tempfile::tempdir().unwrap();
    let cwd = temp.path().canonicalize().unwrap();
    let manager = Manager::default();
    let worker = fixture(&manager, &cwd).await;
    *worker.last_used.lock().unwrap() = Instant::now() - IDLE;
    let (sender, _response) = oneshot::channel();
    worker
        .pending
        .lock()
        .unwrap()
        .insert("active".into(), sender);
    manager.inner.release_idle().await;
    assert_eq!(manager.inner.workers.lock().await.len(), 1);
    worker.pending.lock().unwrap().clear();
    manager.inner.release_idle().await;
    assert!(manager.inner.workers.lock().await.is_empty());
    assert!(worker.stopped.load(Ordering::Acquire));
}

#[tokio::test]
async fn native_backend_real_sidecar_smoke() {
    let Some(binary) = std::env::var_os("CODEY_FASTCTX_NATIVE_EXECUTABLE") else {
        eprintln!("Set CODEY_FASTCTX_NATIVE_EXECUTABLE to run the real native sidecar check");
        return;
    };
    let temp = tempfile::tempdir().unwrap();
    let cwd = temp.path().canonicalize().unwrap();
    std::fs::write(cwd.join("sample.txt"), "native backend\n").unwrap();
    let manager = Manager::default();
    let binary = PathBuf::from(binary);
    let home = temp.path().join("home");
    std::fs::create_dir_all(home.join(".codex")).unwrap();
    let mut env = environment();
    for name in ["HOME", "USERPROFILE"] {
        env.insert(name.into(), home.to_string_lossy().into_owned());
    }
    env.insert(
        "CODEX_HOME".into(),
        home.join(".codex").to_string_lossy().into_owned(),
    );
    env.insert(
        "CODEY_APP_STATE_DIR".into(),
        home.join("state").to_string_lossy().into_owned(),
    );
    let result = manager.tools(&binary, &cwd, &env).await.unwrap();
    assert_eq!(result["tools"].as_array().unwrap().len(), 7);
    let created = cwd.join("created.txt");
    let moved = cwd.join("moved.txt");
    for (id, tool, arguments) in [
        (
            "real-create",
            "create_file",
            json!({"path":created,"content":"new 世界"}),
        ),
        (
            "real-move",
            "move",
            json!({"source":created,"destination":moved}),
        ),
        ("real-preview", "delete", json!({"paths":[moved]})),
        (
            "real-delete",
            "delete",
            json!({"paths":[moved],"dry_run":false}),
        ),
    ] {
        let mut call = request(id, arguments);
        call.tool = tool.into();
        let result = manager.call(&binary, &cwd, &env, call).await.unwrap();
        assert_eq!(result["isError"], false, "{result}");
        if id != "real-delete" {
            let path = if id == "real-create" {
                &created
            } else {
                &moved
            };
            assert_eq!(std::fs::read_to_string(path).unwrap(), "new 世界");
        }
    }
    assert!(!created.exists());
    assert!(!moved.exists());
    let mut call = request("real-call", json!({"file_path":cwd.join("sample.txt")}));
    call.tool = "inspect_local_file".into();
    let result = manager.call(&binary, &cwd, &env, call).await.unwrap();
    assert_eq!(result["isError"], false, "{result}");
    assert!(
        result["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("native backend")
    );
    let mut reads = tokio::task::JoinSet::new();
    for index in 0..64 {
        let manager = manager.clone();
        let binary = binary.clone();
        let cwd = cwd.clone();
        let env = env.clone();
        reads.spawn(async move {
            let mut call = request(
                &format!("real-read-{index}"),
                json!({"file_path":cwd.join("sample.txt")}),
            );
            call.tool = "inspect_local_file".into();
            manager.call(&binary, &cwd, &env, call).await
        });
    }
    while let Some(result) = tokio::time::timeout(Duration::from_secs(10), reads.join_next())
        .await
        .unwrap()
    {
        let result = result.unwrap().unwrap();
        assert_eq!(result["isError"], false, "{result}");
        assert!(
            result["content"][0]["text"]
                .as_str()
                .unwrap()
                .contains("native backend")
        );
    }
    for (_, worker) in manager.inner.workers.lock().await.drain() {
        worker.close().await;
    }
}

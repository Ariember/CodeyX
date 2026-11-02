use super::*;

#[test]
fn live_speed_throttle_skips_session_stats_until_the_next_sample() {
    let controller = RouteRequestLogController::with_root(PathBuf::new());
    let registry = controller.session_stats();
    let now = Instant::now();
    let probe = controller
        .begin(|producer| {
            producer.begin(RouteRequestLogStart {
                request_id: "throttled-live",
                started_at: now - Duration::from_secs(6),
                request_protocol: RequestProtocol::Sse,
                request_kind: "responses",
                requested_model: "model",
                reasoning_effort: None,
                thinking_budget_tokens: None,
                codex_session_id: Some("throttled-session"),
                codex_session_is_parent: false,
            })
        })
        .unwrap();
    probe
        .shared
        .upstream_started_at
        .set(now - Duration::from_secs(5))
        .unwrap();
    probe.shared.first_byte_micros.store(1, Ordering::Relaxed);

    probe.observe_event_at(
        &serde_json::json!({"type":"response.output_text.delta","delta":"a".repeat(400)}),
        now - Duration::from_secs(4),
    );
    let first_update = registry
        .snapshot("throttled-session")
        .unwrap()
        .speed_recorded_at_unix_ms
        .unwrap();

    probe.observe_event_at(
        &serde_json::json!({"type":"response.output_text.delta","delta":"b".repeat(40)}),
        now - Duration::from_millis(3_900),
    );
    probe.observe_event_at(
        &serde_json::json!({"type":"response.function_call_arguments.delta","delta":"c".repeat(40)}),
        now - Duration::from_millis(3_800),
    );
    let throttled = registry.snapshot("throttled-session").unwrap();
    assert_eq!(
        throttled.speed_recorded_at_unix_ms,
        Some(first_update),
        "deltas inside the throttle window must not rewrite session speed"
    );
    assert_eq!(
        lock_unpoisoned(&probe.shared.live_output).estimated_quarters,
        480
    );

    probe.observe_event_at(
        &serde_json::json!({"type":"response.output_text.delta","delta":"d".repeat(40)}),
        now - Duration::from_millis(3_750),
    );
    let next_update = registry.snapshot("throttled-session").unwrap();
    assert_ne!(next_update.speed_recorded_at_unix_ms, Some(first_update));
    assert!(next_update.speed_is_estimate);
    assert!(
        next_update.output_tokens_per_second.is_some(),
        "the first delta at or beyond 250ms must publish a new sample"
    );
}

fn begin(producer: &RouteRequestLogProducer) -> RouteRequestLogProbe {
    producer
        .begin(RouteRequestLogStart {
            request_id: "stats-request",
            started_at: Instant::now(),
            request_protocol: RequestProtocol::Sse,
            request_kind: "responses",
            requested_model: "model",
            reasoning_effort: None,
            thinking_budget_tokens: None,
            codex_session_id: Some("stats-session"),
            codex_session_is_parent: false,
        })
        .unwrap()
}

#[tokio::test]
async fn disabled_logging_collects_usage_without_creating_files() {
    let root = tempfile::tempdir().unwrap();
    let controller = RouteRequestLogController::with_root(root.path().to_owned());
    controller
        .reconfigure(&RouteRequestLogConfig::default())
        .await
        .unwrap();
    let probe = controller.begin(|producer| Some(begin(producer))).unwrap();
    assert_eq!(
        controller
            .session_stats()
            .snapshot("stats-session")
            .unwrap()
            .in_flight,
        Some(1)
    );
    probe.observe_event(&serde_json::json!({"usage": {"input_tokens": 100, "output_tokens": 20, "total_tokens": 120}}));
    probe.finish_success();
    probe.finish_success();
    let snapshot = controller
        .session_stats()
        .snapshot("stats-session")
        .unwrap();
    assert_eq!(snapshot.in_flight, Some(0));
    assert_eq!(snapshot.requests, Some(1));
    assert_eq!(snapshot.total_tokens, Some(120));
    assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 0);
}

#[test]
fn sampling_does_not_drop_session_stats_or_send_to_writer() {
    let (sender, receiver) = mpsc::sync_channel(1);
    let registry = Arc::new(crate::conversation_stats::ConversationStatsRegistry::default());
    let producer = RouteRequestLogProducer {
        sender: Some(sender),
        accepting: Arc::new(AtomicBool::new(true)),
        submitting: Arc::new(AtomicU64::new(0)),
        sample_rate_per_million: 0,
        sample_sequence: Arc::new(AtomicU64::new(0)),
        stats: Arc::default(),
        session_stats: Some(Arc::clone(&registry)),
    };
    let probe = begin(&producer);
    probe.finish_success();
    assert!(receiver.try_recv().is_err());
    assert_eq!(
        registry.snapshot("stats-session").unwrap().requests,
        Some(1)
    );
    assert_eq!(producer.stats.sampled_out.load(Ordering::Relaxed), 1);
}

#[tokio::test]
async fn disabling_writer_settles_already_running_session_requests() {
    let root = tempfile::tempdir().unwrap();
    let controller = RouteRequestLogController::with_root(root.path().to_owned());
    controller
        .reconfigure(&RouteRequestLogConfig {
            enabled: true,
            ..Default::default()
        })
        .await
        .unwrap();
    let probe = controller.begin(|producer| Some(begin(producer))).unwrap();
    controller
        .reconfigure(&RouteRequestLogConfig::default())
        .await
        .unwrap();
    probe.finish_success();
    let snapshot = controller
        .session_stats()
        .snapshot("stats-session")
        .unwrap();
    assert_eq!(snapshot.requests, Some(1));
    assert_eq!(snapshot.in_flight, Some(0));
}

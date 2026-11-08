use super::*;
use futures_util::{SinkExt, StreamExt};
use std::sync::atomic::AtomicUsize;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message;

struct MockCdpState {
    healthy: AtomicBool,
    discovery_available: AtomicBool,
    hang_next_discovery: AtomicBool,
    stalled_discoveries: AtomicUsize,
    discoveries: AtomicUsize,
    health_checks: AtomicUsize,
    injections: AtomicUsize,
    active_bridges: AtomicUsize,
    close_bridges: tokio::sync::Notify,
}

struct MockCdp {
    port: u16,
    state: Arc<MockCdpState>,
    tasks: Vec<tokio::task::JoinHandle<()>>,
}

impl Drop for MockCdp {
    fn drop(&mut self) {
        for task in &self.tasks {
            task.abort();
        }
    }
}

impl MockCdp {
    async fn start() -> Self {
        let http = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = http.local_addr().unwrap().port();
        let websocket = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let websocket_address = websocket.local_addr().unwrap();
        let state = Arc::new(MockCdpState {
            healthy: AtomicBool::new(true),
            discovery_available: AtomicBool::new(true),
            hang_next_discovery: AtomicBool::new(false),
            stalled_discoveries: AtomicUsize::new(0),
            discoveries: AtomicUsize::new(0),
            health_checks: AtomicUsize::new(0),
            injections: AtomicUsize::new(0),
            active_bridges: AtomicUsize::new(0),
            close_bridges: tokio::sync::Notify::new(),
        });
        let http_state = state.clone();
        let http_task = tokio::spawn(async move {
            let mut connections = tokio::task::JoinSet::new();
            loop {
                let (mut socket, _) = http.accept().await.unwrap();
                let state = http_state.clone();
                connections.spawn(async move {
                    let mut request = [0; 4096];
                    let size = socket.read(&mut request).await.unwrap();
                    if size == 0 {
                        return;
                    }
                    // Match Chrome's localhost-only discovery so each round is counted once.
                    if !String::from_utf8_lossy(&request[..size])
                        .lines()
                        .any(|line| line.eq_ignore_ascii_case(&format!("host: localhost:{port}")))
                    {
                        let _ = socket
                            .write_all(b"HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                            .await;
                        return;
                    }
                    state.discoveries.fetch_add(1, Ordering::SeqCst);
                    if state.hang_next_discovery.swap(false, Ordering::SeqCst) {
                        state.stalled_discoveries.fetch_add(1, Ordering::SeqCst);
                        let _ = socket.read(&mut request).await;
                        return;
                    }
                    let (status, body) = if state.discovery_available.load(Ordering::SeqCst) {
                        (
                            "200 OK",
                            serde_json::json!([{
                                "id": "page",
                                "type": "page",
                                "title": "Codex",
                                "url": "app://-/index.html",
                                "webSocketDebuggerUrl": format!("ws://{websocket_address}/devtools/page/mock"),
                            }]).to_string(),
                        )
                    } else {
                        // Keep discovery reachable without an injectable page;
                        // HTTP failures also probe alternate loopback addresses.
                        ("200 OK", "[]".to_string())
                    };
                    let response = format!(
                        "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len(),
                    );
                    let _ = socket.write_all(response.as_bytes()).await;
                });
                while connections.try_join_next().is_some() {}
            }
        });
        let websocket_state = state.clone();
        let websocket_task = tokio::spawn(async move {
            let mut connections = tokio::task::JoinSet::new();
            loop {
                let (socket, _) = websocket.accept().await.unwrap();
                let state = websocket_state.clone();
                connections.spawn(async move {
                    let Ok(mut socket) = tokio_tungstenite::accept_async(socket).await else {
                        return;
                    };
                    let mut bridge = false;
                    loop {
                        let message = tokio::select! {
                            message = socket.next() => message,
                            _ = state.close_bridges.notified(), if bridge => break,
                        };
                        let Some(Ok(message)) = message else { break };
                        if message.is_close() {
                            let _ = socket.close(None).await;
                            break;
                        }
                        let Ok(text) = message.to_text() else {
                            continue;
                        };
                        let command: serde_json::Value = serde_json::from_str(text).unwrap();
                        let expression = command["params"]["expression"].as_str().unwrap_or("");
                        let health =
                            expression == codey_runtime_core::bridge::bridge_health_check_script();
                        let result = match command["method"].as_str() {
                            Some("Runtime.addBinding") => {
                                bridge = true;
                                state.active_bridges.fetch_add(1, Ordering::SeqCst);
                                state.injections.fetch_add(1, Ordering::SeqCst);
                                serde_json::json!({})
                            }
                            Some("Page.addScriptToEvaluateOnNewDocument") => {
                                serde_json::json!({"identifier": command["id"].to_string()})
                            }
                            Some("Runtime.evaluate") => {
                                let value = if health {
                                    serde_json::json!(if state.healthy.load(Ordering::SeqCst) {
                                        "healthy"
                                    } else {
                                        "unhealthy"
                                    })
                                } else if expression
                                    .starts_with("typeof window.__codeySettingsOverlay")
                                {
                                    serde_json::json!(true)
                                } else {
                                    serde_json::json!(
                                        serde_json::json!({"ready": true}).to_string()
                                    )
                                };
                                serde_json::json!({"result": {"value": value}})
                            }
                            _ => serde_json::json!({}),
                        };
                        if socket
                            .send(Message::Text(
                                serde_json::json!({
                                    "id": command["id"], "result": result,
                                })
                                .to_string()
                                .into(),
                            ))
                            .await
                            .is_err()
                        {
                            break;
                        }
                        if health {
                            let _ = socket.next().await;
                            state.health_checks.fetch_add(1, Ordering::SeqCst);
                            break;
                        }
                    }
                    if bridge {
                        state.active_bridges.fetch_sub(1, Ordering::SeqCst);
                    }
                });
                while connections.try_join_next().is_some() {}
            }
        });
        Self {
            port,
            state,
            tasks: vec![http_task, websocket_task],
        }
    }

    async fn watchdog(&self) -> InjectionWatchdog {
        let scripts = cdp::prepare_injection_scripts(false, false, false, &[]);
        let handler = cdp::bridge_handler(|_, _| async { serde_json::Value::Null });
        let target = cdp::retry_inject_with_scripts(
            self.port,
            handler.clone(),
            &scripts,
            cdp::InjectionRetrySource::Startup,
        )
        .await
        .expect("initial mock renderer injection");
        let discoveries = self.state.discoveries.load(Ordering::SeqCst);
        let watchdog = spawn_injection_watchdog(target, self.port, handler, scripts);
        wait_until(|| self.state.discoveries.load(Ordering::SeqCst) > discoveries).await;
        watchdog
    }
}

// Keep Tokio runnable so socket/log IO cannot automatically advance paused time.
struct ManualClock(tokio::task::JoinHandle<()>);

impl ManualClock {
    fn pause() -> Self {
        tokio::time::pause();
        Self(tokio::spawn(async {
            loop {
                tokio::task::yield_now().await;
            }
        }))
    }
}

impl Drop for ManualClock {
    fn drop(&mut self) {
        self.0.abort();
    }
}

async fn wait_until(mut condition: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while !condition() {
        assert!(
            Instant::now() < deadline,
            "mock CDP operation did not settle"
        );
        tokio::task::yield_now().await;
    }
}

async fn tick_health(mock: &MockCdp, interval: Duration) {
    let previous = mock.state.health_checks.load(Ordering::SeqCst);
    let discoveries = mock.state.discoveries.load(Ordering::SeqCst);
    tokio::time::advance(interval + Duration::from_millis(1)).await;
    wait_until(|| mock.state.health_checks.load(Ordering::SeqCst) > previous).await;
    wait_until(|| mock.state.discoveries.load(Ordering::SeqCst) > discoveries).await;
}

async fn stop_watchdog(mock: &MockCdp, watchdog: InjectionWatchdog) {
    let started = tokio::time::Instant::now();
    watchdog.shutdown.send(()).expect("watchdog still running");
    wait_until(|| watchdog.task.is_finished()).await;
    watchdog.task.await.unwrap();
    wait_until(|| mock.state.active_bridges.load(Ordering::SeqCst) == 0).await;
    assert_eq!(
        tokio::time::Instant::now(),
        started,
        "shutdown waited for a timer"
    );
}

#[tokio::test]
async fn cdp_watchdog_rebuilds_a_closed_pump_without_waiting_for_the_interval() {
    let mock = MockCdp::start().await;
    let watchdog = mock.watchdog().await;
    let _clock = ManualClock::pause();
    let before = tokio::time::Instant::now();
    mock.state.close_bridges.notify_waiters();
    wait_until(|| mock.state.injections.load(Ordering::SeqCst) == 2).await;
    assert_eq!(mock.state.health_checks.load(Ordering::SeqCst), 0);
    assert_eq!(tokio::time::Instant::now(), before);
    stop_watchdog(&mock, watchdog).await;
}

#[tokio::test]
async fn cdp_watchdog_pump_closure_interrupts_auxiliary_refresh() {
    let mock = MockCdp::start().await;
    let watchdog = mock.watchdog().await;
    let _clock = ManualClock::pause();
    mock.state.hang_next_discovery.store(true, Ordering::SeqCst);
    tick_health(&mock, CDP_WATCHDOG_INTERVAL).await;
    wait_until(|| mock.state.stalled_discoveries.load(Ordering::SeqCst) == 1).await;
    let before = tokio::time::Instant::now();
    mock.state.close_bridges.notify_waiters();
    wait_until(|| mock.state.injections.load(Ordering::SeqCst) == 2).await;
    assert_eq!(tokio::time::Instant::now(), before);
    stop_watchdog(&mock, watchdog).await;
}

#[tokio::test]
async fn cdp_watchdog_confirms_unhealthy_after_five_seconds() {
    let mock = MockCdp::start().await;
    let watchdog = mock.watchdog().await;
    let _clock = ManualClock::pause();
    mock.state.healthy.store(false, Ordering::SeqCst);
    tick_health(&mock, CDP_WATCHDOG_INTERVAL).await;
    assert_eq!(mock.state.injections.load(Ordering::SeqCst), 1);
    tick_health(&mock, CDP_WATCHDOG_UNHEALTHY_CONFIRM_INTERVAL).await;
    wait_until(|| mock.state.injections.load(Ordering::SeqCst) == 2).await;
    stop_watchdog(&mock, watchdog).await;
}

#[tokio::test]
async fn cdp_watchdog_failed_closed_pump_recovery_keeps_retry_interval() {
    let mock = MockCdp::start().await;
    let watchdog = mock.watchdog().await;
    let _clock = ManualClock::pause();
    let previous = watchdog.statuses.read().await.clone();
    mock.state
        .discovery_available
        .store(false, Ordering::SeqCst);
    mock.state.close_bridges.notify_waiters();
    let discoveries = mock.state.discoveries.load(Ordering::SeqCst);
    wait_until(|| mock.state.discoveries.load(Ordering::SeqCst) > discoveries).await;
    let recovery_discoveries = mock.state.discoveries.load(Ordering::SeqCst);
    // Watchdog injection has a 30-second deadline, distinct from its retry wait.
    tokio::time::advance(Duration::from_secs(31)).await;
    wait_until(|| {
        watchdog
            .statuses
            .try_read()
            .is_ok_and(|current| !Arc::ptr_eq(&current, &previous))
    })
    .await;
    // The next auxiliary refresh starts after failure logging and the timer reset.
    wait_until(|| mock.state.discoveries.load(Ordering::SeqCst) > recovery_discoveries).await;
    let discoveries = mock.state.discoveries.load(Ordering::SeqCst);
    tokio::time::advance(Duration::from_secs(29)).await;
    for _ in 0..1000 {
        tokio::task::yield_now().await;
    }
    assert_eq!(mock.state.discoveries.load(Ordering::SeqCst), discoveries);
    tokio::time::advance(Duration::from_secs(1) + Duration::from_millis(1)).await;
    wait_until(|| mock.state.discoveries.load(Ordering::SeqCst) > discoveries).await;
    stop_watchdog(&mock, watchdog).await;
}

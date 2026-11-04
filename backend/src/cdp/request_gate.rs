use std::{sync::Arc, time::Duration};

use codey_runtime_core::bridge::evaluate_script_with_await_promise_timeout;
use serde::Deserialize;

use crate::error_log;

// 一次 evaluate 绑定原页面、补丁与桥接，重新注入后旧轮询不能发布状态。
const VERIFY_SCRIPT: &str = r#"(async () => {
  const patch = window.__codeyModelWhitelistPatch;
  const bridge = window.__codexSessionDeleteBridge;
  const current = () => !!patch && window.__codeyModelWhitelistPatch === patch
    && typeof bridge === "function" && window.__codexSessionDeleteBridge === bridge
    && typeof patch.ensureRequestGate === "function";
  let polls = 0;
  const verdict = (ready, abandoned, reason) => JSON.stringify({ ready, abandoned, reason, polls });
  let reason = "notReady";
  for (; polls < __ATTEMPTS__;) {
    if (!current()) return verdict(false, true, "patchLost");
    polls += 1;
    let timer;
    const timeout = Symbol("timeout");
    let result;
    try {
      result = await Promise.race([
        Promise.resolve().then(() => patch.ensureRequestGate()).then(
          ready => ({ ready }), error => ({ error }),
        ),
        new Promise(resolve => { timer = setTimeout(() => resolve(timeout), __CALL_MS__); }),
      ]);
    } finally { clearTimeout(timer); }
    if (!current() || result?.error?.message === "模型请求校验已重新加载") {
      return verdict(false, true, "patchLost");
    }
    if (result !== timeout && result.ready === true && patch.requestGateReady?.() === true) {
      return verdict(true, false, "ready");
    }
    reason = result === timeout ? "probeTimeout" : result.error ? "exception" : "notReady";
    if (polls < __ATTEMPTS__) await new Promise(resolve => setTimeout(resolve, __DELAY_MS__));
  }
  if (!current()) return verdict(false, true, "patchLost");
  try { patch.notifyRequestGateUnavailable?.(); } catch {}
  return verdict(false, false, reason);
})()"#;

fn verify_script(attempts: u32, call_ms: u64, delay_ms: u64) -> String {
    VERIFY_SCRIPT
        .replace("__ATTEMPTS__", &attempts.to_string())
        .replace("__CALL_MS__", &call_ms.to_string())
        .replace("__DELAY_MS__", &delay_ms.to_string())
}

#[derive(Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
enum Reason {
    Ready,
    NotReady,
    ProbeTimeout,
    Exception,
    PatchLost,
}

impl Reason {
    fn message(&self) -> &'static str {
        match self {
            Self::Ready => "模型请求校验已就绪",
            Self::NotReady => "模型请求入口尚未就绪",
            Self::ProbeTimeout => "模型请求校验探测超时",
            Self::Exception => "模型请求校验失败",
            Self::PatchLost => "模型请求补丁或桥接已移除或替换",
        }
    }
}

#[derive(Debug, Deserialize)]
struct Verdict {
    ready: bool,
    abandoned: bool,
    reason: Reason,
    polls: u32,
}

async fn verify(
    websocket_url: &str,
    script: &str,
    timeout: Duration,
) -> Result<Verdict, &'static str> {
    let response = tokio::time::timeout(
        timeout,
        evaluate_script_with_await_promise_timeout(websocket_url, script, true, timeout),
    )
    .await
    .map_err(|_| "模型请求校验的 CDP 响应超时")?
    .map_err(|_| "模型请求校验的 CDP 连接或页面上下文已失效")?;
    let payload = super::runtime_value(&response)
        .and_then(serde_json::Value::as_str)
        .ok_or("模型请求校验响应不可解析")?;
    serde_json::from_str(payload).map_err(|_| "模型请求校验结果不可解析")
}

pub(super) struct Task(tokio::task::JoinHandle<()>);

impl Task {
    pub(super) fn abort(&self) {
        self.0.abort();
    }
}

impl Drop for Task {
    fn drop(&mut self) {
        self.abort();
    }
}

pub(super) fn spawn(target_id: String, websocket_url: Arc<str>) -> Task {
    Task(tokio::spawn(async move {
        let result = verify(
            &websocket_url,
            &verify_script(12, 2_000, 500),
            Duration::from_secs(35),
        )
        .await;
        let (message, polls) = match result {
            Ok(verdict) if verdict.abandoned => return,
            Ok(verdict) if verdict.ready => {
                let _ = codey_runtime_core::diagnostic_log::append_diagnostic_log(
                    "cdp.request_gate_ready",
                    serde_json::json!({ "targetId": target_id, "polls": verdict.polls }),
                );
                return;
            }
            Ok(verdict) => (verdict.reason.message(), Some(verdict.polls)),
            Err(message) => (message, None),
        };
        // 页面异常可包含用户输入；仅记录固定分类，不回传原始异常内容。
        error_log::record_failure_with_metadata_async(
            "request_gate_degraded",
            "verify_model_request_gate",
            message.to_string(),
            error_log::FailureMetadata {
                stage: Some("runtime.model_request_gate".to_string()),
                recoverable: Some(true),
            },
            serde_json::json!({ "targetId": target_id, "polls": polls }),
        )
        .await;
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_gate_retries_without_blocking_or_notifying_replaced_patches() {
        let harness = r#"
const assert = require('node:assert/strict');
const vm = require('node:vm');
const script = JSON.parse(process.argv[1]);
const bridgeScript = JSON.parse(process.argv[2]);
const run = async (ensure, change) => {
  let calls = 0, notices = 0, timers = 0;
  const pending = new Set();
  const context = vm.createContext({ window: { __codexSessionDeleteBridge() {} },
    setTimeout(fn, ms) { const timer = setTimeout(() => { pending.delete(timer); fn(); }, ms); pending.add(timer); timers++; return timer; },
    clearTimeout(timer) { clearTimeout(timer); pending.delete(timer); },
  });
  const patch = ensure == null ? ensure : {
    ensureRequestGate: () => ensure(++calls, context),
    requestGateReady: () => true,
    notifyRequestGateUnavailable() { notices++; },
  };
  context.window.__codeyModelWhitelistPatch = patch;
  const operation = vm.runInContext(script, context);
  change?.(context, patch);
  const result = JSON.parse(await operation);
  assert.equal(pending.size, 0, 'all race and retry timers are cleared');
  return { ...result, calls, notices, timers };
};
(async () => {
  const bridgeContext = vm.createContext({ window: {} });
  vm.runInContext(bridgeScript, bridgeContext);
  const previousBridge = bridgeContext.window.__codexSessionDeleteBridge;
  vm.runInContext(bridgeScript, bridgeContext);
  assert.notEqual(bridgeContext.window.__codexSessionDeleteBridge, previousBridge,
    'the native install script replaces the bridge function on every installation');
  const ready = await run(() => true);
  assert.equal(ready.ready, true); assert.equal(ready.calls, 1); assert.equal(ready.notices, 0);
  const later = await run(count => count >= 2);
  assert.equal(later.ready, true); assert.equal(later.calls, 2); assert.equal(later.notices, 0);
  for (const ensure of [() => false, () => Promise.reject(new Error('private fixture error')), () => new Promise(() => {})]) {
    const failed = await run(ensure);
    assert.equal(failed.ready, false); assert.equal(failed.abandoned, false);
    assert.equal(failed.calls, 3); assert.equal(failed.notices, 1);
    assert.ok(!JSON.stringify(failed).includes('private'));
  }
  for (const patch of [null, undefined]) {
    const missing = await run(patch);
    assert.equal(missing.abandoned, true); assert.equal(missing.calls, 0);
  }
  for (const ensure of [() => true, () => Promise.reject(new Error('disposed')), () => new Promise(() => {})]) {
    const replaced = await run(ensure, context => { context.window.__codeyModelWhitelistPatch = {}; });
    assert.equal(replaced.abandoned, true); assert.equal(replaced.notices, 0);
    assert.equal(replaced.calls, 1);
  }
  for (const ensure of [() => true, () => false, () => new Promise(() => {})]) {
    const reinstalled = await run(ensure, context => { context.window.__codexSessionDeleteBridge = () => {}; });
    assert.equal(reinstalled.abandoned, true); assert.equal(reinstalled.ready, false);
    assert.equal(reinstalled.notices, 0); assert.equal(reinstalled.calls, 1);
  }
  const disposed = await run(() => Promise.reject(new Error('模型请求校验已重新加载')));
  assert.equal(disposed.abandoned, true); assert.equal(disposed.calls, 1); assert.equal(disposed.notices, 0);
  for (const change of [patch => { patch.requestGateReady = () => false; }, patch => { delete patch.requestGateReady; }]) {
    const unconfirmed = await run(() => true, (_context, patch) => change(patch));
    assert.equal(unconfirmed.ready, false); assert.equal(unconfirmed.calls, 3); assert.equal(unconfirmed.notices, 1);
  }
  const vanished = await run((_count, context) => { delete context.window.__codeyModelWhitelistPatch; return true; });
  assert.equal(vanished.abandoned, true); assert.equal(vanished.notices, 0);
})().catch(error => { console.error(error); process.exit(1); });
"#;
        let output = std::process::Command::new("node")
            .args([
                "-e",
                harness,
                &serde_json::to_string(&verify_script(3, 10, 1)).unwrap(),
                &serde_json::to_string(&codey_runtime_core::bridge::build_bridge_script(
                    codey_runtime_core::bridge::BRIDGE_BINDING_NAME,
                ))
                .unwrap(),
            ])
            .output()
            .expect("Node should run the background request-gate harness");
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    #[tokio::test]
    async fn request_gate_transport_is_bounded_and_never_replays_after_context_loss() {
        use futures_util::{SinkExt, StreamExt};
        use serde_json::json;
        use tokio_tungstenite::tungstenite::Message;

        for mode in [
            "ready",
            "degraded",
            "gone",
            "invalid",
            "hanging",
            "handshake",
        ] {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let server = tokio::spawn(async move {
                let (stream, _) = listener.accept().await.unwrap();
                if mode == "handshake" {
                    let _stream = stream;
                    std::future::pending::<()>().await;
                    return;
                }
                let mut socket = tokio_tungstenite::accept_async(stream).await.unwrap();
                while let Some(Ok(message)) = socket.next().await {
                    let Ok(text) = message.to_text() else {
                        continue;
                    };
                    let request: serde_json::Value = serde_json::from_str(text).unwrap();
                    let evaluate = request["method"] == "Runtime.evaluate";
                    if evaluate && mode == "gone" {
                        socket.close(None).await.unwrap();
                        return;
                    }
                    if evaluate && mode == "hanging" {
                        std::future::pending::<()>().await;
                    }
                    let result = if evaluate {
                        let value = if mode == "invalid" {
                            json!("private invalid response")
                        } else {
                            json!(json!({ "ready": mode == "ready", "abandoned": false,
                                "reason": if mode == "ready" { "ready" } else { "notReady" }, "polls": 3 }).to_string())
                        };
                        json!({"result":{"value":value}})
                    } else {
                        json!({})
                    };
                    socket
                        .send(Message::Text(
                            json!({"id":request["id"],"result":result})
                                .to_string()
                                .into(),
                        ))
                        .await
                        .unwrap();
                    if evaluate {
                        return;
                    }
                }
            });
            let result = verify(
                &format!("ws://{address}"),
                &verify_script(3, 10, 1),
                Duration::from_millis(300),
            )
            .await;
            if matches!(mode, "ready" | "degraded") {
                assert_eq!(result.unwrap().ready, mode == "ready");
            } else {
                assert!(result.is_err(), "{mode}");
                assert!(!format!("{result:?}").contains("private"));
            }
            server.abort();
        }
    }

    #[tokio::test]
    async fn request_gate_unavailable_does_not_block_overlay_but_overlay_failure_still_retries() {
        use futures_util::{SinkExt, StreamExt};
        use serde_json::json;
        use tokio_tungstenite::tungstenite::Message;

        use super::super::{
            AttemptOutcome, EstablishedInjection, InjectionPhase, bridge_handler,
            prepare_injection_scripts, run_injection_attempt,
        };

        for overlay_ready in [true, false] {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let gate_started = Arc::new(tokio::sync::Notify::new());
            let server_gate_started = gate_started.clone();
            let server = tokio::spawn(async move {
                let mut connections = tokio::task::JoinSet::new();
                loop {
                    let (stream, _) = listener.accept().await.unwrap();
                    let gate_started = server_gate_started.clone();
                    connections.spawn(async move {
                        let mut socket = tokio_tungstenite::accept_async(stream).await.unwrap();
                        while let Some(Ok(message)) = socket.next().await {
                            let Ok(text) = message.to_text() else {
                                continue;
                            };
                            let request: serde_json::Value = serde_json::from_str(text).unwrap();
                            let expression = request["params"]["expression"].as_str().unwrap_or("");
                            let result = if expression.contains("const current =") {
                                gate_started.notify_one();
                                // A hanging model probe must not hold startup or close the bridge.
                                std::future::pending::<()>().await;
                                return;
                            } else if expression.starts_with("typeof window.__codeySettingsOverlay")
                            {
                                json!({"result":{"value":overlay_ready}})
                            } else if expression.starts_with("String(window.__codeyOverlayError") {
                                json!({"result":{"value":"fixture overlay failure"}})
                            } else if request["method"] == "Page.addScriptToEvaluateOnNewDocument" {
                                json!({"identifier":"test"})
                            } else {
                                json!({})
                            };
                            if socket
                                .send(Message::Text(
                                    json!({"id":request["id"],"result":result})
                                        .to_string()
                                        .into(),
                                ))
                                .await
                                .is_err()
                            {
                                break;
                            }
                        }
                    });
                    while connections.try_join_next().is_some() {}
                }
            });
            let websocket_url: Arc<str> = Arc::from(format!("ws://{address}"));
            let handler = bridge_handler(|_, _| async { json!(null) });
            let pump = codey_runtime_core::bridge::install_bridge(
                &websocket_url,
                codey_runtime_core::bridge::BRIDGE_BINDING_NAME,
                handler.clone(),
                &[],
            )
            .await
            .unwrap();
            let bridge = EstablishedInjection {
                target_id: "test".into(),
                websocket_url,
                pump,
            };
            let result = tokio::time::timeout(
                Duration::from_secs(1),
                run_injection_attempt(
                    Some(bridge),
                    0,
                    handler,
                    &prepare_injection_scripts(false, false, false, &[]),
                    &std::sync::atomic::AtomicU8::new(InjectionPhase::InstallBridge as u8),
                ),
            )
            .await
            .expect("startup must not wait for the model probe");
            match result {
                AttemptOutcome::Injected(target) if overlay_ready => {
                    tokio::time::timeout(Duration::from_secs(1), gate_started.notified())
                        .await
                        .unwrap();
                    assert!(!target.pump_finished());
                    target.close().await;
                }
                AttemptOutcome::Retry { retained: None, .. } if !overlay_ready => {}
                _ => panic!("unexpected startup outcome for overlay_ready={overlay_ready}"),
            }
            server.abort();
        }
    }
}

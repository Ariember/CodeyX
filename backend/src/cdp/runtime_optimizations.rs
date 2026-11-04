use super::PreparedInjectionScripts;
use codey_runtime_core::{
    bridge::evaluate_script_with_await_promise_timeout,
    cdp::{CdpTarget, list_targets},
};
use std::time::Duration;

fn auxiliary_renderer<'a>(target: &'a CdpTarget, primary: &str) -> Option<&'a str> {
    if target.target_type != "page" {
        return None;
    }
    let path = target.url.split(['?', '#']).next()?;
    if !matches!(path, "app://-/index.html" | "app://-/detached-window.html") {
        return None;
    }
    target
        .web_socket_debugger_url
        .as_deref()
        .filter(|url| *url != primary)
}

/// Detached chats have their own tracker and JavaScript context. Reuse the
/// existing watchdog cadence; no second bridge, UI, or high-frequency poll.
pub(crate) async fn refresh_auxiliary_renderers(
    debug_port: u16,
    primary: &str,
    scripts: &PreparedInjectionScripts,
) {
    // Optional optimization must never hold up bridge recovery or shutdown.
    let _ = tokio::time::timeout(Duration::from_secs(3), async {
        let Ok(targets) = list_targets(debug_port).await else {
            return;
        };
        for websocket in targets
            .iter()
            .filter_map(|target| auxiliary_renderer(target, primary))
            .take(8)
        {
            // Both scripts return immediately when their current installation
            // is already active. A reloaded context installs them afresh.
            let _ = evaluate_script_with_await_promise_timeout(
                websocket,
                &scripts.runtime_optimizations,
                false,
                Duration::from_secs(1),
            )
            .await;
        }
    })
    .await;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn selects_only_auxiliary_native_codex_pages() {
        let target = |kind: &str, url: &str, websocket: Option<&str>| CdpTarget {
            id: "test".into(),
            title: "".into(),
            target_type: kind.into(),
            url: url.into(),
            web_socket_debugger_url: websocket.map(str::to_string),
        };
        for url in [
            "app://-/index.html",
            "app://-/index.html?initialRoute=%2Favatar-overlay",
            "app://-/detached-window.html#chat",
        ] {
            assert!(
                auxiliary_renderer(&target("page", url, Some("ws://aux")), "ws://main").is_some()
            );
            assert!(
                auxiliary_renderer(&target("page", url, Some("ws://main")), "ws://main").is_none()
            );
            assert!(
                auxiliary_renderer(&target("iframe", url, Some("ws://aux")), "ws://main").is_none()
            );
            assert!(auxiliary_renderer(&target("page", url, None), "ws://main").is_none());
        }
        for url in [
            "https://example.test/index.html",
            "app://other/index.html",
            "app://-/settings.html",
            "app://-/index.html/other",
            "codex-sandbox://frame/index.html",
        ] {
            assert!(
                auxiliary_renderer(&target("page", url, Some("ws://aux")), "ws://main").is_none()
            );
        }
    }

    #[tokio::test]
    async fn auxiliary_injection_contains_only_runtime_optimization_and_its_adapter() {
        use futures_util::{SinkExt, StreamExt};
        use serde_json::json;
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        use tokio_tungstenite::tungstenite::Message;

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = [0; 4096];
            assert_ne!(stream.read(&mut request).await.unwrap(), 0);
            let body = json!([
                {"id":"main","type":"page","title":"","url":"app://-/index.html","webSocketDebuggerUrl":"ws://main"},
                {"id":"sandbox","type":"webview","title":"","url":"https://example.test/","webSocketDebuggerUrl":"ws://skip"},
                {"id":"chat","type":"page","title":"","url":"app://-/detached-window.html","webSocketDebuggerUrl":format!("ws://{address}")}
            ]).to_string();
            stream
                .write_all(
                    format!(
                        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    )
                    .as_bytes(),
                )
                .await
                .unwrap();
            drop(stream);
            let (stream, _) = listener.accept().await.unwrap();
            let mut socket = tokio_tungstenite::accept_async(stream).await.unwrap();
            while let Some(Ok(message)) = socket.next().await {
                let request: serde_json::Value =
                    serde_json::from_str(message.to_text().unwrap()).unwrap();
                let evaluate = request["method"] == "Runtime.evaluate";
                if evaluate {
                    let expression = request["params"]["expression"].as_str().unwrap();
                    assert!(expression.contains("__codeyRuntimeOptimizations"));
                    assert!(expression.contains("discoverAppAssetUrls"));
                    assert!(!expression.contains("__CODEY_SLIM_PET__"));
                    // The lazy adapter may reference the gate without installing its hooks or UI.
                    assert!(!expression.contains("__codeyCreateModelRequestGate"));
                    assert!(!expression.contains("codey-provider-mismatch-notice"));
                    assert!(!expression.contains("__codeySettingsOverlay"));
                    assert_eq!(request["params"]["awaitPromise"], false);
                }
                socket
                    .send(Message::Text(
                        json!({"id":request["id"],"result":{"result":{"type":"undefined"}}})
                            .to_string()
                            .into(),
                    ))
                    .await
                    .unwrap();
                if evaluate {
                    return;
                }
            }
            panic!("native auxiliary renderer must receive the optimization");
        });
        let scripts = super::super::prepare_injection_scripts(false, true, false, &[]);
        refresh_auxiliary_renderers(address.port(), "ws://main", &scripts).await;
        tokio::time::timeout(Duration::from_secs(1), server)
            .await
            .unwrap()
            .unwrap();
    }
}

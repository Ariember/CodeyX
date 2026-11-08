use anyhow::{Context, bail};
use futures_util::{StreamExt, stream::FuturesUnordered};
use serde::Deserialize;
use std::sync::OnceLock;
use std::time::Duration;

const CDP_HTTP_TIMEOUT: Duration = Duration::from_secs(3);
static CDP_HTTP_CLIENT: OnceLock<reqwest::Client> = OnceLock::new();

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
pub struct CdpTarget {
    pub id: String,
    #[serde(rename = "type")]
    pub target_type: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub url: String,
    #[serde(default, rename = "webSocketDebuggerUrl")]
    pub web_socket_debugger_url: Option<String>,
}

pub async fn list_targets(debug_port: u16) -> anyhow::Result<Vec<CdpTarget>> {
    let client = cdp_http_client()?;
    // Chrome 150+ rejects DevTools HTTP when the Host header is an IP literal
    // and answers the same listener for `localhost`. Older builds and an
    // IPv6-only socket still need the explicit loopback URLs. Probe together
    // so an unresponsive address cannot delay a working one during startup.
    let urls = [
        format!("http://localhost:{debug_port}/json"),
        format!("http://127.0.0.1:{debug_port}/json"),
        format!("http://[::1]:{debug_port}/json"),
    ];
    query_targets_urls(client, &urls).await
}

async fn query_targets_urls(
    client: &reqwest::Client,
    urls: &[String],
) -> anyhow::Result<Vec<CdpTarget>> {
    let mut probes = FuturesUnordered::new();
    for url in urls {
        probes.push(async move { (url, query_targets_url(client, url).await) });
    }
    let mut errors = Vec::new();
    while let Some((url, result)) = probes.next().await {
        match result {
            Ok(targets) => return Ok(targets),
            Err(error) => errors.push(format!("{url}: {error:#}")),
        }
    }

    bail!(
        "failed to query CDP targets on loopback addresses: {}",
        errors.join("; ")
    )
}

fn cdp_http_client() -> anyhow::Result<&'static reqwest::Client> {
    if let Some(client) = CDP_HTTP_CLIENT.get() {
        return Ok(client);
    }
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(CDP_HTTP_TIMEOUT)
        .build()
        .context("failed to build CDP HTTP client")?;
    let _ = CDP_HTTP_CLIENT.set(client);
    Ok(CDP_HTTP_CLIENT
        .get()
        .expect("CDP HTTP client must be initialized"))
}

async fn query_targets_url(client: &reqwest::Client, url: &str) -> anyhow::Result<Vec<CdpTarget>> {
    let response = client
        .get(url)
        .send()
        .await
        .context("failed to query CDP targets")?
        .error_for_status()
        .context("CDP target query failed")?;

    response
        .json::<Vec<CdpTarget>>()
        .await
        .context("failed to deserialize CDP targets")
}

pub fn pick_injectable_codex_page_target(targets: &[CdpTarget]) -> anyhow::Result<CdpTarget> {
    for target in targets
        .iter()
        .filter(|target| is_injectable_page_target(target))
    {
        if is_primary_codex_page_target(target) {
            return Ok(target.clone());
        }
    }

    bail!("No injectable Codex page target found")
}

pub fn is_injectable_page_target(target: &CdpTarget) -> bool {
    target.target_type == "page"
        && target
            .web_socket_debugger_url
            .as_deref()
            .is_some_and(|url| !url.is_empty())
}

pub fn is_codex_page_target(target: &CdpTarget) -> bool {
    if target.target_type != "page"
        || target
            .url
            .trim()
            .to_ascii_lowercase()
            .starts_with("data:text/html")
    {
        return false;
    }
    let haystack = format!("{} {}", target.title, target.url).to_lowercase();
    haystack.contains("codex")
        || is_chatgpt_desktop_page(&target.title, &target.url)
        || is_packaged_codex_page(&target.url)
}

pub fn is_primary_codex_page_target(target: &CdpTarget) -> bool {
    is_codex_page_target(target) && !is_avatar_overlay_page_target(target)
}

pub fn is_avatar_overlay_page_target(target: &CdpTarget) -> bool {
    if !is_injectable_page_target(target) {
        return false;
    }
    let url = target.url.trim().to_ascii_lowercase();
    url.starts_with("app://-/index.html?")
        && (url.contains("initialroute=%2favatar-overlay")
            || url.contains("initialroute=/avatar-overlay"))
}

fn is_chatgpt_desktop_page(title: &str, url: &str) -> bool {
    let title = title.trim().to_ascii_lowercase();
    let url = url.trim().to_ascii_lowercase();
    title == "chatgpt"
        && (url == "https://chatgpt.com"
            || url.starts_with("https://chatgpt.com/")
            || url == "https://chat.openai.com"
            || url.starts_with("https://chat.openai.com/"))
}

fn is_packaged_codex_page(url: &str) -> bool {
    let url = url.trim().to_ascii_lowercase();
    url == "app://-/index.html"
        || url.starts_with("app://-/index.html?")
        || url.starts_with("app://-/index.html#")
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    const TARGETS_RESPONSE: &str = "HTTP/1.1 200 OK\r\nContent-Length: 31\r\nConnection: close\r\n\r\n[{\"id\":\"page-1\",\"type\":\"page\"}]";

    async fn target_server(response: &'static str) -> (String, tokio::task::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/json", listener.local_addr().unwrap());
        let task = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = [0; 1024];
            assert!(stream.read(&mut request).await.unwrap() > 0);
            stream.write_all(response.as_bytes()).await.unwrap();
        });
        (url, task)
    }

    #[tokio::test]
    async fn target_discovery_does_not_wait_for_a_stalled_loopback_address() {
        let client = reqwest::Client::builder()
            .no_proxy()
            .timeout(CDP_HTTP_TIMEOUT)
            .build()
            .unwrap();
        for stalled_first in [true, false] {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let stalled_url = format!("http://{}/json", listener.local_addr().unwrap());
            let stalled = tokio::spawn(async move {
                let (_stream, _) = listener.accept().await.unwrap();
                std::future::pending::<()>().await;
            });
            let (ready_url, ready) = target_server(TARGETS_RESPONSE).await;
            let urls = if stalled_first {
                [stalled_url, ready_url]
            } else {
                [ready_url, stalled_url]
            };
            let result =
                tokio::time::timeout(Duration::from_secs(2), query_targets_urls(&client, &urls))
                    .await;
            stalled.abort();
            let _ = stalled.await;
            let targets = result
                .expect("a ready endpoint must not wait for another probe")
                .unwrap();
            assert_eq!(targets[0].id, "page-1");
            ready.await.unwrap();
        }
    }

    #[tokio::test]
    async fn target_discovery_keeps_success_after_an_address_rejects_the_request() {
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let (rejected_url, rejected) = target_server(
            "HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
        )
        .await;
        let (ready_url, ready) = target_server(TARGETS_RESPONSE).await;
        let targets = query_targets_urls(&client, &[rejected_url, ready_url])
            .await
            .unwrap();
        assert_eq!(targets[0].id, "page-1");
        rejected.abort();
        let _ = rejected.await;
        ready.await.unwrap();
    }

    #[tokio::test]
    async fn target_discovery_reports_all_failed_addresses() {
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let (invalid_url, invalid) =
            target_server("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}")
                .await;
        let (rejected_url, rejected) = target_server(
            "HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
        )
        .await;
        let error = query_targets_urls(&client, &[invalid_url.clone(), rejected_url.clone()])
            .await
            .unwrap_err()
            .to_string();
        assert!(error.contains(&invalid_url));
        assert!(error.contains(&rejected_url));
        assert!(error.contains("failed to deserialize CDP targets"));
        assert!(error.contains("CDP target query failed"));
        invalid.await.unwrap();
        rejected.await.unwrap();
    }

    #[test]
    fn cdp_http_client_is_reused() {
        let first = cdp_http_client().unwrap();
        let second = cdp_http_client().unwrap();

        assert!(std::ptr::eq(first, second));
    }
}

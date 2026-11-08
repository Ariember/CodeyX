use super::*;

#[derive(Default)]
pub(super) struct UpstreamHttpClients {
    state: Mutex<ClientState>,
}

#[derive(Default)]
struct ClientState {
    generation: u64,
    system: Option<(Arc<SystemProxyMatcher>, reqwest::Client)>,
}

pub(super) struct HttpClientLease {
    pub(super) client: reqwest::Client,
    pub(super) generation: u64,
    pub(super) system_proxy_applies: bool,
}

pub(crate) struct RouterUpstreamClient {
    pub(super) client: reqwest::Client,
    pub(super) generation: u64,
    pub(super) system_proxy_applies: bool,
}

impl std::ops::Deref for RouterUpstreamClient {
    type Target = reqwest::Client;

    fn deref(&self) -> &Self::Target {
        &self.client
    }
}

impl UpstreamHttpClients {
    pub(super) async fn client(
        self: &Arc<Self>,
        url: &str,
    ) -> std::result::Result<HttpClientLease, String> {
        let clients = Arc::clone(self);
        let url = url.to_string();
        // 系统代理和证书读取都可能阻塞；仅配置变化或失效后重建连接池。
        tokio::task::spawn_blocking(move || {
            #[cfg(not(test))]
            let matcher = SystemProxyMatcher::from_system();
            #[cfg(test)]
            let matcher = SystemProxyMatcher::builder().build();
            clients.client_with_matcher(&url, Arc::new(matcher))
        })
        .await
        .map_err(|_| "刷新上游网络客户端任务异常退出".to_string())?
    }

    fn client_with_matcher(
        &self,
        url: &str,
        matcher: Arc<SystemProxyMatcher>,
    ) -> std::result::Result<HttpClientLease, String> {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let uri = url
            .parse::<WebSocketUri>()
            .map_err(|_| "线路的上游地址无效".to_string())?;
        let changed = state
            .system
            .as_ref()
            .is_some_and(|(previous, _)| !same_proxy(previous, &matcher, &uri));
        if state.system.is_none() || changed {
            let snapshot = Arc::clone(&matcher);
            let client = upstream_http_client_builder()
                .no_proxy()
                .proxy(reqwest::Proxy::custom(move |url| {
                    system_proxy_url(&snapshot, url)
                }))
                .build()
                .map_err(|_| "无法创建上游网络客户端".to_string())?;
            if changed {
                state.generation = state.generation.wrapping_add(1);
            }
            state.system = Some((Arc::clone(&matcher), client));
        }
        Ok(HttpClientLease {
            client: state
                .system
                .as_ref()
                .expect("system client was initialized")
                .1
                .clone(),
            generation: state.generation,
            system_proxy_applies: matcher.intercept(&uri).is_some(),
        })
    }

    pub(super) fn invalidate(&self, generation: u64) {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        // 旧请求的失败不能清掉网络切换后已经安装的新客户端。
        if state.generation != generation {
            return;
        }
        state.generation = state.generation.wrapping_add(1);
        state.system = None;
    }
}

fn same_proxy(left: &SystemProxyMatcher, right: &SystemProxyMatcher, uri: &WebSocketUri) -> bool {
    match (left.intercept(uri), right.intercept(uri)) {
        (None, None) => true,
        (Some(left), Some(right)) => {
            left.uri() == right.uri()
                && left.basic_auth() == right.basic_auth()
                && left.raw_auth() == right.raw_auth()
        }
        _ => false,
    }
}

fn system_proxy_url(matcher: &SystemProxyMatcher, url: &reqwest::Url) -> Option<reqwest::Url> {
    let intercept = matcher.intercept(&url.as_str().parse::<WebSocketUri>().ok()?)?;
    let mut proxy = reqwest::Url::parse(&intercept.uri().to_string()).ok()?;
    if let Some((username, password)) = intercept.raw_auth() {
        proxy.set_username(&username.replace('%', "%25")).ok()?;
        proxy
            .set_password(Some(&password.replace('%', "%25")))
            .ok()?;
    } else if let Some(auth) = intercept.basic_auth() {
        let encoded = auth.to_str().ok()?.strip_prefix("Basic ")?;
        let decoded =
            base64::Engine::decode(&base64::engine::general_purpose::STANDARD, encoded).ok()?;
        let decoded = std::str::from_utf8(&decoded).ok()?;
        let (username, password) = decoded.split_once(':')?;
        // URL setters preserve '%' escapes, but the matcher already decoded credentials.
        proxy.set_username(&username.replace('%', "%25")).ok()?;
        proxy
            .set_password(Some(&password.replace('%', "%25")))
            .ok()?;
    }
    Some(proxy)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct Endpoint {
        url: String,
        connections: Arc<AtomicUsize>,
        requests: mpsc::UnboundedReceiver<HttpRequest>,
        task: tokio::task::JoinHandle<()>,
    }

    impl Drop for Endpoint {
        fn drop(&mut self) {
            self.task.abort();
        }
    }

    async fn endpoint(body: &'static str) -> Endpoint {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let connections = Arc::new(AtomicUsize::new(0));
        let accepted = Arc::clone(&connections);
        let (tx, requests) = mpsc::unbounded_channel();
        let task = tokio::spawn(async move {
            let mut tasks = JoinSet::new();
            loop {
                tokio::select! {
                    accepted_socket = listener.accept() => {
                        let (mut socket, _) = accepted_socket.unwrap();
                        accepted.fetch_add(1, Ordering::SeqCst);
                        let tx = tx.clone();
                        tasks.spawn(async move {
                            while let Ok(request) = read_http_request(&mut socket).await {
                                tx.send(request).unwrap();
                                if socket.write_all(format!("HTTP/1.1 200 OK\r\ncontent-length: {}\r\n\r\n{body}", body.len()).as_bytes()).await.is_err() {
                                    break;
                                }
                            }
                        });
                    }
                    _ = tasks.join_next(), if !tasks.is_empty() => {}
                }
            }
        });
        Endpoint {
            url,
            connections,
            requests,
            task,
        }
    }

    fn matcher(proxy: Option<&str>) -> Arc<SystemProxyMatcher> {
        Arc::new(
            SystemProxyMatcher::builder()
                .all(proxy.unwrap_or(""))
                .build(),
        )
    }

    async fn post(lease: &HttpClientLease, url: &str) -> String {
        lease
            .client
            .post(url)
            .body("one request")
            .send()
            .await
            .unwrap()
            .text()
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn system_proxy_changes_replace_connections_and_unchanged_settings_reuse_them() {
        let origin = endpoint("origin").await;
        let first_proxy = endpoint("first proxy").await;
        let second_proxy = endpoint("second proxy").await;
        let clients = UpstreamHttpClients::default();
        let url = format!("{}/v1/responses", origin.url);
        let mut previous_generation = None;
        for (proxy, expected) in [
            (None, "origin"),
            (Some(first_proxy.url.as_str()), "first proxy"),
            (Some(second_proxy.url.as_str()), "second proxy"),
            (None, "origin"),
        ] {
            let first = clients.client_with_matcher(&url, matcher(proxy)).unwrap();
            if let Some(previous) = previous_generation {
                assert_ne!(first.generation, previous);
            }
            assert_eq!(first.system_proxy_applies, proxy.is_some());
            assert_eq!(post(&first, &url).await, expected);
            let second = clients.client_with_matcher(&url, matcher(proxy)).unwrap();
            assert_eq!(first.generation, second.generation);
            assert_eq!(post(&second, &url).await, expected);
            previous_generation = Some(second.generation);
        }
        assert_eq!(origin.connections.load(Ordering::SeqCst), 2);
        assert_eq!(first_proxy.connections.load(Ordering::SeqCst), 1);
        assert_eq!(second_proxy.connections.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn proxy_bypass_and_credentials_are_part_of_the_network_snapshot() {
        let origin = endpoint("origin").await;
        let mut proxy = endpoint("proxy").await;
        let clients = UpstreamHttpClients::default();
        let first = clients
            .client_with_matcher(&origin.url, matcher(Some(&proxy.url)))
            .unwrap();
        assert_eq!(post(&first, &origin.url).await, "proxy");
        let bypass = Arc::new(
            SystemProxyMatcher::builder()
                .all(proxy.url.as_str())
                .no("127.0.0.1")
                .build(),
        );
        let direct = clients.client_with_matcher(&origin.url, bypass).unwrap();
        assert!(!direct.system_proxy_applies);
        assert_ne!(direct.generation, first.generation);
        assert_eq!(post(&direct, &origin.url).await, "origin");
        proxy.requests.recv().await.unwrap();
        let mut previous_generation = direct.generation;
        for password in ["first", "second"] {
            let mut authenticated = reqwest::Url::parse(&proxy.url).unwrap();
            authenticated.set_username("test-user").unwrap();
            authenticated.set_password(Some(password)).unwrap();
            let lease = clients
                .client_with_matcher(&origin.url, matcher(Some(authenticated.as_str())))
                .unwrap();
            assert_ne!(lease.generation, previous_generation);
            assert_eq!(post(&lease, &origin.url).await, "proxy");
            let request = proxy.requests.recv().await.unwrap();
            let expected = format!(
                "Basic {}",
                base64::Engine::encode(
                    &base64::engine::general_purpose::STANDARD,
                    format!("test-user:{password}")
                )
            );
            assert_eq!(
                incoming_header(&request, "proxy-authorization"),
                Some(expected.as_str())
            );
            previous_generation = lease.generation;
        }
    }

    #[tokio::test]
    async fn invalidation_replaces_system_proxy_pool_and_ignores_old_failures() {
        let proxy = endpoint("proxy").await;
        let clients = UpstreamHttpClients::default();
        let url = "http://unused.invalid/v1/responses";
        let first = clients
            .client_with_matcher(url, matcher(Some(&proxy.url)))
            .unwrap();
        assert_eq!(post(&first, url).await, "proxy");
        clients.invalidate(first.generation);
        let fresh = clients
            .client_with_matcher(url, matcher(Some(&proxy.url)))
            .unwrap();
        assert_ne!(fresh.generation, first.generation);
        assert_eq!(post(&fresh, url).await, "proxy");
        clients.invalidate(first.generation);
        let reused = clients
            .client_with_matcher(url, matcher(Some(&proxy.url)))
            .unwrap();
        assert_eq!(fresh.generation, reused.generation);
        assert_eq!(post(&reused, url).await, "proxy");
        assert_eq!(proxy.connections.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn proxy_credentials_keep_literal_percent_escapes_for_http_and_socks() {
        let destination = reqwest::Url::parse("https://example.invalid/v1/responses").unwrap();
        let uri = destination.as_str().parse::<WebSocketUri>().unwrap();
        for scheme in ["http", "https", "socks4", "socks4a", "socks5", "socks5h"] {
            let configured = format!("{scheme}://user%2540:p%252F%40ss@127.0.0.1:1080");
            let original = matcher(Some(&configured));
            let restored = system_proxy_url(&original, &destination).unwrap();
            let restored = matcher(Some(restored.as_str()));
            assert!(same_proxy(&original, &restored, &uri), "{scheme}");
        }
    }
}

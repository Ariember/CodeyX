use std::{future::Future, time::Duration};

use anyhow::{Context, Result};

#[cfg(windows)]
pub(super) async fn prepare(process_id: Option<u32>, websocket_url: &str) -> Result<()> {
    let process_id = process_id.context("managed Codex process ID is unavailable")?;
    wait_for_native_exit(
        || codey_runtime_core::windows_process_is_running(process_id),
        crate::cdp::request_native_quit(websocket_url),
        Duration::from_secs(10),
    )
    .await
}

async fn wait_for_native_exit(
    mut is_running: impl FnMut() -> Result<bool>,
    request_quit: impl Future<Output = Result<()>>,
    timeout: Duration,
) -> Result<()> {
    tokio::time::timeout(timeout, async {
        if !is_running()? {
            return Ok(());
        }
        // IPC can disconnect during quit; only process exit authorizes cleanup.
        let _ = request_quit.await;
        while is_running()? {
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        Ok(())
    })
    .await
    .context("timed out waiting for native Codex exit")?
}

#[cfg(test)]
mod tests {
    use std::sync::{
        Arc,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    };

    use super::*;

    #[tokio::test(start_paused = true)]
    async fn restart_waits_for_pending_preferences_to_be_saved() {
        let home = tempfile::tempdir().unwrap();
        let path = home.path().join("config.toml");
        std::fs::write(&path, "[desktop]\ntheme = \"light\"\n").unwrap();
        let running = Arc::new(AtomicBool::new(true));
        let exiting = Arc::clone(&running);
        let saved_path = path.clone();
        wait_for_native_exit(
            || Ok(running.load(Ordering::Acquire)),
            async move {
                tokio::spawn(async move {
                    // Longer than the old restart's fixed 250 ms delay.
                    tokio::time::sleep(Duration::from_millis(600)).await;
                    std::fs::write(saved_path, "[desktop]\ntheme = \"dark\"\n").unwrap();
                    exiting.store(false, Ordering::Release);
                });
                Ok(())
            },
            Duration::from_secs(2),
        )
        .await
        .unwrap();
        assert!(std::fs::read_to_string(path).unwrap().contains("\"dark\""));
    }

    #[tokio::test(start_paused = true)]
    async fn acknowledgement_without_exit_cannot_authorize_cleanup() {
        let running = AtomicBool::new(true);
        let result = wait_for_native_exit(
            || Ok(running.load(Ordering::Acquire)),
            async { Ok(()) },
            Duration::from_secs(1),
        )
        .await;
        assert!(result.is_err());
        assert!(running.load(Ordering::Acquire));
    }

    #[tokio::test(start_paused = true)]
    async fn a_lost_quit_acknowledgement_is_not_replayed() {
        let running = AtomicBool::new(true);
        let requests = AtomicUsize::new(0);
        wait_for_native_exit(
            || Ok(running.load(Ordering::Acquire)),
            async {
                requests.fetch_add(1, Ordering::Relaxed);
                running.store(false, Ordering::Release);
                anyhow::bail!("connection closed during quit")
            },
            Duration::from_secs(1),
        )
        .await
        .unwrap();
        assert_eq!(requests.load(Ordering::Relaxed), 1);
    }

    #[tokio::test(start_paused = true)]
    async fn an_already_exited_process_does_not_receive_a_quit_request() {
        let requested = AtomicBool::new(false);
        wait_for_native_exit(
            || Ok(false),
            async {
                requested.store(true, Ordering::Relaxed);
                Ok(())
            },
            Duration::from_secs(1),
        )
        .await
        .unwrap();
        assert!(!requested.load(Ordering::Relaxed));
    }

    #[tokio::test(start_paused = true)]
    async fn a_hung_quit_request_is_bounded_without_authorizing_cleanup() {
        assert!(
            wait_for_native_exit(|| Ok(true), std::future::pending(), Duration::from_secs(1),)
                .await
                .is_err()
        );
    }

    #[tokio::test(start_paused = true)]
    async fn process_inspection_failure_does_not_request_quit() {
        let requested = AtomicBool::new(false);
        let error = wait_for_native_exit(
            || anyhow::bail!("process inspection failed"),
            async {
                requested.store(true, Ordering::Relaxed);
                Ok(())
            },
            Duration::from_secs(1),
        )
        .await
        .unwrap_err();
        assert!(error.to_string().contains("process inspection failed"));
        assert!(!requested.load(Ordering::Relaxed));
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn unknown_managed_process_is_not_closed() {
        assert!(prepare(None, "ws://127.0.0.1:0/unused").await.is_err());
    }
}

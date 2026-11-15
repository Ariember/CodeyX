use super::*;

impl CodeyRuntime {
    pub(crate) async fn replace_model_delivery_target_for_test(&self, websocket_url: &str) {
        *self.injection_websocket_url.write().await = Arc::from(websocket_url);
    }

    pub(crate) fn for_model_delivery_test(
        config: CodeyConfig,
        websocket_url: &str,
        local_router: Option<LocalRouter>,
    ) -> Self {
        Self {
            codex_app_path: PathBuf::new(),
            maintenance: MaintenanceStatus {
                session_status: String::new(),
                session_files_fixed: 0,
                sqlite_rows_updated: 0,
                ghost_tasks_pruned: 0,
                performance_status: String::new(),
                performance_detail: String::new(),
                startup_injection_mode: String::new(),
            },
            applied_model_config: RwLock::new(AppliedModelConfig::new(config.clone())),
            applied_subagent_config: RwLock::new(Arc::new(RuntimeSubagentConfig::from_config(
                &config,
            ))),
            applied_config: config,
            subagent_route_catalog_installed: true,
            injection_statuses: Arc::new(RwLock::new(Arc::from([]))),
            injection_scripts: cdp::prepare_injection_scripts(false, false, false, &[]),
            injection_websocket_url: Arc::new(RwLock::new(Arc::from(websocket_url))),
            child: Arc::new(Mutex::new(None)),
            process_id: None,
            #[cfg(windows)]
            tracked_process_id: None,
            #[cfg(unix)]
            process_group_id: None,
            #[cfg(target_os = "macos")]
            inspector_argument: None,
            watchdog_shutdown: Mutex::new(None),
            watchdog_task: Mutex::new(None),
            exit_watchdog_shutdown: Mutex::new(None),
            exit_watchdog_task: Mutex::new(None),
            crashpad_guard_enabled: Arc::new(AtomicBool::new(false)),
            crashpad_guard_shutdown: Mutex::new(None),
            crashpad_guard_task: Mutex::new(None),
            local_router,
        }
    }
}

#[cfg(windows)]
#[test]
fn runtime_process_id_follows_the_desktop_handoff() {
    let mut runtime = CodeyRuntime::for_model_delivery_test(CodeyConfig::default(), "", None);
    runtime.process_id = Some(10);
    assert_eq!(runtime.current_process_id(), Some(10));
    let tracked = Arc::new(std::sync::atomic::AtomicU32::new(20));
    runtime.tracked_process_id = Some(Arc::clone(&tracked));
    assert_eq!(runtime.current_process_id(), Some(20));
    tracked.store(30, Ordering::Release);
    assert_eq!(runtime.current_process_id(), Some(30));
}

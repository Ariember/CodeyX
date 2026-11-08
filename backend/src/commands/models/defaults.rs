use super::super::official_accounts::{
    refresh_official_route_after_account_change, write_official_account_route_settings,
};
use super::*;

pub async fn save_default_model(
    state: &Arc<AppState>,
    requested_model: String,
    route_id: Option<String>,
) -> Result<Value, String> {
    let _config_write_guard = state.config_write_lock.lock().await;
    let mut config = state.config.read().await.clone();
    ensure_local_route_config_writable(&config)?;
    let requested_model = requested_model.trim();
    if requested_model.is_empty() {
        return Err("默认模型不能为空".to_string());
    }
    let target_route_id = route_id
        .as_deref()
        .map(str::trim)
        .filter(|route_id| !route_id.is_empty())
        .unwrap_or(config.active_profile_id.as_str());
    let target_profile = config
        .profiles
        .iter()
        .find(|profile| profile.id == target_route_id)
        .cloned()
        .ok_or_else(|| "找不到要设置默认模型的线路".to_string())?;
    if target_profile.official_account && !config.official_route_usable(&target_profile) {
        return Err("本次 Codex 没有可用的官方账号登录态，不能选择官方模型".to_string());
    }
    let target = config
        .model_target_for_route(target_route_id, requested_model)
        .ok_or_else(|| format!("模型 {requested_model} 当前不可用，无法设为默认"))?;
    config.default_model = target.alias;
    // `active_profile_id` remains a compatibility projection for older features.
    // The model default is authoritative and therefore owns that projection.
    config.active_profile_id = target_profile.id;
    config = config.normalize();
    config.settings_revision = config.settings_revision.saturating_add(1);
    let model_state = current_model_state_async(&config).await?;
    let config = save_config_to_store(state, config).await?;
    *state.config.write().await = config.clone();
    let public_config = redacted_config(&config);
    drop(_config_write_guard);
    let hot_reload = hot_reload_runtime_models(state).await;
    let restart_required = runtime_config_requires_restart(state, &config).await;
    Ok(hot_reload.add_to_response(json!({
        "status":"ok",
        "config":public_config,
        "modelState":model_state,
        "restartRequired":restart_required,
    })))
}

// 官方模型允许调整本地上下文预算，思考强度仍沿用官方目录。
pub struct OfficialRouteModelSave {
    pub route_id: String,
    pub models: Vec<String>,
    pub model_contexts: Option<BTreeMap<String, crate::config::ModelContextConfig>>,
    pub enabled: Option<bool>,
    pub show_account_usage: Option<bool>,
    pub base_url: Option<String>,
    pub account_id: Option<String>,
    pub route_name: Option<String>,
    pub route_short_name: Option<String>,
}

pub async fn save_official_route_models(
    state: &Arc<AppState>,
    input: OfficialRouteModelSave,
) -> Result<Value, String> {
    let OfficialRouteModelSave {
        route_id,
        models: requested_models,
        model_contexts: requested_model_contexts,
        enabled: requested_enabled,
        show_account_usage: requested_show_account_usage,
        base_url: requested_base_url,
        account_id,
        route_name,
        route_short_name,
    } = input;
    let normalized_base_url = match requested_base_url.as_deref() {
        Some(base_url) => Some(crate::codex_provider::normalize_official_gateway_base_url(
            base_url,
        )?),
        None => None,
    };
    let mut timings = ModelOperationTimings::new("save_official_route_models");
    validate_requested_model_list_bounds("官方模型", &requested_models)?;
    let _config_write_guard = state.config_write_lock.lock().await;
    timings.mark("validationAndLockMs");
    let previous = state.config.read().await.clone();
    let mut config = previous.clone();
    ensure_local_route_config_writable(&config)?;
    let route_id = route_id.trim();
    let profile_index = config
        .profiles
        .iter()
        .position(|profile| profile.id == route_id)
        .ok_or_else(|| "找不到要更新模型的官方账号线路".to_string())?;
    let profile = &config.profiles[profile_index];
    if !profile.official_account || !config.official_route_usable(profile) {
        return Err("当前线路不是本次登录可用的官方账号线路".to_string());
    }
    let account_id = account_id
        .map(|id| id.trim().to_string())
        .filter(|id| !id.is_empty());
    if account_id
        .as_ref()
        .is_some_and(|id| profile.official_account_id.as_ref() != Some(id))
    {
        return Err("官方账号与要保存的线路不匹配".to_string());
    }
    let provider_id = profile.provider_id().to_string();
    if let Some(enabled) = requested_enabled {
        config.profiles[profile_index].enabled = enabled;
    }
    // 参数缺席表示保持现状；空字符串表示恢复官方默认网关。
    if let Some(base_url) = normalized_base_url.as_ref() {
        config.profiles[profile_index].base_url = base_url.clone().unwrap_or_default();
    }
    if let Some(show_usage) = requested_show_account_usage {
        config.show_account_usage_in_header = show_usage;
    }
    let official_models = config
        .upstream_models_by_provider
        .get(&provider_id)
        .filter(|models| !models.is_empty())
        .cloned()
        .unwrap_or_else(model_catalog::default_official_model_slugs);
    let selected_models = ordered_official_selection(&official_models, &requested_models)?;
    set_model_contexts(
        &mut config,
        &provider_id,
        requested_model_contexts.as_ref(),
        &official_models,
    )?;
    config
        .selected_models_by_provider
        .insert(provider_id, selected_models);
    config = config.normalize();
    config.profiles[profile_index].validate()?;
    let RefreshedModelState {
        refresh: catalog_refresh,
        model_state,
        custom_contexts_restored,
    } = refreshed_model_state_with_context_recovery(
        &mut config,
        false,
        crate::native_update_ui::confirm_context_recovery,
    )
    .await?;
    timings.mark("prepareModelsMs");
    subagent_policy::reconcile_with_model_state(&mut config, Some(&model_state));
    config = config.normalize();
    config.settings_revision = config.settings_revision.saturating_add(1);
    // 账号记录是下次启动派生线路的来源，必须与主配置一起确认保存结果。
    let save_account = async {
        if let Some(account_id) = account_id {
            write_official_account_route_settings(
                state,
                account_id,
                route_name.unwrap_or_default(),
                route_short_name.unwrap_or_default(),
                requested_base_url.clone().unwrap_or_default(),
            )
            .await
            .map(Some)
        } else {
            Ok(None)
        }
    };
    let SavedOfficialRouteConfig {
        config,
        account_id: saved_account_id,
        warning: account_override_warning,
    } = commit_official_route_config(state, previous, config, catalog_refresh, save_account)
        .await?;
    drop(_config_write_guard);
    timings.mark("saveConfigMs");
    let (mut response, subagent_hot_reload) = if saved_account_id.is_some() {
        let refresh = refresh_official_route_after_account_change(state).await?;
        timings.mark("modelDeliveryMs");
        let config = state.config.read().await.clone();
        let subagent_hot_reload = hot_reload_runtime_subagent_config(state, &config).await;
        timings.mark("subagentReloadMs");
        let mut response = refresh;
        if let Some(object) = response.as_object_mut() {
            object.insert(
                "customContextsRestored".to_string(),
                Value::Bool(custom_contexts_restored),
            );
            object.insert("accountId".to_string(), json!(saved_account_id));
        }
        (response, subagent_hot_reload)
    } else {
        let hot_reload = hot_reload_runtime_models(state).await;
        timings.mark("modelDeliveryMs");
        let subagent_hot_reload = hot_reload_runtime_subagent_config(state, &config).await;
        timings.mark("subagentReloadMs");
        let restart_required = runtime_config_requires_restart(state, &config).await;
        (
            hot_reload.add_to_response(json!({
                "status":"ok",
                "config":redacted_config(&config),
                "modelState":model_state,
                "customContextsRestored":custom_contexts_restored,
                "restartRequired":restart_required,
            })),
            subagent_hot_reload,
        )
    };
    if let Some(warning) = account_override_warning
        && let Some(object) = response.as_object_mut()
    {
        object.insert("warning".to_string(), Value::String(warning));
    }
    Ok(add_subagent_hot_reload_to_response(
        response,
        subagent_hot_reload,
    ))
}

struct SavedOfficialRouteConfig {
    config: CodeyConfig,
    account_id: Option<String>,
    warning: Option<String>,
}

/// 调用方持有配置写锁；账号提交失败时恢复主配置和目录，避免磁盘领先于内存。
async fn commit_official_route_config(
    state: &Arc<AppState>,
    previous: CodeyConfig,
    config: CodeyConfig,
    catalog_refresh: Option<ModelCatalogRefresh>,
    save_account: impl std::future::Future<Output = Result<Option<String>, String>>,
) -> Result<SavedOfficialRouteConfig, String> {
    let config = match save_config_to_store(state, config).await {
        Ok(config) => config,
        Err(error) => {
            return Err(
                rollback_model_catalog_after_config_save_async(catalog_refresh, error).await,
            );
        }
    };
    let (account_id, warning) = match save_account.await {
        Ok(account_id) => (account_id, None),
        Err(error) => {
            let store = state.store.clone();
            let restored =
                tokio::task::spawn_blocking(move || store.restore_after_failed_save(previous))
                    .await
                    .map_err(|error| format!("恢复 Codey 配置任务异常退出：{error}"))
                    .and_then(|result| result.map_err(|error| error.to_string()));
            match restored {
                Ok(restored) => {
                    *state.config.write().await = restored;
                    return Err(rollback_model_catalog_after_config_save_async(
                        catalog_refresh,
                        error,
                    )
                    .await);
                }
                Err(rollback_error) => (
                    None,
                    Some(format!(
                        "主配置已保存，但官方账号设置未保存：{error}；恢复主配置失败：{rollback_error}，请重新读取并确认线路设置"
                    )),
                ),
            }
        }
    };
    *state.config.write().await = config.clone();
    Ok(SavedOfficialRouteConfig {
        config,
        account_id,
        warning,
    })
}

/// 官方线路启用的模型按请求顺序保存，线路卡片和选择器都按这个顺序显示；
/// 模型 ID 统一回写为官方目录里的拼写。
pub(crate) fn ordered_official_selection(
    official_models: &[String],
    requested_models: &[String],
) -> Result<Vec<String>, String> {
    let official_by_key = official_models
        .iter()
        .map(|model| (model_id::key(model), model.as_str()))
        .collect::<std::collections::HashMap<_, _>>();
    let mut selected = Vec::with_capacity(requested_models.len());
    let mut seen = HashSet::new();
    for model in requested_models
        .iter()
        .map(|model| model.trim())
        .filter(|model| !model.is_empty())
    {
        let key = model_id::key(model);
        let Some(official_model) = official_by_key.get(key.as_str()) else {
            return Err(format!("模型 {model} 不在官方模型列表中"));
        };
        if seen.insert(key) {
            selected.push((*official_model).to_string());
        }
    }
    if selected.is_empty() {
        return Err("官方账号线路至少需要保留一个模型".to_string());
    }
    Ok(selected)
}

pub(crate) fn current_model_state(
    config: &CodeyConfig,
) -> Result<model_catalog::ModelSelectionState, String> {
    current_model_state_at(config, codex_home())
}

pub(crate) fn current_model_state_at(
    config: &CodeyConfig,
    home: &std::path::Path,
) -> Result<model_catalog::ModelSelectionState, String> {
    if !config.local_router_enabled {
        let provider = codex_provider::current_provider(home)
            .map_err(|error| format!("读取当前 Codex 线路失败：{error:#}"))?;
        return native_model_state_for_provider(config, &provider, home);
    }
    let active_profile = config
        .profiles
        .iter()
        .find(|profile| profile.enabled && profile.id == config.active_profile_id)
        .or_else(|| config.profiles.iter().find(|profile| profile.enabled));
    let Some(active_profile) = active_profile else {
        return Ok(model_catalog::ModelSelectionState::default());
    };
    let provider_id = active_profile.provider_id();
    let official = active_profile.official_account && config.official_route_usable(active_profile);
    let selected_models = if official {
        config
            .selected_models_by_provider
            .get(provider_id)
            .cloned()
            .unwrap_or_default()
    } else {
        config.enabled_route_models(provider_id)
    };
    let requested_default_model = config.default_model_for_profile(active_profile);
    let reasoning_efforts = config.model_reasoning_efforts_for_provider(provider_id);
    model_catalog::selection_state_with_manual_models(
        home,
        official,
        config
            .upstream_models_by_provider
            .get(provider_id)
            .map(Vec::as_slice),
        &selected_models,
        config
            .manual_third_party_models_by_provider
            .get(provider_id)
            .map(Vec::as_slice)
            .unwrap_or_default(),
        Some(&reasoning_efforts),
        requested_default_model.as_deref(),
    )
    .map_err(|error| error.to_string())
}

#[cfg(test)]
mod commit_tests {
    use super::*;
    use crate::config::ConfigStore;
    use tokio::sync::RwLock;

    #[tokio::test]
    async fn official_route_account_failure_restores_config_and_catalog() {
        let directory = tempfile::tempdir().unwrap();
        let previous = CodeyConfig::default();
        let state = Arc::new(AppState {
            store: ConfigStore::new(directory.path().join("config.json")),
            config: RwLock::new(previous.clone()),
            ..AppState::default()
        });
        state.store.save(&previous).unwrap();
        let catalog_path = directory.path().join(model_catalog::relative_path());
        std::fs::create_dir_all(catalog_path.parent().unwrap()).unwrap();
        std::fs::write(&catalog_path, b"original catalog").unwrap();
        let snapshot = model_catalog::snapshot(directory.path()).unwrap();
        std::fs::write(&catalog_path, b"pending catalog").unwrap();
        let mut next = previous.clone();
        next.settings_revision += 1;
        next.show_account_usage_in_header = false;
        let error = commit_official_route_config(
            &state,
            previous.clone(),
            next,
            Some(ModelCatalogRefresh {
                fallback: false,
                snapshot,
            }),
            async { Err("模拟账号写入失败".into()) },
        )
        .await
        .err()
        .unwrap();
        assert!(error.contains("模拟账号写入失败"));
        assert_eq!(*state.config.read().await, previous);
        assert_eq!(state.store.load().unwrap(), previous);
        let backup: CodeyConfig = serde_json::from_slice(
            &std::fs::read(directory.path().join("config.json.bak.1")).unwrap(),
        )
        .unwrap();
        assert_eq!(backup, previous, "失败事务不进入正常备份链");
        assert_eq!(std::fs::read(&catalog_path).unwrap(), b"original catalog");
    }

    #[tokio::test]
    async fn official_route_config_failure_does_not_write_account() {
        let directory = tempfile::tempdir().unwrap();
        let previous = CodeyConfig::default();
        let state = Arc::new(AppState {
            store: ConfigStore::new(directory.path()),
            config: RwLock::new(previous.clone()),
            ..AppState::default()
        });
        let result =
            commit_official_route_config(&state, previous.clone(), previous.clone(), None, async {
                panic!("主配置失败后不能继续提交账号设置")
            })
            .await;
        assert!(result.is_err());
        assert_eq!(*state.config.read().await, previous);
    }

    #[tokio::test]
    async fn official_route_commit_publishes_config_after_account_confirmation() {
        let directory = tempfile::tempdir().unwrap();
        let previous = CodeyConfig::default();
        let state = Arc::new(AppState {
            store: ConfigStore::new(directory.path().join("config.json")),
            config: RwLock::new(previous.clone()),
            ..AppState::default()
        });
        let mut next = previous.clone();
        next.settings_revision += 1;
        next.show_account_usage_in_header = false;
        let saved =
            commit_official_route_config(&state, previous.clone(), next.clone(), None, async {
                assert_eq!(*state.config.read().await, previous);
                assert_eq!(state.store.load().unwrap(), next);
                Ok(Some("account".into()))
            })
            .await
            .unwrap();
        assert_eq!(saved.account_id.as_deref(), Some("account"));
        assert!(saved.warning.is_none());
        assert_eq!(*state.config.read().await, next);
        assert_eq!(state.store.load().unwrap(), next);
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn official_route_rollback_failure_reports_the_committed_config() {
        use std::os::windows::fs::OpenOptionsExt;
        let directory = tempfile::tempdir().unwrap();
        let previous = CodeyConfig::default();
        let state = Arc::new(AppState {
            store: ConfigStore::new(directory.path().join("config.json")),
            config: RwLock::new(previous.clone()),
            ..AppState::default()
        });
        let mut next = previous.clone();
        next.settings_revision += 1;
        next.show_account_usage_in_header = false;
        let held = std::sync::Mutex::new(None);
        let saved = commit_official_route_config(&state, previous, next.clone(), None, async {
            // 模拟其他进程只共享读取，使随后的原子替换失败。
            *held.lock().unwrap() = Some(
                std::fs::OpenOptions::new()
                    .read(true)
                    .share_mode(1)
                    .open(state.store.path())
                    .unwrap(),
            );
            Err("模拟账号写入失败".into())
        })
        .await
        .unwrap();
        assert!(saved.warning.as_deref().unwrap().contains("恢复主配置失败"));
        assert!(saved.account_id.is_none());
        assert_eq!(saved.config, next);
        assert_eq!(*state.config.read().await, next);
        assert_eq!(state.store.load().unwrap(), next);
    }
}

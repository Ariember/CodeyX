use std::{collections::BTreeMap, path::PathBuf, sync::Arc};

use serde::Deserialize;
use serde_json::{Value, json};

use super::AppState;
use crate::fastctx_native::CallRequest;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ToolCall {
    request_id: String,
    thread_id: String,
    turn_id: String,
    cwd: PathBuf,
    tool: String,
    arguments: Value,
    permissions: Value,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Cancel {
    request_id: String,
    thread_id: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Tools {
    cwd: Option<PathBuf>,
}

pub(super) async fn invoke(
    state: &Arc<AppState>,
    command: &str,
    args: &Value,
) -> Result<Value, String> {
    if state.is_shutting_down() {
        return Err("Codey 正在退出，FastCtx native 调用已停止接收".into());
    }
    match command {
        "cancel_fastctx_native_tool" => {
            let cancel: Cancel = parse(args)?;
            identifier(&cancel.request_id)?;
            identifier(&cancel.thread_id)?;
            state
                .fastctx_native
                .cancel(&cancel.request_id, &cancel.thread_id)
                .await
        }
        "get_fastctx_native_tools" => {
            let args: Tools = parse(args)?;
            let Some((executable, environment)) = environment(state).await? else {
                return Ok(json!({"available":false,"tools":[]}));
            };
            let cwd = args
                .cwd
                .unwrap_or_else(|| crate::codex_config::codex_home().into());
            let cwd = canonical_cwd(cwd).await?;
            match state
                .fastctx_native
                .tools(&executable, &cwd, &environment)
                .await
            {
                Ok(result) if tool_names_valid(&result) => {
                    Ok(json!({"available":true,"tools":result["tools"]}))
                }
                _ => Ok(json!({"available":false,"tools":[]})),
            }
        }
        "call_fastctx_native_tool" => {
            let call: ToolCall = parse(args)?;
            validate_call(&call)?;
            let Some((executable, environment)) = environment(state).await? else {
                return Err(
                    "内置 FastCtx native 不可用，请检查内置工具设置、客户端兼容性和服务程序".into(),
                );
            };
            let cwd = canonical_cwd(call.cwd).await?;
            state
                .fastctx_native
                .call(
                    &executable,
                    &cwd,
                    &environment,
                    CallRequest {
                        request_id: call.request_id,
                        thread_id: call.thread_id,
                        tool: call.tool,
                        arguments: call.arguments,
                    },
                )
                .await
        }
        _ => Err("未知 FastCtx native 命令".into()),
    }
}

fn parse<T: serde::de::DeserializeOwned>(value: &Value) -> Result<T, String> {
    serde_json::from_value(value.clone()).map_err(|_| "FastCtx native 参数格式无效".into())
}

fn identifier(value: &str) -> Result<(), String> {
    if value.is_empty() || value.len() > 256 || value.chars().any(char::is_control) {
        return Err("FastCtx native 调用或会话标识无效".into());
    }
    Ok(())
}

fn validate_call(call: &ToolCall) -> Result<(), String> {
    identifier(&call.request_id)?;
    identifier(&call.thread_id)?;
    identifier(&call.turn_id)?;
    if !matches!(
        call.tool.as_str(),
        "inspect_local_file" | "grep" | "glob" | "replace" | "delete" | "move" | "create_file"
    ) || !call.arguments.is_object()
    {
        return Err("FastCtx native 工具或参数无效".into());
    }
    // The native worker has host permissions, so restricted profiles cannot execute it.
    if call.permissions["sandboxPolicy"]["type"].as_str() != Some("dangerFullAccess") {
        return Err("当前权限模式不支持 FastCtx native，仅支持本地标准完全访问会话".into());
    }
    let profile = &call.permissions["activePermissionProfile"];
    if !profile.is_null()
        && profile.as_str().or_else(|| profile["id"].as_str()) != Some(":danger-full-access")
    {
        return Err("当前权限配置不支持 FastCtx native，仅支持标准完全访问权限配置".into());
    }
    if !call.cwd.is_absolute() {
        return Err("FastCtx native 工作目录必须是绝对路径".into());
    }
    Ok(())
}

fn tool_names_valid(result: &Value) -> bool {
    result["tools"].as_array().is_some_and(|tools| {
        tools.len() == 7
            && [
                "inspect_local_file",
                "grep",
                "glob",
                "replace",
                "delete",
                "move",
                "create_file",
            ]
            .iter()
            .all(|name| {
                tools
                    .iter()
                    .any(|tool| tool["name"] == *name && tool["inputSchema"].is_object())
            })
    })
}

async fn canonical_cwd(path: PathBuf) -> Result<PathBuf, String> {
    tokio::task::spawn_blocking(move || {
        if !path.is_absolute() || !path.is_dir() {
            return Err("FastCtx native 工作目录无效".into());
        }
        path.canonicalize()
            .map_err(|_| "无法读取 FastCtx native 工作目录".into())
    })
    .await
    .map_err(|_| "读取 FastCtx native 工作目录的任务失败".to_string())?
}

async fn environment(
    state: &AppState,
) -> Result<Option<(PathBuf, BTreeMap<String, String>)>, String> {
    // Unsupported hosts and restricted permission profiles never start a native worker.
    if !native_enabled(std::env::var("CODEY_FASTCTX_NATIVE_TOOLS").ok().as_deref())
        || !state.config.read().await.fast_context_tools
        || state.config_load_error.is_some()
    {
        return Ok(None);
    }
    tokio::task::spawn_blocking(|| {
        let executable = match crate::codex_config::fastctx_server_command() {
            Ok(executable) => executable,
            Err(_) => return Ok(None),
        };
        let home = crate::codex_config::codex_home();
        let Some(budgets) = crate::codex_config::fastctx_native_environment(home)
            .map_err(|_| "无法确认当前 FastCtx 配置，native 已停用".to_string())?
        else {
            return Ok(None);
        };
        let mut environment: BTreeMap<_, _> = std::env::vars().collect();
        for name in [
            "FASTCTX_TOKEN_BUDGET",
            "FASTCTX_GREP_TOKEN_BUDGET",
            "FASTCTX_GLOB_TOKEN_BUDGET",
        ] {
            environment.remove(name);
        }
        environment.extend(budgets);
        environment.insert("CODEX_HOME".into(), home.to_string_lossy().into_owned());
        environment.insert(
            "CODEY_FASTCTX_MAX_FRAME_BYTES".into(),
            (16 * 1024 * 1024).to_string(),
        );
        Ok(Some((executable, environment)))
    })
    .await
    .map_err(|_| "检查 FastCtx native 运行环境的任务失败".to_string())?
}

fn native_enabled(value: Option<&str>) -> bool {
    matches!(value, None | Some("1"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_transport_defaults_on_and_honors_explicit_disable() {
        assert!(native_enabled(None));
        assert!(native_enabled(Some("1")));
        for value in [Some(""), Some("0"), Some("true")] {
            assert!(!native_enabled(value));
        }
    }

    fn call() -> ToolCall {
        ToolCall {
            request_id: "call-1".into(),
            thread_id: "thread-1".into(),
            turn_id: "turn-1".into(),
            cwd: std::env::temp_dir(),
            tool: "grep".into(),
            arguments: json!({"pattern":"test"}),
            permissions: json!({"sandboxPolicy":{"type":"dangerFullAccess"}}),
        }
    }

    #[test]
    fn native_permissions_never_upgrade_restricted_or_unknown_profiles() {
        let mut call = call();
        assert!(validate_call(&call).is_ok());
        for policy in [
            "readOnly",
            "workspaceWrite",
            "externalSandbox",
            "unknown",
            "",
        ] {
            call.permissions = json!({"sandboxPolicy":{"type":policy}});
            assert!(validate_call(&call).is_err());
        }
        call.permissions = Value::Null;
        assert!(validate_call(&call).is_err());
        for profile in [
            json!(":danger-full-access"),
            json!({"id":":danger-full-access"}),
            Value::Null,
        ] {
            call.permissions = json!({"sandboxPolicy":{"type":"dangerFullAccess"},"activePermissionProfile":profile});
            assert!(validate_call(&call).is_ok());
        }
        for profile in [json!("custom"), json!({"id":"custom"}), json!({})] {
            call.permissions = json!({"sandboxPolicy":{"type":"dangerFullAccess"},"activePermissionProfile":profile});
            assert!(validate_call(&call).is_err());
        }
    }

    #[test]
    fn filesystem_mutations_require_full_access_and_complete_tool_metadata() {
        let mut call = call();
        for tool in ["create_file", "move", "delete"] {
            call.tool = tool.into();
            call.permissions = json!({"sandboxPolicy":{"type":"dangerFullAccess"}});
            assert!(validate_call(&call).is_ok(), "{tool}");
            call.permissions = json!({"sandboxPolicy":{"type":"readOnly"}});
            assert!(validate_call(&call).is_err(), "{tool}");
        }
        let mut tools = [
            "inspect_local_file",
            "grep",
            "glob",
            "replace",
            "delete",
            "move",
            "create_file",
        ]
        .map(|name| json!({"name":name,"inputSchema":{"type":"object"}}))
        .to_vec();
        assert!(tool_names_valid(&json!({"tools":tools})));
        tools.pop();
        assert!(!tool_names_valid(&json!({"tools":tools})));
        tools.push(tools[0].clone());
        assert!(!tool_names_valid(&json!({"tools":tools})));
    }

    #[test]
    fn invalid_call_metadata_is_rejected_before_execution() {
        let mut call = call();
        call.tool = "shell".into();
        assert!(validate_call(&call).is_err());
        call.tool = "grep".into();
        call.arguments = Value::Null;
        assert!(validate_call(&call).is_err());
        call.arguments = json!({});
        call.request_id = "id\n".into();
        assert!(validate_call(&call).is_err());
        call.request_id = "id".into();
        call.cwd = std::path::Path::new("relative").into();
        assert!(validate_call(&call).is_err());
        assert!(parse::<Tools>(&json!({"cwd":null})).is_ok());
        assert!(parse::<Tools>(&json!({"private":"secret"})).is_err());
    }

    #[tokio::test]
    async fn disabled_builtin_never_starts_a_native_worker() {
        let state = Arc::new(AppState::default());
        *state.config.write().await = crate::config::CodeyConfig {
            fast_context_tools: false,
            ..crate::config::CodeyConfig::default()
        };
        assert_eq!(
            invoke(&state, "get_fastctx_native_tools", &json!({}))
                .await
                .unwrap(),
            json!({"available":false,"tools":[]})
        );
    }

    #[test]
    fn native_environment_derives_budgets_without_writing_configuration() {
        let home = tempfile::tempdir().unwrap();
        let path = home.path().join("config.toml");
        for (source, expected) in [
            ("tool_output_token_limit=100", Some("90")),
            ("tool_output_token_limit=0", None),
        ] {
            std::fs::write(&path, source).unwrap();
            let environment = crate::codex_config::fastctx_native_environment(home.path())
                .unwrap()
                .unwrap();
            assert_eq!(
                environment.get("FASTCTX_TOKEN_BUDGET").map(String::as_str),
                expected
            );
            assert!(environment.keys().all(|key| {
                [
                    "FASTCTX_TOKEN_BUDGET",
                    "FASTCTX_GREP_TOKEN_BUDGET",
                    "FASTCTX_GLOB_TOKEN_BUDGET",
                ]
                .contains(&key.as_str())
            }));
            assert_eq!(std::fs::read_to_string(&path).unwrap(), source);
        }
        std::fs::write(&path, "[mcp_servers.custom]\ncommand='fastctx'\n").unwrap();
        assert!(
            crate::codex_config::fastctx_native_environment(home.path())
                .unwrap()
                .is_none()
        );
    }
}

use std::borrow::Cow;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use anyhow::{Context, Result};
use codey_runtime_core::bridge::{
    BridgeHandler, BridgePumpHandle, bridge_health_check_script, install_bridge,
};
use codey_runtime_core::cdp::{CdpTarget, list_targets, pick_injectable_codex_page_target};
use codey_runtime_core::devtools::{FailureKind, ProtocolFailure};
use serde::{Deserialize, Serialize};

use crate::error_log;

mod request_gate;
mod runtime_optimizations;
pub(crate) use runtime_optimizations::refresh_auxiliary_renderers;
#[cfg(windows)]
mod quit;
#[cfg(windows)]
pub(crate) use quit::request_native_quit;

const SETTINGS_OVERLAY_LOAD_PATH: &str = "/internal/codey/settings-overlay/load";
const SESSION_TOOLS_LOAD_PATH: &str = "/internal/codey/session-tools/load";
const CDP_INJECTION_TIMEOUT: Duration = Duration::from_secs(30);
// Desktop 创建主窗口前会先读取启动策略；WSL 模式需在发行版内冷启动 app-server，
// 官方为准备与策略读取分别预留 120 秒和 60 秒。只在 CDP 端点仍有响应时沿用此上限。
const CDP_WINDOW_WAIT_TIMEOUT: Duration = Duration::from_secs(180);
const INITIAL_RETRY_INTERVAL: Duration = Duration::from_millis(100);
// 发现与选择阶段的失败只付一次 loopback 请求的代价，既不触碰 renderer，也不
// 留下 CDP 副作用，因此可以用更密的节奏跟随 renderer 就绪。校验阶段的失败
// 复用已装好的桥接，但每次探测仍要在页面里跑一轮资产导入与 React 遍历；
// 桥接安装失败则必须重建 WebSocket 并重复注册持久注入脚本。两类失败都保持
// 原有退避，避免在 Codex 冷启动的 CPU 高峰窗口里叠加负担。
const DISCOVERY_RETRY_STEP: Duration = Duration::from_millis(50);
const DISCOVERY_RETRY_MAX_INTERVAL: Duration = Duration::from_millis(200);
// 发现阶段单次失败超过这个预算就不再算廉价探测：正常情况是一次被拒绝或返回空
// 列表的 loopback 请求，远低于此值。
const DISCOVERY_RETRY_COST_BUDGET: Duration = Duration::from_millis(100);
const BRIDGE_RETRY_MAX_INTERVAL: Duration = Duration::from_millis(500);
const NATIVE_RUNTIME_INJECT_TIMEOUT: Duration = Duration::from_secs(8);
const MCP_RELOAD_EVALUATE_TIMEOUT: Duration = Duration::from_secs(20);
const CODEY_BRIDGE_SCRIPT: &str = include_str!("../../dist-overlay/inject/codey-bridge.js");
const CODEX_RUNTIME_ADAPTER_SCRIPT: &str =
    include_str!("../../dist-overlay/inject/codex-runtime-adapter.js");
const RUNTIME_OPTIMIZATIONS_SCRIPT: &str =
    include_str!("../../dist-overlay/inject/runtime-optimizations.js");
const MODEL_WHITELIST_INJECT_SCRIPT: &str = concat!(
    include_str!("../../dist-overlay/inject/model-request-gate.js"),
    "\n",
    include_str!("../../dist-overlay/inject/model-whitelist-inject.js"),
);
const RENDERER_INJECT_SCRIPT: &str = include_str!("../../dist-overlay/inject/renderer-inject.js");
const CODEY_SESSION_TOOLS_SCRIPT: &str = include_str!("../../dist-overlay/inject/codey-inject.js");
const PET_CONTROL_SHIELD_SCRIPT: &str =
    include_str!("../../dist-overlay/inject/pet-control-shield.js");
const SECURITY_WARNING_SHIELD_SCRIPT: &str =
    include_str!("../../dist-overlay/inject/security-warning-shield.js");
const QUOTA_NOTICE_DISMISS_SCRIPT: &str =
    include_str!("../../dist-overlay/inject/quota-notice-dismiss.js");
const QUOTA_UNLOCK_SCRIPT: &str = include_str!("../../dist-overlay/inject/quota-unlock.js");
pub(crate) const SETTINGS_OVERLAY_SCRIPT: &str =
    include_str!("../../dist-overlay/codey-overlay.js");
const PLUGIN_MARKETPLACE_FIX_SCRIPT: &str =
    include_str!("../../dist-overlay/inject/plugin-marketplace-fix.js");
const PROMPT_OPTIMIZE_SCRIPT: &str = include_str!("../../dist-overlay/inject/prompt-optimize.js");
const CONVERSATION_GIT_SCRIPT: &str = include_str!("../../dist-overlay/inject/conversation-git.js");
const CONVERSATION_STATS_SCRIPT: &str =
    include_str!("../../dist-overlay/inject/conversation-stats-inject.js");
const STARTUP_SPLASH_SCRIPT: &str = include_str!("../../dist-overlay/inject/startup-splash.js");
const MAX_INJECTION_ERROR_CHARS: usize = 500;
// 面向用户的是归类后的摘要；完整错误链只进诊断与错误日志，单独给一个更大预算。
const MAX_INJECTION_DETAIL_CHARS: usize = 2000;
static SETTINGS_OVERLAY_LOAD_SCRIPT: OnceLock<Arc<str>> = OnceLock::new();
static NATIVE_RUNTIME_LOAD_SCRIPT: OnceLock<Arc<str>> = OnceLock::new();
static SESSION_TOOLS_LOAD_SCRIPT: OnceLock<Arc<str>> = OnceLock::new();

#[derive(Clone, Copy)]
#[repr(u8)]
enum InjectionPhase {
    DiscoverTargets,
    SelectTarget,
    InstallBridge,
    VerifyRequestGate,
    VerifyOverlay,
    ReadStatuses,
}

impl InjectionPhase {
    fn from_raw(value: u8) -> Self {
        match value {
            value if value == Self::SelectTarget as u8 => Self::SelectTarget,
            value if value == Self::InstallBridge as u8 => Self::InstallBridge,
            value if value == Self::VerifyRequestGate as u8 => Self::VerifyRequestGate,
            value if value == Self::VerifyOverlay as u8 => Self::VerifyOverlay,
            value if value == Self::ReadStatuses as u8 => Self::ReadStatuses,
            _ => Self::DiscoverTargets,
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::DiscoverTargets => "枚举 CDP 页面",
            Self::SelectTarget => "选择 Codex renderer",
            Self::InstallBridge => "安装 CDP bridge 与注入脚本",
            Self::VerifyRequestGate => "校验模型请求入口",
            Self::VerifyOverlay => "验证 CodeyX 浮层",
            Self::ReadStatuses => "读取注入状态",
        }
    }

    /// 诊断日志用的稳定标识，避免把面向用户的中文文案写进可检索字段。
    fn key(self) -> &'static str {
        match self {
            Self::DiscoverTargets => "discoverTargets",
            Self::SelectTarget => "selectTarget",
            Self::InstallBridge => "installBridge",
            Self::VerifyRequestGate => "verifyRequestGate",
            Self::VerifyOverlay => "verifyOverlay",
            Self::ReadStatuses => "readStatuses",
        }
    }

    /// 该阶段的失败是否只花掉一次廉价探测：没有建立 CDP 会话，因而可以安全地
    /// 用更短的间隔重试。
    fn is_discovery(self) -> bool {
        matches!(self, Self::DiscoverTargets | Self::SelectTarget)
    }
}

const INJECTION_PHASES: [InjectionPhase; 6] = [
    InjectionPhase::DiscoverTargets,
    InjectionPhase::SelectTarget,
    InjectionPhase::InstallBridge,
    InjectionPhase::VerifyRequestGate,
    InjectionPhase::VerifyOverlay,
    InjectionPhase::ReadStatuses,
];
const INJECTION_PHASE_COUNT: usize = INJECTION_PHASES.len();

/// 触发这一轮注入重试的入口：首次启动等待渲染进程就绪，与看门狗在运行期按
/// 健康判定重建，失败画像的含义完全不同，日志里必须能分开。
#[derive(Clone, Copy)]
pub enum InjectionRetrySource {
    Startup,
    Watchdog,
}

impl InjectionRetrySource {
    fn key(self) -> &'static str {
        match self {
            Self::Startup => "startup",
            Self::Watchdog => "watchdog",
        }
    }
}

#[derive(Clone)]
struct InjectionScriptDescriptor {
    id: String,
    name: String,
    source: &'static str,
    visibility: InjectionScriptVisibility,
    probe: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum InjectionScriptVisibility {
    Feature,
    Internal,
}

impl InjectionScriptVisibility {
    fn as_str(self) -> &'static str {
        match self {
            Self::Feature => "feature",
            Self::Internal => "internal",
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct InjectionScriptStatus {
    pub id: String,
    pub name: String,
    pub source: String,
    pub visibility: String,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Clone)]
pub struct PreparedInjectionScripts {
    scripts: Arc<[String]>,
    descriptors: Arc<[InjectionScriptDescriptor]>,
    runtime_optimizations: Arc<str>,
}

pub struct InjectedTarget {
    websocket_url: Arc<str>,
    pump: BridgePumpHandle,
    injection_statuses: Arc<[InjectionScriptStatus]>,
    request_gate: request_gate::Task,
}

#[derive(Debug)]
pub struct InjectionRetryFailure {
    error: anyhow::Error,
    detail: Option<String>,
}

impl InjectionRetryFailure {
    pub fn retryable(&self) -> bool {
        self.error
            .downcast_ref::<ProtocolFailure>()
            .is_none_or(ProtocolFailure::retryable_setup)
    }

    pub fn into_error(self) -> anyhow::Error {
        self.error
    }

    /// 最后一次注入尝试的完整错误链（已截断）。对外错误只保留归类摘要，
    /// 排查需要这条原始信息，调用方把它写进错误日志上下文。
    pub fn detail(&self) -> Option<&str> {
        self.detail.as_deref()
    }
}

impl std::fmt::Display for InjectionRetryFailure {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.error.fmt(formatter)
    }
}

impl std::error::Error for InjectionRetryFailure {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        self.error.source()
    }
}

impl InjectedTarget {
    pub fn websocket_url(&self) -> &str {
        &self.websocket_url
    }

    pub fn injection_statuses(&self) -> Arc<[InjectionScriptStatus]> {
        self.injection_statuses.clone()
    }

    pub fn websocket_url_arc(&self) -> Arc<str> {
        self.websocket_url.clone()
    }

    /// 常驻桥接连接的消息泵是否已经结束。
    /// 结束时页面内的桥接调用再也无法送达后端，重新注入是唯一出路。
    pub fn pump_finished(&self) -> bool {
        self.pump.is_finished()
    }

    pub async fn pump_closed(&self) {
        self.pump.finished().await;
    }

    pub async fn close(self) {
        self.request_gate.abort();
        self.pump.close().await;
    }
}

pub fn prepare_injection_scripts(
    local_router_enabled: bool,
    slim_codex_pet: bool,
    hide_full_access_warning: bool,
    user_scripts: &[String],
) -> PreparedInjectionScripts {
    use InjectionScriptVisibility::{Feature, Internal};

    let mut builtin_scripts = vec![
        (
            "bridge-helpers",
            "桥接辅助",
            CODEY_BRIDGE_SCRIPT,
            r#"typeof window.__codexSessionDeleteBridge === "function"
              && typeof window.__codeyCall === "function"
              ? "桥接函数可调用" : """#
                .to_string(),
            Internal,
        ),

        (
            "native-runtime",
            "原生接口适配",
            CODEX_RUNTIME_ADAPTER_SCRIPT,
            r#"window.__codeyNativeRuntime?.isActive?.() === true
              ? "原生接口适配已加载，能力按需探测" : """#
                .to_string(),
            Internal,
        ),
        (
            "model-whitelist",
            "模型白名单",
            MODEL_WHITELIST_INJECT_SCRIPT,
            r#"(() => {
              const patch = window.__codeyModelWhitelistPatch;
              if (!patch || typeof patch.snapshot !== "function") return "";
              const snapshot = patch.snapshot();
              return snapshot?.loaded === true
                ? `模型目录已加载（${Array.isArray(snapshot.models) ? snapshot.models.length : 0} 个模型）`
                : "";
            })()"#
                .to_string(),
            Internal,
        ),
        (
            "pet-control-shield",
            "宠物控制精简",
            PET_CONTROL_SHIELD_SCRIPT,
            format!(
                r#"window.__codeyPetControlShield?.enabled === {slim_codex_pet}
                  && typeof window.__codeyPetControlShield?.block === "function"
                  ? {} : """#,
                if slim_codex_pet {
                    serde_json::to_string("宠物控制精简已启用")
                        .expect("pet probe detail should serialize")
                } else {
                    format!(
                        "{{ effective: false, inactive: true, detail: {} }}",
                        serde_json::to_string("控制器已就绪，当前精简策略关闭")
                            .expect("pet inactive detail should serialize")
                    )
                }
            ),
            Feature,
        ),
        (
            "security-warning-shield",
            "安全提示控制",
            SECURITY_WARNING_SHIELD_SCRIPT,
            format!(
                r#"window.__codeySecurityWarningShieldInstalled === true
                  && window.__codeySecurityWarningShield?.enabled === {hide_full_access_warning}
                  && typeof window.__codeySecurityWarningShield?.dismissWarnings === "function"
                  ? {} : """#,
                if hide_full_access_warning {
                    serde_json::to_string("安全提示屏蔽已启用")
                        .expect("security probe detail should serialize")
                } else {
                    format!(
                        "{{ effective: false, inactive: true, detail: {} }}",
                        serde_json::to_string("控制器已就绪，当前屏蔽策略关闭")
                            .expect("security inactive detail should serialize")
                    )
                }
            ),
            Feature,
        ),
        (
            "quota-notice-dismiss",
            "额度提示关闭",
            QUOTA_NOTICE_DISMISS_SCRIPT,
            r#"window.__codeyQuotaNoticeDismissInstalled === true
              && typeof window.__codeyQuotaNoticeDismiss?.scan === "function"
              && typeof window.__codeyQuotaNoticeDismiss?.dismiss === "function"
              ? "额度提示关闭按钮已就绪" : """#
                .to_string(),
            Feature,
        ),
        (
            "settings-overlay-loader",
            "配置面板加载器",
            lazy_settings_overlay_loader_script(),
            r#"typeof window.__codeySettingsOverlay?.toggle === "function"
              ? (window.__codeySettingsOverlay.__codeyLazyLoader
                ? "配置面板按需加载器可用" : "配置面板已加载")
              : """#
                .to_string(),
            Internal,
        ),
        (
            "renderer-controls",
            "渲染器控制",
            RENDERER_INJECT_SCRIPT,
            r#"(() => {
              if (window.__codeyRendererCoreLoaded !== true
                || typeof window.__codeyRendererScan !== "function"
                || typeof window.__codeyLoadSessionTools !== "function") return "";
              return "渲染器控制与按需加载 API 可用";
            })()"#
                .to_string(),
            Internal,
        ),
        (
            "plugin-marketplace-compatibility",
            "插件市场兼容",
            PLUGIN_MARKETPLACE_FIX_SCRIPT,
            r#"window.__codeyPluginMarketplaceFixInstalled === true
              && typeof window.__codeyEnsurePluginBridge === "function"
              && window.electronBridge?.sendMessageFromView?.__codeyPatched === true
              ? "插件市场桥接已接管" : """#
                .to_string(),
            Internal,
        ),
        (
            "prompt-optimize",
            "提示词优化",
            PROMPT_OPTIMIZE_SCRIPT,
            r#"(() => {
              const optimizer = window.__codeyPromptOptimize;
              if (!optimizer || typeof optimizer.snapshot !== "function") return "";
              const snapshot = optimizer.snapshot();
              if (snapshot.ready !== true) return "";
              return snapshot.enabled === true
                ? "提示词优化按钮已就绪"
                : { effective: false, inactive: true, detail: "提示词优化已关闭" };
            })()"#
                .to_string(),
            Feature,
        ),
        (
            "conversation-stats",
            "会话状态条",
            CONVERSATION_STATS_SCRIPT,
            r#"window.__codeyConversationStats?.installed === true
              ? "会话状态条已就绪" : """#.to_string(),
            Internal,
        ),
        (
            "runtime-optimizations",
            "运行时资源优化",
            RUNTIME_OPTIMIZATIONS_SCRIPT,
            r#"(() => {
              const status = window.__codeyRuntimeOptimizations?.snapshot?.();
              if (!status) return "";
              const active = [];
              if (status.cpuSamplingDisabled) active.push("CPU 采样");
              if (status.interactionHeartbeatDisabled) active.push("交互心跳");
              if (status.appStateHeartbeatDisabled) active.push("诊断心跳");
              if (status.petPrewarmDisabled) active.push("宠物自动预热");
              return active.length ? { effective: true, detail: `已抑制：${active.join("、")}` } : "";
            })()"#.to_string(),
            Feature,
        ),
        (
            "conversation-git",
            "对话 Git 提交增强",
            CONVERSATION_GIT_SCRIPT,
            r#"window.__codeyConversationGit?.snapshot?.().ready === true
              ? (window.__codeyConversationGit.snapshot().enabled
                ? "对话 Git 提交入口已就绪"
                : { effective: false, inactive: true, detail: "对话 Git 提交增强已关闭" }) : """#.to_string(),
            Feature,
        ),
    ];
    if local_router_enabled {
        builtin_scripts.push((
            "quota-unlock",
            "额度状态兼容",
            QUOTA_UNLOCK_SCRIPT,
            r#"(() => {
              const status = window.__codeyQuotaUnlock?.status?.();
              if (!status) return "";
              return status.enabled === true
                ? { effective: true, detail: `额度状态兼容已处理 ${status.sanitized ?? 0} 次` }
                : { effective: false, inactive: true, detail: "额度状态兼容已关闭" };
            })()"#
                .to_string(),
            Feature,
        ));
    }
    let mut core_bundle = String::with_capacity(
        CODEY_BRIDGE_SCRIPT.len()
            + CODEX_RUNTIME_ADAPTER_SCRIPT.len()
            + RUNTIME_OPTIMIZATIONS_SCRIPT.len()
            + MODEL_WHITELIST_INJECT_SCRIPT.len()
            + RENDERER_INJECT_SCRIPT.len()
            + PET_CONTROL_SHIELD_SCRIPT.len()
            + SECURITY_WARNING_SHIELD_SCRIPT.len()
            + QUOTA_NOTICE_DISMISS_SCRIPT.len()
            + QUOTA_UNLOCK_SCRIPT.len()
            + PLUGIN_MARKETPLACE_FIX_SCRIPT.len()
            + PROMPT_OPTIMIZE_SCRIPT.len()
            + CONVERSATION_STATS_SCRIPT.len()
            + STARTUP_SPLASH_SCRIPT.len()
            + crate::codex_startup_patch::STARTUP_SPLASH_MARKUP.len()
            + 4096,
    );
    core_bundle.push_str("try {\n");
    core_bundle.push_str(&startup_splash_script());
    core_bundle.push_str(
        "\n} catch (error) {\n  console.error(\"[Codey] startup splash injection failed\", error);\n}\n",
    );
    let mut descriptors = Vec::with_capacity(builtin_scripts.len() + user_scripts.len());
    for (id, name, script, probe, visibility) in builtin_scripts {
        let descriptor = InjectionScriptDescriptor {
            id: id.to_string(),
            name: name.to_string(),
            source: "builtin",
            visibility,
            probe: Some(probe),
        };
        let prepared = if id == "model-whitelist" {
            Cow::Owned(format!(
                "window.__codeyNativeModelSelectionOnly = {};\n{script}",
                !local_router_enabled,
            ))
        } else {
            prepare_script(script, slim_codex_pet)
        };
        append_guarded_script(&mut core_bundle, &descriptor, prepared.as_ref());
        descriptors.push(descriptor);
    }

    let mut scripts = Vec::with_capacity(1 + user_scripts.len());
    scripts.push(core_bundle);
    for (index, script) in user_scripts
        .iter()
        .filter(|script| !script.trim().is_empty())
        .enumerate()
    {
        let descriptor = InjectionScriptDescriptor {
            id: format!("user-script-{}", index + 1),
            name: format!("用户脚本 {}", index + 1),
            source: "user",
            visibility: Feature,
            probe: None,
        };
        let mut guarded = String::with_capacity(script.len() + 512);
        append_guarded_script(&mut guarded, &descriptor, script);
        scripts.push(guarded);
        descriptors.push(descriptor);
    }
    PreparedInjectionScripts {
        scripts: Arc::from(scripts),
        descriptors: Arc::from(descriptors),
        runtime_optimizations: Arc::from(format!(
            "{CODEX_RUNTIME_ADAPTER_SCRIPT}\n{}",
            prepare_script(RUNTIME_OPTIMIZATIONS_SCRIPT, slim_codex_pet),
        )),
    }
}

fn startup_splash_script() -> String {
    STARTUP_SPLASH_SCRIPT.replace(
        "__CODEY_STARTUP_SPLASH__",
        &serde_json::to_string(crate::codex_startup_patch::STARTUP_SPLASH_MARKUP)
            .expect("startup splash markup should serialize"),
    )
}

fn prepare_script(script: &str, slim_codex_pet: bool) -> Cow<'_, str> {
    if !script.contains("__CODEY_SLIM_PET__") {
        return Cow::Borrowed(script);
    }
    Cow::Owned(script.replace(
        "__CODEY_SLIM_PET__",
        if slim_codex_pet { "true" } else { "false" },
    ))
}

fn append_guarded_script(
    bundle: &mut String,
    descriptor: &InjectionScriptDescriptor,
    script: &str,
) {
    let id = serde_json::to_string(&descriptor.id).expect("script id should serialize");
    let name = serde_json::to_string(&descriptor.name).expect("script name should serialize");
    let source = serde_json::to_string(descriptor.source).expect("script source should serialize");
    // A failed user script may already have performed side effects. Reconnect
    // must not replay it; a new document gets a fresh registry.
    if descriptor.source == "user" {
        bundle.push_str("\nif (!window.__codeyInjectionStatus?.[");
        bundle.push_str(&id);
        bundle.push_str("]) {\n");
    }
    bundle.push_str("\n(window.__codeyInjectionStatus ||= Object.create(null))[");
    bundle.push_str(&id);
    bundle.push_str("] = { id: ");
    bundle.push_str(&id);
    bundle.push_str(", name: ");
    bundle.push_str(&name);
    bundle.push_str(", source: ");
    bundle.push_str(&source);
    bundle.push_str(", status: \"pending\", detail: null, error: null };\n");
    bundle.push_str("try {\n");
    bundle.push_str(script);
    bundle.push_str("\n  const completedEntry = window.__codeyInjectionStatus[");
    bundle.push_str(&id);
    bundle.push_str("];\n");
    bundle.push_str(
        "  if (completedEntry.status === \"pending\") completedEntry.status = \"executed\";\n",
    );
    bundle.push_str("} catch (error) {\n");
    bundle.push_str(
        "  const message = error instanceof Error\n    ? `${error.name}: ${error.message}${error.stack ? `\\n${error.stack}` : \"\"}`\n    : String(error || \"未知错误\");\n",
    );
    bundle.push_str("  const registry = window.__codeyInjectionStatus ||= Object.create(null);\n");
    bundle.push_str("  const entry = registry[");
    bundle.push_str(&id);
    bundle.push_str("] ||= { id: ");
    bundle.push_str(&id);
    bundle.push_str(", name: ");
    bundle.push_str(&name);
    bundle.push_str(", source: ");
    bundle.push_str(&source);
    bundle.push_str(" };\n");
    bundle.push_str("  entry.status = \"failed\";\n");
    bundle.push_str("  entry.error = message.slice(0, ");
    bundle.push_str(&MAX_INJECTION_ERROR_CHARS.to_string());
    bundle.push_str(");\n  console.error(\"[Codey] ");
    bundle.push_str(&descriptor.name);
    bundle.push_str(" injection failed\", error);\n}\n");
    if descriptor.source == "user" {
        bundle.push_str("}\n");
    }
}

pub async fn retry_inject_with_scripts(
    debug_port: u16,
    handler: BridgeHandler,
    scripts: &PreparedInjectionScripts,
    source: InjectionRetrySource,
) -> std::result::Result<InjectedTarget, InjectionRetryFailure> {
    // Renderer asset preparation on newer Windows Codex builds can consume
    // more than ten seconds before the first injectable page appears. Keep
    // enough budget for the bridge commands after discovery while retaining a
    // hard startup deadline.
    let started = tokio::time::Instant::now();
    let mut deadline = InjectionDeadline::new(started, source);
    let mut delay = INITIAL_RETRY_INTERVAL;
    let phase = Arc::new(AtomicU8::new(InjectionPhase::DiscoverTargets as u8));
    let mut previous_error = None;
    let mut previous_detail = None;
    let mut stats = InjectionRetryStats::default();
    // 校验失败时桥接本身仍然可用：把它跨轮保留，下一轮只在原 WebSocket 上
    // 重跑校验，不再重连并重放全部注入脚本。
    let mut retained_bridge: Option<EstablishedInjection> = None;
    let last_error = loop {
        stats.attempts += 1;
        let attempt_started = tokio::time::Instant::now();
        match tokio::time::timeout_at(
            deadline.at(),
            run_injection_attempt(
                retained_bridge.take(),
                debug_port,
                handler.clone(),
                scripts,
                &phase,
            ),
        )
        .await
        {
            Ok(AttemptOutcome::Injected(target)) => {
                deadline.observe(InjectionPhase::ReadStatuses, attempt_started);
                stats.page_discovered = deadline.page_discovered();
                stats.report(source, "injected", started.elapsed(), None);
                return Ok(target);
            }
            Ok(AttemptOutcome::Retry { error, retained }) => {
                retained_bridge = retained;
                let current_phase = InjectionPhase::from_raw(phase.load(Ordering::Acquire));
                // 发现阶段在尝试开始后的一次回环请求内完成，用开始时刻记录端点与页面。
                deadline.observe(current_phase, attempt_started);
                stats.page_discovered = deadline.page_discovered();
                let failure_cost = attempt_started.elapsed();
                stats.record_failure(current_phase, failure_cost);
                stats.last_protocol_failure = error.downcast_ref::<ProtocolFailure>().cloned();
                previous_detail = Some(injection_failure_detail(&error));
                if stats
                    .last_protocol_failure
                    .as_ref()
                    .is_some_and(|failure| !failure.retryable_setup())
                {
                    stats.report(
                        source,
                        "incompatible",
                        started.elapsed(),
                        previous_detail.as_deref(),
                    );
                    let summary = safe_injection_error_summary(&error);
                    break error.context(format!(
                        "Codex CDP bridge 注入失败（阶段：{}；{summary}）",
                        current_phase.label()
                    ));
                }
                if tokio::time::Instant::now() + delay > deadline.at() {
                    stats.report(
                        source,
                        "noRetryBudget",
                        started.elapsed(),
                        previous_detail.as_deref(),
                    );
                    break anyhow::anyhow!(
                        "Codex CDP bridge 注入失败（阶段：{}；{}）",
                        current_phase.label(),
                        safe_injection_error_summary(&error)
                    );
                }
                previous_error = Some(safe_injection_error_summary(&error));
                tokio::time::sleep(delay).await;
                delay = next_injection_retry_delay(delay, current_phase, failure_cost);
            }
            Err(_) => {
                let current_phase = InjectionPhase::from_raw(phase.load(Ordering::Acquire));
                stats.report(
                    source,
                    "deadlineExceeded",
                    started.elapsed(),
                    previous_detail.as_deref(),
                );
                let previous_error = previous_error
                    .as_deref()
                    .map(|error| format!("；最近一次失败：{error}"))
                    .unwrap_or_default();
                if deadline.awaiting_window() {
                    break anyhow::anyhow!(
                        "等待 Codex 主窗口超时（{} ms，Codex 仍在启动但未创建可注入页面{}）",
                        started.elapsed().as_millis(),
                        previous_error
                    );
                }
                break anyhow::anyhow!(
                    "等待 Codex CDP bridge 注入超时（{} ms，阶段：{}{}）",
                    started.elapsed().as_millis(),
                    current_phase.label(),
                    previous_error
                );
            }
        }
    };
    Err(InjectionRetryFailure {
        error: last_error,
        detail: previous_detail,
    })
}

/// 启动注入的截止时间。主窗口出现前，CDP 端点每次响应都把截止时间顺延一个注入
/// 预算，但不超过窗口等待上限；端点停止响应时按最后一次响应计，避免 Codex 退出后
/// 长时间空等。发现 Codex 页面后，注入预算从该时刻计起。看门狗重建沿用固定预算。
struct InjectionDeadline {
    started: tokio::time::Instant,
    wait_for_window: bool,
    endpoint_responded: Option<tokio::time::Instant>,
    page_discovered: Option<tokio::time::Instant>,
}

impl InjectionDeadline {
    fn new(started: tokio::time::Instant, source: InjectionRetrySource) -> Self {
        Self {
            started,
            wait_for_window: matches!(source, InjectionRetrySource::Startup),
            endpoint_responded: None,
            page_discovered: None,
        }
    }

    /// 记录一次尝试到达的阶段：进入选择阶段说明端点已返回页面列表，进入安装阶段
    /// 说明已找到 Codex 页面。
    fn observe(&mut self, phase: InjectionPhase, attempt_started: tokio::time::Instant) {
        if phase as u8 >= InjectionPhase::InstallBridge as u8 {
            self.page_discovered.get_or_insert(attempt_started);
        } else if phase as u8 == InjectionPhase::SelectTarget as u8 {
            self.endpoint_responded = Some(attempt_started);
        }
    }

    fn at(&self) -> tokio::time::Instant {
        let fixed = self.started + CDP_INJECTION_TIMEOUT;
        if !self.wait_for_window {
            return fixed;
        }
        match (self.page_discovered, self.endpoint_responded) {
            (Some(page), _) => fixed.max(page + CDP_INJECTION_TIMEOUT),
            (None, Some(responded)) => fixed
                .max(responded + CDP_INJECTION_TIMEOUT)
                .min(self.started + CDP_WINDOW_WAIT_TIMEOUT),
            (None, None) => fixed,
        }
    }

    fn awaiting_window(&self) -> bool {
        self.wait_for_window && self.page_discovered.is_none() && self.endpoint_responded.is_some()
    }

    fn page_discovered(&self) -> Option<Duration> {
        self.page_discovered
            .map(|page| page.saturating_duration_since(self.started))
    }
}

/// 下一次重试前的等待时长。发现与选择阶段的失败通常只付一次 loopback 请求的
/// 代价，既不触碰 renderer 也不留 CDP 副作用，用小步长逼近 renderer 就绪即可。
/// 但同一阶段的失败也可能突然变贵（例如调试端口被别的服务占用而让请求挂到
/// 超时），因此还要看刚结束的那次失败的实付代价：一旦不再廉价就立刻退回保守
/// 退避。桥接安装失败要重建 WebSocket 并重放脚本，校验失败虽然复用桥接却仍要
/// 驱动一轮页面内探测，两者无论代价高低都沿用原来的指数退避。
fn next_injection_retry_delay(
    current: Duration,
    phase: InjectionPhase,
    last_failure_cost: Duration,
) -> Duration {
    if phase.is_discovery() && last_failure_cost <= DISCOVERY_RETRY_COST_BUDGET {
        return (current + DISCOVERY_RETRY_STEP).min(DISCOVERY_RETRY_MAX_INTERVAL);
    }
    (current * 2).min(BRIDGE_RETRY_MAX_INTERVAL)
}

/// 单次注入重试的失败画像：按阶段分别计数，不再把桥接安装与后续校验压缩成
/// 同一个 bucket——「注入慢」的归因直接读 failures 即可。每次启动只写一条
/// 汇总，不随重试次数增长。
#[derive(Default)]
struct InjectionRetryStats {
    attempts: u32,
    phase_failures: [u32; INJECTION_PHASE_COUNT],
    failure_expense_ms: u64,
    last_failure_phase: Option<InjectionPhase>,
    last_protocol_failure: Option<ProtocolFailure>,
    page_discovered: Option<Duration>,
}

impl InjectionRetryStats {
    fn record_failure(&mut self, phase: InjectionPhase, cost: Duration) {
        self.phase_failures[phase as usize] += 1;
        self.failure_expense_ms += cost.as_millis() as u64;
        self.last_failure_phase = Some(phase);
    }

    fn discovery_failures(&self) -> u32 {
        self.phase_failures[..=InjectionPhase::SelectTarget as usize]
            .iter()
            .sum()
    }

    fn bridge_failures(&self) -> u32 {
        self.phase_failures[InjectionPhase::InstallBridge as usize..]
            .iter()
            .sum()
    }

    fn report(
        &self,
        source: InjectionRetrySource,
        outcome: &str,
        elapsed: Duration,
        last_error: Option<&str>,
    ) {
        let failures: serde_json::Map<String, serde_json::Value> = INJECTION_PHASES
            .iter()
            .filter(|phase| self.phase_failures[**phase as usize] > 0)
            .map(|phase| {
                let index = *phase as usize;
                (
                    phase.key().to_string(),
                    serde_json::json!(self.phase_failures[index]),
                )
            })
            .collect();
        let mut detail = serde_json::json!({
            "source": source.key(),
            "outcome": outcome,
            "attempts": self.attempts,
            "discoveryFailures": self.discovery_failures(),
            "bridgeFailures": self.bridge_failures(),
            "failures": failures,
            "failureExpenseMs": self.failure_expense_ms,
            "lastFailurePhase": self.last_failure_phase.map(InjectionPhase::key),
            "totalMs": elapsed.as_millis() as u64,
            "pageDiscoveredMs": self.page_discovered.map(|elapsed| elapsed.as_millis() as u64),
            "codexAppVersion": error_log::cached_codex_app_version(),
            "protocolFailure": self.last_protocol_failure,
        });
        // 汇总文案只保留归类结果，完整错误链随最后一次尝试一起进诊断记录。
        if let Some(last_error) = last_error {
            detail["lastError"] = serde_json::json!(last_error);
        }
        let _ = codey_runtime_core::diagnostic_log::append_diagnostic_log(
            "cdp.injection_retry_summary",
            detail,
        );
    }
}

fn summarize_cdp_targets(targets: &[CdpTarget]) -> String {
    if targets.is_empty() {
        return "[]".to_string();
    }
    let visible = targets
        .iter()
        .take(6)
        .map(|target| {
            format!(
                "{{type:{},url:{:?},ws:{}}}",
                truncate_chars(&target.target_type, 20),
                safe_target_url_shape(&target.url),
                target.web_socket_debugger_url.is_some()
            )
        })
        .collect::<Vec<_>>();
    let omitted = targets.len().saturating_sub(visible.len());
    if omitted == 0 {
        format!("[{}]", visible.join(","))
    } else {
        format!("[{},+{omitted}]", visible.join(","))
    }
}

fn safe_target_url_shape(url: &str) -> String {
    let trimmed = url.trim();
    if trimmed.to_ascii_lowercase().starts_with("app://") {
        let end = trimmed
            .char_indices()
            .find_map(|(index, character)| matches!(character, '?' | '#').then_some(index))
            .unwrap_or(trimmed.len());
        return truncate_chars(&trimmed[..end], 100);
    }
    trimmed
        .split_once(':')
        .filter(|(scheme, _)| {
            !scheme.is_empty()
                && scheme.chars().all(|character| {
                    character.is_ascii_alphanumeric() || matches!(character, '+' | '-' | '.')
                })
        })
        .map(|(scheme, _)| format!("{}:", scheme.to_ascii_lowercase()))
        .unwrap_or_else(|| "<unknown>".to_string())
}

fn safe_injection_error_summary(error: &anyhow::Error) -> String {
    if let Some(failure) = error.downcast_ref::<ProtocolFailure>() {
        let reason = match failure.kind {
            FailureKind::UnsupportedMethod => "不支持此方法",
            FailureKind::InvalidParameters => "不支持此参数",
            FailureKind::ContextLost => "页面上下文已重建",
            FailureKind::Connection | FailureKind::Closed => "调试连接中断",
            FailureKind::Timeout => "命令响应超时",
            FailureKind::ScriptException => "页面脚本执行异常",
            FailureKind::InvalidMessage => "调试协议响应无效",
            FailureKind::Rejected => "调试命令被拒绝",
        };
        return format!(
            "{}：{reason}{}",
            failure.method.as_deref().unwrap_or("CDP"),
            failure
                .code
                .map(|code| format!("（{code}）"))
                .unwrap_or_default()
        );
    }
    let message = format!("{error:#}");
    if let Some((_, targets)) = message.split_once("CDP targets=") {
        let targets = targets
            .split_once(']')
            .map(|(targets, _)| format!("{targets}]"))
            .unwrap_or_else(|| "[]".to_string());
        return truncate_chars(
            &format!("未发现匹配的 Codex renderer；CDP targets={targets}"),
            MAX_INJECTION_ERROR_CHARS,
        );
    }
    let normalized = message.to_ascii_lowercase();
    if normalized.contains("failed to query cdp targets")
        || normalized.contains("枚举 codex cdp 页面失败")
    {
        "CDP 页面列表尚不可用".to_string()
    } else if normalized.contains("timed out connecting cdp websocket")
        || normalized.contains("failed to connect")
    {
        "CDP WebSocket 连接失败".to_string()
    } else if normalized.contains("timed out waiting for cdp command") {
        "CDP 命令未在单次响应预算内完成".to_string()
    } else if normalized.contains("codey 内嵌配置面板注入失败") {
        "CodeyX 浮层未就绪".to_string()
    } else if normalized.contains("codex 页面没有 cdp websocket 地址") {
        "Codex 页面缺少调试连接地址".to_string()
    } else if normalized.contains("cdp websocket closed before response") {
        let method = message
            .split_once("CDP websocket closed before response for ")
            .and_then(|(_, rest)| rest.split_once(" id ").map(|(method, _)| method.trim()));
        method.map_or_else(
            || "CDP 连接被 Codex 关闭".to_string(),
            |method| format!("CDP 连接被 Codex 关闭（{method}）"),
        )
    } else if normalized.contains("failed to send cdp command")
        || normalized.contains("failed to read cdp websocket message")
        || normalized.contains("failed to parse cdp message")
    {
        "CDP 连接中断".to_string()
    } else if normalized.contains("cdp command ") && normalized.contains(" failed: ") {
        cdp_command_failure_summary(&message).unwrap_or_else(|| "CDP 命令被 Codex 拒绝".to_string())
    } else if normalized.contains("模型请求校验未通过：") {
        // 校验脚本以 JSON 返回页面侧失败原因（"当前 Codex 暂不支持模型请求
        // 校验"、"模型请求补丁未注入"等），文案本身就是可用的归类摘要。
        message
            .lines()
            .next()
            .map(|line| truncate_chars(line, MAX_INJECTION_ERROR_CHARS))
            .unwrap_or_else(|| "模型请求校验未通过".to_string())
    } else if normalized.contains("安装 codex 模型请求校验失败")
        || normalized.contains("校验模型请求入口失败")
    {
        // 校验入口失败时页面抛出的错误（"模型请求校验尚未就绪"、"当前 Codex
        // 暂不支持模型请求校验"等）藏在 exceptionDetails 里，取出来才有定位价值。
        evaluate_exception_detail(&message).map_or_else(
            || "模型请求校验未通过".to_string(),
            |detail| format!("模型请求校验未通过：{detail}"),
        )
    } else if normalized.contains("runtime.evaluate raised an exception") {
        evaluate_exception_detail(&message).map_or_else(
            || "页面脚本执行异常".to_string(),
            |detail| format!("页面脚本执行异常：{detail}"),
        )
    } else {
        "内部注入尝试失败".to_string()
    }
}

/// 完整错误链（含 anyhow 上下文）只进诊断与错误日志，不进用户可见文案。
fn injection_failure_detail(error: &anyhow::Error) -> String {
    if let Some(failure) = error.downcast_ref::<ProtocolFailure>() {
        return serde_json::to_string(failure).expect("protocol metadata should serialize");
    }
    truncate_chars(&format!("{error:#}"), MAX_INJECTION_DETAIL_CHARS)
}

/// CDP 命令错误响应形如 `{"code":-32601,"message":"..."}`，摘出方法与
/// 协议消息比笼统的"内部注入尝试失败"更能定位是哪一步被拒绝。
fn cdp_command_failure_summary(message: &str) -> Option<String> {
    let (_, rest) = message.split_once("CDP command ")?;
    let (method, rest) = rest.split_once(" id ")?;
    let (_, error_json) = rest.split_once(" failed: ")?;
    let payload = serde_json::from_str::<serde_json::Value>(error_json.trim()).ok()?;
    let reason = payload.get("message").and_then(serde_json::Value::as_str)?;
    Some(truncate_chars(
        &format!(
            "CDP 命令 {} 被 Codex 拒绝：{}",
            method.trim(),
            reason.trim()
        ),
        MAX_INJECTION_ERROR_CHARS,
    ))
}

/// Runtime.evaluate 的 exceptionDetails 里带页面侧错误首行（注入脚本或
/// Codex 内部抛出的错误），取它比只说"执行异常"更有定位价值。
fn evaluate_exception_detail(message: &str) -> Option<String> {
    let (_, details) = message.split_once("Runtime.evaluate raised an exception: ")?;
    let payload = serde_json::from_str::<serde_json::Value>(details.trim_end()).ok()?;
    let exception = payload.get("exception")?;
    let description = exception
        .get("description")
        .and_then(serde_json::Value::as_str)?;
    let first_line = description.lines().next()?.trim();
    if first_line.is_empty() {
        return None;
    }
    // "Error: 描述" / "TypeError: 描述" 的首行去掉类型前缀，只留可读内容。
    let detail = first_line
        .split_once(": ")
        .filter(|(head, _)| {
            !head.is_empty()
                && head
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '$' | '_' | '.'))
        })
        .map(|(_, rest)| rest.trim())
        .filter(|rest| !rest.is_empty())
        .unwrap_or(first_line);
    Some(truncate_chars(detail, MAX_INJECTION_ERROR_CHARS / 2))
}

/// 已成功安装桥接、待确认浮层可用的 CDP 会话。
struct EstablishedInjection {
    target_id: String,
    websocket_url: Arc<str>,
    pump: BridgePumpHandle,
}

/// 浮层或桥接失效时重装；仍可用的会话可保留供下一轮确认。
struct VerifyFailure {
    reinstall: bool,
    error: anyhow::Error,
}

enum AttemptOutcome {
    Injected(InjectedTarget),
    Retry {
        error: anyhow::Error,
        retained: Option<EstablishedInjection>,
    },
}

async fn run_injection_attempt(
    retained: Option<EstablishedInjection>,
    debug_port: u16,
    handler: BridgeHandler,
    scripts: &PreparedInjectionScripts,
    phase: &AtomicU8,
) -> AttemptOutcome {
    let bridge = match retained.filter(|bridge| !bridge.pump.is_finished()) {
        Some(bridge) => bridge,
        // 没有可复用的桥接（首轮，或上一轮留下的桥接泵已随页面导航/目标关闭
        // 而结束）时回到发现阶段整轮重建。
        None => match establish_injection(debug_port, handler, scripts, phase).await {
            Ok(bridge) => bridge,
            Err(error) => {
                return AttemptOutcome::Retry {
                    error,
                    retained: None,
                };
            }
        },
    };
    match verify_injection(&bridge, scripts, phase).await {
        Ok(injection_statuses) => {
            let request_gate = request_gate::spawn(bridge.target_id, bridge.websocket_url.clone());
            AttemptOutcome::Injected(InjectedTarget {
                websocket_url: bridge.websocket_url,
                pump: bridge.pump,
                injection_statuses,
                request_gate,
            })
        }
        Err(failure) if failure.reinstall => {
            // 校验端明确要求重建：显式关掉这条会话，下一轮从头装桥。
            bridge.pump.close().await;
            AttemptOutcome::Retry {
                error: failure.error,
                retained: None,
            }
        }
        Err(failure) => AttemptOutcome::Retry {
            error: failure.error,
            retained: Some(bridge),
        },
    }
}

async fn establish_injection(
    debug_port: u16,
    handler: BridgeHandler,
    scripts: &PreparedInjectionScripts,
    phase: &AtomicU8,
) -> Result<EstablishedInjection> {
    phase.store(InjectionPhase::DiscoverTargets as u8, Ordering::Release);
    let targets = list_targets(debug_port)
        .await
        .context("枚举 Codex CDP 页面失败")?;
    phase.store(InjectionPhase::SelectTarget as u8, Ordering::Release);
    let target = pick_injectable_codex_page_target(&targets).with_context(|| {
        format!(
            "没有找到可注入的 Codex renderer；CDP targets={}",
            summarize_cdp_targets(&targets)
        )
    })?;
    let websocket_url: Arc<str> = Arc::from(
        target
            .web_socket_debugger_url
            .as_deref()
            .ok_or_else(|| anyhow::anyhow!("Codex 页面没有 CDP WebSocket 地址"))?,
    );
    let handler = with_lazy_loaders(handler, websocket_url.clone());
    phase.store(InjectionPhase::InstallBridge as u8, Ordering::Release);
    let pump = install_bridge(
        &websocket_url,
        codey_runtime_core::bridge::BRIDGE_BINDING_NAME,
        handler,
        &scripts.scripts,
    )
    .await
    .with_context(|| format!("向 Codex renderer {} 安装 CDP bridge 失败", target.id))?;
    Ok(EstablishedInjection {
        target_id: target.id,
        websocket_url,
        pump,
    })
}

async fn verify_injection(
    bridge: &EstablishedInjection,
    scripts: &PreparedInjectionScripts,
    phase: &AtomicU8,
) -> std::result::Result<Arc<[InjectionScriptStatus]>, VerifyFailure> {
    // 模型请求入口随 Codex 自身初始化；后台确认不影响已安装的桥接与浮层。
    phase.store(InjectionPhase::VerifyOverlay as u8, Ordering::Release);
    ensure_settings_overlay_ready(&bridge.websocket_url)
        .await
        .map_err(|error| VerifyFailure {
            // 浮层由加载器脚本同步生成，缺失说明注入脚本执行失败，只能重装。
            reinstall: true,
            error: error.context(format!(
                "验证 Codex renderer {} 的 CodeyX 浮层失败",
                bridge.target_id
            )),
        })?;
    // Status probing is diagnostic-only. Keep it out of the critical startup
    // path: the bridge and overlay checks above prove injection is usable, and
    // the existing refresh_injection_statuses command fills in the real state
    // once the UI asks for it.
    phase.store(InjectionPhase::ReadStatuses as u8, Ordering::Release);
    Ok(scripts.statuses_with_error("启动后复核注入状态"))
}

impl PreparedInjectionScripts {
    pub fn statuses_with_error(&self, error: impl Into<String>) -> Arc<[InjectionScriptStatus]> {
        let error: String = error.into();
        let error = truncate_chars(&error, MAX_INJECTION_ERROR_CHARS);
        Arc::from(
            self.descriptors
                .iter()
                .map(|descriptor| InjectionScriptStatus {
                    id: descriptor.id.clone(),
                    name: descriptor.name.clone(),
                    source: descriptor.source.to_string(),
                    visibility: descriptor.visibility.as_str().to_string(),
                    status: "unknown".to_string(),
                    detail: None,
                    error: Some(error.clone()),
                })
                .collect::<Vec<_>>(),
        )
    }
}

#[derive(Deserialize)]
struct RuntimeInjectionStatus {
    id: String,
    status: String,
    detail: Option<String>,
    error: Option<String>,
}

pub async fn read_injection_statuses(
    websocket_url: &str,
    scripts: &PreparedInjectionScripts,
) -> Result<Arc<[InjectionScriptStatus]>> {
    let result: Result<Arc<[InjectionScriptStatus]>> = async {
        let response = codey_runtime_core::bridge::evaluate_script_with_await_promise(
            websocket_url,
            &injection_status_snapshot_script(&scripts.descriptors),
            true,
        )
        .await
        .context("查询脚本注入状态失败")?;
        let payload = runtime_value(&response)
            .and_then(serde_json::Value::as_str)
            .context("脚本注入状态未返回可解析结果")?;
        let reported = serde_json::from_str::<Vec<RuntimeInjectionStatus>>(payload)
            .context("解析脚本注入状态失败")?;
        Ok(reconcile_injection_statuses(&scripts.descriptors, reported))
    }
    .await;

    match result {
        Ok(statuses) => {
            record_failed_injection_statuses(websocket_url, &statuses).await;
            Ok(statuses)
        }
        Err(error) => {
            error_log::record_failure_async(
                "injection_status_failed",
                "read_injection_statuses",
                format!("{error:#}"),
                serde_json::json!({
                    "websocketUrl": websocket_url,
                }),
            )
            .await;
            Err(error)
        }
    }
}

async fn record_failed_injection_statuses(websocket_url: &str, statuses: &[InjectionScriptStatus]) {
    for status in statuses
        .iter()
        .filter(|status| status.status == "failed" || status.error.is_some())
    {
        error_log::record_failure_async(
            "injection_script_failed",
            status.id.clone(),
            status
                .error
                .clone()
                .unwrap_or_else(|| "注入脚本报告执行失败".to_string()),
            serde_json::json!({
                "name": status.name.as_str(),
                "source": status.source.as_str(),
                "detail": status.detail.as_deref(),
                "websocketUrl": websocket_url,
            }),
        )
        .await;
    }
}

#[derive(Debug)]
pub struct ModelWhitelistRefresh {
    /// The catalog was accepted and the transport patch guarantees future
    /// `model/list` responses carry it, but no live model query existed yet
    /// to patch in place (cold renderer, picker not mounted).
    pub deferred: bool,
}

pub async fn reload_mcp_servers(websocket_url: &str) -> Result<()> {
    // 在 awaitPromise 之前确认原生适配，避免嵌套 evaluate 等待；刷新接口
    // 不依赖会话 UI 的安装，也不应触发侧栏和消息选择器的初始化。
    ensure_mcp_reload_function_ready(websocket_url).await;
    let response = codey_runtime_core::bridge::evaluate_script_with_await_promise_timeout(
        websocket_url,
        r#"(async () => {
  for (const delay of [0, 200, 500, 1000, 2000]) {
    if (delay > 0) {
      await new Promise((resolve) => window.setTimeout(resolve, delay));
    }
    if (typeof window.__codeyReloadMcpServers !== "function") continue;
    try {
      return (await window.__codeyReloadMcpServers())?.ok === true;
    } catch {
      // Retry readiness only; an attempted operation may already have applied.
      return false;
    }
  }
  return false;
})()"#,
        true,
        MCP_RELOAD_EVALUATE_TIMEOUT,
    )
    .await
    .context("请求 Codex 刷新 MCP 配置失败")?;
    anyhow::ensure!(
        runtime_value(&response).and_then(serde_json::Value::as_bool) == Some(true),
        "Codex 未确认 MCP 配置刷新"
    );
    Ok(())
}

async fn mcp_reload_function_available(websocket_url: &str) -> bool {
    codey_runtime_core::bridge::evaluate_script(
        websocket_url,
        r#"typeof window.__codeyReloadMcpServers === "function""#,
    )
    .await
    .ok()
    .and_then(|response| runtime_value(&response).and_then(serde_json::Value::as_bool))
    .unwrap_or(false)
}

async fn ensure_mcp_reload_function_ready(websocket_url: &str) {
    if mcp_reload_function_available(websocket_url).await {
        return;
    }
    let _ = codey_runtime_core::bridge::evaluate_script_with_await_promise_timeout(
        websocket_url,
        &prepared_native_runtime_load_script(),
        false,
        NATIVE_RUNTIME_INJECT_TIMEOUT,
    )
    .await;
    for delay_ms in [80_u64, 200, 500, 1000] {
        tokio::time::sleep(Duration::from_millis(delay_ms)).await;
        if mcp_reload_function_available(websocket_url).await {
            return;
        }
    }
}

pub(crate) async fn remote_control_request(
    websocket_url: &str,
    args: &serde_json::Value,
) -> Result<serde_json::Value, String> {
    // A request client is sufficient for MCP reload, but remote operations need
    // the native manager adapter. Load it before starting an awaited CDP call.
    let ready = codey_runtime_core::bridge::evaluate_script(
        websocket_url,
        r#"typeof window.__codeyRemoteControl === "function""#,
    )
    .await
    .map_err(|_| "无法连接 Codex 桌面，请检查 CodeyX 是否正在运行")?;
    if runtime_value(&ready).and_then(serde_json::Value::as_bool) != Some(true) {
        let loaded = codey_runtime_core::bridge::evaluate_script_with_await_promise_timeout(
            websocket_url,
            &prepared_native_runtime_load_script(),
            false,
            NATIVE_RUNTIME_INJECT_TIMEOUT,
        )
        .await
        .map_err(|_| "桌面会话接口加载失败，请重新连接")?;
        if runtime_value(&loaded).and_then(serde_json::Value::as_str) != Some("") {
            return Err("桌面会话接口尚未就绪，请更新或重启 CodeyX".into());
        }
    }
    let expires_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| "系统时间无效")?
        .as_millis()
        + 60_000;
    // CDP returns object references by default. Send JSON text like the other
    // structured renderer probes so both resume and create return their value.
    let script = format!(
        r#"(async () => {{
          if (typeof window.__codeyRemoteControl !== "function") return JSON.stringify({{status:"failed",message:"桌面会话接口尚未就绪，请更新或重启 CodeyX"}});
          try {{ return JSON.stringify(await window.__codeyRemoteControl({args}, {expires_at})); }}
          catch {{ return JSON.stringify({{status:"failed",message:"桌面未确认远程操作，请检查会话状态后重试"}}); }}
        }})()"#
    );
    let response = codey_runtime_core::bridge::evaluate_script_with_await_promise_timeout(
        websocket_url,
        &script,
        true,
        Duration::from_secs(65),
    )
    .await
    .map_err(|_| "桌面响应中断或超时，操作可能已提交；请先查看会话，不要重复发送".to_string())?;
    let value = runtime_value(&response)
        .and_then(serde_json::Value::as_str)
        .and_then(|payload| serde_json::from_str::<serde_json::Value>(payload).ok())
        .filter(|value| value.is_object())
        .ok_or("桌面会话接口返回了无效结果")?;
    if value["status"] == "failed" {
        return Err(value["message"]
            .as_str()
            .unwrap_or("桌面未确认远程操作")
            .to_string());
    }
    Ok(value)
}

pub async fn refresh_model_whitelist(
    websocket_url: &str,
    expected_catalog: &serde_json::Value,
) -> Result<ModelWhitelistRefresh> {
    let response = codey_runtime_core::bridge::evaluate_script_with_await_promise(
        websocket_url,
        &model_whitelist_refresh_script(expected_catalog),
        true,
    )
    .await
    .context("请求 Codex 刷新模型列表失败")?;
    verify_model_whitelist_refresh_response(&response)
}

fn model_whitelist_refresh_script(expected_catalog: &serde_json::Value) -> String {
    let expected_catalog =
        serde_json::to_string(expected_catalog).expect("model catalog should serialize");
    format!(
        r#"(async () => {{
  const expectedCatalog = {expected_catalog};
  const expectedModels = Array.isArray(expectedCatalog.models)
    ? expectedCatalog.models
    : [];
  const expectedDefaultModel = typeof expectedCatalog.default_model === "string"
    ? expectedCatalog.default_model
    : typeof expectedCatalog.model === "string"
      ? expectedCatalog.model
      : "";
  const matchesExpected = (snapshot) => (
    snapshot?.loaded === true
    && Array.isArray(snapshot.models)
    && snapshot.models.length === expectedModels.length
    && snapshot.models.every((model, index) => model === expectedModels[index])
    && snapshot.defaultModel === expectedDefaultModel
  );
  const catalogAccepted = (delivery) => (
    delivery?.responsePatchInstalled === true
    && Number(delivery.statsigClients) > 0
    && Number(delivery.notifiedClients) > 0
    && Number(delivery.pendingQueryEntries || 0) === 0
  );
  const reachedActiveModelPicker = (delivery) => (
    catalogAccepted(delivery)
    && Number(delivery.queryClients) > 0
    && Number(delivery.queryEntries) > 0
  );
  const deliverySummary = (delivery) => delivery
    ? `（statsigClients=${{Number(delivery.statsigClients)}}, notifiedClients=${{Number(delivery.notifiedClients)}}, queryClients=${{Number(delivery.queryClients)}}, queryEntries=${{Number(delivery.queryEntries)}}, pendingQueryEntries=${{Number(delivery.pendingQueryEntries || 0)}}）`
    : "";
  let snapshot = null;
  let delivery = null;
  let lastError = "模型白名单补丁尚未就绪";
  for (const delay of [0, 80, 200, 500, 1000, 2000]) {{
    if (delay > 0) {{
      await new Promise((resolve) => window.setTimeout(resolve, delay));
    }}
    const patch = window.__codeyModelWhitelistPatch;
    if (
      !patch
      || typeof patch.setCatalog !== "function"
      || typeof patch.delivery !== "function"
      || typeof patch.snapshot !== "function"
    ) {{
      lastError = "模型白名单补丁尚未就绪";
      continue;
    }}
    try {{
      const updated = await patch.setCatalog(expectedCatalog);
      snapshot = patch.snapshot();
      delivery = patch.delivery();
      if (updated !== true) {{
        lastError = "模型白名单拒绝了后端推送的目录";
      }} else if (!matchesExpected(snapshot)) {{
        lastError = "模型白名单快照与已保存配置不一致";
      }} else if (reachedActiveModelPicker(delivery)) {{
        return JSON.stringify({{ ok: true, delivered: "active", snapshot, delivery }});
      }} else if (catalogAccepted(delivery)) {{
        // Catalog is on the transport patch; waiting for a mounted picker
        // would only upgrade deferred to active while holding evaluate open.
        return JSON.stringify({{ ok: true, delivered: "deferred", snapshot, delivery }});
      }} else if (delivery?.responsePatchInstalled !== true) {{
        lastError = "模型响应补丁未安装";
      }} else if (Number(delivery.statsigClients) < 1) {{
        lastError = "未找到 Codex 的 Statsig 客户端";
      }} else if (Number(delivery.pendingQueryEntries) > 0) {{
        lastError = "Codex 已有模型查询缓存尚未更新";
      }} else {{
        lastError = "未能通知 Codex 的 Statsig 客户端";
      }}
    }} catch (error) {{
      lastError = error instanceof Error ? error.message : String(error);
    }}
  }}
  return JSON.stringify({{ ok: false, error: `${{lastError}}${{deliverySummary(delivery)}}`, snapshot, delivery }});
}})()"#
    )
}

fn verify_model_whitelist_refresh_response(
    response: &serde_json::Value,
) -> Result<ModelWhitelistRefresh> {
    let payload = runtime_value(response)
        .and_then(serde_json::Value::as_str)
        .context("Codex 模型列表热更新未返回可解析结果")?;
    let report = serde_json::from_str::<serde_json::Value>(payload)
        .context("解析 Codex 模型列表热更新结果失败")?;
    if report.get("ok").and_then(serde_json::Value::as_bool) == Some(true) {
        return Ok(ModelWhitelistRefresh {
            deferred: report.get("delivered").and_then(serde_json::Value::as_str)
                == Some("deferred"),
        });
    }
    let error = report
        .get("error")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("模型白名单刷新结果未通过校验");
    anyhow::bail!("Codex 模型列表热更新失败：{error}")
}

fn injection_status_snapshot_script(descriptors: &[InjectionScriptDescriptor]) -> String {
    let mut probes = String::from("{\n");
    for descriptor in descriptors {
        let Some(probe) = descriptor.probe.as_deref() else {
            continue;
        };
        probes.push_str(&serde_json::to_string(&descriptor.id).expect("probe id should serialize"));
        probes.push_str(": () => (");
        probes.push_str(probe);
        probes.push_str("),\n");
    }
    probes.push('}');
    format!(
        r#"(async () => {{
  const registry = window.__codeyInjectionStatus || Object.create(null);
  const probes = {probes};
  const verify = () => {{
    for (const [id, probe] of Object.entries(probes)) {{
      const entry = registry[id];
      if (!entry || !["executed", "effective", "inactive"].includes(entry.status)) continue;
      try {{
        const evidence = probe();
        const structured = evidence && typeof evidence === "object"
          && Object.prototype.hasOwnProperty.call(evidence, "effective");
        const effective = structured ? evidence.effective === true : Boolean(evidence);
        const inactive = structured && evidence.inactive === true;
        const detail = structured ? evidence.detail : evidence;
        if (effective) {{
          entry.status = "effective";
        }} else if (inactive) {{
          entry.status = "inactive";
        }}
        if (detail) entry.detail = String(detail);
      }} catch (error) {{
        entry.status = "failed";
        entry.error = String(error instanceof Error
          ? `${{error.name}}: ${{error.message}}`
          : error || "生效自检失败").slice(0, {MAX_INJECTION_ERROR_CHARS});
      }}
    }}
  }};
  const hasPendingProbe = () => Object.keys(probes)
    .some((id) => registry[id]?.status === "executed");
  verify();
  for (const delay of [50, 200, 750]) {{
    if (!hasPendingProbe()) break;
    await new Promise((resolve) => setTimeout(resolve, delay));
    verify();
  }}
  return JSON.stringify(Object.values(registry));
}})()"#
    )
}

fn reconcile_injection_statuses(
    descriptors: &[InjectionScriptDescriptor],
    reported: Vec<RuntimeInjectionStatus>,
) -> Arc<[InjectionScriptStatus]> {
    let mut reported = reported
        .into_iter()
        .map(|status| (status.id.clone(), status))
        .collect::<HashMap<_, _>>();
    Arc::from(
        descriptors
            .iter()
            .map(|descriptor| {
                let Some(status) = reported.remove(&descriptor.id) else {
                    return InjectionScriptStatus {
                        id: descriptor.id.clone(),
                        name: descriptor.name.clone(),
                        source: descriptor.source.to_string(),
                        visibility: descriptor.visibility.as_str().to_string(),
                        status: "unknown".to_string(),
                        detail: None,
                        error: Some("脚本未返回注入状态".to_string()),
                    };
                };
                let RuntimeInjectionStatus {
                    id: _,
                    status: reported_status,
                    detail,
                    error,
                } = status;
                let valid_status = matches!(
                    reported_status.as_str(),
                    "effective" | "executed" | "inactive" | "failed"
                );
                let normalized_detail = if valid_status {
                    detail
                        .map(|detail| truncate_chars(&detail, MAX_INJECTION_ERROR_CHARS))
                        .or_else(|| {
                            (reported_status == "executed").then(|| {
                                if descriptor.source == "user" {
                                    "脚本已执行，但未提供生效自检".to_string()
                                } else {
                                    "脚本已执行，但生效探针尚未通过".to_string()
                                }
                            })
                        })
                } else {
                    None
                };
                InjectionScriptStatus {
                    id: descriptor.id.clone(),
                    name: descriptor.name.clone(),
                    source: descriptor.source.to_string(),
                    visibility: descriptor.visibility.as_str().to_string(),
                    status: if valid_status {
                        reported_status
                    } else {
                        "unknown".to_string()
                    },
                    detail: normalized_detail,
                    error: if valid_status {
                        error.map(|error| truncate_chars(&error, MAX_INJECTION_ERROR_CHARS))
                    } else {
                        Some("脚本返回了未知注入状态".to_string())
                    },
                }
            })
            .collect::<Vec<_>>(),
    )
}

fn truncate_chars(value: &str, max_chars: usize) -> String {
    value.chars().take(max_chars).collect()
}

fn with_lazy_loaders(handler: BridgeHandler, websocket_url: Arc<str>) -> BridgeHandler {
    Arc::new(move |path, payload| {
        if path == SETTINGS_OVERLAY_LOAD_PATH {
            let websocket_url = websocket_url.clone();
            return Box::pin(async move {
                let settings_overlay_load_script = prepared_settings_overlay_load_script();
                let response = codey_runtime_core::bridge::evaluate_script(
                    &websocket_url,
                    &settings_overlay_load_script,
                )
                .await
                .context("按需加载 CodeyX 内嵌配置面板失败")?;
                let message = runtime_value(&response)
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("配置面板加载脚本未返回状态");
                if !message.is_empty() {
                    anyhow::bail!("CodeyX 内嵌配置面板加载失败：{message}");
                }
                Ok(serde_json::json!({ "status": "ok" }))
            });
        }

        if path == SESSION_TOOLS_LOAD_PATH {
            let websocket_url = websocket_url.clone();
            return Box::pin(async move {
                let session_tools_load_script = prepared_session_tools_load_script();
                let response = codey_runtime_core::bridge::evaluate_script(
                    &websocket_url,
                    &session_tools_load_script,
                )
                .await
                .context("按需加载 CodeyX 会话工具失败")?;
                let message = runtime_value(&response)
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("会话工具加载脚本未返回状态");
                if !message.is_empty() {
                    anyhow::bail!("CodeyX 会话工具加载失败：{message}");
                }
                Ok(serde_json::json!({ "status": "ok" }))
            });
        }

        handler(path, payload)
    })
}

pub(crate) async fn show_update_prompt(
    websocket_url: &str,
    check: &serde_json::Value,
) -> Result<()> {
    let loaded = codey_runtime_core::bridge::evaluate_script_with_await_promise_timeout(
        websocket_url,
        &prepared_settings_overlay_load_script(),
        false,
        Duration::from_secs(10),
    )
    .await?;
    if runtime_value(&loaded).and_then(serde_json::Value::as_str) != Some("") {
        anyhow::bail!("更新公告界面未能加载");
    }
    let response = codey_runtime_core::bridge::evaluate_script_with_await_promise_timeout(
        websocket_url,
        &update_prompt_script(check),
        false,
        Duration::from_secs(5),
    )
    .await?;
    if runtime_value(&response).and_then(serde_json::Value::as_bool) != Some(true) {
        anyhow::bail!("更新公告界面未能打开");
    }
    Ok(())
}

fn update_prompt_script(check: &serde_json::Value) -> String {
    format!(
        r#"(() => {{
  const overlay = window.__codeySettingsOverlay;
  if (!overlay || overlay.__codeyLazyLoader || typeof overlay.open !== "function") return false;
  overlay.open();
  const update = {check};
  window.__codeyPendingUpdatePrompt = update;
  window.dispatchEvent(new CustomEvent("codey-update-prompt"));
  return true;
}})()"#
    )
}

fn prepared_settings_overlay_load_script() -> Arc<str> {
    SETTINGS_OVERLAY_LOAD_SCRIPT
        .get_or_init(|| Arc::from(settings_overlay_load_script(SETTINGS_OVERLAY_SCRIPT)))
        .clone()
}

fn prepared_native_runtime_load_script() -> Arc<str> {
    NATIVE_RUNTIME_LOAD_SCRIPT
        .get_or_init(|| Arc::from(native_runtime_load_script(CODEX_RUNTIME_ADAPTER_SCRIPT)))
        .clone()
}

fn native_runtime_load_script(script: &str) -> String {
    format!(
        r#"(() => {{
  try {{
{script}
  }} catch (error) {{
    return String(error instanceof Error ? error.message : error);
  }}
  return window.__codeyNativeRuntime?.isActive?.() === true
    ? "" : "未生成原生接口适配";
}})()"#
    )
}

fn prepared_session_tools_load_script() -> Arc<str> {
    SESSION_TOOLS_LOAD_SCRIPT
        .get_or_init(|| Arc::from(session_tools_load_script(CODEY_SESSION_TOOLS_SCRIPT)))
        .clone()
}

fn lazy_settings_overlay_loader_script() -> &'static str {
    r#"(() => {
  const loadPath = "/internal/codey/settings-overlay/load";
  const existing = window.__codeySettingsOverlay;
  if (existing && typeof existing.toggle === "function" && !existing.__codeyLazyLoader) {
    return;
  }
  if (existing?.__codeyLazyLoader) return;

  const loadTimeoutMs = 15000;
  let loading = null;
  let opening = false;
  const formatError = (error) => error instanceof Error
    ? `${error.name}: ${error.message}`
    : String(error || "未知错误");
  const readyOverlay = () => {
    const overlay = window.__codeySettingsOverlay;
    return overlay && overlay !== proxy && typeof overlay.toggle === "function"
      ? overlay
      : null;
  };
  const requestLoad = (retried) => new Promise((resolve) => {
    resolve(window.__codexSessionDeleteBridge(loadPath, {}, { timeoutMs: loadTimeoutMs }));
  }).then((result) => {
    // 后端求值超时后页面可能已完成加载，以真实浮层为准。
    const overlay = readyOverlay();
    if (overlay) return overlay;
    if (result?.code === "bridge_reinstalled" && !retried) return requestLoad(true);
    if (!result || result.status !== "ok") {
      throw new Error(result?.message || "配置面板加载请求失败");
    }
    throw new Error(window.__codeyOverlayError || "未生成浮层控制器");
  });
  const proxy = {
    __codeyLazyLoader: true,
    close() {},
    isOpen() { return false; },
    load() {
      if (loading) return loading;
      if (typeof window.__codexSessionDeleteBridge !== "function") {
        return Promise.reject(new Error("CodeyX bridge 尚未就绪"));
      }
      loading = requestLoad(false).catch((error) => {
        const overlay = readyOverlay();
        if (overlay) return overlay;
        loading = null;
        throw error;
      });
      return loading;
    },
    open() {
      this.toggle();
    },
    toggle() {
      if (opening) return;
      opening = true;
      void this.load().then((overlay) => {
        if (typeof overlay.open === "function") overlay.open();
        else overlay.toggle();
      }).catch((error) => {
        const message = formatError(error);
        window.__codeyOverlayError = message;
        window.alert(`CodeyX 内嵌配置面板加载失败：${message}`);
      }).finally(() => {
        opening = false;
      });
    },
  };
  window.__codeySettingsOverlay = proxy;
})()"#
}

fn settings_overlay_load_script(script: &str) -> String {
    let wrapped = wrap_settings_overlay(script);
    format!(
        r#"(() => {{
  const current = window.__codeySettingsOverlay;
  if (current && typeof current.toggle === "function" && !current.__codeyLazyLoader) {{
    return "";
  }}
  if (current?.__codeyLazyLoader) delete window.__codeySettingsOverlay;
  {wrapped}
  const ready = typeof window.__codeySettingsOverlay === "object"
    && typeof window.__codeySettingsOverlay.toggle === "function"
    && !window.__codeySettingsOverlay.__codeyLazyLoader;
  if (ready) return "";
  if (current?.__codeyLazyLoader) window.__codeySettingsOverlay = current;
  return String(window.__codeyOverlayError || "未生成浮层控制器");
}})()"#
    )
}

fn wrap_settings_overlay(script: &str) -> String {
    let mut wrapped = String::from(
        r#"(() => {
  window.__codeyOverlayError = "";
  try {
"#,
    );
    wrapped.push_str(script);
    wrapped.push_str(
        r#"
  } catch (error) {
    const message = error instanceof Error
      ? `${error.name}: ${error.message}${error.stack ? `\n${error.stack}` : ""}`
      : String(error);
    window.__codeyOverlayError = message;
    console.error("[Codey] settings overlay failed to load", error);
  }
})();
"#,
    );
    wrapped
}

fn session_tools_load_script(script: &str) -> String {
    format!(
        r#"(() => {{
  if (window.__codeySessionToolsInjectLoaded === true) return "";
  window.__codeySessionToolsError = "";
  try {{
{script}
  }} catch (error) {{
    const message = error instanceof Error
      ? `${{error.name}}: ${{error.message}}${{error.stack ? `\n${{error.stack}}` : ""}}`
      : String(error);
    window.__codeySessionToolsError = message;
    window.__codeySessionToolsInjectLoading = false;
    window.__codeySessionToolsInjectLoaded = false;
    console.error("[Codey] session tools failed to load", error);
  }}
  return window.__codeySessionToolsInjectLoaded === true
    ? ""
    : String(window.__codeySessionToolsError || "未生成会话工具控制器");
}})()"#
    )
}

async fn ensure_settings_overlay_ready(websocket_url: &str) -> Result<()> {
    let ready = codey_runtime_core::bridge::evaluate_script(
        websocket_url,
        r#"typeof window.__codeySettingsOverlay === "object"
          && typeof window.__codeySettingsOverlay.toggle === "function""#,
    )
    .await
    .context("检查 CodeyX 内嵌配置面板状态失败")?;
    if runtime_value(&ready).and_then(serde_json::Value::as_bool) == Some(true) {
        return Ok(());
    }

    let error = codey_runtime_core::bridge::evaluate_script(
        websocket_url,
        r#"String(window.__codeyOverlayError || "未生成浮层控制器")"#,
    )
    .await
    .context("读取 CodeyX 内嵌配置面板异常失败")?;
    let message = runtime_value(&error)
        .and_then(serde_json::Value::as_str)
        .unwrap_or("未知错误");
    anyhow::bail!("CodeyX 内嵌配置面板注入失败：{message}")
}

fn runtime_value(response: &serde_json::Value) -> Option<&serde_json::Value> {
    response
        .get("result")
        .and_then(|value| value.get("result"))
        .and_then(|value| value.get("value"))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TargetHealth {
    Healthy,
    Unhealthy,
    Busy,
    /// 探测连接可用，但页面端点没有在 CDP 命令预算内产生任何回应。
    /// 页面忙碌时命令仍会被 renderer 排队执行并回包，完全不回应只出现在
    /// renderer 已被回收或页面重载导致 page target 被替换的情况。
    Unresponsive,
}

fn target_health_from_evaluate_response(response: &serde_json::Value) -> TargetHealth {
    match runtime_value(response).and_then(serde_json::Value::as_str) {
        Some("healthy") => TargetHealth::Healthy,
        Some("busy") => TargetHealth::Busy,
        _ => TargetHealth::Unhealthy,
    }
}

pub async fn is_target_healthy(websocket_url: &str) -> Result<TargetHealth> {
    match codey_runtime_core::bridge::evaluate_script_with_await_promise(
        websocket_url,
        bridge_health_check_script(),
        true,
    )
    .await
    {
        Ok(result) => Ok(target_health_from_evaluate_response(&result)),
        Err(error) => {
            // 探测每次都新建 CDP 连接。命令超时意味着端点收下了连接却不执行
            // 命令，与"页面忙而桥接仍在"是两种状态：前者只能重新发现 target，
            // 后者保守等待。这里把超时单独标出来，交给看门狗分级处理。
            if error
                .downcast_ref::<tokio::time::error::Elapsed>()
                .is_some()
            {
                return Ok(TargetHealth::Unresponsive);
            }
            Err(error).context("检查 CodeyX bridge 健康状态失败")
        }
    }
}

pub fn target_health_error_requires_rediscovery(error: &anyhow::Error) -> bool {
    // Renderer command deadlines are deliberately inconclusive: injecting more
    // work into a busy page can make it less responsive. A Tungstenite error,
    // however, means the saved page endpoint could not carry the probe at all
    // (including HTTP upgrade failures from a replaced CDP target), so the
    // watchdog must rediscover `/json` instead of retrying the stale URL.
    error
        .downcast_ref::<ProtocolFailure>()
        .is_some_and(ProtocolFailure::requires_reconnect)
        || error
            .downcast_ref::<tokio_tungstenite::tungstenite::Error>()
            .is_some()
}

pub fn bridge_handler<F, Fut>(handler: F) -> BridgeHandler
where
    F: Fn(String, serde_json::Value) -> Fut + Send + Sync + 'static,
    Fut: std::future::Future<Output = serde_json::Value> + Send + 'static,
{
    Arc::new(move |path, payload| {
        let future = handler(path, payload);
        Box::pin(async move { Ok(future.await) })
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn protocol_failures_select_recovery_without_exposing_remote_data() {
        for (kind, retryable, reconnect) in [
            (FailureKind::UnsupportedMethod, false, false),
            (FailureKind::InvalidParameters, false, false),
            (FailureKind::ScriptException, false, false),
            (FailureKind::InvalidMessage, false, false),
            (FailureKind::Rejected, false, false),
            (FailureKind::Connection, true, true),
            (FailureKind::Closed, true, true),
            (FailureKind::ContextLost, true, true),
            (FailureKind::Timeout, true, false),
        ] {
            let error = anyhow::Error::new(ProtocolFailure::new(
                "command",
                kind,
                Some("Runtime.evaluate"),
                Some(4),
            ))
            .context("outer context contains private data");
            assert!(safe_injection_error_summary(&error).contains("Runtime.evaluate"));
            assert!(!injection_failure_detail(&error).contains("private data"));
            assert_eq!(target_health_error_requires_rediscovery(&error), reconnect);
            assert_eq!(
                InjectionRetryFailure {
                    error,
                    detail: None
                }
                .retryable(),
                retryable
            );
        }
    }

    #[tokio::test]
    async fn unsupported_bridge_protocol_stops_after_one_install_attempt() {
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
            let body = json!([{"id":"main", "type":"page", "title":"Codex", "url":"app://-/index.html", "webSocketDebuggerUrl":format!("ws://{address}")}]).to_string();
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
            let message = socket.next().await.unwrap().unwrap();
            let command: serde_json::Value =
                serde_json::from_str(message.to_text().unwrap()).unwrap();
            assert_eq!(command["method"], "Runtime.enable");
            socket
                .send(Message::Text(
                    json!({"id":command["id"],"error":{"code":-32601,"message":"private token"}})
                        .to_string()
                        .into(),
                ))
                .await
                .unwrap();
            assert!(matches!(
                socket.next().await,
                None | Some(Err(_)) | Some(Ok(Message::Close(_)))
            ));
            assert!(
                tokio::time::timeout(Duration::from_millis(200), listener.accept())
                    .await
                    .is_err()
            );
        });
        let prepared = prepare_injection_scripts(false, false, false, &[]);
        let result = tokio::time::timeout(
            Duration::from_secs(2),
            retry_inject_with_scripts(
                address.port(),
                bridge_handler(|_, _| async { json!({}) }),
                &prepared,
                InjectionRetrySource::Startup,
            ),
        )
        .await
        .unwrap();
        let error = match result {
            Err(error) => error,
            Ok(_) => panic!("unsupported protocol must fail"),
        };
        assert!(!error.retryable());
        assert!(!error.to_string().contains("private token"));
        assert!(error.detail().unwrap().contains("-32601"));
        server.await.unwrap();
    }

    #[tokio::test]
    async fn remote_control_loads_the_adapter_before_submitting_once() {
        use futures_util::{SinkExt, StreamExt};
        use serde_json::json;

        let encoded = |value: serde_json::Value| {
            Some(json!({"result":{"type":"string","value":value.to_string()}}))
        };
        let resumed = json!({"status":"ok"});
        let created = json!({"id":"thread","firstTurn":"accepted"});
        let invalid = Err("桌面会话接口返回了无效结果".to_string());
        let interrupted =
            Err("桌面响应中断或超时，操作可能已提交；请先查看会话，不要重复发送".to_string());
        for (ready, action, payload, expected) in [
            (
                true,
                "resume",
                encoded(resumed.clone()),
                Ok(resumed.clone()),
            ),
            (false, "resume", encoded(resumed.clone()), Ok(resumed)),
            (
                true,
                "create",
                encoded(created.clone()),
                Ok(created.clone()),
            ),
            (false, "create", encoded(created.clone()), Ok(created)),
            (
                false,
                "create",
                encoded(json!({"status":"failed","message":"桌面未就绪"})),
                Err("桌面未就绪".to_string()),
            ),
            (
                true,
                "resume",
                encoded(json!({"status":"failed"})),
                Err("桌面未确认远程操作".to_string()),
            ),
            (
                true,
                "resume",
                Some(json!({"result":{"type":"object","objectId":"remote-object"}})),
                invalid.clone(),
            ),
            (
                true,
                "create",
                Some(json!({"result":{"type":"string","value":"private native detail"}})),
                invalid.clone(),
            ),
            (true, "create", encoded(json!(null)), invalid.clone()),
            (true, "resume", encoded(json!([])), invalid.clone()),
            (true, "resume", encoded(json!(true)), invalid.clone()),
            (
                true,
                "create",
                Some(json!({"result":{"type":"undefined"}})),
                invalid,
            ),
            (
                true,
                "create",
                Some(json!({"exceptionDetails":{"text":"private native error"}})),
                interrupted.clone(),
            ),
            (true, "create", None, interrupted),
        ] {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let server = tokio::spawn(async move {
                let mut loaded = ready;
                let mut submissions = 0;
                loop {
                    let (stream, _) = listener.accept().await.unwrap();
                    let mut socket = tokio_tungstenite::accept_async(stream).await.unwrap();
                    while let Some(Ok(message)) = socket.next().await {
                        let Ok(text) = message.to_text() else {
                            continue;
                        };
                        let request: serde_json::Value = serde_json::from_str(text).unwrap();
                        let evaluate = request["method"] == "Runtime.evaluate";
                        let awaited = evaluate && request["params"]["awaitPromise"] == true;
                        let result = if awaited {
                            assert!(loaded, "the adapter must load before the awaited operation");
                            submissions += 1;
                            let expression = request["params"]["expression"].as_str().unwrap();
                            assert!(expression.contains("window.__codeyRemoteControl("));
                            assert!(!expression.contains("__codeyLoadSessionTools"));
                            let deadline: u128 = expression
                                .split(", ")
                                .last()
                                .unwrap()
                                .split(')')
                                .next()
                                .unwrap()
                                .parse()
                                .unwrap();
                            let now = std::time::SystemTime::now()
                                .duration_since(std::time::UNIX_EPOCH)
                                .unwrap()
                                .as_millis();
                            assert!(deadline > now && deadline <= now + 60_000);
                            let Some(payload) = &payload else {
                                socket.close(None).await.unwrap();
                                return submissions;
                            };
                            payload.clone()
                        } else if evaluate {
                            let expression = request["params"]["expression"].as_str().unwrap();
                            if expression == r#"typeof window.__codeyRemoteControl === "function""# {
                                json!({"result":{"value":loaded}})
                            } else {
                                assert!(expression.contains("__codeyNativeRuntime"));
                                assert!(!expression.contains("__codeySessionToolsInjectLoaded"));
                                loaded = true;
                                json!({"result":{"value":""}})
                            }
                        } else {
                            json!({})
                        };
                        socket
                            .send(tokio_tungstenite::tungstenite::Message::Text(
                                json!({"id":request["id"],"result":result})
                                    .to_string()
                                    .into(),
                            ))
                            .await
                            .unwrap();
                        if awaited {
                            return submissions;
                        }
                    }
                }
            });
            let result = tokio::time::timeout(
                Duration::from_secs(10),
                remote_control_request(
                    &format!("ws://{address}"),
                    &json!({"action":action,"threadId":"thread","params":{"input":[]}}),
                ),
            )
            .await
            .unwrap();
            assert_eq!(result, expected);
            assert!(!format!("{result:?}").contains("private native"));
            assert_eq!(
                server.await.unwrap(),
                1,
                "an uncertain operation must never be replayed"
            );
        }
    }

    #[tokio::test]
    async fn mcp_reload_requires_a_confirmed_renderer_response() {
        use futures_util::{SinkExt, StreamExt};
        use serde_json::json;

        for (payload, succeeds, already_loaded) in [
            (
                json!({"result":{"type":"boolean","value":true}}),
                true,
                true,
            ),
            (
                json!({"result":{"type":"boolean","value":false}}),
                false,
                true,
            ),
            (
                json!({"exceptionDetails":{"text":"Unknown method"}}),
                false,
                true,
            ),
            (
                json!({"result":{"type":"boolean","value":true}}),
                true,
                false,
            ),
        ] {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let server = tokio::spawn(async move {
                let mut adapter_ready = already_loaded;
                loop {
                    let Ok((stream, _)) = listener.accept().await else {
                        break;
                    };
                    let mut socket = tokio_tungstenite::accept_async(stream).await.unwrap();
                    let mut finished = false;
                    while let Some(message) = socket.next().await {
                        let Ok(message) = message else {
                            break;
                        };
                        let Ok(text) = message.to_text() else {
                            continue;
                        };
                        let request: serde_json::Value = serde_json::from_str(text).unwrap();
                        let evaluate = request["method"] == "Runtime.evaluate";
                        let result = if evaluate {
                            let expression = request["params"]["expression"].as_str().unwrap();
                            let await_promise = request["params"]["awaitPromise"] == true;
                            if await_promise {
                                assert!(expression.contains("__codeyReloadMcpServers"));
                                assert!(
                                    !expression.contains("__codeyAppServerRequestClients"),
                                    "MCP client selection belongs to the native adapter"
                                );
                                assert!(
                                    !expression.contains("__codeyLoadSessionTools"),
                                    "MCP reload must not nest session-tools loading inside awaitPromise"
                                );
                                payload.clone()
                            } else if expression
                                .contains("typeof window.__codeyReloadMcpServers === \"function\"")
                            {
                                json!({"result":{"type":"boolean","value":adapter_ready}})
                            } else {
                                assert!(expression.contains("__codeyNativeRuntime"));
                                assert!(!expression.contains("__codeySessionToolsInstall"));
                                assert!(!expression.contains(SESSION_TOOLS_LOAD_PATH));
                                adapter_ready = true;
                                json!({"result":{"type":"string","value":""}})
                            }
                        } else {
                            json!({})
                        };
                        if socket
                            .send(tokio_tungstenite::tungstenite::Message::Text(
                                json!({"id":request["id"],"result":result})
                                    .to_string()
                                    .into(),
                            ))
                            .await
                            .is_err()
                        {
                            break;
                        }
                        if evaluate && request["params"]["awaitPromise"] == true {
                            finished = true;
                            break;
                        }
                    }
                    if finished {
                        break;
                    }
                }
            });
            assert_eq!(
                reload_mcp_servers(&format!("ws://{address}")).await.is_ok(),
                succeeds
            );
            server.await.unwrap();
        }
    }

    #[test]
    fn native_runtime_loader_works_without_ui_and_reports_installation_failure() {
        let scripts = [
            native_runtime_load_script(CODEX_RUNTIME_ADAPTER_SCRIPT),
            native_runtime_load_script("throw new Error('adapter failed');"),
            native_runtime_load_script(""),
        ];
        let harness = r#"
const assert = require('node:assert/strict');
const vm = require('node:vm');
const [source, broken, missing] = JSON.parse(process.argv[1]);
const context = vm.createContext({ window: {} });
assert.equal(vm.runInContext(source, context), '');
const adapter = context.window.__codeyNativeRuntime;
assert.equal(typeof context.window.__codeyReloadMcpServers, 'function');
assert.equal(typeof context.window.__codeyRemoteControl, 'function');
assert.equal(context.window.__codeySessionToolsInstall, undefined);
assert.equal(vm.runInContext(source, context), '');
assert.equal(context.window.__codeyNativeRuntime, adapter);
assert.equal(vm.runInNewContext(broken, { window: {} }), 'adapter failed');
assert.equal(vm.runInNewContext(missing, { window: {} }), '未生成原生接口适配');
"#;
        let output = std::process::Command::new("node")
            .args(["-e", harness, &serde_json::to_string(&scripts).unwrap()])
            .output()
            .expect("Node should run the generated native adapter loader");
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    #[test]
    fn user_scripts_are_attempted_once_per_document_even_after_failure() {
        let scripts = prepare_injection_scripts(
            false,
            false,
            false,
            &["window.attempts = (window.attempts || 0) + 1; if (window.fail) throw new Error('retry');".to_string()],
        );
        let harness = r#"
const assert = require('node:assert/strict');
const vm = require('node:vm');
const script = JSON.parse(process.argv[1]);
const context = () => vm.createContext({ window: {}, console: { error() {} } });
const page = context();
page.window.fail = true;
vm.runInContext(script, page);
assert.equal(page.window.__codeyInjectionStatus['user-script-1'].status, 'failed');
page.window.fail = false;
vm.runInContext(script, page);
vm.runInContext(script, page);
assert.equal(page.window.attempts, 1);
assert.equal(page.window.__codeyInjectionStatus['user-script-1'].status, 'failed');
const nextPage = context();
vm.runInContext(script, nextPage);
vm.runInContext(script, nextPage);
assert.equal(nextPage.window.attempts, 1);
"#;
        let output = std::process::Command::new("node")
            .args([
                "-e",
                harness,
                &serde_json::to_string(&scripts.scripts[1]).unwrap(),
            ])
            .output()
            .expect("Node should run the generated user script");
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    #[test]
    fn injection_deadline_leaves_time_for_slow_windows_renderer_startup() {
        assert_eq!(CDP_INJECTION_TIMEOUT, Duration::from_secs(30));
        assert_eq!(CDP_WINDOW_WAIT_TIMEOUT, Duration::from_secs(180));
    }

    #[test]
    fn startup_deadline_waits_for_a_late_window_only_while_cdp_responds() {
        let started = tokio::time::Instant::now();
        let at = |seconds: u64| started + Duration::from_secs(seconds);
        let mut deadline = InjectionDeadline::new(started, InjectionRetrySource::Startup);
        deadline.observe(InjectionPhase::DiscoverTargets, at(10));
        assert_eq!(deadline.at(), at(30));
        assert!(!deadline.awaiting_window());

        // WSL 启动策略读取期间端点返回空列表：每次响应都顺延，但有窗口等待上限。
        deadline.observe(InjectionPhase::SelectTarget, at(29));
        assert_eq!(deadline.at(), at(59));
        assert!(deadline.awaiting_window());
        deadline.observe(InjectionPhase::SelectTarget, at(170));
        assert_eq!(deadline.at(), at(180));
        // 端点不再响应时不刷新，按最后一次响应计。
        deadline.observe(InjectionPhase::DiscoverTargets, at(175));
        assert_eq!(deadline.at(), at(180));

        let mut deadline = InjectionDeadline::new(started, InjectionRetrySource::Startup);
        deadline.observe(InjectionPhase::SelectTarget, at(28));
        deadline.observe(InjectionPhase::InstallBridge, at(29));
        assert_eq!(deadline.at(), at(59));
        assert!(!deadline.awaiting_window());
        assert_eq!(deadline.page_discovered(), Some(Duration::from_secs(29)));
        // 页面发现时刻只记录一次，之后的端点响应不再延长注入预算。
        deadline.observe(InjectionPhase::VerifyRequestGate, at(50));
        deadline.observe(InjectionPhase::SelectTarget, at(55));
        assert_eq!(deadline.at(), at(59));

        let mut early = InjectionDeadline::new(started, InjectionRetrySource::Startup);
        early.observe(InjectionPhase::VerifyRequestGate, at(2));
        assert_eq!(early.at(), at(32));
    }

    #[test]
    fn watchdog_reinjection_keeps_the_fixed_deadline() {
        let started = tokio::time::Instant::now();
        let mut deadline = InjectionDeadline::new(started, InjectionRetrySource::Watchdog);
        deadline.observe(
            InjectionPhase::SelectTarget,
            started + Duration::from_secs(29),
        );
        assert_eq!(deadline.at(), started + CDP_INJECTION_TIMEOUT);
        assert!(!deadline.awaiting_window());
        deadline.observe(
            InjectionPhase::InstallBridge,
            started + Duration::from_secs(29),
        );
        assert_eq!(deadline.at(), started + CDP_INJECTION_TIMEOUT);
        assert_eq!(deadline.page_discovered(), Some(Duration::from_secs(29)));
    }

    /// 按给定阶段的退避节奏推导探测时刻（毫秒），首项为立即执行的第一次探测。
    fn probe_times(phase: InjectionPhase, count: usize) -> Vec<u64> {
        let mut delay = INITIAL_RETRY_INTERVAL;
        let mut elapsed = 0u64;
        let mut probes = vec![0];
        for _ in 0..count {
            elapsed += delay.as_millis() as u64;
            probes.push(elapsed);
            delay = next_injection_retry_delay(delay, phase, Duration::from_millis(1));
        }
        probes
    }

    #[test]
    fn discovery_retry_stays_dense_while_probes_stay_cheap() {
        assert_eq!(
            probe_times(InjectionPhase::DiscoverTargets, 5),
            vec![0, 100, 250, 450, 650, 850]
        );
        assert_eq!(
            probe_times(InjectionPhase::SelectTarget, 5),
            vec![0, 100, 250, 450, 650, 850]
        );
    }

    #[test]
    fn discovery_retry_never_exceeds_its_dense_ceiling() {
        assert_eq!(
            next_injection_retry_delay(
                Duration::from_millis(500),
                InjectionPhase::SelectTarget,
                Duration::from_millis(1)
            ),
            DISCOVERY_RETRY_MAX_INTERVAL
        );
    }

    #[test]
    fn discovery_retry_falls_back_when_a_probe_stops_being_cheap() {
        // 廉价失败：维持密集节奏。
        assert_eq!(
            next_injection_retry_delay(
                INITIAL_RETRY_INTERVAL,
                InjectionPhase::DiscoverTargets,
                Duration::from_millis(8)
            ),
            Duration::from_millis(150)
        );
        // 同阶段但单次探测已花掉 900 ms，说明失败不再廉价（例如端口被别的
        // 服务占用导致请求挂起），立刻退回指数退避而不是继续密集轮询。
        assert_eq!(
            next_injection_retry_delay(
                Duration::from_millis(200),
                InjectionPhase::DiscoverTargets,
                Duration::from_millis(900)
            ),
            Duration::from_millis(400)
        );
    }

    #[test]
    fn bridge_retry_keeps_the_original_exponential_backoff() {
        assert_eq!(
            probe_times(InjectionPhase::InstallBridge, 6),
            vec![0, 100, 300, 700, 1200, 1700, 2200]
        );
    }

    #[test]
    fn post_discovery_phases_ignore_the_dense_interval() {
        for phase in [
            InjectionPhase::InstallBridge,
            InjectionPhase::VerifyOverlay,
            InjectionPhase::ReadStatuses,
        ] {
            assert!(!phase.is_discovery());
            assert_eq!(
                next_injection_retry_delay(INITIAL_RETRY_INTERVAL, phase, Duration::from_millis(1)),
                Duration::from_millis(200)
            );
        }
    }

    #[test]
    fn dense_discovery_retry_probes_a_late_renderer_sooner() {
        let legacy = probe_times(InjectionPhase::InstallBridge, 6);
        let dense = probe_times(InjectionPhase::DiscoverTargets, 12);

        // 旧节奏在 1200 ms 之后要等到 1700 ms 才再次探测。
        assert_eq!(legacy[4], 1200);
        assert_eq!(legacy[5], 1700);
        // 新节奏在 1200~1700 ms 之间补出三个探测点，最多提前 450 ms 命中。
        assert_eq!(
            dense
                .iter()
                .copied()
                .filter(|&t| t > 1200 && t < 1700)
                .collect::<Vec<_>>(),
            vec![1250, 1450, 1650]
        );
    }

    #[test]
    fn retry_stats_separate_cheap_discovery_failures_from_bridge_failures() {
        let mut stats = InjectionRetryStats {
            attempts: 5,
            ..Default::default()
        };
        stats.record_failure(InjectionPhase::DiscoverTargets, Duration::from_millis(12));
        stats.record_failure(InjectionPhase::SelectTarget, Duration::from_millis(18));
        stats.record_failure(InjectionPhase::VerifyOverlay, Duration::from_millis(900));

        assert_eq!(stats.attempts, 5);
        assert_eq!(stats.discovery_failures(), 2);
        assert_eq!(stats.bridge_failures(), 1);
        assert_eq!(
            stats.phase_failures[InjectionPhase::VerifyOverlay as usize],
            1
        );
        assert_eq!(stats.failure_expense_ms, 930);
        assert_eq!(
            stats.last_failure_phase.map(InjectionPhase::key),
            Some("verifyOverlay")
        );
    }

    #[test]
    fn retry_source_keys_separate_startup_from_watchdog_rebuilds() {
        assert_eq!(InjectionRetrySource::Startup.key(), "startup");
        assert_eq!(InjectionRetrySource::Watchdog.key(), "watchdog");
    }

    #[test]
    fn injection_phase_keys_cover_every_variant() {
        for (phase, key) in [
            (InjectionPhase::DiscoverTargets, "discoverTargets"),
            (InjectionPhase::SelectTarget, "selectTarget"),
            (InjectionPhase::InstallBridge, "installBridge"),
            (InjectionPhase::VerifyRequestGate, "verifyRequestGate"),
            (InjectionPhase::VerifyOverlay, "verifyOverlay"),
            (InjectionPhase::ReadStatuses, "readStatuses"),
        ] {
            assert_eq!(phase.key(), key);
            assert_eq!(InjectionPhase::from_raw(phase as u8) as u8, phase as u8);
        }
    }

    #[test]
    fn cdp_target_summary_keeps_shape_but_redacts_query_and_fragment() {
        let targets = vec![CdpTarget {
            id: "page-1".to_string(),
            target_type: "page".to_string(),
            title: "private task title".to_string(),
            url: "app://-/index.html?token=secret#private".to_string(),
            web_socket_debugger_url: Some("ws://127.0.0.1/devtools/page/1".to_string()),
        }];

        let summary = summarize_cdp_targets(&targets);

        assert!(summary.contains("app://-/index.html"));
        assert!(summary.contains("ws:true"));
        assert!(!summary.contains("secret"));
        assert!(!summary.contains("private"));
        assert!(!summary.contains("task title"));
        assert!(!summary.contains("127.0.0.1"));
    }

    #[test]
    fn injection_error_summary_does_not_persist_renderer_or_script_secrets() {
        let target_error = anyhow::anyhow!(
            "没有找到 renderer；CDP targets=[{{type:page,url:\"app://-/index.html\",ws:true}}]: secret title"
        );
        let script_error = anyhow::anyhow!(
            "timed out waiting for CDP command Runtime.evaluate: token=secret stack=/private/path"
        );

        let target_summary = safe_injection_error_summary(&target_error);
        let script_summary = safe_injection_error_summary(&script_error);

        assert!(target_summary.contains("app://-/index.html"));
        assert!(!target_summary.contains("secret title"));
        assert_eq!(script_summary, "CDP 命令未在单次响应预算内完成");
        assert!(!script_summary.contains("secret"));
        assert!(!script_summary.contains("private"));
    }

    #[test]
    fn injection_error_summary_names_the_cdp_protocol_failure() {
        // installBridge 期间的协议/连接错误必须保留方法名，不再回落到
        // 笼统的"内部注入尝试失败"。
        let refused = anyhow::anyhow!(
            "向 Codex renderer page-1 安装 CDP bridge 失败: CDP command Runtime.addBinding id 3 failed: {{\"code\":-32601,\"message\":\"'Runtime.addBinding' wasn't found\"}}"
        );
        let closed = anyhow::anyhow!(
            "安装 Codex 模型请求校验失败: CDP websocket closed before response for Runtime.evaluate id 9"
        );
        let exception = anyhow::anyhow!(
            "安装 Codex 模型请求校验失败: Runtime.evaluate raised an exception: {{\"exceptionId\":1,\"text\":\"Uncaught\",\"exception\":{{\"type\":\"object\",\"description\":\"Error: 当前 Codex 暂不支持模型请求校验\\n    at <anonymous>:1:5\"}}}}"
        );

        assert_eq!(
            safe_injection_error_summary(&refused),
            "CDP 命令 Runtime.addBinding 被 Codex 拒绝：'Runtime.addBinding' wasn't found"
        );
        assert_eq!(
            safe_injection_error_summary(&closed),
            "CDP 连接被 Codex 关闭（Runtime.evaluate）"
        );
        assert_eq!(
            safe_injection_error_summary(&exception),
            "模型请求校验未通过：当前 Codex 暂不支持模型请求校验"
        );
    }

    #[test]
    fn injection_failure_detail_keeps_the_full_bounded_error_chain() {
        let error = anyhow::anyhow!("inner cause").context("outer context");
        assert_eq!(
            injection_failure_detail(&error),
            "outer context: inner cause"
        );

        let huge = anyhow::anyhow!("x".repeat(MAX_INJECTION_DETAIL_CHARS * 2));
        assert_eq!(
            injection_failure_detail(&huge).chars().count(),
            MAX_INJECTION_DETAIL_CHARS
        );
    }

    #[test]
    fn overlay_wrapper_records_runtime_errors() {
        let wrapped = wrap_settings_overlay("throw new Error('boom');");
        assert!(wrapped.contains("window.__codeyOverlayError = message"));
        assert!(wrapped.contains("throw new Error('boom');"));
    }

    #[test]
    fn extracts_runtime_evaluate_primitive_value() {
        let response = serde_json::json!({
            "result": { "result": { "type": "boolean", "value": true } }
        });
        assert_eq!(runtime_value(&response), Some(&serde_json::json!(true)));
    }

    #[test]
    fn target_health_parses_tri_state_probe_results() {
        let response = |value: serde_json::Value| {
            serde_json::json!({
                "result": { "result": { "type": "string", "value": value } }
            })
        };
        assert_eq!(
            target_health_from_evaluate_response(&response(serde_json::json!("healthy"))),
            TargetHealth::Healthy
        );
        assert_eq!(
            target_health_from_evaluate_response(&response(serde_json::json!("busy"))),
            TargetHealth::Busy
        );
        for value in ["missing", "unhealthy"] {
            assert_eq!(
                target_health_from_evaluate_response(&response(serde_json::json!(value))),
                TargetHealth::Unhealthy
            );
        }
        // Legacy boolean and missing values degrade to unhealthy, never busy,
        // so a genuinely absent bridge still triggers reinjection.
        assert_eq!(
            target_health_from_evaluate_response(&response(serde_json::json!(false))),
            TargetHealth::Unhealthy
        );
        assert_eq!(
            target_health_from_evaluate_response(&serde_json::json!({})),
            TargetHealth::Unhealthy
        );
    }

    #[test]
    fn websocket_upgrade_errors_require_target_rediscovery_but_timeouts_do_not() {
        let response = tokio_tungstenite::tungstenite::http::Response::builder()
            .status(tokio_tungstenite::tungstenite::http::StatusCode::INTERNAL_SERVER_ERROR)
            .body(Some(Vec::new()))
            .unwrap();
        let websocket_error =
            anyhow::Error::new(tokio_tungstenite::tungstenite::Error::Http(response))
                .context("failed to connect CDP websocket");
        assert!(target_health_error_requires_rediscovery(&websocket_error));

        let renderer_timeout = anyhow::anyhow!("timed out waiting for CDP command");
        assert!(!target_health_error_requires_rediscovery(&renderer_timeout));
    }

    #[tokio::test]
    async fn an_endpoint_that_answers_no_cdp_command_is_unresponsive_not_busy() {
        // An endpoint can accept the WebSocket upgrade and still never execute
        // a command; that is what a replaced page target looks like. It must
        // not be reported as a busy renderer, because "busy" tells the watchdog
        // to wait instead of rediscovering the target.
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let socket = tokio_tungstenite::accept_async(stream).await.unwrap();
            let _held = socket;
            std::future::pending::<()>().await;
        });

        assert_eq!(
            is_target_healthy(&format!("ws://{address}")).await.unwrap(),
            TargetHealth::Unresponsive,
        );

        server.abort();
    }

    #[test]
    fn model_whitelist_refresh_script_retries_and_verifies_the_expected_snapshot() {
        let script = model_whitelist_refresh_script(&serde_json::json!({
            "status": "ok",
            "model": "provider-\"quoted",
            "default_model": "provider-\"quoted",
            "models": ["gpt-5.6-sol", "provider-\"quoted"],
            "model_metadata": [{
                "model": "provider-\"quoted",
                "display_name": "Provider / provider-\"quoted",
                "provider_id": "provider",
                "source_model": "provider-\"quoted"
            }]
        }));

        assert!(script.contains("window.__codeyModelWhitelistPatch"));
        assert!(script.contains("await patch.setCatalog(expectedCatalog)"));
        assert!(script.contains("patch.delivery()"));
        assert!(script.contains("patch.snapshot()"));
        assert!(!script.contains("patch.refresh()"));
        assert!(!script.contains("/codex-model-catalog"));
        assert!(script.contains("[0, 80, 200, 500, 1000, 2000]"));
        assert!(script.contains("model_metadata"));
        assert!(script.contains(r#"provider-\"quoted"#));
        assert!(script.contains("snapshot.defaultModel === expectedDefaultModel"));
        assert!(script.contains("delivery.queryEntries"));
        assert!(script.contains("catalogAccepted"));
        assert!(script.contains("} else if (catalogAccepted(delivery)) {"));
        assert!(script.contains(
            "return JSON.stringify({ ok: true, delivered: \"deferred\", snapshot, delivery });"
        ));
        assert!(!script.contains("deferredDelivery"));
        assert!(!script.contains("Keep retrying"));
    }

    #[test]
    fn model_whitelist_refresh_response_requires_a_verified_result() {
        let success = serde_json::json!({
            "result": {
                "result": {
                    "type": "string",
                    "value": r#"{"ok":true,"delivered":"active","snapshot":{"loaded":true},"delivery":{"queryEntries":1}}"#
                }
            }
        });
        let outcome = verify_model_whitelist_refresh_response(&success).unwrap();
        assert!(!outcome.deferred);
        let mismatch = serde_json::json!({
            "result": {
                "result": {
                    "type": "string",
                    "value": r#"{"ok":false,"error":"模型白名单快照与已保存配置不一致（statsigClients=1, notifiedClients=1, queryClients=1, queryEntries=0）"}"#
                }
            }
        });
        let error = verify_model_whitelist_refresh_response(&mismatch).unwrap_err();
        assert!(format!("{error:#}").contains("快照与已保存配置不一致"));
        assert!(format!("{error:#}").contains("queryEntries=0"));
    }

    #[test]
    fn model_whitelist_refresh_response_reports_a_deferred_delivery() {
        let deferred = serde_json::json!({
            "result": {
                "result": {
                    "type": "string",
                    "value": r#"{"ok":true,"delivered":"deferred","snapshot":{"loaded":true},"delivery":{"queryEntries":0}}"#
                }
            }
        });
        let outcome = verify_model_whitelist_refresh_response(&deferred).unwrap();
        assert!(outcome.deferred);
    }

    #[test]
    fn core_scripts_share_one_cdp_document_script_and_user_scripts_stay_isolated() {
        let prepared = prepare_injection_scripts(
            true,
            false,
            false,
            &["".to_string(), "window.userScriptRan = true;".to_string()],
        );

        assert_eq!(prepared.scripts.len(), 2);
        let core = &prepared.scripts[0];
        assert!(core.contains("window.__codeyBridgeHelpersInstalled"));
        assert!(!core.contains("__codeyGitRequestGuard"));
        assert!(!core.contains("__codeyWindowsWmiSamplerGuard"));
        assert!(core.contains("window.__codeyModelWhitelistPatch"));
        assert!(core.contains("/codex-model-catalog"));
        let shared_runtime_offset = core
            .find("window.__codeySharedRuntime=Object.freeze")
            .expect("bridge helpers must initialize the shared runtime");
        let renderer_offset = core
            .find("window.__codeyRendererCoreLoaded")
            .expect("renderer bootstrap must be part of renderer-controls");
        assert!(shared_runtime_offset < renderer_offset);
        let native_runtime_offset = core.find("window.__codeyNativeRuntime").unwrap();
        let model_patch_offset = core.find("window.__codeyModelWhitelistPatch").unwrap();
        assert!(shared_runtime_offset < native_runtime_offset);
        assert!(native_runtime_offset < model_patch_offset);
        assert!(core.contains("window.__codeyRendererCoreLoaded"));
        assert!(core.contains(r#"["false"][0]==="true""#));
        assert!(core.contains(SETTINGS_OVERLAY_LOAD_PATH));
        assert!(core.contains(SESSION_TOOLS_LOAD_PATH));
        assert!(core.contains("__codeyLazyLoader"));
        assert!(!core.contains("codey-settings-overlay-host"));
        assert!(!core.contains("__codeyInstallSessionDeleteButtons"));
        assert!(core.len() < SETTINGS_OVERLAY_SCRIPT.len());
        assert!(core.contains("插件市场兼容 injection failed"));
        assert!(core.contains("window.__codeyInjectionStatus"));
        assert!(prepared.scripts[1].contains("window.userScriptRan = true;"));
        assert!(prepared.scripts[1].contains(r#"status = "executed""#));
        assert!(prepared.scripts[1].contains("用户脚本 1 injection failed"));
        assert_eq!(prepared.descriptors.len(), 15);
        assert!(core.contains("__codeyQuotaNoticeDismiss"));
        assert!(
            prepared
                .descriptors
                .iter()
                .any(|descriptor| descriptor.id == "quota-notice-dismiss")
        );
        assert!(core.contains("__codeyConversationStats"));
        assert!(
            prepared
                .descriptors
                .iter()
                .any(|descriptor| descriptor.id == "conversation-stats")
        );
        assert!(
            prepared
                .descriptors
                .iter()
                .any(|descriptor| descriptor.id == "conversation-git")
        );
        let user_script = prepared
            .descriptors
            .iter()
            .find(|descriptor| descriptor.id == "user-script-1")
            .expect("user script descriptor should be present");
        assert_eq!(user_script.source, "user");
        assert_eq!(
            prepared.descriptors[0].visibility,
            InjectionScriptVisibility::Internal
        );
        assert_eq!(prepared.descriptors[1].id, "native-runtime");
        assert_eq!(prepared.descriptors[7].id, "renderer-controls");
        assert_eq!(
            prepared.descriptors[7].visibility,
            InjectionScriptVisibility::Internal
        );
        assert!(
            prepared
                .descriptors
                .iter()
                .any(|descriptor| descriptor.id == "quota-unlock")
        );
        assert!(core.contains("__codeyQuotaUnlock"));
        assert_eq!(user_script.visibility, InjectionScriptVisibility::Feature);
        let snapshot_script = injection_status_snapshot_script(&prepared.descriptors);
        assert!(snapshot_script.contains("bridge-helpers"));
        assert!(snapshot_script.contains("effective: false"));
        assert!(snapshot_script.contains("entry.status = \"inactive\""));
        assert!(snapshot_script.contains("[\"executed\", \"effective\", \"inactive\"].includes"));
        assert!(snapshot_script.contains("Object.prototype.hasOwnProperty.call"));
        assert!(snapshot_script.contains("模型目录已加载"));
        assert!(snapshot_script.contains("插件市场桥接已接管"));
        assert!(snapshot_script.contains("for (const delay of [50, 200, 750])"));
        assert!(!snapshot_script.contains("user-script-1\": () =>"));
        let overlay_load_script = prepared_settings_overlay_load_script();
        assert!(overlay_load_script.contains("codey-settings-overlay-host"));
        assert!(overlay_load_script.contains("codey-overlay-root"));
        assert!(overlay_load_script.contains("codey-overlay-modal-container"));
        assert!(overlay_load_script.contains("@layer"));
        assert!(overlay_load_script.contains("delete window.__codeySettingsOverlay"));
        assert!(
            overlay_load_script.contains("window.__codeySettingsOverlay = current"),
            "a failed bundle evaluation must restore the lazy loader for retry"
        );
        let session_tools_load_script = prepared_session_tools_load_script();
        assert!(session_tools_load_script.contains("window.__codeySessionToolsInjectLoaded"));
        assert!(
            session_tools_load_script.contains("window.__codeySessionToolsInjectLoading = false")
        );
        // 压缩会改写内部标识符，锚点必须用不会被改名的 window 属性。
        assert!(session_tools_load_script.contains("__codeyInstallSessionDeleteButtons"));
    }

    #[test]
    fn startup_splash_runs_first_in_the_core_bundle_without_a_status_entry() {
        let prepared = prepare_injection_scripts(true, false, false, &[]);
        let core = &prepared.scripts[0];
        let splash_at = core
            .find("codey-splash__mark")
            .expect("splash markup is embedded");
        let first_status_at = core
            .find("window.__codeyInjectionStatus")
            .expect("builtin scripts follow the splash");
        assert!(splash_at < first_status_at);
        assert!(!core.contains("__CODEY_STARTUP_SPLASH__"));
        assert!(core.contains("startup splash injection failed"));
        assert!(
            prepared
                .descriptors
                .iter()
                .all(|descriptor| !descriptor.id.contains("splash"))
        );
    }

    #[test]
    fn disabled_local_router_installs_only_native_model_selection_mode() {
        let prepared = prepare_injection_scripts(false, false, false, &[]);

        assert!(
            prepared
                .descriptors
                .iter()
                .any(|descriptor| descriptor.id == "model-whitelist")
        );
        assert!(prepared.scripts[0].contains("window.__codeyNativeModelSelectionOnly = true;"));
        assert!(prepared.scripts[0].contains("window.__codeyBridgeHelpersInstalled"));
        assert!(
            prepared
                .descriptors
                .iter()
                .any(|descriptor| descriptor.id == "settings-overlay-loader")
        );
        assert!(
            !prepared
                .descriptors
                .iter()
                .any(|descriptor| descriptor.id == "quota-unlock")
        );
    }

    #[test]
    fn injection_statuses_preserve_script_order_and_report_missing_entries() {
        let prepared = prepare_injection_scripts(
            true,
            false,
            false,
            &["window.userScriptRan = true;".to_string()],
        );
        let reported = vec![
            RuntimeInjectionStatus {
                id: "user-script-1".to_string(),
                status: "failed".to_string(),
                detail: None,
                error: Some("boom".repeat(200)),
            },
            RuntimeInjectionStatus {
                id: "bridge-helpers".to_string(),
                status: "effective".to_string(),
                detail: Some("桥接函数可调用".to_string()),
                error: None,
            },
            RuntimeInjectionStatus {
                id: "security-warning-shield".to_string(),
                status: "inactive".to_string(),
                detail: Some("控制器已就绪，当前屏蔽策略关闭".to_string()),
                error: None,
            },
        ];

        let statuses = reconcile_injection_statuses(&prepared.descriptors, reported);

        assert_eq!(statuses.len(), prepared.descriptors.len());
        assert_eq!(statuses[0].id, "bridge-helpers");
        assert_eq!(statuses[0].status, "effective");
        assert_eq!(statuses[0].detail.as_deref(), Some("桥接函数可调用"));
        assert_eq!(statuses[1].id, "native-runtime");
        assert_eq!(statuses[1].status, "unknown");
        assert_eq!(statuses[2].id, "model-whitelist");
        assert_eq!(statuses[2].status, "unknown");
        assert_eq!(statuses[4].id, "security-warning-shield");
        assert_eq!(statuses[4].status, "inactive");
        assert_eq!(
            statuses.last().map(|status| status.id.as_str()),
            Some("user-script-1")
        );
        assert_eq!(
            statuses.last().map(|status| status.status.as_str()),
            Some("failed")
        );
        assert_eq!(
            statuses
                .last()
                .and_then(|status| status.error.as_deref())
                .map(str::chars)
                .map(Iterator::count),
            Some(MAX_INJECTION_ERROR_CHARS)
        );
    }

    #[test]
    fn failed_settings_overlay_bundle_restores_the_lazy_loader() {
        let script = settings_overlay_load_script("throw new Error('bundle failed');");

        let delete_index = script
            .find("delete window.__codeySettingsOverlay")
            .expect("lazy loader should be removed before evaluating the bundle");
        let restore_index = script
            .find("window.__codeySettingsOverlay = current")
            .expect("lazy loader should be restored when the bundle is not ready");

        assert!(restore_index > delete_index);
        assert!(script.contains("if (ready) return \"\""));
    }
}

import type { ConfigApplyResult, ConfigApplyStatus, ConfigSaveResult, FastContextToolsStatus, Notice, RuntimeStatus } from "../../App.types";
import { subagentUpdateNote } from "../../modelSelectionNotice";
import type { ConfigLoadResult } from "./types";

export const UNKNOWN_FAST_CONTEXT_TOOLS_STATUS: FastContextToolsStatus = {
  userConfigured: false,
  detectionFailed: true,
};

export function configLoadNotice(result: ConfigLoadResult, status: RuntimeStatus | null): Notice | null {
  const startupError = status?.startupError || result.startupError;
  const errors = [startupError && `自动启动失败：${startupError}`, result.configLoadError].filter(Boolean);
  if (errors.length > 0) return { tone: "error", text: errors.join("；") };
  const application = status?.configApply && status.configApply.settingsRevision >= result.config.settingsRevision ? status.configApply : null;
  if (application?.phase === "failed" || application?.applyError) return configApplyNotice(application);
  if (application) return configApplyNotice(application);
  if (status?.restartRequired) return { tone: "info", text: "已保存的配置需重启 Codex 后生效" };
  if (status && !status.running) return { tone: "info", text: "CodeyX 运行时已就绪" };
  return null;
}

export function configApplyNotice(status: ConfigApplyStatus): Notice {
  if (status.phase === "pending" || status.phase === "applying") {
    return { tone: "info", text: "CodeyX 设置已保存，正在后台应用，可继续修改" };
  }
  if (status.applyError) return { tone: "error", text: `CodeyX 设置已保存；${status.applyError}` };
  const notice = configSaveNotice(status, false);
  if (status.phase === "failed") return { ...notice, tone: "error" };
  if (status.phase === "applied" && notice.text === "CodeyX 设置已保存") return { ...notice, text: "CodeyX 设置已保存并应用" };
  return notice;
}

export function configSaveNotice(result: ConfigApplyResult & Pick<Partial<ConfigSaveResult>, "configApply">, retryCountChanged: boolean): Notice {
  if (result.configApply) return configApplyNotice(result.configApply);
  const subagentNote = subagentUpdateNote(result);
  const requestLogHealth = result.routeRequestLogHealth;
  const restartSuffix = result.restartRequired ? "；其他启动参数将在重启 Codex 后生效" : "";
  let tone: Notice["tone"] = result.restartRequired || result.subagentConfigHotReloadError ? "info" : "success";
  let text = result.restartRequired && !subagentNote
    ? "CodeyX 设置已保存，启动参数将在重启 Codex 后生效"
    : "CodeyX 设置已保存";
  if (result.subagentConfigRepaired) {
    text = "CodeyX 设置已保存；子代理配置已同步";
  } else if (result.subagentConfigHotReloaded) {
    text = "CodeyX 设置已保存；子代理配置已实时更新";
  }
  if (requestLogHealth === "failed") {
    tone = "error";
    text = `CodeyX 设置已保存；${result.routeRequestLogHotReloadError || "请求日志记录未能实时更新"}`;
  } else if (requestLogHealth === "superseded") {
    tone = "info";
    text = `CodeyX 设置已保存；${result.routeRequestLogHotReloadError || "请求日志配置被更新的设置取代，请确认当前开关状态"}`;
  } else if (requestLogHealth === "enabled") {
    text = `CodeyX 设置已保存；请求日志记录已实时开启，无需重启${restartSuffix}`;
  } else if (requestLogHealth === "disabled") {
    text = `CodeyX 设置已保存；请求日志记录已实时关闭，无需重启${restartSuffix}`;
  }
  if (retryCountChanged && result.restartRequired) {
    text = "CodeyX 设置已保存；会话重试次数将在重启 Codex 后生效";
  }
  if (subagentNote) {
    text += `；${subagentNote}`;
    if (tone === "success") tone = "info";
  }
  if (result.modelHotReloadError) {
    text += `；模型列表未能实时更新：${result.modelHotReloadError}`;
    if (tone === "success") tone = "info";
  }
  if (result.warning) {
    text += `；${result.warning}`;
    if (tone === "success") tone = "info";
  }
  return { tone, text };
}

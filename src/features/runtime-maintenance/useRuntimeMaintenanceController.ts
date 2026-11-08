import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { Config, Confirmation, Notice, PluginMarketplaceStatus, RuntimeStatus } from "../../App.types";
import type { DiagnosticStorageTarget } from "../../diagnosticStorage";
import { errorText } from "../../appUtils";
import { repairOperationResult } from "../../injectionRepair";
import { canRepairMainProcessInjection, isMainProcessInjectionConfirmed } from "../../runtimeStatusPresentation";
import { useStableEvent } from "../../useStableEvent";
import { runtimeMaintenanceRequests } from "./requests";
import type { DiagnosticCleanupState } from "./types";

type Options = {
  active: boolean;
  config: Config | null;
  onConfigChange: (config: Config) => void;
  dirty: boolean;
  isBusy: boolean;
  status: RuntimeStatus;
  restartStatusError: string | null;
  persist: (config: Config) => Promise<unknown>;
  refreshStatus: () => Promise<RuntimeStatus>;
  markRestartInProgress: () => void;
  setRestartStatusError: (error: string) => void;
  setStatus: Dispatch<SetStateAction<RuntimeStatus>>;
  setBusy: (name: string | null) => void;
  setNotice: (notice: Notice) => void;
  setConfirmation: (confirmation: Confirmation | null) => void;
};

export function useRuntimeMaintenanceController({ active, config, onConfigChange, dirty, isBusy, status, restartStatusError,
  persist, refreshStatus, markRestartInProgress, setRestartStatusError, setStatus, setBusy, setNotice, setConfirmation,
}: Options) {
  const [pluginMarketplaceStatus, setPluginMarketplaceStatus] = useState<PluginMarketplaceStatus | null>(null);
  const [computerUseNotice, setComputerUseNotice] = useState<Notice | null>(null);
  const [configRepairNotice, setConfigRepairNotice] = useState<Notice | null>(null);
  const [codexDirectoryNotice, setCodexDirectoryNotice] = useState<Notice | null>(null);
  const [injectionRepairRequested, setInjectionRepairRequested] = useState(false);
  const [diagnosticCleanup, setDiagnosticCleanup] = useState<DiagnosticCleanupState | null>(null);
  const mounted = useRef(false);
  const session = useRef<object | null>(null);
  const activeRef = useRef(active);
  activeRef.current = active;
  const pending = useRef(false);
  const readGeneration = useRef(0);
  const refreshPending = useRef(false);
  const timers = useRef(new Set<number>());
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      timers.current.forEach(timer => window.clearTimeout(timer));
      timers.current.clear();
    };
  }, []);
  useEffect(() => {
    session.current = active ? {} : null;
    if (!active) setDiagnosticCleanup(null);
    return () => { session.current = null; readGeneration.current++; };
  }, [active]);

  function withTimeout<T>(request: Promise<T>, timeout: number, message: string): Promise<T> {
    // 超时只停止等待，不取消或重放后台写入；卸载时清理本 controller 的定时器。
    let timer: number;
    return new Promise<T>((resolve, reject) => {
      timer = window.setTimeout(() => reject(new Error(message)), timeout);
      timers.current.add(timer);
      request.then(resolve, reject);
    }).finally(() => {
      // 每个请求只释放自己的定时器，避免影响同时进行的状态读取。
      window.clearTimeout(timer);
      timers.current.delete(timer);
    });
  }

  const refreshPluginMarketplaceStatus = useStableEvent(async (isCurrent: () => boolean = () => true) => {
    const scope = session.current;
    if (!activeRef.current || !scope) return;
    if (pending.current) { refreshPending.current = true; return; }
    refreshPending.current = false;
    const generation = ++readGeneration.current;
    const current = () => mounted.current && activeRef.current && session.current === scope
      && generation === readGeneration.current && isCurrent();
    try {
      const next = await withTimeout(runtimeMaintenanceRequests.marketplaceStatus(), 15_000, "插件市场状态查询超时");
      if (current()) setPluginMarketplaceStatus(next);
    } catch (error) {
      if (current()) setPluginMarketplaceStatus({ status: "error", needsRepair: true, message: errorText(error) });
    }
  });
  const previouslyActive = useRef(active);
  useEffect(() => {
    if (active && !previouslyActive.current) void refreshPluginMarketplaceStatus();
    previouslyActive.current = active;
  }, [active, refreshPluginMarketplaceStatus]);

  useEffect(() => {
    if (!active || !injectionRepairRequested || status.restartInProgress) return;
    setInjectionRepairRequested(false);
    const confirmed = isMainProcessInjectionConfirmed(status);
    setNotice({
      tone: status.startupError || !confirmed ? "error" : "success",
      text: status.startupError || (confirmed
        ? "主进程注入已修复，Codex 已自动重启"
        : "尚未确认主进程注入修复成功，请查看运行状态或失败提示"),
    });
  }, [active, injectionRepairRequested, status.restartInProgress, status.startupError, status.running, status.maintenance, setNotice]);

  const blocked = isBusy || (injectionRepairRequested && !restartStatusError);
  async function run(name: string, action: (current: () => boolean) => Promise<void>) {
    const scope = session.current;
    if (!activeRef.current || !scope || blocked || pending.current) return;
    pending.current = true;
    readGeneration.current++;
    const current = () => mounted.current && activeRef.current && session.current === scope;
    setBusy(name);
    try { await action(current); }
    catch (error) { if (current()) setNotice({ tone: "error", text: errorText(error) }); }
    finally {
      // 隐藏不取消后台写入；完成后释放共享忙碌状态，重开时重新读取。
      pending.current = false;
      if (mounted.current) {
        setBusy(null);
        if (refreshPending.current || !current()) void refreshPluginMarketplaceStatus();
      }
    }
  }

  const restartCodex = useStableEvent(async () => {
    if (!config) return;
    await run("restart", async current => {
      if (dirty) await persist(config);
      if (!current()) return;
      setNotice({ tone: "info", text: "正在重启 Codex，CodeyX 将自动重新拉起客户端…" });
      try {
        await withTimeout(runtimeMaintenanceRequests.restart(), 10_000,
          "重启请求超时，暂时无法确认执行状态，请点击重新查询状态");
      } catch (error) {
        if (current()) setRestartStatusError("暂时无法确认重启请求的执行状态，请点击重新查询状态");
        throw error;
      }
      if (current()) markRestartInProgress();
    });
  });

  function askRestartCodex() {
    if (!activeRef.current || blocked || pending.current) return;
    if (restartStatusError) {
      void run("restart", async current => {
        const next = await refreshStatus();
        if (current()) setNotice({ tone: next.startupError ? "error" : "info", text: next.startupError || (next.restartInProgress
          ? "Codex 仍在重启，请稍候" : (next.running ? "Codex 已运行" : "Codex 未运行")) });
      });
      return;
    }
    setConfirmation({ action: "restart", title: "重启 Codex？",
      description: "当前 Codex 客户端将被关闭并由 CodeyX 自动重新拉起，正在执行的本地任务会被中断。",
      confirmLabel: "重启 Codex", run: () => void restartCodex() });
  }

  async function repairPluginMarketplace() {
    await run("repair-plugin-marketplace", async current => {
      const result = await withTimeout(runtimeMaintenanceRequests.repairMarketplace(), 30_000, "插件市场修复超时，请稍后重试");
      if (!current()) return;
      setPluginMarketplaceStatus(result);
      setNotice(result.status === "ready"
        ? { tone: "success", text: result.configChanged || result.initializedRemote || result.configuredRemote
          ? "插件市场已修复并立即生效，无需重启 Codex" : "插件市场状态正常，无需修改" }
        : { tone: "error", text: "插件市场仍有缺失项，请检查本地市场文件后重试" });
    });
  }

  async function prepareComputerUse() {
    await run("prepare-computer-use", async current => {
      setComputerUseNotice(null);
      try {
        const result = await withTimeout(runtimeMaintenanceRequests.prepareComputerUse(), 30_000, "桌面插件准备超时，请重新打开设置检查状态");
        if (!current()) return;
        setPluginMarketplaceStatus(result);
        setComputerUseNotice(result.computerUse?.ready
          ? { tone: "success", text: "桌面插件已准备，请在 Codex 插件页面安装或更新 CodeyX Computer Use。" }
          : { tone: "error", text: "桌面插件尚未准备完整，请重新准备。" });
      } catch (error) { if (current()) setComputerUseNotice({ tone: "error", text: errorText(error) }); }
    });
  }

  const canRepairInjection = useStableEvent(() => !restartStatusError && canRepairMainProcessInjection(status));
  const performMainProcessInjectionRepair = useStableEvent(async () => {
    if (!config || !canRepairInjection()) return;
    await run("repair-main-process-injection", async current => {
      if (dirty) await persist(config);
      if (!current() || !canRepairInjection()) return;
      setNotice({ tone: "info", text: "正在退出 Codex 并修复主进程注入，成功后将自动重启…" });
      try {
        await withTimeout(runtimeMaintenanceRequests.repairInjection(), 10_000, "修复请求暂未确认，请稍后重新查询状态");
        if (!current()) return;
        setInjectionRepairRequested(true);
      } catch (error) {
        if (!current()) return;
        const result = repairOperationResult(error);
        setNotice({ tone: result.tone, text: result.text });
        // 退出客户端会断开内嵌页面连接；后端明确拒绝才不会开始修复。
        if (!result.unconfirmed) return;
        setInjectionRepairRequested(true);
      }
      markRestartInProgress();
    });
  });

  function repairMainProcessInjection() {
    const scope = session.current;
    if (!activeRef.current || !scope || blocked || pending.current || !config
      || restartStatusError || !canRepairMainProcessInjection(status)) return;
    setConfirmation({ action: "repair-main-process-injection", title: "修复主进程注入？",
      description: "将退出并重启 Codex，正在执行的本地任务会被中断。CodeyX 会先备份运行时，再开启主进程调试；修改会使 Codex 原厂签名失效，可使用备份回滚。",
      confirmLabel: "备份并修复", run: () => {
        if (session.current === scope) void performMainProcessInjectionRepair();
      } });
  }

  const repairCodexConfig = useStableEvent(async () => {
    await run("repair-codex-config", async current => {
      const report = (notice: Notice) => {
        if (!current()) return;
        setConfigRepairNotice(notice);
        setNotice(notice);
      };
      report({ tone: "info", text: "正在检查并修复 Codex 配置…" });
      try {
        const result = await runtimeMaintenanceRequests.repairConfig();
        const summary = result.message || (result.repaired ? "Codex 配置已修复" : "Codex 配置检查通过，无需修改");
        report({ tone: "success", text: [result.repaired ? "修复成功，请从 CodeyX 重启 Codex 使修改生效。" : null,
          summary, `配置文件：${result.configPath}`, result.backupPath ? `备份文件：${result.backupPath}` : null].filter(Boolean).join("\n") });
      } catch (error) {
        report({ tone: "error", text: `Codex 配置修复未完成：${errorText(error)}。请查看 CodeyX 错误日志；连接中断时可重新检查执行结果。` });
      }
    });
  });

  const adoptCodexDirectory = useStableEvent((path: string) => {
    if (config) onConfigChange({ ...config, codexAppPath: path });
  });
  const selectCodexDirectory = useStableEvent(async () => {
    if (!config) return;
    await run("select-codex-directory", async current => {
      setCodexDirectoryNotice(null);
      try {
        const path = await runtimeMaintenanceRequests.selectCodexDirectory();
        if (!current() || !path) return;
        adoptCodexDirectory(path);
        setCodexDirectoryNotice({ tone: "success", text: "目录已识别，保存后在下次启动 Codex 时使用。" });
      } catch (error) {
        if (current()) setCodexDirectoryNotice({ tone: "error", text: `未更换 Codex 目录，已保留原目录：${errorText(error)}` });
      }
    });
  });

  function askRepairCodexConfig() {
    if (!activeRef.current || blocked || pending.current) return;
    setConfirmation({ action: "repair-codex-config", title: "修复 Codex 配置？",
      description: "将检查配置文件及相关路径，修改已有配置前自动备份，并修复能够确认的问题。修复成功后，请从 CodeyX 重启 Codex 使修改生效。",
      confirmLabel: "确认修复", run: () => void repairCodexConfig() });
  }

  async function analyzeDiagnosticStorage(target: DiagnosticStorageTarget) {
    await run("clear-diagnostic-storage", async current => {
      setDiagnosticCleanup({ target, phase: "running" });
      try {
        const result = await runtimeMaintenanceRequests.clearDiagnosticStorage(target);
        if (!current()) return;
        setStatus(previous => ({ ...previous, traceLogWriteProtectionActive: result.traceLogWriteProtectionActive }));
        setDiagnosticCleanup({ target, phase: "complete", result });
      } catch (error) { if (current()) setDiagnosticCleanup({ target, phase: "failed", error: errorText(error) }); }
    });
  }

  return { pluginMarketplaceStatus, computerUseNotice, configRepairNotice, codexDirectoryNotice, selectCodexDirectory, injectionRepairRequested, diagnosticCleanup,
    refreshPluginMarketplaceStatus, askRestartCodex, repairPluginMarketplace, prepareComputerUse,
    repairMainProcessInjection, askRepairCodexConfig, analyzeDiagnosticStorage };
}

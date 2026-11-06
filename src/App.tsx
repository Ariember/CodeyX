import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  IconBrandGithub,
  IconCheck,
  IconCircleArrowUp,
  IconDeviceFloppy as Save,
  IconLayoutDashboard,
  IconLoader2 as LoaderCircle,
  IconRefresh as RefreshCw,
  IconSettings,
  IconX,
} from "@tabler/icons-react";
import { useConfigurationController } from "./features/configuration";
import { useRoutesController } from "./features/routes";
import { useDraftConfig } from "./useDraftConfig";
import { ModelPickerDialog } from "./AppDialogs";
import { SystemSettingsDialog } from "./SystemSettingsDialog";
import { FeaturePolicyCard, SubagentPolicyCard } from "./FeaturePolicyCard";
import { ModelSection } from "./ModelSection";
import { UsageAnalysisPanel } from "./features/usage-analysis";
import { OperationsPanel } from "./OperationsPanel";
import { CodeyPluginsSection } from "./features/codey-plugins";
import { BuiltinToolsPage } from "./features/builtin-tools";
import { NetworkProxyPage } from "./features/network-proxy";
import { BackupPage } from "./features/backup";
import { CodexExtensionsPage } from "./features/codex-extensions";
import { SessionsPage } from "./features/session-management";
import { DiagnosticCleanupToast, useRuntimeMaintenanceController } from "./features/runtime-maintenance";
import { useNotificationsController } from "./features/notifications";
import { errorText } from "./appUtils";
import type { DiagnosticStorageTarget } from "./diagnosticStorage";
import { PromptOptimizationCard } from "./features/prompt-optimization";
import { CodeyBrandMark, SettingsModalShell } from "./SettingsModalShell";
import { SettingsPageHeader } from "./SettingsPageHeader";
import { SettingsLayout } from "./SettingsLayout";
import { RemoteControlPanel } from "./features/remote-control";
import { useModelSelectionController } from "./features/model-selection";
import { useRuntimeStatusController } from "./features/runtime-status";
import { useAppUpdatesController } from "./features/app-updates";
import {
  NoticeLoadingText,
  NoticeToast,
  useAppNoticeController,
} from "./useAppNotice";
import {
  ConfirmationDialogHost,
  useConfirmationController,
} from "./useConfirmationDialog";
import { useStableEvent } from "./useStableEvent";
import type {
  AppProps,
  ProviderStatus,
  Config,
  ConfigSaveResult,
  Profile,
} from "./App.types";
import { Badge, Button, Tooltip } from "./components/ui";

const Check = IconCheck;
const X = IconX;

export function App({
  embedded = false,
  modalContainer,
  modalVisible = true,
  onAfterClose,
  onClose,
}: AppProps) {
  const {
    config,
    setConfig,
    dirty,
    setDirty,
    persistedConfigRef,
    canSyncCurrentProvider,
    editConfig,
    isOnlyNativeRouterToggle,
    adoptRouteConfig,
    adoptSavedConfig,
    discardDraft,
  } = useDraftConfig();
  const { status, setStatus, markRestartInProgress, refreshStatus, refreshStatusForLoad,
    restartStatusError, setRestartStatusError } =
    useRuntimeStatusController({
      active: !embedded || modalVisible,
      embedded,
    });
  const [providerStatus, setProviderStatus] = useState<ProviderStatus | null>(
    null,
  );
  const [usageAnalysisOpen, setUsageAnalysisOpen] = useState(false);
  const settingsScroll = useRef<HTMLDivElement>(null);
  const usageReturn = useRef<{ trigger: HTMLElement; scrollTop: number } | null>(null);
  const handleOpenUsageAnalysis = useCallback((trigger: HTMLElement) => {
    usageReturn.current = { trigger, scrollTop: settingsScroll.current?.scrollTop ?? 0 };
    setUsageAnalysisOpen(true);
  }, []);
  useEffect(() => {
    if (usageAnalysisOpen || !usageReturn.current) return;
    const previous = usageReturn.current;
    const frame = requestAnimationFrame(() => {
      if (settingsScroll.current) settingsScroll.current.scrollTop = previous.scrollTop;
      previous.trigger.focus({ preventScroll: true });
      usageReturn.current = null;
    });
    return () => cancelAnimationFrame(frame);
  }, [usageAnalysisOpen]);
  const [busy, setBusy] = useState<string | null>(null);
  const [systemSettingsOpen, setSystemSettingsOpen] = useState(false);
  const popupContainer = modalContainer ?? null;
  const noticeController = useAppNoticeController();
  const confirmationController = useConfirmationController();
  const setNotice = noticeController.set;
  const setConfirmation = confirmationController.set;
  useEffect(() => {
    if (restartStatusError) setNotice({ tone: "error", text: restartStatusError });
  }, [restartStatusError, setNotice]);

  const provider = providerStatus?.provider;
  const {
    pluginMarketplaceStatus, computerUseNotice, configRepairNotice, codexDirectoryNotice, selectCodexDirectory, injectionRepairRequested, diagnosticCleanup,
    refreshPluginMarketplaceStatus, askRestartCodex, repairPluginMarketplace, prepareComputerUse,
    repairMainProcessInjection, askRepairCodexConfig, analyzeDiagnosticStorage,
  } = useRuntimeMaintenanceController({
    active: !embedded || modalVisible,
    config, onConfigChange: editConfig, dirty, isBusy: busy !== null, status, restartStatusError, persist, refreshStatus,
    markRestartInProgress, setRestartStatusError, setStatus, setBusy, setNotice, setConfirmation,
  });
  const isBusy = busy !== null || (injectionRepairRequested && !restartStatusError);
  const { addNotificationChannel, updateNotificationChannel, askRemoveNotificationChannel } = useNotificationsController({
    active: !embedded || modalVisible,
    config, isBusy, onSaved: applySavedConfig, setBusy, setNotice, setConfirmation,
  });
  const configLoaded = config !== null;
  const runOperation = useCallback(
    async (name: string, action: () => Promise<void>) => {
      if (isBusy) return;
      setBusy(name);
      try {
        await action();
      } catch (error) {
        setNotice({ tone: "error", text: errorText(error) });
      } finally {
        setBusy(null);
      }
    },
    [isBusy, setNotice],
  );
  const operationsStatus = useMemo(
    () => ({
      running: status.running,
      codexAppVersion: status.codexAppVersion,
      clientPlatform: status.clientPlatform,
      restartRequired: status.restartRequired,
      restartInProgress: status.restartInProgress,
      codexAppPath: status.codexAppPath,
      maintenance: status.maintenance,
      injectionScripts: status.injectionScripts,
      fastContextToolsActive: status.fastContextToolsActive,
      subagentOptimizationActive: status.subagentOptimizationActive,
      notificationChannelsActive: status.notificationChannelsActive,
      activeNotificationChannelCount: status.activeNotificationChannelCount,
      traceLogWriteProtectionActive: status.traceLogWriteProtectionActive,
      crashpadDiskProtectionActive: status.crashpadDiskProtectionActive,
      featurePolicy: status.featurePolicy,
    }),
    [
      status.running,
      status.codexAppVersion,
      status.clientPlatform,
      status.restartRequired,
      status.restartInProgress,
      status.codexAppPath,
      status.maintenance,
      status.injectionScripts,
      status.fastContextToolsActive,
      status.subagentOptimizationActive,
      status.notificationChannelsActive,
      status.activeNotificationChannelCount,
      status.traceLogWriteProtectionActive,
      status.crashpadDiskProtectionActive,
      status.featurePolicy,
    ],
  );
  const {
    subagentModelOptions,
    modelState,
    modelEditorState,
    officialOnly,
    setModelState,
    modelPickerVisible,
    modelPickerLoading,
    setModelPickerVisible,
    beginModelPickerLoad,
    completeModelPickerLoad,
    cancelModelPickerLoad,
    customModelInput,
    modelInputError,
    modelSyncWarning,
    draftAutoReviewSupported,
    setDraftAutoReviewSupported,
    draftModelSet,
    draftModelContexts,
    updateDraftModelContext,
    draftReasoningEfforts,
    reasoningEffortAutoByModel,
    modelPickerReasoningCapabilities,
    updateDraftReasoningEffort,
    resetDraftReasoningEffort,
    draftManualThirdPartyModelKeys,
    thirdPartyModelOptions,
    toggleDraftModel,
    deleteDraftThirdPartyModel,
    updateCustomModelInput,
    addCustomModel,
    saveModelSelection,
  } = useModelSelectionController({
    active: !embedded || modalVisible,
    config,
    currentProvider: provider ?? null,
    officialAccountAvailable: status.officialAccountAvailable === true,
    runOperation,
    adoptRouteConfig,
    setDirty,
    setStatus,
    setNotice,
  });
  const configuration = useConfigurationController({
    active: !embedded || modalVisible,
    status,
    config, isBusy, persistedConfigRef, adoptRouteConfig, adoptSavedConfig, setDirty,
    setBusy, setNotice, setProviderStatus, setModelState, setStatus,
    refreshStatus, refreshStatusForLoad, refreshPluginMarketplaceStatus,
  });
  const { load, loadFailed, fastContextToolsStatus, saveCurrent } = configuration;

  function persist(next: Config): Promise<ConfigSaveResult> {
    return configuration.persist(next);
  }

  function applySavedConfig(result: ConfigSaveResult, submitted?: Config): boolean {
    return configuration.applySavedConfig(result, submitted);
  }

  const {
    saveRoute, setRouteEnabled, reorderRoute, reorderRouteModels, requestDeleteRoute,
    fetchRouteModels, saveOfficialRouteSettings, setRouteDefaultModel, handleOfficialAccountsChanged,
    toggleLocalRouter, toggleRouteRequestLog,
  } = useRoutesController({
    active: !embedded || modalVisible,
    config, dirty, isBusy, provider, setConfig, setDirty, persistedConfigRef,
    isOnlyNativeRouterToggle, adoptRouteConfig, onConfigChange: editConfig,
    modelState, setModelState, beginModelPickerLoad, completeModelPickerLoad, cancelModelPickerLoad,
    setProviderStatus, setStatus, setNotice, setConfirmation, runOperation, persist,
  });
  const {
    automaticallyChecking,
    updateResult,
    updateCheck,
    downloadedUpdate,
    checkForUpdates,
    changeUpdatePolicy,
    changeUpdateDownloadSource,
  } = useAppUpdatesController({
    active: !embedded || modalVisible,
    embedded,
    configLoaded,
    config,
    onConfigChange: editConfig,
    codeyUpdatePolicy: persistedConfigRef.current?.codeyUpdatePolicy ?? "stable",
    isBusy,
    setBusy,
    setNotice,
    setConfirmation,
    beforeInstall: async () => {
      if (config && dirty) await persist(config);
    },
  });

  function closeSettings() {
    if (isBusy) return;
    discardDraft();
    setModelPickerVisible(false);
    setUsageAnalysisOpen(false);
    usageReturn.current = null;
    setConfirmation(null);
    onClose?.();
  }

  function requestCloseSettings() {
    if (isBusy) return;
    if (!dirty) {
      closeSettings();
      return;
    }
    setConfirmation({
      action: "discard-settings-changes",
      title: "放弃未保存的更改？",
      description: "关闭后将丢弃尚未保存的配置修改。你可以取消关闭，继续编辑或保存。",
      confirmLabel: "放弃更改并关闭",
      run: closeSettings,
    });
  }

  const handleCloseSettings = useStableEvent(requestCloseSettings);
  const handleSaveCurrent = useStableEvent(() => void saveCurrent());
  const handleRepairPluginMarketplace = useStableEvent(
    () => void repairPluginMarketplace(),
  );
  const handlePrepareComputerUse = useStableEvent(
    () => void prepareComputerUse(),
  );
  const handleRestartCodex = useStableEvent(askRestartCodex);
  const handleRepairMainProcessInjection = useStableEvent(
    () => void repairMainProcessInjection(),
  );
  const handleFooterUpdateClick = useStableEvent(() => void checkForUpdates());
  const handleConfigChange = useStableEvent(editConfig);
  const handleAddNotificationChannel = useStableEvent(addNotificationChannel);
  const handleNotificationChannelChange = useStableEvent(
    updateNotificationChannel,
  );
  const handleRequestRemoveNotificationChannel = useStableEvent(
    askRemoveNotificationChannel,
  );
  const handleSaveRoute = useStableEvent(saveRoute);
  const handleSetRouteEnabled = useStableEvent(setRouteEnabled);
  const handleReorderRoute = useStableEvent(reorderRoute);
  const handleReorderRouteModels = useStableEvent(reorderRouteModels);
  const handleDeleteRoute = useStableEvent(requestDeleteRoute);
  const handleFetchRouteModels = useStableEvent((route: Profile) => {
    void fetchRouteModels(route);
  });
  const handleToggleLocalRouter = useStableEvent(toggleLocalRouter);
  const handleToggleRouteRequestLog = useStableEvent(toggleRouteRequestLog);
  const handleNotice = useStableEvent(
    (notice: { tone: "success" | "info" | "error"; text: string }) => setNotice(notice),
  );
  const handleSaveOfficialRouteSettings = useStableEvent(
    saveOfficialRouteSettings,
  );
  const handleSetRouteDefaultModel = useStableEvent(
    (routeId: string, model: string) => {
      void setRouteDefaultModel(routeId, model);
    },
  );
  const handleAnalyzeDiagnosticStorage = useStableEvent(
    (target: DiagnosticStorageTarget) => void analyzeDiagnosticStorage(target),
  );
  const handleModelPickerOpenChange = useStableEvent((open: boolean) => {
    if (!isBusy || open) setModelPickerVisible(open);
  });
  if (!config || !provider) {
    const loadingContent = (
      <main className="app-shell loading-shell">
        <div className="codey-card loading-card">
          <div className="loading-mark"><CodeyBrandMark /></div>
          <div className="loading-copy">
            <div role="status" aria-live="polite" aria-atomic="true">
              <strong>{loadFailed ? "CodeyX 加载失败" : "正在载入 CodeyX"}</strong>
              <p>
                <NoticeLoadingText controller={noticeController} />
              </p>
            </div>
            {loadFailed && (
              <div className="flex flex-wrap gap-2 mt-3">
                <Button variant="outline" size="sm" disabled={isBusy} onClick={askRepairCodexConfig}>
                  {busy === "repair-codex-config" ? <LoaderCircle className="animate-spin" aria-hidden="true" /> : <RefreshCw aria-hidden="true" />}
                  {busy === "repair-codex-config" ? "检查修复中…" : "修复 Codex 配置"}
                </Button>
                <Button variant="secondary" size="sm" disabled={isBusy} onClick={() => void load()}>
                  重新检查
                </Button>
              </div>
            )}
          </div>
          {!loadFailed && <LoaderCircle
            className="animate-spin motion-reduce:animate-none loading-animate-spin"
            size={16}
            aria-hidden="true"
          />}
        </div>
        <ConfirmationDialogHost
          container={popupContainer}
          controller={confirmationController}
        />
      </main>
    );
    return embedded ? (
      <SettingsModalShell
        afterClose={onAfterClose}
        container={modalContainer}
        onCancel={handleCloseSettings}
        title="CodeyX 配置"
        visible={modalVisible}
      >
        {loadingContent}
      </SettingsModalShell>
    ) : (
      loadingContent
    );
  }

  const hasUpdate =
    updateCheck?.updateAvailable === true &&
    Boolean(updateCheck.selectedAsset);
  const isCheckingUpdate = busy === "check-update" || automaticallyChecking;
  const isDownloadingUpdate = busy === "download-update";
  const isInstallingUpdate = busy === "install-update";
  const updateTooltipText = downloadedUpdate
    ? `新版本 v${downloadedUpdate.latestVersion} 已下载，点击检查更新并安装`
    : hasUpdate
      ? `发现新版本 v${updateCheck?.latestVersion}，点击重新检查并更新`
      : isCheckingUpdate
        ? "正在检查更新…"
        : updateResult?.text
          ? `${updateResult.text}（点击再次检查）`
          : "检查 CodeyX 在线更新";

  const configHeaderContent = (
    <div className="grid w-full min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-5 max-[760px]:gap-2.5">
      <div className="flex min-w-0 items-center gap-3 justify-self-start max-[760px]:gap-2">
        <CodeyBrandMark />
        <div className="flex min-w-0 flex-col">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <h1 className="m-0 whitespace-nowrap text-base font-bold tracking-[-0.02em] text-[var(--codey-text,#1d1d1f)]">CodeyX 控制台</h1>
            {dirty && (
              <Badge variant="warning">
                未保存更改
              </Badge>
            )}
          </div>
          <p className="m-0 mt-0.5 text-[11px] text-[var(--codey-muted,#6e6e73)] max-[760px]:hidden">管理 Codex 线路、模型服务、运行策略与诊断日志</p>
        </div>
      </div>

      <div className="flex min-w-0 items-center gap-4 justify-self-end">
        <div className="flex items-center gap-2">
          {embedded && (
            <Button
              aria-label={restartStatusError ? "重新查询状态" : status.running ? "重启 Codex" : "Codex 未运行"}
              className="h-8! whitespace-nowrap px-3 text-xs max-[520px]:w-8! max-[520px]:px-0!"
              disabled={isBusy || (!restartStatusError && (status.restartInProgress || !status.running))}
              onClick={handleRestartCodex}
              variant={status.restartRequired || restartStatusError ? "warning" : "outline"}
            >
              {busy === "restart" || (status.restartInProgress && !restartStatusError) ? (
                <LoaderCircle className="animate-spin" size={14} aria-hidden="true" />
              ) : (
                <RefreshCw size={14} aria-hidden="true" />
              )}
              <span className="max-[520px]:hidden">
                {restartStatusError ? "重新查询状态" : status.running ? "重启 Codex" : "未运行"}
              </span>
            </Button>
          )}
          <Button
            aria-label={dirty ? "保存更改" : "已保存"}
            className="h-8! min-w-[84px] px-3 text-xs max-[520px]:min-w-8! max-[520px]:w-8! max-[520px]:px-0!"
            disabled={!dirty || isBusy}
            onClick={handleSaveCurrent}
            variant={dirty ? "default" : "secondary"}
          >
            {busy === "save" ? (
              <LoaderCircle className="animate-spin" size={14} aria-hidden="true" />
            ) : dirty ? (
              <Save size={14} aria-hidden="true" />
            ) : (
              <Check size={14} aria-hidden="true" />
            )}
            <span className="max-[520px]:hidden">
              {dirty ? "保存更改" : "已保存"}
            </span>
          </Button>
          {embedded && (
            <Button
              aria-label="关闭配置"
              className="size-8! flex-none p-0! rounded-full! max-[520px]:size-8! max-[520px]:p-0!"
              disabled={isBusy}
              onClick={handleCloseSettings}
              size="icon"
              variant="ghost"
            >
              <X size={15} aria-hidden="true" />
            </Button>
          )}
        </div>
      </div>
    </div>
  );

  const appContent = (
    <main className={`app-shell${embedded ? " embedded" : ""}`}>
      <a className="skip-link" href={usageAnalysisOpen ? "#usage-analysis-title" : "#codey-settings-content"}>
        {usageAnalysisOpen ? "跳至用量分析" : "跳至设置内容"}
      </a>

      {!embedded && (
        <div className="macos-titlebar">
          <div className="macos-traffic-lights">
            <Button
              variant="ghost"
              size="icon"
              className="size-3! min-w-3! rounded-full! border! border-[rgb(var(--codey-ink-rgb,0,0,0))]/15! bg-[#ff5f56]! p-0! shadow-none! hover:opacity-85"
              title="关闭"
              aria-label="关闭窗口"
            />
            <Button
              variant="ghost"
              size="icon"
              className="size-3! min-w-3! rounded-full! border! border-[rgb(var(--codey-ink-rgb,0,0,0))]/15! bg-[#ffbd2e]! p-0! shadow-none! hover:opacity-85"
              title="最小化"
              aria-label="最小化窗口"
            />
            <Button
              variant="ghost"
              size="icon"
              className="size-3! min-w-3! rounded-full! border! border-[rgb(var(--codey-ink-rgb,0,0,0))]/15! bg-[#27c93f]! p-0! shadow-none! hover:opacity-85"
              title="缩放"
              aria-label="全屏缩放"
            />
          </div>
          <div className="macos-titlebar-title">
            <span className="app-title-text">CodeyX Control Panel</span>
          </div>
          <div className="macos-titlebar-right" aria-hidden="true" />
        </div>
      )}

      {!embedded && (
        <header className="z-30 flex flex-col border-b border-[rgb(var(--codey-ink-rgb,0,0,0))]/8 bg-[var(--codey-surface,#fff)]/75 px-5 py-2.5 backdrop-blur-xl shadow-[0_3px_8px_rgba(0,0,0,0.04),0_1px_2px_rgba(0,0,0,0.02)]">
          {configHeaderContent}
        </header>
      )}

      {usageAnalysisOpen && (
        <div className="page-scroll">
          <UsageAnalysisPanel active={!embedded || modalVisible} onBack={() => setUsageAnalysisOpen(false)} />
        </div>
      )}
      <SettingsLayout
        hidden={usageAnalysisOpen}
        contentRef={settingsScroll}
        sidebarFooter={
          <div className="sidebar-footer-bar">
            <div className="sidebar-footer-left">
              <span className="sidebar-footer-version font-mono">
                v{status.appVersion || "1.0.0"}
                {(updateCheck?.updateAvailable === true || Boolean(downloadedUpdate)) && (
                  <span
                    className="ml-1.5 inline-flex shrink-0"
                    role="img"
                    aria-label={downloadedUpdate ? "新版本已下载，待安装" : "有新版本可用"}
                    title={downloadedUpdate ? "新版本已下载，待安装" : "有新版本可用"}
                  >
                    <span className="size-1.5 rounded-full bg-[var(--codey-red)]" aria-hidden="true" />
                  </span>
                )}
              </span>
            </div>

            <div className="sidebar-footer-right">
              <Tooltip content={updateTooltipText} position="top">
                <Button
                  size="icon-sm"
                  variant="ghost"
                  className="sidebar-footer-icon-btn"
                  disabled={isBusy && !isCheckingUpdate}
                  aria-label={updateTooltipText}
                  onClick={handleFooterUpdateClick}
                >
                  {isCheckingUpdate || isDownloadingUpdate || isInstallingUpdate ? (
                    <LoaderCircle className="animate-spin" size={14} aria-hidden="true" />
                  ) : downloadedUpdate ? (
                    <IconCheck size={14} className="text-success" aria-hidden="true" />
                  ) : hasUpdate ? (
                    <span className="relative inline-flex items-center justify-center">
                      <IconCircleArrowUp size={15} className="text-primary" aria-hidden="true" />
                      <span className="absolute -top-0.5 -right-0.5 size-1.5 rounded-full bg-primary animate-pulse" />
                    </span>
                  ) : (
                    <IconCircleArrowUp size={15} aria-hidden="true" />
                  )}
                </Button>
              </Tooltip>
              {embedded && (
                <Tooltip content="GitHub 仓库" position="top">
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    className="sidebar-footer-icon-btn"
                    aria-label="打开 CodeyX GitHub 仓库"
                    onClick={() => window.open("https://github.com/Ariember/CodeyX", "_blank", "noopener,noreferrer")}
                  >
                    <IconBrandGithub size={15} aria-hidden="true" />
                  </Button>
                </Tooltip>
              )}
              <Tooltip content="系统设置与偏好" position="top">
                <Button
                  size="icon-sm"
                  variant="ghost"
                  className="sidebar-footer-icon-btn"
                  aria-label="系统设置与偏好"
                  onClick={() => setSystemSettingsOpen(true)}
                >
                  <IconSettings size={15} aria-hidden="true" />
                </Button>
              </Tooltip>
            </div>
          </div>
        }
        sections={{
          overview: (active) => (
            <>
              <SettingsPageHeader
                id="overview-title"
                title="基础功能"
                icon={<IconLayoutDashboard size={15} />}
                description="查看 Codex 运行状态，管理客户端功能与通知。"
              />
              <OperationsPanel
                codexAppPath={config.codexAppPath}
                fastContextToolsStatus={fastContextToolsStatus}
                status={operationsStatus}
                busy={busy}
                isBusy={isBusy}
                pluginMarketplaceStatus={pluginMarketplaceStatus}
                onRepairPluginMarketplace={handleRepairPluginMarketplace}
                onPrepareComputerUse={handlePrepareComputerUse}
                computerUseNotice={computerUseNotice}
                onRepairMainProcessInjection={handleRepairMainProcessInjection}
                onRepairCodexConfig={askRepairCodexConfig}
                configRepairNotice={configRepairNotice}
                injectionRepairing={injectionRepairRequested || busy === "repair-main-process-injection"}
                onRestart={handleRestartCodex}
                restartStatusUnknown={Boolean(restartStatusError)}
                showRestartAction={!embedded}
              />
              <FeaturePolicyCard
                active={active && (!embedded || modalVisible)}
                config={config}
                runtimeStatus={status}
                isMacClient={status.clientPlatform === "macos"}
                isWindowsClient={status.clientPlatform === "windows"}
                cleanupBusy={busy === "clear-diagnostic-storage"}
                onAnalyzeDiagnosticStorage={handleAnalyzeDiagnosticStorage}
                popupContainer={popupContainer}
                isBusy={isBusy}
                onConfigChange={handleConfigChange}
                onAddChannel={handleAddNotificationChannel}
                onChannelChange={handleNotificationChannelChange}
                onRequestRemoveChannel={handleRequestRemoveNotificationChannel}
              />
            </>
          ),
          models: (active) => (
            <ModelSection
              active={active && (!embedded || modalVisible)}
              config={config}
              runtimeStatus={status}
              currentProvider={provider ?? null}
              officialAccountAvailable={status.officialAccountAvailable === true}
              popupContainer={popupContainer}
              modelState={modelState}
              dirty={dirty}
              canSyncCurrentProvider={canSyncCurrentProvider}
              isBusy={isBusy}
              busy={busy}
              showAccountUsageInHeader={config.showAccountUsageInHeader}
              subagentModelOptions={subagentModelOptions}
              onToggleLocalRouter={handleToggleLocalRouter}
              onToggleRouteRequestLog={handleToggleRouteRequestLog}
              onOpenUsageAnalysis={handleOpenUsageAnalysis}
              onSaveRoute={handleSaveRoute}
              onSetRouteEnabled={handleSetRouteEnabled}
              onReorderRoute={handleReorderRoute}
              onReorderRouteModels={handleReorderRouteModels}
              onDeleteRoute={handleDeleteRoute}
              onFetchRouteModels={handleFetchRouteModels}
              onOfficialAccountsChanged={handleOfficialAccountsChanged}
              onNotice={handleNotice}
              onSaveOfficialRouteSettings={handleSaveOfficialRouteSettings}
              onSetDefaultModel={handleSetRouteDefaultModel}
              onConfigChange={handleConfigChange}
              onRequestConfirmation={setConfirmation}
            />
          ),
          prompt: (active) => (
            <PromptOptimizationCard
              active={active && (!embedded || modalVisible)}
              config={config}
              isBusy={isBusy}
              subagentModelOptions={subagentModelOptions}
              onConfigChange={handleConfigChange}
              onNotice={setNotice}
            />
          ),
          subagents: (
            <SubagentPolicyCard
              config={config}
              isBusy={isBusy}
              subagentModelOptions={subagentModelOptions}
              onConfigChange={handleConfigChange}
            />
          ),
          remote: (active) => <RemoteControlPanel active={active} />,
          network: (active) => <NetworkProxyPage active={active && (!embedded || modalVisible)}
            config={config} isBusy={isBusy} onConfigChange={handleConfigChange} />,
          sessions: (active) => <SessionsPage active={active} isBusy={isBusy} onRestart={handleRestartCodex} container={popupContainer} />,
          backup: (active) => <BackupPage active={active && (!embedded || modalVisible)} isBusy={isBusy}
            dirty={dirty} setBusy={setBusy} onSaved={applySavedConfig} onReload={load} container={popupContainer} />,
          tools: (active) => (
            <BuiltinToolsPage active={active} config={config} fastContextToolsStatus={fastContextToolsStatus}
              isBusy={isBusy} onConfigChange={handleConfigChange} />
          ),
          plugins: (active) => <CodeyPluginsSection active={active && (!embedded || modalVisible)} container={popupContainer} />,
          mcp: (active) => (
            <CodexExtensionsPage kind="mcp" active={active && (!embedded || modalVisible)} container={popupContainer} />
          ),
          skills: (active) => (
            <CodexExtensionsPage kind="skill" active={active && (!embedded || modalVisible)} container={popupContainer} />
          ),
        }}
      />

      <NoticeToast controller={noticeController} />
      <DiagnosticCleanupToast state={diagnosticCleanup} />

      <ModelPickerDialog
        open={modelPickerVisible}
        routeConfigReadOnly={config?.localRouterEnabled === false}
        officialOnly={officialOnly}
        isBusy={isBusy}
        busy={busy}
        container={popupContainer}
        customModelInput={customModelInput}
        modelInputError={modelInputError}
        modelSyncWarning={modelSyncWarning}
        loading={modelPickerLoading}
        autoReviewSupported={draftAutoReviewSupported}
        reasoningEffortCapabilities={modelPickerReasoningCapabilities}
        thirdPartyModelOptions={thirdPartyModelOptions}
        modelState={modelEditorState}
        draftModelSet={draftModelSet}
        draftModelContexts={draftModelContexts}
        draftReasoningEfforts={draftReasoningEfforts}
        reasoningEffortAutoByModel={reasoningEffortAutoByModel}
        onUpdateDraftModelContext={updateDraftModelContext}
        onUpdateDraftReasoningEffort={updateDraftReasoningEffort}
        onResetDraftReasoningEffort={resetDraftReasoningEffort}
        manualThirdPartyModelKeys={draftManualThirdPartyModelKeys}
        onOpenChange={handleModelPickerOpenChange}
        onCustomModelInputChange={updateCustomModelInput}
        onAddCustomModel={addCustomModel}
        onToggleDraftModel={toggleDraftModel}
        onDeleteThirdPartyModel={deleteDraftThirdPartyModel}
        onAutoReviewSupportedChange={setDraftAutoReviewSupported}
        onSave={saveModelSelection}
      />

      <ConfirmationDialogHost
        container={popupContainer}
        controller={confirmationController}
      />

      <SystemSettingsDialog
        open={systemSettingsOpen}
        onOpenChange={setSystemSettingsOpen}
        container={popupContainer}
        appVersion={status.appVersion}
        codexAppVersion={status.codexAppVersion}
        codexAppPath={config.codexAppPath || status.codexAppPath}
        isBusy={isBusy}
        busy={busy}
        onRepairCodexConfig={askRepairCodexConfig}
        configRepairNotice={configRepairNotice}
        onSelectCodexDirectory={selectCodexDirectory}
        codexDirectoryNotice={codexDirectoryNotice}
        codeyUpdatePolicy={config.codeyUpdatePolicy}
        onCodeyUpdatePolicyChange={changeUpdatePolicy}
        codeyUpdateDownloadSource={config.codeyUpdateDownloadSource ?? "github"}
        onCodeyUpdateDownloadSourceChange={changeUpdateDownloadSource}
      />
    </main>
  );
  return embedded ? (
    <SettingsModalShell
      afterClose={onAfterClose}
      container={modalContainer}
      header={
        <div className="flex w-full items-center overflow-visible">
          {configHeaderContent}
        </div>
      }
      onCancel={handleCloseSettings}
      visible={modalVisible}
    >
      {appContent}
    </SettingsModalShell>
  ) : (
    appContent
  );
}

import { useEffect, useRef, type Dispatch, type SetStateAction } from "react";
import type { Config, ConfigSaveResult, Confirmation, ModelContextConfig, Notice, OfficialAccountsResult, Profile, ProviderStatus, RuntimeStatus } from "../../App.types";
import type { useDraftConfig } from "../../useDraftConfig";
import type { useModelSelectionController } from "../model-selection";
import { SETTINGS_OPENED_EVENT } from "../runtime-status";
import { useStableEvent } from "../../useStableEvent";
import { errorText } from "../../appUtils";
import { modelIdsEqual } from "../../modelIds";
import { prefixedRouteName } from "../../routeShortNames";
import { customContextRestoredNote } from "../../modelSelectionNotice";
import { routeRequests, rememberOfficialAccounts } from "./requests";
import { thirdPartyRouteModelState } from "./state";
import type { RouteResult } from "./types";

type Options = Pick<ReturnType<typeof useDraftConfig>,
  "config" | "dirty" | "setConfig" | "setDirty" | "persistedConfigRef" | "isOnlyNativeRouterToggle" | "adoptRouteConfig"
> & Pick<ReturnType<typeof useModelSelectionController>, "modelState" | "setModelState" | "beginModelPickerLoad" | "completeModelPickerLoad" | "cancelModelPickerLoad"> & {
  active: boolean;
  isBusy: boolean;
  provider: ProviderStatus["provider"] | undefined;
  onConfigChange: (config: Config) => void;
  setProviderStatus: Dispatch<SetStateAction<ProviderStatus | null>>;
  setStatus: Dispatch<SetStateAction<RuntimeStatus>>;
  setNotice: (notice: Notice) => void;
  setConfirmation: (confirmation: Confirmation | null) => void;
  runOperation: (name: string, action: () => Promise<void>) => Promise<void>;
  persist: (config: Config) => Promise<ConfigSaveResult>;
};

export function useRoutesController({ active, config, dirty, isBusy, provider, setConfig, setDirty,
  persistedConfigRef, isOnlyNativeRouterToggle, adoptRouteConfig, onConfigChange,
  modelState, setModelState, beginModelPickerLoad, completeModelPickerLoad, cancelModelPickerLoad,
  setProviderStatus, setStatus, setNotice, setConfirmation, runOperation, persist,
}: Options) {
  const mounted = useRef(true);
  const refreshGeneration = useRef(0);
  const operationLocked = useRef(false);
  const refreshPending = useRef(false);
  const activeRef = useRef(active);
  activeRef.current = active;
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; refreshGeneration.current++; };
  }, []);

  const refreshRoutes = useStableEvent(async () => {
    if (!activeRef.current) return;
    if (operationLocked.current) { refreshPending.current = true; return; }
    refreshPending.current = false;
    const generation = ++refreshGeneration.current;
    try {
      const result = await routeRequests.load();
      if (!mounted.current || !activeRef.current || generation !== refreshGeneration.current) return;
      const merged = adoptRouteConfig(result.config);
      if (!merged) return;
      setDirty(merged.dirty);
      if (result.providerStatus) setProviderStatus(result.providerStatus);
      if (result.modelState) setModelState(result.modelState);
    } catch {
      // 被动刷新不清空已有配置；主动操作仍通过统一错误提示报告失败。
    }
  });
  const previouslyActive = useRef(active);
  useEffect(() => {
    if (active && !previouslyActive.current) void refreshRoutes();
    previouslyActive.current = active;
    if (!active) return;
    const refresh = () => { void refreshRoutes(); };
    window.addEventListener("codey:plugin-routes-changed", refresh);
    window.addEventListener(SETTINGS_OPENED_EVENT, refresh);
    return () => {
      refreshGeneration.current++;
      window.removeEventListener("codey:plugin-routes-changed", refresh);
      window.removeEventListener(SETTINGS_OPENED_EVENT, refresh);
    };
  }, [active, refreshRoutes]);

  async function runRouteOperation(name: string, action: () => Promise<void>) {
    if (!activeRef.current || isBusy || operationLocked.current) return;
    operationLocked.current = true;
    refreshGeneration.current++;
    try { await runOperation(name, action); }
    finally {
      operationLocked.current = false;
      if (mounted.current && refreshPending.current) void refreshRoutes();
    }
  }

  function applyRouteResult(result: RouteResult) {
    if (!mounted.current) return false;
    const merged = adoptRouteConfig(result.config);
    if (!merged) return false;
    refreshGeneration.current++;
    if (result.providerStatus) setProviderStatus(result.providerStatus);
    if (result.modelState) setModelState(result.modelState);
    if (typeof result.restartRequired === "boolean") {
      setStatus((current) => ({ ...current, restartRequired: result.restartRequired }));
    }
    setDirty(merged.dirty);
    window.dispatchEvent(new CustomEvent("codey:config-changed", { detail: { config: result.config } }));
    return true;
  }

  const handleOfficialAccountsChanged = useStableEvent((result: OfficialAccountsResult) => {
    if (!mounted.current) return;
    if (result.config && !applyRouteResult({ config: result.config, modelState: result.modelState, restartRequired: result.restartRequired })) return;
    rememberOfficialAccounts(result);
    if (typeof result.officialAccountAvailable === "boolean") {
      setStatus((current) => ({ ...current, officialAccountAvailable: result.officialAccountAvailable }));
    }
  });

  const toggleLocalRouter = useStableEvent((enabled: boolean) => {
    if (!config || !mounted.current || !active || isBusy || operationLocked.current) return;
    onConfigChange({ ...config, localRouterEnabled: enabled });
    setNotice({ tone: "info", text: enabled
      ? "保存并重启 Codex 后开启本地路由"
      : "保存并重启 Codex 后关闭本地路由" });
  });
  const toggleRouteRequestLog = useStableEvent((enabled: boolean) => {
    if (!config || !mounted.current || !active || isBusy || operationLocked.current) return;
    onConfigChange({ ...config, routeRequestLog: { ...config.routeRequestLog, enabled,
      ...(enabled ? { backend: "sqlite" as const } : {}) } });
    setNotice({ tone: "info", text: enabled
      ? "保存后开启日志记录，无需重启"
      : "保存后关闭日志记录，无需重启" });
  });

  async function syncCurrentProvider() {
    if (!config || isBusy) return;
    const nativeMode = config.localRouterEnabled === false;
    const shouldPersistNativeToggle = Boolean(nativeMode && dirty && isOnlyNativeRouterToggle(config));
    if (dirty && !shouldPersistNativeToggle) return;
    await runRouteOperation("sync-provider", async () => {
      if (shouldPersistNativeToggle) await persist(config);
      if (!mounted.current) return;
      const session = nativeMode ? beginModelPickerLoad(provider?.official ? null : provider?.id ?? null, false) : 0;
      try {
        const result = await routeRequests.sync();
        if (!mounted.current) return;
        if (!applyRouteResult(result)) {
          if (nativeMode) cancelModelPickerLoad(session);
          return;
        }
        if (nativeMode) completeModelPickerLoad(session,
          result.providerStatus.provider.official ? result.modelState : { ...result.modelState, officialModels: [], officialModelIds: [] },
          "", result.providerStatus.provider.official ? null : result.providerStatus.provider.id);
        setNotice({ tone: result.restartRequired ? "info" : "success", text: nativeMode
          ? `已同步当前线路「${result.providerStatus.provider.name}」，请勾选要启用的模型`
          : result.restartRequired ? "已重新读取 Codex 配置，重启后应用当前线路" : "已重新读取 Codex 配置" });
      } catch (error) {
        if (mounted.current && nativeMode) completeModelPickerLoad(session,
          provider?.official ? modelState : { ...modelState, officialModels: [], officialModelIds: [] },
          `自动同步失败：${errorText(error)}。请重试以读取当前账号可用模型。`, provider?.official ? null : provider?.id ?? null);
        throw error;
      }
    });
  }

  async function saveRoute(route: Profile) {
    if (!config) return false;
    let saved = false;
    await runRouteOperation("save-route", async () => {
      const routeExists = config.profiles.some((profile) => profile.id === route.id);
      const result = await persist({ ...config, profiles: routeExists
        ? config.profiles.map((profile) => profile.id === route.id ? route : profile)
        : [...config.profiles, route] });
      saved = true;
      if (!mounted.current) return;
      setNotice({ tone: result.configApply || result.restartRequired ? "info" : "success", text: result.configApply
        ? `线路「${route.name}」已保存，正在后台应用`
        : result.restartRequired
        ? `线路「${route.name}」已保存，重启 Codex 后注册新的接入配置`
        : `线路「${route.name}」已保存，模型选择器已刷新` });
    });
    return saved;
  }

  async function setRouteEnabled(routeId: string, enabled: boolean) {
    if (!config || dirty || isBusy || !config.localRouterEnabled) return false;
    const route = config.profiles.find((profile) => profile.id === routeId);
    if (!route) return false;
    let saved = false;
    await runRouteOperation("set-route-enabled", async () => {
      const result = await routeRequests.setEnabled(routeId, enabled, config.settingsRevision);
      saved = true;
      if (!mounted.current) return;
      if (!applyRouteResult(result)) return;
      const reloadError = result.modelHotReloadError || result.subagentConfigHotReloadError;
      setNotice({ tone: reloadError || result.restartRequired ? "info" : "success",
        text: `线路「${route.name}」已${enabled ? "启用" : "停用"}${reloadError ? `，部分运行配置未更新：${reloadError}` : result.restartRequired ? "，重启 Codex 后完全生效" : ""}` });
    });
    return saved;
  }

  async function reorderRoute(sourceId: string, targetId: string) {
    if (!config || dirty || isBusy || !config.localRouterEnabled) return;
    const profiles = [...config.profiles];
    const sourceIndex = profiles.findIndex((profile) => profile.id === sourceId);
    const targetIndex = profiles.findIndex((profile) => profile.id === targetId);
    if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) return;
    if ((profiles[sourceIndex].enabled === false) !== (profiles[targetIndex].enabled === false)) return;
    profiles.splice(targetIndex, 0, profiles.splice(sourceIndex, 1)[0]);
    await runRouteOperation("reorder-routes", async () => {
      await persist({ ...config, profiles });
      if (mounted.current) setNotice({ tone: "success", text: "线路顺序已保存" });
    });
  }

  async function reorderRouteModels(routeId: string, models: string[]) {
    if (!config || dirty || isBusy || !config.localRouterEnabled) return;
    const route = config.profiles.find((profile) => profile.id === routeId);
    if (!route) return;
    await runRouteOperation("reorder-route-models", async () => {
      const result = await routeRequests.reorderModels(routeId, models, config.settingsRevision);
      if (!mounted.current) return;
      if (!applyRouteResult(result)) return;
      setNotice(result.modelHotReloadError
        ? { tone: "info", text: `模型顺序已保存，但模型列表未刷新：${result.modelHotReloadError}` }
        : { tone: "success", text: "模型顺序已保存" });
    });
  }

  async function deleteRoute(routeId: string) {
    if (!config || dirty) return;
    await runRouteOperation("delete-route", async () => {
      const result = await routeRequests.remove(routeId, config.settingsRevision);
      if (!mounted.current) return;
      if (!applyRouteResult(result)) return;
      setNotice({ tone: result.modelHotReloaded === false ? "info" : "success", text: "线路已删除，相关模型已从选择器移除" });
    });
  }

  function requestDeleteRoute(routeId: string) {
    if (!config || isBusy || operationLocked.current) return;
    const persisted = persistedConfigRef.current;
    const persistedRoute = persisted?.profiles.some((profile) => profile.id === routeId);
    if (!persistedRoute) {
      const profiles = config.profiles.filter((profile) => profile.id !== routeId);
      if (profiles.length === 0) return;
      const next = { ...config, activeProfileId: config.activeProfileId === routeId ? profiles[0].id : config.activeProfileId, profiles };
      setConfig(next);
      setDirty(!persisted || JSON.stringify({ ...next, settingsRevision: 0 }) !== JSON.stringify({ ...persisted, settingsRevision: 0 }));
      return;
    }
    if (dirty) { setNotice({ tone: "info", text: "请先保存或放弃当前更改，再删除已保存线路" }); return; }
    const route = config.profiles.find((profile) => profile.id === routeId);
    setConfirmation({ action: "delete-route", title: `删除线路「${route ? prefixedRouteName(route) : "未命名线路"}」？`,
      description: "该线路及其模型选择会立即从对话模型选择器移除。此操作无法撤销。", confirmLabel: "删除线路", run: () => void deleteRoute(routeId) });
  }

  async function fetchRouteModels(route: Profile) {
    if (!config) return;
    if (!config.localRouterEnabled) { await syncCurrentProvider(); return; }
    await runRouteOperation("fetch-route-models", async () => {
      const savedConfig = config;
      const savedRoute = savedConfig.profiles.find((profile) => profile.id === route.id);
      if (!savedRoute) throw new Error("找不到要同步模型的线路");
      const session = beginModelPickerLoad(savedRoute.id, savedRoute.supportsAutoReview === true);
      try {
        const result = await routeRequests.fetchModels(savedRoute.id, savedConfig.settingsRevision);
        if (!mounted.current) return;
        if (!applyRouteResult(result)) { cancelModelPickerLoad(session); return; }
        completeModelPickerLoad(session, savedRoute.authMode === "officialAccount"
          ? result.routeModelState : { ...result.routeModelState, officialModels: [], officialModelIds: [] }, "", savedRoute.id,
          result.config.profiles.find((profile) => profile.id === savedRoute.id)?.supportsAutoReview === true);
      } catch (error) {
        if (!mounted.current) return;
        const warning = savedRoute.authMode === "officialAccount"
          ? `自动同步失败：${errorText(error)}。请重试以读取当前账号可用模型。`
          : `自动同步失败：${errorText(error)}。仍可手动录入当前线路支持的模型 ID。`;
        completeModelPickerLoad(session, savedRoute.authMode === "officialAccount" ? modelState : thirdPartyRouteModelState(savedConfig, savedRoute, modelState), warning, savedRoute.id, savedRoute.supportsAutoReview === true);
        setNotice({ tone: "error", text: "模型同步失败，已打开手动配置" });
      }
    });
  }

  async function saveOfficialRouteSettings(routeId: string, models: string[], showAccountUsageInHeader: boolean, enabled: boolean,
    modelContexts: Record<string, ModelContextConfig> | undefined,
    routeSettings?: { accountId: string; routeName: string; routeShortName: string; baseUrl: string },
  ) {
    if (!config) return false;
    const profile = config.profiles.find((candidate) => candidate.id === routeId);
    if (!profile || profile.authMode !== "officialAccount") return false;
    if (models.length === 0) { setNotice({ tone: "info", text: "官方账号线路至少需要保留一个模型" }); return false; }
    let saved = false;
    await runRouteOperation("save-official-route-settings", async () => {
      const modelResult = await routeRequests.saveOfficial({ routeId, models, enabled, showAccountUsageInHeader,
        ...(modelContexts === undefined ? {} : { modelContexts }),
        ...routeSettings });
      saved = true;
      if (!mounted.current) return;
      if (!applyRouteResult(modelResult)) return;
      if (routeSettings) handleOfficialAccountsChanged(modelResult);
      const restartNote = modelResult.restartRequired ? "，重启 Codex 后完全生效" : "，模型与额度展示已更新";
      const warning = modelResult.warning || modelResult.modelHotReloadError || modelResult.subagentConfigHotReloadError;
      setNotice({ tone: warning || modelResult.restartRequired || modelResult.customContextsRestored ? "info" : "success",
        text: `官方账号设置已保存${warning ? `；${warning}` : restartNote}${customContextRestoredNote(modelResult)}` });
    });
    return saved;
  }

  async function setRouteDefaultModel(routeId: string, model: string) {
    if (!config) return;
    const profile = config.profiles.find((candidate) => candidate.id === routeId);
    if (!profile) return;
    const providerId = profile.sourceProviderId || profile.id;
    const configuredOfficialModels = config.selectedModelsByProvider[providerId] || [];
    const enabledModels = profile.authMode === "officialAccount"
      ? configuredOfficialModels.length > 0 ? configuredOfficialModels : modelState.officialModelIds
      : [...(config.selectedModelsByProvider[providerId] || []), ...(config.declaredOfficialModelsByProvider[providerId] || [])];
    if (!enabledModels.some((candidate) => modelIdsEqual(candidate, model))) {
      setNotice({ tone: "error", text: `模型 ${model} 不属于该线路` }); return;
    }
    await runRouteOperation("save-default-model", async () => {
      const result = await routeRequests.setDefaultModel(routeId, model);
      if (!mounted.current) return;
      if (!applyRouteResult(result)) return;
      setNotice({ tone: result.restartRequired ? "info" : "success", text: `已将全局默认模型设为「${profile.name} / ${model}」` });
    });
  }

  return { saveRoute, setRouteEnabled, reorderRoute, reorderRouteModels, requestDeleteRoute,
    fetchRouteModels, saveOfficialRouteSettings, setRouteDefaultModel, handleOfficialAccountsChanged,
    toggleLocalRouter, toggleRouteRequestLog };
}

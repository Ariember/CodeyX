import { memo, useCallback, useEffect, useState } from "react";
import {
  IconCheck as Check,
  IconAdjustmentsHorizontal,
  IconArchive,
  IconBolt,
  IconChartDonut,
  IconCpu,
  IconEdit as Edit,
  IconEye,
  IconEyeOff,
  IconFileText,
  IconGitCommit,
  IconGripVertical,
  IconInfoCircle,
  IconListDetails,
  IconPlus as Plus,
  IconRefresh as RefreshCw,
  IconRoute,
  IconServer as Server,
  IconShieldCheck,
  IconSparkles,
  IconTrash as Trash,
  IconWorld,
} from "@tabler/icons-react";

import type { Confirmation, Config, ModelState, OfficialAccount, OfficialAccountsResult, Profile, ProviderStatus, RuntimeStatus } from "./App.types";
import { OfficialAccountsPanel } from "./OfficialAccountsPanel";
import { SettingsPageHeader } from "./SettingsPageHeader";
import { ModelCombobox } from "./components/ModelCombobox";
import { ModelSettingsFields } from "./components/ModelSettingsFields";
import type { SubagentModelOption } from "./subagentModels";
import {
  Badge,
  Button,
  Checkbox,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  NumberInput,
  PasswordInput,
  Select,
  Switch,
  Tooltip,
} from "./components/ui";
import { modelIdsEqual, modelKey, moveModelId } from "./modelIds";
import { MAX_ROUTE_NAME_CHARACTERS } from "./officialRouteSettings";
import { routeProviderId } from "./modelRoutes";
import { maskEmail, maskUrl } from "./sensitiveText";
import {
  MAX_ROUTE_SHORT_NAME_CHARACTERS,
  prefixedRouteName,
} from "./routeShortNames";
import { accountForRoute as findRouteAccount, NewApiImport, useRouteCatalogController, useRouteEditorController, useRoutePanelController, type RouteEditorActions } from "./features/routes";
import { readHostTheme } from "./overlayTheme";
import { getRouteCompactionStatus } from "./remoteCompactionStatus";

type ModelSectionProps = RouteEditorActions & {
  config: Config;
  runtimeStatus?: RuntimeStatus;
  currentProvider: ProviderStatus["provider"] | null;
  officialAccountAvailable: boolean;
  popupContainer: HTMLElement | null;
  /** 该页是否正显示在设置里：额度等官方数据只在打开「线路与模型」时获取。 */
  active: boolean;
  modelState: ModelState;
  dirty: boolean;
  canSyncCurrentProvider: boolean;
  isBusy: boolean;
  busy: string | null;
  showAccountUsageInHeader: boolean;
  subagentModelOptions?: SubagentModelOption[];
  onToggleLocalRouter: (checked: boolean) => void;
  onToggleRouteRequestLog: (checked: boolean) => void;
  onOpenUsageAnalysis: (trigger: HTMLElement) => void;
  onSetRouteEnabled: (routeId: string, enabled: boolean) => Promise<boolean>;
  onReorderRoute: (sourceId: string, targetId: string) => Promise<void>;
  onReorderRouteModels: (routeId: string, models: string[]) => Promise<void>;
  onDeleteRoute: (routeId: string) => void;
  onFetchRouteModels: (route: Profile) => void;
  onOfficialAccountsChanged: (result: OfficialAccountsResult) => void;
  onNotice: (notice: { tone: "success" | "info" | "error"; text: string }) => void;
  onSetDefaultModel: (routeId: string, model: string) => void;
  onConfigChange?: (config: Config) => void;
  onRequestConfirmation?: (confirmation: Confirmation) => void;
};

type RouteModelRef = { routeId: string; model: string };

const routeProtocolOptions: Array<{
  label: string;
  value: Profile["upstreamProtocol"];
}> = [
  { label: "OpenAI Responses", value: "openaiResponses" },
  { label: "OpenAI Chat Completions", value: "openaiChatCompletions" },
  { label: "Anthropic Messages", value: "anthropicMessages" },
  { label: "Gemini", value: "gemini" },
];

const REQUIRED_FIELD_MARKER = <span aria-hidden="true" className="text-[var(--codey-red,#d70015)]">*</span>;

function ModelSectionComponent({
  config,
  runtimeStatus,
  currentProvider,
  officialAccountAvailable,
  popupContainer,
  active,
  modelState,
  dirty,
  canSyncCurrentProvider,
  isBusy: externalBusy,
  busy,
  showAccountUsageInHeader,
  subagentModelOptions = [],
  onToggleLocalRouter,
  onToggleRouteRequestLog,
  onOpenUsageAnalysis,
  onSaveRoute,
  onSetRouteEnabled,
  onReorderRoute,
  onReorderRouteModels,
  onDeleteRoute,
  onFetchRouteModels,
  onOfficialAccountsChanged,
  onNotice,
  onSaveOfficialRouteSettings,
  onSetDefaultModel,
  onConfigChange,
  onRequestConfirmation,
}: ModelSectionProps) {
  const [draggedRouteId, setDraggedRouteId] = useState<string | null>(null);
  const [dropRouteId, setDropRouteId] = useState<string | null>(null);
  // 模型只能在所属线路内拖动排序，因此拖动状态同时记录线路和模型。
  const [draggedModel, setDraggedModel] = useState<RouteModelRef | null>(null);
  const [dropModel, setDropModel] = useState<RouteModelRef | null>(null);
  const [routeApiKeyVisible, setRouteApiKeyVisible] = useState(false);
  // 脱敏只作用于当前页面显示，每次进入页面默认关闭。
  const [maskSensitive, setMaskSensitive] = useState(false);
  const routeConfigReadOnly = !config.localRouterEnabled;

  const { officialAccounts, refreshOfficialAccounts, adoptOfficialAccounts,
    handleOfficialAccountsChanged, openRequestLogs } = useRoutePanelController({
      active, readOnly: routeConfigReadOnly, onAccountsChanged: onOfficialAccountsChanged, onNotice,
    });

  const { officialCatalog, officialDisplayNames, visibleProfiles, modelGroupByProviderId,
    totalModelCount, pendingRouteToggle, handleToggleRouteEnabled } = useRouteCatalogController({
      active, config, currentProvider, modelState, officialAccountAvailable, isBusy: externalBusy,
      dirty, onSetRouteEnabled, onNotice,
    });
  const { routeDraft, routeDialogOpen, routeValidationAttempted, routeDraftErrors, routeDraftHasErrors,
    officialRouteDraft, officialRouteDraftErrors, officialDialogScope, officialModelDraft, officialModelDraftKeys,
    officialModelContextDraft, draftOfficialAccount, headerDialogProfile, routeHeadersText, headerError, saving,
    openNewRouteDialog, openRouteDialog, updateRouteDraft, changeProtocol, importConnection, updateOfficialRouteDraft,
    toggleOfficialModel, updateOfficialModelContext, openHeadersDialog, changeHeaders, saveHeaders, saveRouteDraft,
    closeRouteDialog, closeHeadersDialog } = useRouteEditorController({
      active, config, isBusy: externalBusy, officialAccounts, officialCatalog, showAccountUsageInHeader,
      onSaveRoute, onSaveOfficialRouteSettings, refreshOfficialAccounts, onNotice,
    });
  const isBusy = externalBusy || saving;
  useEffect(() => { setRouteApiKeyVisible(false); }, [routeDialogOpen, routeDraft?.id]);
  const toggleRouteApiKeyVisibility = () => setRouteApiKeyVisible(visible => !visible);
  const accountForRoute = (profile: Profile) => findRouteAccount(profile, officialAccounts);
  const saveAndFocusInvalidField = async () => {
    const invalid = await saveRouteDraft();
    if (!invalid) return;
    requestAnimationFrame(() => {
      const root = popupContainer ?? document;
      root.querySelector<HTMLInputElement>(invalid === "official"
        ? ".official-route-editor [aria-invalid='true']" : ".route-editor-form [aria-invalid='true']")?.focus();
    });
  };
  const displayedEmail = useCallback(
    (account: OfficialAccount | null) => {
      const email = account?.email?.trim();
      if (!email) return "";
      return maskSensitive ? maskEmail(email) : email;
    },
    [maskSensitive],
  );
  const officialLoginLabelFor = useCallback(
    (account: OfficialAccount | null) => {
      const email = displayedEmail(account);
      return email ? `官方账号登录 · ${email}` : "官方账号登录";
    },
    [displayedEmail],
  );
  const hideUrl = useCallback(
    (value: string) => (maskSensitive ? maskUrl(value) : value),
    [maskSensitive],
  );

  const draggedProfile = draggedRouteId
    ? visibleProfiles.find((profile) => profile.id === draggedRouteId)
    : undefined;
  const draftOfficialAccountLabel =
    displayedEmail(draftOfficialAccount) || draftOfficialAccount?.id || "";

  const preferredProfile =
    config.profiles.find((profile) => profile.id === config.activeProfileId) ??
    config.profiles[0];
  const preferredProviderId = preferredProfile
    ? routeProviderId(preferredProfile)
    : undefined;
  const miscModelDisabled = isBusy || subagentModelOptions.length === 0;
  const selectedMiscModelKey = config.miscModel.trim().toLowerCase();
  const miscModelUnavailable =
    selectedMiscModelKey !== "" &&
    !subagentModelOptions.some(
      (option) => option.value.toLowerCase() === selectedMiscModelKey,
    );

  const miscModelTooltip = (
    <div className="flex flex-col gap-1 text-xs leading-relaxed max-w-[360px]">
      <div className="font-semibold text-foreground">
        统一指定会话命名、Git 提交消息、环境建议与自动复核回退使用的模型
      </div>
      <div className="text-muted">
        留空时沿用默认选择：会话命名优先使用官方 Luna，第三方线路使用已启用的 Luna 或默认模型；Git 提交消息和环境建议沿用内置模型。选择模型后，这些功能及自动复核回退使用所选模型；只要任一线路声明支持 codex-auto-review，自动复核仍使用专用模型。自动复核回退在保存后生效，其余功能需要重启 Codex，且依赖当前版本的主进程补丁支持。
      </div>
      {miscModelUnavailable && (
        <div className="text-warning font-medium">
          当前选择不在可用模型列表中，请重新选择；保存后若仍无法解析，将沿用默认行为，自动复核回退不可用。
        </div>
      )}
      {!config.localRouterEnabled && (
        <div className="text-muted italic">
          本地路由已关闭，自动复核回退不会生效。
        </div>
      )}
    </div>
  );

  const conversationGitTooltip = (
    <div className="flex flex-col gap-1 text-xs leading-relaxed max-w-[360px]">
      <div className="font-semibold text-foreground">
        指定分析本对话文件改动并生成 Git 提交信息的模型
      </div>
      <div className="text-muted">
        在对话工具栏中点击 Git 提交时，使用此模型分析限定文件的完整 diff 并生成提交说明。保存后生效；推荐使用具备良好推理能力的代码模型。
      </div>
      {!config.localRouterEnabled && (
        <div className="text-muted italic">
          本地路由已关闭，无法通过本地路由分发模型请求。
        </div>
      )}
    </div>
  );

  return (
    <section className="route-section" aria-labelledby="route-title">
      <SettingsPageHeader
        id="route-title"
        title="线路与模型"
        icon={<IconRoute size={15} />}
        badge={
          <button
            type="button"
            className="route-mask-toggle-btn"
            aria-label={maskSensitive ? "显示线路 URL 与邮箱" : "隐藏线路 URL 与邮箱"}
            title={maskSensitive ? "显示线路 URL 与邮箱" : "隐藏线路 URL 与邮箱"}
            onClick={() => setMaskSensitive((previous) => !previous)}
          >
            {maskSensitive ? (
              <IconEyeOff size={16} aria-hidden="true" />
            ) : (
              <IconEye size={16} aria-hidden="true" />
            )}
          </button>
        }
        description={routeConfigReadOnly
          ? "查看 Codex 当前线路并同步原始模型目录"
          : "统一管理供应商线路与模型目录"}
        actions={
          <div className="route-header-controls">
            <div className="route-header-switch-item">
              <span className="route-header-switch-label">本地路由</span>
              <Switch
                size="sm"
                checked={config.localRouterEnabled}
                disabled={isBusy}
                onCheckedChange={onToggleLocalRouter}
                aria-label="启用本地路由"
              />
            </div>
            {config.localRouterEnabled && (
              <>
                <span className="route-header-divider" aria-hidden="true" />
                <div className="route-header-switch-item">
                  <span className="route-header-switch-label">日志记录</span>
                  <Switch
                    size="sm"
                    checked={config.routeRequestLog.enabled}
                    disabled={isBusy}
                    onCheckedChange={onToggleRouteRequestLog}
                    aria-label="开启请求日志记录"
                  />
                </div>
                <span className="route-header-divider" aria-hidden="true" />
                <div className="route-header-btn-group">
                  <Button
                    color="primary"
                    variant="filled"
                    size="sm"
                    onClick={(event) => {
                      if (event.currentTarget instanceof HTMLElement) onOpenUsageAnalysis(event.currentTarget);
                    }}
                  >
                    <IconChartDonut size={14} aria-hidden="true" />
                    <span>用量分析</span>
                  </Button>
                  <Button
                    color="primary"
                    variant="filled"
                    size="sm"
                    onClick={() => void openRequestLogs(readHostTheme())}
                  >
                    <IconFileText size={14} aria-hidden="true" />
                    <span>查看请求日志</span>
                  </Button>
                </div>
              </>
            )}
          </div>
        }
      />

      <div className="route-content">
        <div className={`route-manager${routeConfigReadOnly ? " route-manager-current" : ""}`}>
          <div className="route-catalog-pane">
            {!routeConfigReadOnly && (
              <OfficialAccountsPanel
                officialAccountAvailable={officialAccountAvailable}
                isBusy={isBusy}
                active={active}
                maskSensitive={maskSensitive}
                popupContainer={popupContainer}
                onAccountsLoaded={adoptOfficialAccounts}
                onAccountsChanged={handleOfficialAccountsChanged}
                onNotice={onNotice}
                onRequestConfirmation={onRequestConfirmation}
              />
            )}

            <div className="catalog-aggregate-heading">
              <div className="catalog-aggregate-title-wrap">
                <div className="catalog-aggregate-title">
                  <strong>{routeConfigReadOnly ? "当前线路模型" : "供应商与模型"}</strong>
                  <Badge variant="info">
                    {visibleProfiles.length} 条线路 · {totalModelCount} 个模型
                  </Badge>
                </div>
                <small>
                  {routeConfigReadOnly
                    ? "模型请求由 Codex 当前 Provider 直接处理"
                    : "点击模型设为全局默认；拖动线路或模型左侧手柄调整顺序"}
                </small>
              </div>
              {!routeConfigReadOnly && (
                <Button
                  size="sm"
                  variant="default"
                  disabled={isBusy || dirty}
                  onClick={openNewRouteDialog}
                >
                  <Plus size={13} strokeWidth={2.2} aria-hidden="true" />
                  <span>新增线路</span>
                </Button>
              )}
            </div>

            <div id="provider-model-groups" className="provider-model-groups" role="region" aria-label="供应商与模型列表" tabIndex={0}>
              {visibleProfiles.length === 0 && (
                <div className="provider-model-empty">
                  <div className="provider-empty-content">
                    <IconCpu size={16} className="provider-empty-icon" aria-hidden="true" />
                    <span>{routeConfigReadOnly ? "尚未读取到 Codex 当前线路" : "暂无线路，添加后即可配置模型"}</span>
                  </div>
                </div>
              )}
              {visibleProfiles.map((profile) => {
                const providerId = routeProviderId(profile);
                const group = modelGroupByProviderId.get(providerId);
                const isOfficial = profile.authMode === "officialAccount";
                const disabled = profile.enabled === false;
                const compaction = getRouteCompactionStatus(profile, runtimeStatus, officialAccountAvailable);
                const acceptsRouteDrop = draggedProfile && draggedProfile.id !== profile.id
                  && (draggedProfile.enabled === false) === disabled;
                const officialLoginLabel = officialLoginLabelFor(
                  isOfficial ? accountForRoute(profile) : null,
                );
                const syncModels = () => onFetchRouteModels(profile);
                return (
                  <section
                    className={`provider-model-group${disabled ? " is-disabled" : ""}${dropRouteId === profile.id ? " is-drop-target" : ""}`}
                    key={profile.id}
                    aria-labelledby={`provider-model-${profile.id}`}
                    onDragOver={(event) => {
                      if (routeConfigReadOnly || !acceptsRouteDrop || isBusy || dirty) return;
                      event.preventDefault();
                      event.dataTransfer.dropEffect = "move";
                      setDropRouteId(profile.id);
                    }}
                    onDrop={(event) => {
                      event.preventDefault();
                      if (!routeConfigReadOnly && !isBusy && !dirty && draggedRouteId && acceptsRouteDrop) {
                        void onReorderRoute(draggedRouteId, profile.id);
                      }
                      setDraggedRouteId(null);
                      setDropRouteId(null);
                    }}
                  >
                    <div className="provider-card-header">
                      <div className="provider-heading-main">
                        {!routeConfigReadOnly && (
                          <button
                            type="button"
                            className="route-item-drag-handle cursor-grab text-gray-400 dark:text-gray-400 hover:text-gray-600 active:cursor-grabbing disabled:cursor-default"
                            disabled={isBusy || dirty}
                            draggable={!isBusy && !dirty}
                            aria-label={`调整线路 ${profile.name} 的顺序`}
                            title="在相同启用状态的线路间拖动排序，也可按上下方向键调整"
                            onDragStart={(event) => {
                              event.dataTransfer.setData("text/plain", profile.id);
                              event.dataTransfer.effectAllowed = "move";
                              setDraggedRouteId(profile.id);
                            }}
                            onDragEnd={() => {
                              setDraggedRouteId(null);
                              setDropRouteId(null);
                            }}
                            onKeyDown={(event) => {
                              if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
                              event.preventDefault();
                              const index = visibleProfiles.findIndex((route) => route.id === profile.id);
                              const target = visibleProfiles[index + (event.key === "ArrowUp" ? -1 : 1)];
                              if (target && (target.enabled === false) === disabled) void onReorderRoute(profile.id, target.id);
                            }}
                          >
                            <IconGripVertical size={15} aria-hidden="true" />
                          </button>
                        )}
                        <div className={`provider-avatar-pill ${isOfficial ? "official" : "custom"}`} aria-hidden="true">
                          {isOfficial ? <IconShieldCheck size={14} /> : <Server size={14} />}
                        </div>
                        <div className="provider-heading-text">
                          <div className="provider-heading-title-row">
                            {!routeConfigReadOnly && (
                              <span
                                title={disabled ? `点击启用线路「${profile.name}」` : `点击停用线路「${profile.name}」`}
                                className="provider-route-toggle-wrap"
                              >
                                <Switch
                                  size="xs"
                                  checked={!disabled}
                                  disabled={isBusy || dirty || pendingRouteToggle !== null}
                                  aria-busy={pendingRouteToggle?.id === profile.id}
                                  onCheckedChange={(checked) => void handleToggleRouteEnabled(profile, checked)}
                                  aria-label={`${disabled ? "启用" : "停用"}线路 ${profile.name}`}
                                  className="route-status-switch"
                                />
                              </span>
                            )}
                            <strong id={`provider-model-${profile.id}`} title={profile.name}>{prefixedRouteName(profile)}</strong>
                            <div className="route-item-badges">
                              {pendingRouteToggle?.id === profile.id && <Badge variant="secondary">保存中…</Badge>}
                              {disabled ? <Badge variant="destructive">已禁用</Badge> : (
                                <>
                                  <Badge variant="info">{group?.models.length || 0} 模型</Badge>
                                  {!routeConfigReadOnly && !isOfficial && !group?.models.length && (
                                    <Badge variant="secondary">待配置模型</Badge>
                                  )}
                                  {(isOfficial || profile.supportsWebsockets) && <Badge variant="brand">WS</Badge>}
                                  <Tooltip content={compaction.tooltip}>
                                    <span className="inline-flex">
                                      <Badge variant={compaction.badgeVariant} title={compaction.tooltip}>
                                        {compaction.badgeText}
                                      </Badge>
                                    </span>
                                  </Tooltip>
                                </>
                              )}
                              {disabled && <span className="route-disabled-hint">启用后可使用此线路的模型</span>}
                            </div>
                          </div>
                          <small
                            title={isOfficial ? officialLoginLabel : hideUrl(profile.baseUrl)}
                          >
                            {isOfficial
                              ? officialLoginLabel
                              : profile.baseUrl
                                ? hideUrl(profile.baseUrl)
                                : "待填写 URL"}
                          </small>
                        </div>
                      </div>

                      <div className="provider-card-toolbar">
                        {!disabled && (
                          <Button
                            color="primary"
                            variant="filled"
                            size="xs"
                            disabled={!canSyncCurrentProvider || isBusy}
                            onClick={syncModels}
                            aria-label={`同步 ${profile.name} 模型`}
                            title={`同步 ${profile.name} 模型`}
                          >
                            <RefreshCw size={12} className={busy === "fetch-route-models" && (routeConfigReadOnly || profile.id === config.activeProfileId) ? "animate-spin" : ""} aria-hidden="true" />
                            <span>同步</span>
                          </Button>
                        )}
                        {!routeConfigReadOnly && (
                          <div className="route-item-manage-actions">
                            <Button
                              variant="link"
                              color="primary"
                              size="icon-sm"
                              disabled={isBusy || dirty}
                              onClick={() => openHeadersDialog(profile)}
                              aria-label={`编辑线路 ${profile.name} 的请求头`}
                              title="编辑上游请求头"
                            >
                              <IconListDetails size={14} aria-hidden="true" />
                            </Button>
                            <Button
                              variant="link"
                              color="primary"
                              size="icon-sm"
                              disabled={isBusy || dirty}
                              onClick={() =>
                                openRouteDialog(profile, isOfficial ? "settings" : null)}
                              aria-label={`编辑线路 ${profile.name}`}
                              title={`编辑线路 ${profile.name}`}
                            >
                              <Edit size={14} aria-hidden="true" />
                            </Button>
                            {!isOfficial && (
                              <Button
                                variant="link"
                                color="danger"
                                size="icon-sm"
                                disabled={routeConfigReadOnly || isBusy || dirty || config.profiles.length <= 1}
                                onClick={() => onDeleteRoute(profile.id)}
                                aria-label={`删除线路 ${prefixedRouteName(profile)}`}
                                title={config.profiles.length <= 1 ? "至少需要保留一条线路" : `删除线路 ${prefixedRouteName(profile)}`}
                              >
                                <Trash size={14} aria-hidden="true" />
                              </Button>
                            )}
                          </div>
                        )}
                      </div>
                    </div>

                    <div className="provider-card-body">
                      {group && (group.models.length > 0 ? (
                        <div className="provider-model-tags">
                          {group.models.map((model) => {
                            const isDefault = !routeConfigReadOnly && modelIdsEqual(group.defaultModel, model);
                            const displayName = group.official ? officialDisplayNames.get(modelKey(model)) || model : model;
                            const isDraggedModel = draggedModel?.routeId === profile.id
                              && modelIdsEqual(draggedModel.model, model);
                            const acceptsModelDrop = Boolean(draggedModel)
                              && draggedModel?.routeId === profile.id
                              && !isDraggedModel;
                            const isModelDropTarget = acceptsModelDrop
                              && dropModel?.routeId === profile.id
                              && modelIdsEqual(dropModel.model, model);
                            const reorderModels = (source: string, target: string) => {
                              const models = moveModelId(group.models, source, target);
                              if (models) void onReorderRouteModels(profile.id, models);
                            };
                            return (
                              <div
                                key={`${group.providerId}:${model}`}
                                className={`model-tag-item${isModelDropTarget ? " is-drop-target" : ""}`}
                                onDragOver={(event) => {
                                  if (!acceptsModelDrop || isBusy || dirty) return;
                                  event.preventDefault();
                                  event.dataTransfer.dropEffect = "move";
                                  setDropModel({ routeId: profile.id, model });
                                }}
                                onDrop={(event) => {
                                  if (!draggedModel) return;
                                  event.preventDefault();
                                  if (acceptsModelDrop && !isBusy && !dirty) {
                                    reorderModels(draggedModel.model, model);
                                  }
                                  setDraggedModel(null);
                                  setDropModel(null);
                                }}
                              >
                                {!routeConfigReadOnly && (
                                  <button
                                    type="button"
                                    className="model-tag-drag-handle cursor-grab text-gray-400 dark:text-gray-400 hover:text-gray-600 active:cursor-grabbing disabled:cursor-default"
                                    disabled={isBusy || dirty}
                                    draggable={!isBusy && !dirty}
                                    aria-label={`调整模型 ${displayName} 的顺序`}
                                    title="在同一线路内拖动排序，也可按方向键调整"
                                    onDragStart={(event) => {
                                      event.dataTransfer.setData("text/plain", model);
                                      event.dataTransfer.effectAllowed = "move";
                                      setDraggedModel({ routeId: profile.id, model });
                                    }}
                                    onDragEnd={() => {
                                      setDraggedModel(null);
                                      setDropModel(null);
                                    }}
                                    onKeyDown={(event) => {
                                      const step = event.key === "ArrowLeft" || event.key === "ArrowUp"
                                        ? -1
                                        : event.key === "ArrowRight" || event.key === "ArrowDown"
                                          ? 1
                                          : 0;
                                      if (step === 0) return;
                                      event.preventDefault();
                                      const index = group.models.findIndex((candidate) => modelIdsEqual(candidate, model));
                                      const target = group.models[index + step];
                                      if (target) reorderModels(model, target);
                                    }}
                                  >
                                    <IconGripVertical size={13} aria-hidden="true" />
                                  </button>
                                )}
                                <button
                                  type="button"
                                  className={`model-tag-pill${isDefault ? " is-default" : ""}`}
                                  disabled={routeConfigReadOnly || isBusy || dirty || isDefault}
                                  onClick={() => onSetDefaultModel(profile.id, model)}
                                  title={routeConfigReadOnly ? displayName : isDefault ? `${displayName}（当前默认模型）` : `点击设为默认模型：${displayName}`}
                                  aria-label={routeConfigReadOnly ? displayName : isDefault ? `${displayName}，当前默认模型` : `设 ${displayName} 为默认模型`}
                                >
                                  <span className="model-tag-indicator" aria-hidden="true">
                                    {isDefault ? <Check size={11} strokeWidth={2.5} /> : <span className="model-tag-dot" />}
                                  </span>
                                  <span className="model-tag-name">{displayName}</span>
                                  {isDefault && <span className="model-tag-badge">默认</span>}
                                </button>
                              </div>
                            );
                          })}
                        </div>
                      ) : (
                        <div className="provider-model-empty">
                          <div className="provider-empty-content">
                            <IconCpu size={16} className="provider-empty-icon" aria-hidden="true" />
                            <span>尚未配置模型</span>
                          </div>
                          <Button
                            variant="secondary"
                            size="xs"
                            disabled={!canSyncCurrentProvider || isBusy}
                            onClick={syncModels}
                          >
                            <Plus size={12} aria-hidden="true" />
                            <span>{routeConfigReadOnly ? "同步模型" : isOfficial ? "配置官方模型" : "同步或手动添加"}</span>
                          </Button>
                        </div>
                      ))}
                    </div>
                  </section>
                );
              })}
            </div>
          </div>
        </div>

        <div className="route-auxiliary-bar">
          <div className="route-auxiliary-header">
            <div className="route-auxiliary-title-wrap">
              <div className="route-auxiliary-title-row">
                <IconAdjustmentsHorizontal size={15} className="route-auxiliary-icon" aria-hidden="true" />
                <span className="route-auxiliary-title">高级路由与重试设置</span>
              </div>
              <small className="route-auxiliary-subtitle">配置辅助任务专用模型与长会话中断后的自动恢复策略</small>
            </div>
          </div>
          <div className="route-auxiliary-grid">
            <div className="route-auxiliary-misc">
              <Tooltip content={miscModelTooltip} position="top">
                <span className="route-auxiliary-label cursor-help">
                  <IconSparkles size={14} className="route-auxiliary-icon" aria-hidden="true" />
                  <strong>杂事模型</strong>
                  <IconInfoCircle size={13} className="route-auxiliary-help" aria-hidden="true" />
                </span>
              </Tooltip>
              <div className="route-auxiliary-combobox">
                <ModelCombobox
                  aria-label="杂事模型"
                  value={config.miscModel}
                  placeholder={
                    subagentModelOptions.length === 0
                      ? "所有线路均暂无模型"
                      : "请选择模型"
                  }
                  disabled={miscModelDisabled}
                  options={subagentModelOptions}
                  preferredProviderId={preferredProviderId}
                  onChange={(value) => {
                    if (!subagentModelOptions.some((option) => option.value === value)) {
                      return;
                    }
                    onConfigChange?.({ ...config, miscModel: value });
                  }}
                />
              </div>
              <Button
                variant="ghost"
                size="sm"
                disabled={isBusy || config.miscModel.trim() === ""}
                onClick={() => onConfigChange?.({ ...config, miscModel: "" })}
                className="route-misc-model-reset"
              >
                恢复默认
              </Button>
            </div>

            <div className="route-auxiliary-retry">
              <div className="local-router-toggle route-retry-toggle">
                <Tooltip content="每轮请求的流式错误重试次数；切换传输方式时可能另行计数，不等于总请求上限。保存并重启 Codex 后生效" position="top">
                  <span className="route-retry-label cursor-help">
                    <strong>会话重试</strong>
                    <IconInfoCircle size={13} className="route-auxiliary-help" aria-hidden="true" />
                  </span>
                </Tooltip>
                <NumberInput
                  size="sm"
                  value={config.streamMaxRetries}
                  minValue={0}
                  maxValue={100}
                  disabled={isBusy}
                  onChange={(value) => {
                    if (Number.isInteger(value) && value >= 0 && value <= 100 && value !== config.streamMaxRetries) {
                      onConfigChange?.({ ...config, streamMaxRetries: value });
                    }
                  }}
                  aria-label="会话错误重试次数"
                />
              </div>
            </div>
          </div>
        </div>

        <div className="route-auxiliary-bar">
          <div className="route-auxiliary-header">
            <div className="route-auxiliary-title-row">
              <IconGitCommit size={15} className="route-auxiliary-icon" aria-hidden="true" />
              <span className="route-auxiliary-title">对话 Git 提交增强</span>
            </div>
            <div className="route-auxiliary-action">
              <Switch
                aria-label="对话 Git 提交增强"
                checked={config.conversationGit?.enabled === true}
                disabled={isBusy || !onConfigChange || (!config.localRouterEnabled && !config.conversationGit?.enabled)}
                onCheckedChange={(enabled) => onConfigChange?.({
                  ...config,
                  conversationGit: { model: config.conversationGit?.model || config.defaultModel, enabled },
                })}
              />
            </div>
          </div>

          {config.conversationGit?.enabled && (
            <div className="route-auxiliary-grid">
              <div className="route-auxiliary-misc">
                <Tooltip content={conversationGitTooltip} position="top">
                  <span className="route-auxiliary-label cursor-help">
                    <IconCpu size={14} className="route-auxiliary-icon" aria-hidden="true" />
                    <strong>提交分析模型</strong>
                    <IconInfoCircle size={13} className="route-auxiliary-help" aria-hidden="true" />
                  </span>
                </Tooltip>
                <div className="route-auxiliary-combobox">
                  <ModelCombobox
                    aria-label="Git 提交分析模型"
                    value={config.conversationGit.model}
                    placeholder={
                      subagentModelOptions.length === 0
                        ? "所有线路均暂无模型"
                        : "请选择提交分析模型"
                    }
                    disabled={isBusy || !config.localRouterEnabled}
                    options={subagentModelOptions}
                    preferredProviderId={preferredProviderId}
                    onChange={(model) => onConfigChange?.({ ...config, conversationGit: { enabled: true, model } })}
                  />
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="readonly-note">
          <IconInfoCircle size={14} className="readonly-note-icon" aria-hidden="true" />
          <span className="readonly-note-text">
            {routeConfigReadOnly
              ? "本地路由已关闭；仅展示 Codex 当前线路，可同步模型，线路地址、密钥和协议保持只读"
              : "所有已启用线路同时生效，模型请求会自动分发到所属供应商"}
          </span>
          <Badge
            variant={routeConfigReadOnly ? "secondary" : "brand"}
            className="readonly-note-tag"
          >
            {routeConfigReadOnly ? "当前线路" : "统一路由"}
          </Badge>
        </div>
      </div>

      <Dialog
        open={routeDialogOpen}
        onOpenChange={(open) => {
          if (!open) closeRouteDialog();
        }}
      >
        {routeDialogOpen && routeDraft && (
          <DialogContent
            className="route-editor-dialog"
            container={popupContainer ?? undefined}
            onEscapeKeyDown={(event) => {
              if (isBusy) event.preventDefault();
            }}
            onPointerDownOutside={(event) => {
              if (isBusy) event.preventDefault();
            }}
          >
            <DialogHeader>
              <div className="route-editor-dialog-title-row">
                <DialogTitle>
                  {routeDraft.authMode === "officialAccount"
                    ? officialDialogScope === "models"
                      ? "同步官方模型"
                      : "编辑官方线路"
                    : config.profiles.some((profile) => profile.id === routeDraft.id)
                      ? "编辑线路"
                      : "新增线路"}
                </DialogTitle>
              </div>
              <DialogDescription>
                {routeDraft.authMode === "officialAccount"
                  ? officialDialogScope === "models"
                    ? draftOfficialAccount
                      ? `当前官方账号：${draftOfficialAccountLabel}。未勾选的模型不会在模型目录和选择器中显示。`
                      : "未勾选的模型不会在模型目录和选择器中显示。"
                    : draftOfficialAccount
                      ? `当前官方账号：${draftOfficialAccountLabel}。此处只调整线路名、短名称和网关地址，模型列表请使用线路卡片上的同步按钮。`
                      : "此处只调整线路名、短名称和网关地址，模型列表请使用线路卡片上的同步按钮。"
                  : "配置第三方服务的接入信息。保存后可在模型目录中同步模型。"}
              </DialogDescription>
            </DialogHeader>

            {routeDraft.authMode === "officialAccount" ? (
              <div className="official-route-editor">
                {officialDialogScope !== "models" && (
                  <>
                    <div className="route-editor-row route-editor-row-names">
                      <label className="route-field">
                        <span>短名称 {REQUIRED_FIELD_MARKER}</span>
                        <Input
                          id="official-route-short-name-input"
                          aria-label="短名称"
                          required
                          aria-required="true"
                          error={Boolean(
                            officialRouteDraftErrors?.shortName &&
                            (routeValidationAttempted ||
                              (officialRouteDraft?.routeShortName.length ?? 0) > 0),
                          )}
                          aria-errormessage={
                            officialRouteDraftErrors?.shortName &&
                            (routeValidationAttempted ||
                              (officialRouteDraft?.routeShortName.length ?? 0) > 0)
                              ? "official-route-short-name-error"
                              : undefined
                          }
                          value={officialRouteDraft?.routeShortName ?? ""}
                          disabled={isBusy || !draftOfficialAccount}
                          placeholder="如：官1、主"
                          maxLength={MAX_ROUTE_SHORT_NAME_CHARACTERS}
                          onChange={(event) =>
                            updateOfficialRouteDraft({ routeShortName: event.target.value })}
                        />
                        {officialRouteDraftErrors?.shortName &&
                        (routeValidationAttempted ||
                          (officialRouteDraft?.routeShortName.length ?? 0) > 0) ? (
                          <small
                            id="official-route-short-name-error"
                            className="text-[var(--codey-red,#d70015)]"
                            role="alert"
                          >
                            {officialRouteDraftErrors.shortName}
                          </small>
                        ) : null}
                      </label>
                      <label className="route-field">
                        <span>线路名（可选）</span>
                        <Input
                          id="official-route-name-input"
                          aria-label="线路名"
                          maxLength={MAX_ROUTE_NAME_CHARACTERS}
                          aria-invalid={Boolean(
                            officialRouteDraftErrors?.routeName &&
                            (routeValidationAttempted ||
                              (officialRouteDraft?.routeName.length ?? 0) > 0),
                          )}
                          aria-describedby={
                            officialRouteDraftErrors?.routeName &&
                            (routeValidationAttempted ||
                              (officialRouteDraft?.routeName.length ?? 0) > 0)
                              ? "official-route-name-error"
                              : undefined
                          }
                          value={officialRouteDraft?.routeName ?? ""}
                          disabled={isBusy || !draftOfficialAccount}
                          placeholder="留空仅显示短名称"
                          onChange={(event) =>
                            updateOfficialRouteDraft({ routeName: event.target.value })}
                        />
                        {officialRouteDraftErrors?.routeName &&
                        (routeValidationAttempted ||
                          (officialRouteDraft?.routeName.length ?? 0) > 0) ? (
                          <small
                            id="official-route-name-error"
                            className="text-[var(--codey-red,#d70015)]"
                            role="alert"
                          >
                            {officialRouteDraftErrors.routeName}
                          </small>
                        ) : !draftOfficialAccount ? (
                          <small className="route-field-hint">
                            未找到该线路对应的官方账号记录。
                          </small>
                        ) : null}
                      </label>
                    </div>

                    <label className="route-field">
                      <span>网关地址（可选）</span>
                      <Input
                        id="official-route-base-url-input"
                        aria-label="网关地址（可选）"
                        aria-invalid={Boolean(officialRouteDraftErrors?.baseUrl)}
                        aria-describedby={
                          officialRouteDraftErrors?.baseUrl
                            ? "official-route-base-url-error"
                            : undefined
                        }
                        value={officialRouteDraft?.baseUrl ?? ""}
                        disabled={isBusy || !draftOfficialAccount}
                        placeholder="留空使用官方默认网关"
                        onChange={(event) =>
                          updateOfficialRouteDraft({ baseUrl: event.target.value })}
                      />
                      {officialRouteDraftErrors?.baseUrl ? (
                        <small
                          id="official-route-base-url-error"
                          className="text-[var(--codey-red,#d70015)]"
                          role="alert"
                        >
                          {officialRouteDraftErrors.baseUrl}
                        </small>
                      ) : (
                        <small className="route-field-hint">
                          默认 https://chatgpt.com/backend-api/codex
                        </small>
                      )}
                    </label>

                  </>
                )}

                {officialDialogScope !== "settings" && (
                  <>
                    <div className="official-model-editor">
                      <div className="official-model-editor-heading">
                        <span>
                          <strong>支持的模型</strong>
                          <small>已启用 {officialModelDraft.length} 个，至少保留一个。</small>
                        </span>
                        <Badge variant="secondary">
                          {officialModelDraft.length} / {officialCatalog.length}
                        </Badge>
                      </div>
                      <div className="official-model-options">
                        {officialCatalog.map((model) => {
                          const checked = officialModelDraftKeys.has(modelKey(model));
                          return (
                            <div className="official-model-option" style={{ flexWrap: "wrap" }} key={model}>
                              <Checkbox
                                checked={checked}
                                disabled={isBusy || (checked && officialModelDraft.length <= 1)}
                                onCheckedChange={(nextChecked) => toggleOfficialModel(model, nextChecked === true)}
                                aria-label={`${checked ? "停用" : "启用"}官方模型 ${model}`}
                              />
                              <span>
                                <strong>
                                  {officialDisplayNames.get(modelKey(model)) || model}
                                </strong>
                                <small>{model}</small>
                              </span>
                              {!routeConfigReadOnly && (
                                <ModelSettingsFields
                                  model={model}
                                  disabled={isBusy}
                                  policy={Object.entries(officialModelContextDraft).find(
                                    ([candidate]) => modelIdsEqual(candidate, model),
                                  )?.[1]}
                                  onChange={(policy) => updateOfficialModelContext(model, policy)}
                                />
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  </>
                )}
              </div>
            ) : (
              <div className="route-editor-form">
                {active && !config.profiles.some(profile => profile.id === routeDraft.id) &&
                  <NewApiImport key={routeDraft.id} disabled={isBusy} onImport={importConnection} />}
                <div className="route-editor-row route-editor-row-names">
                  <label className="route-field">
                    <span>短名称 {REQUIRED_FIELD_MARKER}</span>
                    <Input
                      id="route-short-name-input"
                      aria-label="短名称"
                      required
                      aria-required="true"
                      error={Boolean(
                        routeDraftErrors?.shortName &&
                        (routeValidationAttempted || routeDraft.shortName.length > 0),
                      )}
                      aria-errormessage={
                        routeDraftErrors?.shortName &&
                        (routeValidationAttempted || routeDraft.shortName.length > 0)
                          ? "route-short-name-error"
                          : undefined
                      }
                      value={routeDraft.shortName}
                      disabled={isBusy}
                      placeholder="如：主、备"
                      maxLength={MAX_ROUTE_SHORT_NAME_CHARACTERS}
                      onChange={(event) =>
                        updateRouteDraft({ shortName: event.target.value })}
                    />
                    {routeDraftErrors?.shortName &&
                    (routeValidationAttempted || routeDraft.shortName.length > 0) ? (
                      <small
                        id="route-short-name-error"
                        className="text-[var(--codey-red,#d70015)]"
                        role="alert"
                      >
                        {routeDraftErrors.shortName}
                      </small>
                    ) : null}
                  </label>
                  <label className="route-field">
                    <span>线路名（可选）</span>
                    <Input
                      id="route-name-input"
                      aria-label="线路名"
                      maxLength={MAX_ROUTE_NAME_CHARACTERS}
                      aria-invalid={Boolean(
                        routeDraftErrors?.name &&
                        (routeValidationAttempted || routeDraft.name.length > 0),
                      )}
                      aria-describedby={
                        routeDraftErrors?.name &&
                        (routeValidationAttempted || routeDraft.name.length > 0)
                          ? "route-name-error"
                          : undefined
                      }
                      value={routeDraft.name}
                      disabled={isBusy}
                      placeholder="留空仅显示短名称"
                      onChange={(event) => updateRouteDraft({ name: event.target.value })}
                    />
                    {routeDraftErrors?.name &&
                    (routeValidationAttempted || routeDraft.name.length > 0) ? (
                      <small id="route-name-error" className="text-[var(--codey-red,#d70015)]" role="alert">
                        {routeDraftErrors.name}
                      </small>
                    ) : null}
                  </label>
                </div>

                <div className="route-field">
                  <span id="route-protocol-label">上游协议 {REQUIRED_FIELD_MARKER}</span>
                  <Select
                    aria-label="上游协议"
                    aria-labelledby="route-protocol-label"
                    aria-required={true}
                    value={routeDraft.upstreamProtocol}
                    disabled={isBusy}
                    onChange={changeProtocol}
                    optionList={routeProtocolOptions}
                  />
                </div>

                {routeDraft.upstreamProtocol === "openaiResponses" && (
                  <div className="route-field route-editor-span-all">
                    <div className="route-protocol-section-header">
                      <span className="route-protocol-section-title">
                        <IconAdjustmentsHorizontal size={14} className="text-muted" aria-hidden="true" />
                        协议特性（OpenAI Responses）
                      </span>
                      <span className="route-protocol-section-badge">按需扩展</span>
                    </div>
                    <div className="route-protocol-options">
                      {/* 第一行：原生远程压缩（独立占行，支持展开子面板） */}
                      <div
                        className="route-option-item route-option-item-full"
                        data-active={Boolean(routeDraft.supportsRemoteCompaction)}
                      >
                        <div className="route-option-header">
                          <div className="route-option-title-group">
                            <span className="route-option-icon" aria-hidden="true">
                              <IconArchive size={14} />
                            </span>
                            <strong className="route-option-title">原生远程压缩</strong>
                            <Tooltip content="仅在上游明确支持时开启，并选择服务商支持的压缩接口；未声明原生支持的线路由网关按等价方式压缩。">
                              <span className="route-option-info-trigger" aria-label="原生远程压缩详细说明">
                                <IconInfoCircle size={13} />
                              </span>
                            </Tooltip>
                          </div>
                          <Switch
                            size="sm"
                            checked={Boolean(routeDraft.supportsRemoteCompaction)}
                            disabled={isBusy}
                            onCheckedChange={(checked) =>
                              updateRouteDraft({ supportsRemoteCompaction: checked })}
                            aria-label="原生远程压缩"
                          />
                        </div>
                        <p className="route-field-hint">
                          声明该线路是否原生支持远程压缩；未声明的线路由网关按等价方式压缩
                        </p>
                        {routeDraft.supportsRemoteCompaction && (
                          <div className="route-option-subpanel">
                            <div className="route-option-subpanel-title-row">
                              <span id="route-compaction-protocol-label" className="route-option-subpanel-label">
                                压缩接口
                              </span>
                              <span className="route-option-subpanel-badge">
                                {routeDraft.remoteCompactionProtocol === "compactEndpoint"
                                  ? "兼容接口"
                                  : "原生默认"}
                              </span>
                            </div>
                            <Select
                              aria-labelledby="route-compaction-protocol-label"
                              value={routeDraft.remoteCompactionProtocol ?? "responses"}
                              disabled={isBusy}
                              onChange={(value) => {
                                if (value === "responses" || value === "compactEndpoint") {
                                  updateRouteDraft({ remoteCompactionProtocol: value });
                                }
                              }}
                              optionList={[
                                { label: "原生 Responses（默认）", value: "responses" },
                                { label: "独立压缩接口（兼容）", value: "compactEndpoint" },
                              ]}
                            />
                            <p className="route-option-subpanel-hint">
                              {routeDraft.remoteCompactionProtocol === "compactEndpoint"
                                ? "将新式压缩请求转换到 /responses/compact；上游须返回加密压缩结果。接口选择保存后生效。"
                                : "按 Codex 原始压缩协议发送；若服务商仅支持 /responses/compact，请选择兼容接口。"}
                            </p>
                          </div>
                        )}
                      </div>

                      {/* 第二行：并排两个轻量开关（WebSocket + 原生网页搜索） */}
                      <div className="route-option-grid-row">
                        <div
                          className="route-option-item route-option-col"
                          data-active={Boolean(routeDraft.supportsWebsockets)}
                        >
                          <div className="route-option-header">
                            <div className="route-option-title-group">
                              <span className="route-option-icon" aria-hidden="true">
                                <IconBolt size={14} />
                              </span>
                              <strong className="route-option-title">WebSocket</strong>
                              <Tooltip content="优先尝试复用长连接；使用代理或连接失败时转为流式 HTTP。能力变更需重启 Codex，实际速度取决于上游和网络。">
                                <span className="route-option-info-trigger" aria-label="WebSocket 详细说明">
                                  <IconInfoCircle size={13} />
                                </span>
                              </Tooltip>
                            </div>
                            <Switch
                              size="sm"
                              checked={Boolean(routeDraft.supportsWebsockets)}
                              disabled={isBusy}
                              onCheckedChange={(checked) =>
                                updateRouteDraft({ supportsWebsockets: checked })}
                              aria-label="WebSocket"
                            />
                          </div>
                          <p className="route-field-hint">
                            优先长连接，失败转流式 HTTP
                          </p>
                        </div>

                        <div
                          className="route-option-item route-option-col"
                          data-active={Boolean(routeDraft.supportsNativeWebSearch)}
                        >
                          <div className="route-option-header">
                            <div className="route-option-title-group">
                              <span className="route-option-icon" aria-hidden="true">
                                <IconWorld size={14} />
                              </span>
                              <strong className="route-option-title">原生网页搜索</strong>
                              <Tooltip content="仅在上游和所选模型都明确支持时开启。">
                                <span className="route-option-info-trigger" aria-label="原生网页搜索详细说明">
                                  <IconInfoCircle size={13} />
                                </span>
                              </Tooltip>
                            </div>
                            <Switch
                              size="sm"
                              checked={Boolean(routeDraft.supportsNativeWebSearch)}
                              disabled={isBusy}
                              onCheckedChange={(checked) =>
                                updateRouteDraft({ supportsNativeWebSearch: checked })}
                              aria-label="原生网页搜索"
                            />
                          </div>
                          <p className="route-field-hint">
                            仅在上游与模型支持时开启
                          </p>
                        </div>
                      </div>
                    </div>
                  </div>
                )}

                <label className="route-field">
                  <span>URL {REQUIRED_FIELD_MARKER}</span>
                  <Input
                    id="route-url-input"
                    aria-label="URL"
                    required
                    aria-required="true"
                    aria-invalid={Boolean(
                      routeDraftErrors?.baseUrl &&
                      (routeValidationAttempted || routeDraft.baseUrl.trim()),
                    )}
                    aria-describedby={
                      routeDraftErrors?.baseUrl &&
                      (routeValidationAttempted || routeDraft.baseUrl.trim())
                        ? "route-url-error"
                        : undefined
                    }
                    value={routeDraft.baseUrl}
                    disabled={isBusy}
                    placeholder={
                      routeDraft.upstreamProtocol === "gemini"
                        ? "https://generativelanguage.googleapis.com/v1beta"
                        : routeDraft.upstreamProtocol === "anthropicMessages"
                          ? "https://api.anthropic.com"
                          : "https://api.example.com/v1"
                    }
                    onChange={(event) => updateRouteDraft({ baseUrl: event.target.value })}
                  />
                  {routeDraftErrors?.baseUrl &&
                  (routeValidationAttempted || routeDraft.baseUrl.trim()) ? (
                    <small id="route-url-error" className="text-[var(--codey-red,#d70015)]" role="alert">
                      {routeDraftErrors.baseUrl}
                    </small>
                  ) : null}
                </label>

                <label className="route-field">
                  <span>Key {REQUIRED_FIELD_MARKER}</span>
                  <PasswordInput
                    id="route-key-input"
                    aria-label="Key"
                    required={!routeDraft.apiKeyConfigured}
                    aria-required={!routeDraft.apiKeyConfigured}
                    aria-invalid={Boolean(
                      routeValidationAttempted && routeDraftErrors?.apiKey,
                    )}
                    aria-describedby={
                      routeValidationAttempted && routeDraftErrors?.apiKey
                        ? "route-key-error"
                        : undefined
                    }
                    autoComplete="new-password"
                    visibility={routeApiKeyVisible}
                    onVisibilityChange={toggleRouteApiKeyVisibility}
                    value={routeDraft.apiKey}
                    disabled={isBusy}
                    placeholder={
                      routeDraft.apiKeyConfigured
                        ? "已保存（输入新 Key 替换）"
                        : routeDraft.upstreamProtocol === "gemini"
                          ? "AIza..."
                          : routeDraft.upstreamProtocol === "anthropicMessages"
                            ? "sk-ant-..."
                            : "sk-..."
                    }
                    onChange={(event) => {
                      updateRouteDraft({ apiKey: event.target.value });
                    }}
                  />
                  {routeValidationAttempted && routeDraftErrors?.apiKey ? (
                    <small id="route-key-error" className="text-[var(--codey-red,#d70015)]" role="alert">
                      {routeDraftErrors.apiKey}
                    </small>
                  ) : null}
                </label>

              </div>
            )}

            {headerError && <small className="text-[var(--codey-red,#d70015)]" role="alert">{headerError}；请先在线路的请求头编辑器中修正。</small>}
            <DialogFooter className="route-editor-footer">
              <Button
                variant="outline"
                disabled={isBusy}
                onClick={closeRouteDialog}
              >
                取消
              </Button>
              <Button
                disabled={isBusy || (
                  routeDraft.authMode === "officialAccount"
                    ? officialDialogScope === "models" && officialModelDraft.length === 0
                    : routeValidationAttempted && routeDraftHasErrors
                )}
                onClick={() => void saveAndFocusInvalidField()}
              >
                <Check aria-hidden="true" />
                {routeDraft.authMode === "officialAccount" && officialDialogScope === "models"
                  ? "保存模型"
                  : "保存线路"}
              </Button>
            </DialogFooter>
          </DialogContent>
        )}
      </Dialog>
      <Dialog open={headerDialogProfile !== null} onOpenChange={(open) => { if (!open) closeHeadersDialog(); }}>
        {headerDialogProfile && (
          <DialogContent className="route-editor-dialog">
            <DialogHeader>
              <DialogTitle>编辑上游请求头</DialogTitle>
              <DialogDescription>{headerDialogProfile.name} 的 CodeyX → 上游请求头，使用 JSON 对象表示；null 或空字符串删除普通请求头，认证和协议必需请求头受保护。</DialogDescription>
            </DialogHeader>
            <label className="route-field">
              <span>请求头（JSON）</span>
              <textarea
                aria-label="请求头（JSON）"
                aria-invalid={Boolean(headerError)}
                aria-describedby={headerError ? "request-headers-error" : undefined}
                value={routeHeadersText}
                disabled={isBusy}
                rows={10}
                className="min-h-48 rounded-lg border border-[rgb(var(--codey-ink-rgb,0,0,0))]/10 bg-[var(--codey-surface,#fff)] p-2 font-mono text-xs"
                onChange={(event) => changeHeaders(event.target.value)}
                placeholder={'{"X-Custom-Header": "value"}'}
              />
              {headerError && <small id="request-headers-error" className="text-[var(--codey-red,#d70015)]" role="alert">{headerError}</small>}
            </label>
            <DialogFooter className="route-editor-footer">
              <Button variant="outline" disabled={isBusy} onClick={closeHeadersDialog}>取消</Button>
              <Button disabled={isBusy} onClick={() => void saveHeaders()}><Check aria-hidden="true" />保存请求头</Button>
            </DialogFooter>
          </DialogContent>
        )}
      </Dialog>
    </section>
  );
}

export const ModelSection = memo(ModelSectionComponent);

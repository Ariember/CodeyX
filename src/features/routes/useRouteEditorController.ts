import { useEffect, useMemo, useState } from "react";
import type { Config, ModelContextConfig, Notice, OfficialAccount, Profile } from "../../App.types";
import { errorText } from "../../appUtils";
import { modelIdsEqual, modelKey, uniqueModelIds } from "../../modelIds";
import { routeProviderId } from "../../modelRoutes";
import { validateOfficialRouteSettings, type OfficialRouteSettingsDraft } from "../../officialRouteSettings";
import { headersTextFromMap, parseHeadersText } from "../../requestHeaders";
import { fallbackRouteShortName } from "../../routeShortNames";
import { useOperationScope } from "../../useOperationScope";
import { useStableEvent } from "../../useStableEvent";
import { accountForRoute, officialRouteModelDraft } from "./catalog";
import { createRouteDraft, routeProtocolPatch, validateRouteDraft } from "./draft";
import { importNewApiConnection } from "./connectionImport";
import type { OfficialRouteDialogScope, RouteEditorActions } from "./types";

type Options = RouteEditorActions & {
  active: boolean;
  config: Config;
  isBusy: boolean;
  officialAccounts: OfficialAccount[] | null;
  officialCatalog: string[];
  showAccountUsageInHeader: boolean;
  refreshOfficialAccounts: () => Promise<void>;
  onNotice: (notice: Notice) => void;
};

export function useRouteEditorController(options: Options) {
  const { active, config, officialAccounts, officialCatalog } = options;
  const [routeDraft, setRouteDraft] = useState<Profile | null>(null);
  const [routeValidationAttempted, setRouteValidationAttempted] = useState(false);
  const [routeHeadersText, setRouteHeadersText] = useState("{}");
  const [headerDialogProfile, setHeaderDialogProfile] = useState<Profile | null>(null);
  const [headerError, setHeaderError] = useState("");
  const [officialModelDraft, setOfficialModelDraft] = useState<string[]>([]);
  const [officialModelContextDraft, setOfficialModelContextDraft] = useState<Record<string, ModelContextConfig>>({});
  const [officialRouteDraft, setOfficialRouteDraft] = useState<OfficialRouteSettingsDraft | null>(null);
  const [officialDialogScope, setOfficialDialogScope] = useState<OfficialRouteDialogScope | null>(null);
  const [saving, setSaving] = useState(false);
  const scope = useOperationScope(active && config.localRouterEnabled);
  const available = () => active && config.localRouterEnabled && !options.isBusy && !scope.pending;
  const clearRoute = () => { setRouteDraft(null); setOfficialRouteDraft(null); setOfficialDialogScope(null); setRouteValidationAttempted(false); };
  useEffect(() => {
    if (!config.localRouterEnabled) { clearRoute(); setHeaderDialogProfile(null); }
  }, [config.localRouterEnabled]);

  const draftOfficialAccount = accountForRoute(routeDraft, officialAccounts);
  const accountId = routeDraft?.officialAccountId ?? officialAccounts?.find(account => account.isDefault)?.id ?? "";
  const routeDraftErrors = useMemo(() => routeDraft ? validateRouteDraft(routeDraft, config.profiles) : null, [routeDraft, config.profiles]);
  const routeDraftHasErrors = Boolean(routeDraftErrors && Object.values(routeDraftErrors).some(Boolean));
  const officialRouteDraftErrors = useMemo(() => officialRouteDraft
    ? validateOfficialRouteSettings(officialRouteDraft, config.profiles, officialAccounts, accountId) : null,
  [officialRouteDraft, config.profiles, officialAccounts, accountId]);
  const officialModelDraftKeys = useMemo(() => new Set(officialModelDraft.map(modelKey)), [officialModelDraft]);

  function openNewRouteDialog() {
    if (!available()) return;
    setRouteDraft(createRouteDraft(`route-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`));
    setRouteValidationAttempted(false); setRouteHeadersText("{}"); setHeaderError("");
    setOfficialRouteDraft(null); setOfficialModelDraft([]); setOfficialModelContextDraft({}); setOfficialDialogScope(null);
  }
  function openRouteDialog(profile: Profile, officialScope: OfficialRouteDialogScope | null = null) {
    if (!available()) return;
    const official = profile.authMode === "officialAccount";
    const account = official ? accountForRoute(profile, officialAccounts) : null;
    setRouteDraft({ ...profile, shortName: profile.shortName || fallbackRouteShortName(profile.name) });
    setRouteValidationAttempted(false); setRouteHeadersText(headersTextFromMap(profile.modelRequestHeaders)); setHeaderError("");
    setOfficialRouteDraft(official && officialScope === "settings" ? {
      routeName: account?.routeName ?? profile.name,
      routeShortName: account?.routeShortName || profile.shortName || fallbackRouteShortName(profile.name),
      baseUrl: account?.baseUrl ?? "",
    } : null);
    setOfficialModelDraft(official && officialScope === "models" ? officialRouteModelDraft(config, profile, officialCatalog) : []);
    setOfficialModelContextDraft(official && officialScope === "models" ? config.modelContextByProvider?.[routeProviderId(profile)] || {} : {});
    setOfficialDialogScope(official ? officialScope : null);
  }
  function updateRouteDraft(patch: Partial<Profile>) {
    if (available()) setRouteDraft(current => current ? { ...current, ...patch } : current);
  }
  function changeProtocol(value: unknown) {
    if (!routeDraft) return;
    const patch = routeProtocolPatch(routeDraft, value);
    if (patch) updateRouteDraft(patch);
  }
  function importConnection(text: string): string | null {
    if (!available() || !routeDraft || routeDraft.authMode === "officialAccount"
      || config.profiles.some(profile => profile.id === routeDraft.id)) return "请在新增线路中导入连接串";
    try {
      updateRouteDraft(importNewApiConnection(text, routeDraft));
      return null;
    } catch (cause) { return errorText(cause); }
  }
  function updateOfficialRouteDraft(patch: Partial<OfficialRouteSettingsDraft>) {
    if (available()) setOfficialRouteDraft(current => current ? { ...current, ...patch } : current);
  }
  function toggleOfficialModel(model: string, checked: boolean) {
    if (!available()) return;
    setOfficialModelDraft(current => checked ? uniqueModelIds([...current, model])
      : current.length <= 1 ? current : current.filter(candidate => !modelIdsEqual(candidate, model)));
  }
  function updateOfficialModelContext(model: string, policy: ModelContextConfig | undefined) {
    if (!available()) return;
    setOfficialModelContextDraft(current => {
      const next = Object.fromEntries(Object.entries(current).filter(([candidate]) => !modelIdsEqual(candidate, model)));
      if (policy) next[model] = policy;
      return next;
    });
  }
  function openHeadersDialog(profile: Profile) {
    if (!available()) return;
    setHeaderDialogProfile(profile); setRouteHeadersText(headersTextFromMap(profile.modelRequestHeaders)); setHeaderError("");
  }
  function changeHeaders(value: string) {
    if (available()) { setRouteHeadersText(value); setHeaderError(""); }
  }
  async function save(action: () => Promise<boolean>, onSaved: () => void) {
    const operation = scope.begin();
    if (!operation) return;
    setSaving(true);
    try { if (await action() && operation.current()) onSaved(); }
    catch (cause) { if (operation.current()) options.onNotice({ tone: "error", text: errorText(cause) }); }
    finally { if (operation.finish()) setSaving(false); }
  }
  const saveHeaders = useStableEvent(async () => {
    if (!available() || !headerDialogProfile) return;
    let modelRequestHeaders: Record<string, string>;
    try { modelRequestHeaders = parseHeadersText(routeHeadersText); }
    catch (cause) { setHeaderError(errorText(cause)); return; }
    setHeaderError("");
    await save(() => options.onSaveRoute({ ...headerDialogProfile, modelRequestHeaders }), () => setHeaderDialogProfile(null));
  });
  const saveRouteDraft = useStableEvent(async (): Promise<"route" | "official" | undefined> => {
    if (!available() || !routeDraft) return;
    let modelRequestHeaders: Record<string, string>;
    try { modelRequestHeaders = parseHeadersText(routeHeadersText); }
    catch (cause) { setHeaderError(errorText(cause)); setRouteValidationAttempted(true); return; }
    if (routeDraft.authMode === "officialAccount") {
      if (officialDialogScope === "models") { if (!officialModelDraft.length) return; }
      else if (officialRouteDraftErrors && Object.values(officialRouteDraftErrors).some(Boolean)) {
        setRouteValidationAttempted(true); return "official";
      }
    } else if (routeDraftHasErrors) { setRouteValidationAttempted(true); return "route"; }
    setHeaderError("");
    const official = routeDraft.authMode === "officialAccount";
    const configuredModels = config.selectedModelsByProvider[routeProviderId(routeDraft)] || [];
    const savingSettings = official && officialDialogScope === "settings";
    await save(async () => {
      if (!official) return options.onSaveRoute({ ...routeDraft, modelRequestHeaders });
      if (!options.onSaveOfficialRouteSettings) return false;
      return options.onSaveOfficialRouteSettings(
        routeDraft.id,
        officialDialogScope === "models" ? officialModelDraft : configuredModels.length ? configuredModels : officialCatalog,
        options.showAccountUsageInHeader,
        routeDraft.enabled !== false,
        officialDialogScope === "models" ? officialModelContextDraft : undefined,
        savingSettings && accountId && officialRouteDraft ? {
          accountId, routeName: officialRouteDraft.routeName.trim(),
          routeShortName: officialRouteDraft.routeShortName.trim(), baseUrl: officialRouteDraft.baseUrl.trim(),
        } : undefined,
      );
    }, () => { if (official) void options.refreshOfficialAccounts(); clearRoute(); });
  });

  return { routeDraft, routeDialogOpen: routeDraft !== null, routeValidationAttempted, routeDraftErrors, routeDraftHasErrors,
    officialRouteDraft, officialRouteDraftErrors, officialDialogScope, officialModelDraft, officialModelDraftKeys,
    officialModelContextDraft, draftOfficialAccount, headerDialogProfile, routeHeadersText, headerError, saving,
    openNewRouteDialog, openRouteDialog, updateRouteDraft, changeProtocol, importConnection, updateOfficialRouteDraft,
    toggleOfficialModel, updateOfficialModelContext, openHeadersDialog, changeHeaders, saveHeaders, saveRouteDraft,
    closeRouteDialog: () => { if (!options.isBusy && !scope.pending) clearRoute(); },
    closeHeadersDialog: () => { if (!options.isBusy && !scope.pending) setHeaderDialogProfile(null); } };
}

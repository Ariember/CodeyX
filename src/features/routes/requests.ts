import { invoke } from "../../api";
import { listOfficialAccounts, rememberOfficialAccounts } from "../../officialAccountsRequests";
import type { ModelContextConfig, ModelState } from "../../App.types";
import type { OfficialRouteResult, RouteResult, SyncedRouteResult } from "./types";

export { rememberOfficialAccounts };
export const routeRequests = {
  accounts: listOfficialAccounts,
  openLogs: (theme: string) => invoke("open_route_request_logs", { theme }),
  load: () => invoke<RouteResult>("load_codey_config"),
  sync: () => invoke<SyncedRouteResult>("sync_current_provider"),
  setEnabled: (routeId: string, enabled: boolean, expectedRevision: number) =>
    invoke<RouteResult>("set_route_enabled", { routeId, enabled, expectedRevision }),
  reorderModels: (routeId: string, models: string[], expectedRevision: number) =>
    invoke<RouteResult>("reorder_route_models", { routeId, models, expectedRevision }),
  remove: (routeId: string, expectedRevision: number) =>
    invoke<RouteResult>("delete_route", { routeId, expectedRevision }),
  fetchModels: (routeId: string, expectedRevision: number) =>
    invoke<RouteResult & { routeModelState: ModelState }>("fetch_route_models", { routeId, expectedRevision }),
  saveOfficial: (settings: {
    routeId: string; models: string[]; enabled: boolean; showAccountUsageInHeader: boolean;
    modelContexts?: Record<string, ModelContextConfig>;
    accountId?: string; routeName?: string; routeShortName?: string; baseUrl?: string;
  }) => invoke<OfficialRouteResult>("save_official_route_models", settings),
  setDefaultModel: (routeId: string, model: string) =>
    invoke<RouteResult>("save_default_model", { routeId, model }),
};

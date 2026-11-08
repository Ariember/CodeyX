import type { Config, ModelContextConfig, ModelState, OfficialAccountsResult, Profile, ProviderStatus } from "../../App.types";
import type { ModelRuntimeUpdate } from "../../modelSelectionNotice";

export type RouteResult = {
  config: Config;
  providerStatus?: ProviderStatus;
  modelState?: ModelState;
  restartRequired?: boolean;
} & ModelRuntimeUpdate;

export type SyncedRouteResult = RouteResult & { providerStatus: ProviderStatus; modelState: ModelState };
export type OfficialRouteResult = RouteResult & OfficialAccountsResult & { customContextsRestored?: boolean };

export type OfficialRouteDialogScope = "settings" | "models";
export type RouteModelGroup = {
  profile: Profile;
  providerId: string;
  models: string[];
  defaultModel: string;
  official: boolean;
};

export type RouteEditorActions = {
  onSaveRoute: (route: Profile) => Promise<boolean>;
  onSaveOfficialRouteSettings?: (
    routeId: string,
    models: string[],
    showAccountUsageInHeader: boolean,
    enabled: boolean,
    modelContexts: Record<string, ModelContextConfig> | undefined,
    routeSettings?: { accountId: string; routeName: string; routeShortName: string; baseUrl: string },
  ) => Promise<boolean>;
};

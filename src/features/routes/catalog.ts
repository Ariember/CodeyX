import type { Config, ModelState, OfficialAccount, Profile, ProviderStatus } from "../../App.types";
import { modelKey, uniqueModelIds } from "../../modelIds";
import { globalDefaultForRoute, routeProviderId, sortRoutesByEnabled } from "../../modelRoutes";
import type { RouteModelGroup } from "./types";

export function accountForRoute(profile: Profile | null, accounts: OfficialAccount[] | null): OfficialAccount | null {
  if (!profile) return null;
  return accounts?.find(account => profile.officialAccountId
    ? account.id === profile.officialAccountId : account.isDefault) ?? null;
}

export function officialModelCatalog(state: ModelState): string[] {
  return uniqueModelIds([...state.officialModelIds, ...state.officialModels.map(model => model.slug)]);
}

export function nativeRoute(profiles: Profile[], provider: ProviderStatus["provider"] | null): Profile | null {
  if (!provider) return null;
  const matching = profiles.find(profile => profile.id === provider.id || routeProviderId(profile) === provider.id);
  if (matching?.enabled === false) return null;
  return {
    id: matching?.id || provider.id,
    name: matching ? matching.name.trim() : provider.name.trim() || provider.id,
    shortName: matching?.shortName || "",
    baseUrl: provider.baseUrl || matching?.baseUrl || "",
    apiKey: "",
    upstreamProtocol: matching?.upstreamProtocol || (provider.official ? "official" : "openaiResponses"),
    authMode: provider.official ? "officialAccount" : "apiKey",
    apiKeyConfigured: matching?.apiKeyConfigured === true,
    sourceProviderId: provider.id,
    officialAccount: provider.official,
    supportsRemoteCompaction: matching?.supportsRemoteCompaction,
    supportsWebsockets: matching?.supportsWebsockets,
    supportsNativeWebSearch: matching?.supportsNativeWebSearch,
    supportsAutoReview: matching?.supportsAutoReview,
    modelRequestHeaders: matching?.modelRequestHeaders || {},
  };
}

export function visibleRoutes(config: Config, provider: ProviderStatus["provider"] | null,
  officialAccountAvailable: boolean, pending: { id: string; enabled: boolean } | null): Profile[] {
  if (!config.localRouterEnabled) {
    const profile = nativeRoute(config.profiles, provider);
    return profile ? [profile] : [];
  }
  const profiles = config.profiles.filter(profile => profile.enabled === false
    || profile.authMode !== "officialAccount" || officialAccountAvailable || Boolean(profile.officialAccountId));
  return sortRoutesByEnabled(pending
    ? profiles.map(profile => profile.id === pending.id ? { ...profile, enabled: pending.enabled } : profile)
    : profiles);
}

export function routeModelGroups(config: Config, state: ModelState, profiles: Profile[], catalog: string[]): RouteModelGroup[] {
  const readOnly = !config.localRouterEnabled;
  const supported = readOnly ? state.officialModels.filter(model => model.supported).map(model => model.slug) : [];
  return profiles.filter(profile => profile.enabled !== false).map(profile => {
    const providerId = routeProviderId(profile);
    const official = profile.authMode === "officialAccount";
    const configured = config.selectedModelsByProvider[providerId] || [];
    const models = readOnly
      ? official ? uniqueModelIds(supported.length ? supported : state.officialModelIds) : state.thirdPartyModels
      : official ? uniqueModelIds(configured.length ? configured : catalog)
        : uniqueModelIds([...configured, ...(config.declaredOfficialModelsByProvider[providerId] || [])]);
    return { profile, providerId, models, official,
      defaultModel: readOnly ? state.defaultModel : globalDefaultForRoute(config, profile, models) };
  });
}

export function officialRouteModelDraft(config: Config, profile: Profile, catalog: string[]): string[] {
  const configured = config.selectedModelsByProvider[routeProviderId(profile)] || [];
  const keys = new Set(catalog.map(modelKey));
  const enabled = configured.filter(model => keys.has(modelKey(model)));
  return uniqueModelIds(enabled.length ? enabled : catalog);
}

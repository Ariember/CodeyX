import type { Profile } from "../../App.types";
import { MAX_ROUTE_NAME_CHARACTERS } from "../../officialRouteSettings";
import { validateThirdPartyRouteShortName } from "../../routeShortNames";
import { validateOutboundApiUrl } from "../../urlValidation";

export function createRouteDraft(id: string): Profile {
  return {
    id,
    enabled: true,
    name: "",
    shortName: "",
    baseUrl: "",
    apiKey: "",
    upstreamProtocol: "openaiResponses",
    authMode: "apiKey",
    apiKeyConfigured: false,
    modelRequestHeaders: {},
    clearApiKey: false,
    officialAccount: false,
    supportsRemoteCompaction: false,
    remoteCompactionProtocol: "responses",
    supportsWebsockets: false,
    supportsNativeWebSearch: false,
  };
}

export type RouteDraftErrors = {
  name: string;
  shortName: string;
  baseUrl: string;
  apiKey: string;
};

export function validateRouteDraft(route: Profile, profiles: readonly Profile[]): RouteDraftErrors {
  if (route.authMode === "officialAccount") {
    return { name: "", shortName: "", baseUrl: "", apiKey: "" };
  }
  return {
    name: Array.from(route.name.trim()).length > MAX_ROUTE_NAME_CHARACTERS
      ? `线路名最多 ${MAX_ROUTE_NAME_CHARACTERS} 个字符` : "",
    shortName: validateThirdPartyRouteShortName(route.shortName, profiles, route.id),
    baseUrl: validateOutboundApiUrl(route.baseUrl),
    apiKey: route.apiKey.trim() === "" && !route.apiKeyConfigured ? "请输入 API Key" : "",
  };
}

export function routeProtocolPatch(route: Profile, upstreamProtocol: unknown): Partial<Profile> | null {
  if (upstreamProtocol !== "openaiResponses" && upstreamProtocol !== "openaiChatCompletions"
    && upstreamProtocol !== "anthropicMessages" && upstreamProtocol !== "gemini") return null;
  return {
    upstreamProtocol,
    supportsRemoteCompaction: upstreamProtocol === "openaiResponses" && Boolean(route.supportsRemoteCompaction),
    supportsWebsockets: upstreamProtocol === "openaiResponses" && Boolean(route.supportsWebsockets),
    supportsNativeWebSearch: upstreamProtocol === "openaiResponses" && Boolean(route.supportsNativeWebSearch),
  };
}

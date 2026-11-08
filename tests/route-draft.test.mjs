import assert from "node:assert/strict";
import test from "node:test";
import { createModuleGraph } from "./helpers/jsx-tree.mjs";

const { createRouteDraft, validateRouteDraft, routeProtocolPatch } = createModuleGraph(
  new URL("../src/features/routes/draft.ts", import.meta.url),
).exports;
const validRoute = () => ({ ...createRouteDraft("route-a"), shortName: "主", baseUrl: "https://example.com/v1", apiKey: "test-key" });
const noErrors = { name: "", shortName: "", baseUrl: "", apiKey: "" };

test("线路草稿使用注入 ID，能力默认关闭且可变字段互不共享", () => {
  const first = createRouteDraft("first"), second = createRouteDraft("second");
  assert.equal(first.id, "first");
  assert.equal(second.id, "second");
  assert.equal(first.upstreamProtocol, "openaiResponses");
  for (const key of ["supportsRemoteCompaction", "supportsWebsockets", "supportsNativeWebSearch", "apiKeyConfigured", "clearApiKey"]) assert.equal(first[key], false);
  first.modelRequestHeaders.test = "value";
  assert.deepEqual(second.modelRequestHeaders, {});
});

test("线路校验保留可空名称、Unicode 上限和已保存密钥语义", () => {
  const route = validRoute();
  assert.deepEqual(validateRouteDraft(route, []), noErrors);
  assert.equal(validateRouteDraft({ ...route, name: ` ${"😀".repeat(15)} ` }, []).name, "");
  assert.equal(validateRouteDraft({ ...route, name: "😀".repeat(16) }, []).name, "线路名最多 15 个字符");
  assert.equal(validateRouteDraft({ ...route, apiKey: " " }, []).apiKey, "请输入 API Key");
  assert.equal(validateRouteDraft({ ...route, apiKey: "", apiKeyConfigured: true }, []).apiKey, "");
  assert.equal(validateRouteDraft(route, [route]).shortName, "");
  assert.match(validateRouteDraft(route, [{ ...route, id: "other" }]).shortName, /已被其他线路使用/);
  assert.equal(validateRouteDraft({ ...route, shortName: " " }, []).shortName, "请输入短名称");
});

test("线路校验拦截无效地址，官方账号保留独立校验入口", () => {
  const route = validRoute();
  assert.match(validateRouteDraft({ ...route, baseUrl: "" }, []).baseUrl, /请输入/);
  assert.match(validateRouteDraft({ ...route, baseUrl: "ftp://example.com" }, []).baseUrl, /HTTP/);
  assert.match(validateRouteDraft({ ...route, baseUrl: "https://user:pass@example.com" }, []).baseUrl, /不能包含/);
  assert.deepEqual(validateRouteDraft({ ...createRouteDraft("official"), authMode: "officialAccount" }, []), noErrors);
});

test("切换协议清除 Responses 专有能力，不恢复旧开关或修改原草稿", () => {
  const route = { ...validRoute(), supportsRemoteCompaction: true, supportsWebsockets: true, supportsNativeWebSearch: true };
  for (const protocol of ["openaiResponses", "openaiChatCompletions", "anthropicMessages", "gemini"]) {
    const patch = routeProtocolPatch(route, protocol);
    assert.equal(patch.upstreamProtocol, protocol);
    for (const key of ["supportsRemoteCompaction", "supportsWebsockets", "supportsNativeWebSearch"]) assert.equal(patch[key], protocol === "openaiResponses");
  }
  assert.equal(route.supportsWebsockets, true);
  assert.equal(routeProtocolPatch(createRouteDraft("new"), "openaiResponses").supportsWebsockets, false);
  for (const value of [null, undefined, "official", "unknown", 1]) assert.equal(routeProtocolPatch(route, value), null);
});

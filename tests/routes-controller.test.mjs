import assert from "node:assert/strict";
import test from "node:test";
import { createModuleGraph } from "./helpers/jsx-tree.mjs";
import { createControllerHarness, deferred, installControllerWindow } from "./helpers/controller-harness.mjs";

const { reconcileConfigDraft } = createModuleGraph(new URL("../src/configDraft.ts", import.meta.url)).exports;
const baseline = () => ({
  settingsRevision: 1, localRouterEnabled: true, activeProfileId: "a", defaultModel: "a/m1", streamMaxRetries: 2,
  profiles: [{ id: "a", name: "线路 A", authMode: "apiKey", enabled: true }, { id: "b", name: "线路 B", authMode: "apiKey", enabled: true },
    { id: "official", name: "官方", authMode: "officialAccount", officialAccountId: "account" }],
  selectedModelsByProvider: { a: ["m1", "m2"] }, declaredOfficialModelsByProvider: {},
  manualThirdPartyModelsByProvider: { a: ["manual"] }, upstreamModelsByProvider: { a: ["m1", "m2", "manual"] },
});
const models = () => ({ officialModels: [], officialModelIds: ["official-model"], thirdPartyModels: ["m1", "m2"], manualThirdPartyModels: [], upstreamModels: [], defaultModel: "m1" });

function createRoutesHarness(overrides = {}, handlers = {}) {
  const calls = [], notices = [], completions = [], starts = [], cancelled = [], saved = [], remembered = [];
  const options = {
    active: true, config: baseline(), dirty: false, isBusy: false,
    provider: { id: "a", name: "线路 A", official: false }, modelState: models(),
    persistedConfigRef: { current: baseline() }, status: {}, confirmation: null,
    setConfig(update) { options.config = typeof update === "function" ? update(options.config) : update; },
    setDirty(value) { options.dirty = value; },
    onConfigChange(value) { options.config = value; options.dirty = true; },
    setPersistedConfig(value) { options.persistedConfigRef.current = value; options.config = value; },
    isOnlyNativeRouterToggle: () => true,
    adoptRouteConfig(value) {
      const merged = reconcileConfigDraft(options.persistedConfigRef.current, options.config, value);
      if (merged) { options.persistedConfigRef.current = value; options.config = merged.config; }
      return merged;
    },
    setModelState(value) { options.modelState = value; },
    setProviderStatus(value) { options.provider = value.provider; },
    setStatus(update) { options.status = update(options.status); },
    setNotice(value) { notices.push(value); },
    setConfirmation(value) { options.confirmation = value; },
    beginModelPickerLoad(...args) { starts.push(args); return starts.length; },
    completeModelPickerLoad(...args) { completions.push(args); },
    cancelModelPickerLoad(session) { cancelled.push(session); },
    async runOperation(_name, action) { try { await action(); } catch (error) { notices.push({ tone: "error", text: error.message }); } },
    async persist(value) { saved.push(value); if (handlers.persist) return handlers.persist(value); options.setPersistedConfig(value); options.dirty = false; return { config: value }; },
    ...overrides,
  };
  const invoke = async (command, args) => {
    calls.push({ command, args });
    if (handlers[command]) return handlers[command](args);
    return { config: { ...baseline(), settingsRevision: 2 }, modelState: models(),
      providerStatus: { provider: options.provider }, routeModelState: models(), officialAccountAvailable: true, accounts: [] };
  };
  const harness = createControllerHarness(new URL("../src/features/routes/useRoutesController.ts", import.meta.url), "useRoutesController", {
    "../../api": { invoke },
    "../../officialAccountsRequests": { rememberOfficialAccounts: (value) => remembered.push(value) },
    "../runtime-status": { SETTINGS_OPENED_EVENT: "codey-settings-opened" },
  });
  const render = () => harness.render(options);
  return { ...harness, render, options, calls, notices, completions, starts, cancelled, saved, remembered };
}

test("路由开关只更新共享草稿，日志启用选择 SQLite，关闭保留已有后端", t => {
  installControllerWindow(t);
  const h = createRoutesHarness({ config: { ...baseline(), streamMaxRetries: 9,
    routeRequestLog: { enabled: false, backend: "ndjson", retentionDays: 7 } } });
  const controller = h.render();
  controller.toggleLocalRouter(false);
  assert.equal(h.options.config.localRouterEnabled, false);
  assert.equal(h.options.config.streamMaxRetries, 9);
  assert.equal(h.options.dirty, true);
  assert.equal(h.notices.at(-1).text, "保存并重启 Codex 后关闭本地路由");
  assert.equal(h.render().toggleLocalRouter, controller.toggleLocalRouter);
  controller.toggleLocalRouter(true);
  assert.equal(h.options.config.localRouterEnabled, true);
  assert.equal(h.notices.at(-1).text, "保存并重启 Codex 后开启本地路由");
  h.render().toggleRouteRequestLog(false);
  assert.deepEqual(h.options.config.routeRequestLog, { enabled: false, backend: "ndjson", retentionDays: 7 });
  assert.equal(h.notices.at(-1).text, "保存后关闭日志记录，无需重启");
  h.render().toggleRouteRequestLog(true);
  assert.deepEqual(h.options.config.routeRequestLog, { enabled: true, backend: "sqlite", retentionDays: 7 });
  assert.equal(h.notices.at(-1).text, "保存后开启日志记录，无需重启");
  assert.equal(h.calls.length, 0);
  assert.equal(h.saved.length, 0);
  h.unmount();
});

test("路由草稿开关在未加载、繁忙、隐藏和卸载后不编辑或提示", t => {
  installControllerWindow(t);
  for (const overrides of [{ config: null }, { isBusy: true }, { active: false }, {}]) {
    const h = createRoutesHarness(overrides);
    const controller = h.render();
    const before = h.options.config;
    if (Object.keys(overrides).length === 0) h.unmount();
    controller.toggleLocalRouter(false);
    controller.toggleRouteRequestLog(true);
    assert.equal(h.options.config, before);
    assert.equal(h.options.dirty, false);
    assert.equal(h.notices.length, 0);
    h.unmount();
  }
});

test("线路保存沿用草稿，新增与更新不改变活动线路，失败保留编辑内容", async (t) => {
  installControllerWindow(t);
  const h = createRoutesHarness();
  h.options.config.streamMaxRetries = 9;
  h.options.dirty = true;
  assert.equal(await h.render().saveRoute({ id: "new", name: "新增" }), true);
  assert.equal(h.saved[0].streamMaxRetries, 9);
  assert.equal(h.saved[0].activeProfileId, "a");
  await h.render().saveRoute({ id: "a", name: "更新" });
  assert.equal(h.saved[1].profiles.filter(({ id }) => id === "a").length, 1);
  const failed = createRoutesHarness({ dirty: true }, { persist: () => { throw new Error("版本冲突"); } });
  const before = structuredClone(failed.options.config);
  assert.equal(await failed.render().saveRoute({ id: "a", name: "不会保存" }), false);
  assert.deepEqual(failed.options.config, before);
  assert.equal(failed.options.dirty, true);
  assert.equal(failed.notices.at(-1).text, "版本冲突");
});

test("启停与模型排序使用保存版本，繁忙、草稿、关闭路由和未知线路均不写入", async (t) => {
  installControllerWindow(t);
  for (const overrides of [{ dirty: true }, { isBusy: true }, { active: false }, { config: { ...baseline(), localRouterEnabled: false } }]) {
    const h = createRoutesHarness(overrides);
    assert.equal(await h.render().setRouteEnabled("a", false), false);
    await h.render().reorderRouteModels("a", ["m2", "m1"]);
    assert.equal(h.calls.length, 0);
  }
  const h = createRoutesHarness();
  assert.equal(await h.render().setRouteEnabled("missing", true), false);
  await h.render().reorderRouteModels("missing", []);
  assert.equal(h.calls.length, 0);
  await h.render().setRouteEnabled("a", false);
  assert.deepEqual(h.calls[0], { command: "set_route_enabled", args: { routeId: "a", enabled: false, expectedRevision: 1 } });
  await h.render().reorderRouteModels("a", ["m2", "m1"]);
  assert.deepEqual(h.calls[1], { command: "reorder_route_models", args: { routeId: "a", models: ["m2", "m1"], expectedRevision: 2 } });
});

test("线路排序只在相同启用分组内移动，空操作不保存", async (t) => {
  installControllerWindow(t);
  const h = createRoutesHarness();
  await h.render().reorderRoute("a", "missing");
  await h.render().reorderRoute("a", "a");
  h.options.config.profiles[1].enabled = false;
  await h.render().reorderRoute("a", "b");
  assert.equal(h.saved.length, 0);
  h.options.config.profiles[1].enabled = true;
  await h.render().reorderRoute("a", "b");
  assert.deepEqual(h.saved[0].profiles.map(({ id }) => id), ["b", "a", "official"]);
  assert.equal(h.saved[0].activeProfileId, "a");
});

test("删除草稿不调用后端，已保存线路须先处理草稿并经过确认", async (t) => {
  installControllerWindow(t);
  const h = createRoutesHarness();
  h.options.config.profiles.push({ id: "draft", name: "草稿" });
  h.options.config.activeProfileId = "draft";
  h.render().requestDeleteRoute("draft");
  assert.equal(h.calls.length, 0);
  assert.equal(h.options.config.activeProfileId, "a");
  h.options.dirty = true;
  h.render().requestDeleteRoute("a");
  assert.equal(h.options.confirmation, null);
  assert.match(h.notices.at(-1).text, /请先保存或放弃/);
  h.options.dirty = false;
  h.render().requestDeleteRoute("a");
  assert.equal(h.options.confirmation.action, "delete-route");
  h.options.confirmation.run(); await h.flush();
  assert.equal(h.calls[0].command, "delete_route");
  assert.deepEqual(h.calls[0].args, { routeId: "a", expectedRevision: 1 });
});

test("模型同步失败保留第三方手工候选，官方线路保留官方目录", async (t) => {
  installControllerWindow(t);
  const h = createRoutesHarness({}, { fetch_route_models: () => { throw new Error("offline"); } });
  await h.render().fetchRouteModels(h.options.config.profiles[0]);
  assert.equal(h.completions[0][0], 1);
  assert.deepEqual(h.completions[0][1].officialModels, []);
  assert.deepEqual(h.completions[0][1].thirdPartyModels, ["m1", "m2"]);
  assert.deepEqual(h.completions[0][1].manualThirdPartyModels, ["manual"]);
  assert.match(h.completions[0][2], /仍可手动录入/);
  await h.render().fetchRouteModels(h.options.config.profiles[2]);
  assert.deepEqual(h.completions[1][1].officialModelIds, ["official-model"]);
  assert.match(h.completions[1][2], /当前账号可用模型/);
});

test("原生模式只在单独关闭路由时先保存，再同步并打开模型选择器", async (t) => {
  installControllerWindow(t);
  const config = { ...baseline(), localRouterEnabled: false };
  const h = createRoutesHarness({ config, dirty: true });
  await h.render().fetchRouteModels(config.profiles[0]);
  assert.equal(h.saved.length, 1);
  assert.equal(h.calls[0].command, "sync_current_provider");
  assert.deepEqual(h.completions[0][1].officialModelIds, []);
  const blocked = createRoutesHarness({ config, dirty: true, isOnlyNativeRouterToggle: () => false });
  await blocked.render().fetchRouteModels(config.profiles[0]);
  assert.equal(blocked.calls.length, 0);
  assert.equal(blocked.saved.length, 0);
});

test("官方线路组合保存不清除省略的预算，默认模型必须属于线路", async (t) => {
  installControllerWindow(t);
  const h = createRoutesHarness();
  assert.equal(await h.render().saveOfficialRouteSettings("official", [], false, true, undefined), false);
  assert.equal(await h.render().saveOfficialRouteSettings("a", ["m1"], false, true, undefined), false);
  const settings = { accountId: "account", routeName: "", routeShortName: "官", baseUrl: "https://example.com" };
  assert.equal(await h.render().saveOfficialRouteSettings("official", ["official-model"], true, true, undefined, settings), true);
  assert.deepEqual(h.calls[0].args, { routeId: "official", models: ["official-model"], showAccountUsageInHeader: true, enabled: true, ...settings });
  assert.equal(h.remembered.length, 1);
  await h.render().saveOfficialRouteSettings("official", ["official-model"], true, true, {});
  assert.equal(Object.hasOwn(h.calls[1].args, "upstreamProxy"), false);
  assert.deepEqual(h.calls[1].args.modelContexts, {});
  await h.render().setRouteDefaultModel("a", "unknown");
  assert.match(h.notices.at(-1).text, /不属于该线路/);
  assert.equal(h.calls.length, 2);
  await h.render().setRouteDefaultModel("a", "M1");
  assert.deepEqual(h.calls[2], { command: "save_default_model", args: { routeId: "a", model: "M1" } });
});

test("旧模型同步响应不能回退配置或覆盖新的草稿", async t => {
  installControllerWindow(t);
  const pending = deferred();
  const config = { ...baseline(), localRouterEnabled: false };
  const h = createRoutesHarness({ config }, { sync_current_provider: () => pending.promise });
  const work = h.render().fetchRouteModels(config.profiles[0]);
  h.options.adoptRouteConfig({ ...config, settingsRevision: 5 });
  h.options.config = { ...h.options.config, streamMaxRetries: 9 };
  pending.resolve({ config: { ...config, settingsRevision: 2 }, modelState: { ...models(), defaultModel: "old" },
    providerStatus: { provider: { id: "old" } }, restartRequired: true });
  await work;
  assert.equal(h.options.config.settingsRevision, 5);
  assert.equal(h.options.config.streamMaxRetries, 9);
  assert.equal(h.options.provider.id, "a");
  assert.equal(h.options.modelState.defaultModel, "m1");
  assert.deepEqual(h.options.status, {});
  assert.deepEqual(h.completions, []);
  assert.deepEqual(h.cancelled, [1]);
  assert.deepEqual(h.notices, []);
});

test("官方线路已保存的附属失败作为提示保留", async t => {
  installControllerWindow(t);
  const h = createRoutesHarness({}, { save_official_route_models: async () => ({
    config: { ...baseline(), settingsRevision: 2 }, warning: "官方账号列表未刷新", modelState: models(),
  }) });
  assert.equal(await h.render().saveOfficialRouteSettings("official", ["official-model"], true, true, undefined), true);
  assert.equal(h.notices.at(-1).tone, "info");
  assert.match(h.notices.at(-1).text, /已保存；官方账号列表未刷新/);
});

test("被动刷新合并草稿，旧响应、隐藏与卸载不覆盖当前配置", async (t) => {
  const browser = installControllerWindow(t);
  const reads = [];
  const h = createRoutesHarness({}, { load_codey_config: () => { const pending = deferred(); reads.push(pending); return pending.promise; } });
  h.render();
  h.options.config.streamMaxRetries = 9; h.options.dirty = true;
  browser.dispatch("codey:plugin-routes-changed");
  browser.dispatch("codey:plugin-routes-changed");
  reads[1].resolve({ config: { ...baseline(), settingsRevision: 3 } }); await h.flush();
  reads[0].resolve({ config: { ...baseline(), settingsRevision: 2 }, modelState: { defaultModel: "stale" } }); await h.flush();
  assert.equal(h.options.config.streamMaxRetries, 9);
  assert.equal(h.options.config.settingsRevision, 3);
  assert.equal(h.options.dirty, true);
  assert.equal(h.options.modelState.defaultModel, "m1");
  browser.dispatch("codey:plugin-routes-changed");
  h.options.active = false; h.render();
  reads[2].resolve({ config: { ...baseline(), settingsRevision: 4 } }); await h.flush();
  browser.dispatch("codey:plugin-routes-changed");
  assert.equal(reads.length, 3);
  assert.equal(h.options.config.settingsRevision, 3);
  h.options.active = true; h.render();
  assert.equal(reads.length, 4);
  h.unmount();
  reads[3].resolve({ config: { ...baseline(), settingsRevision: 5 } }); await h.flush();
  assert.equal(h.options.config.settingsRevision, 3);
});

test("同一渲染内重复操作只提交一次，失败后可再次提交", async (t) => {
  installControllerWindow(t);
  const pending = deferred();
  const h = createRoutesHarness({}, { set_route_enabled: () => pending.promise });
  const controller = h.render();
  const first = controller.setRouteEnabled("a", false);
  assert.equal(await controller.setRouteEnabled("b", false), false);
  const draft = h.options.config;
  controller.toggleLocalRouter(false);
  controller.toggleRouteRequestLog(true);
  assert.equal(h.options.config, draft);
  assert.equal(h.options.dirty, false);
  assert.equal(h.notices.length, 0);
  assert.equal(h.calls.length, 1);
  pending.reject(new Error("save failed"));
  assert.equal(await first, false);
  await h.render().reorderRouteModels("a", ["m2", "m1"]);
  assert.equal(h.calls.length, 2);
});

test("写入期间收到的插件变更在完成后合并刷新，不丢弃通知", async (t) => {
  const browser = installControllerWindow(t);
  const pending = deferred();
  const h = createRoutesHarness({}, { set_route_enabled: () => pending.promise });
  const writing = h.render().setRouteEnabled("a", false);
  browser.dispatch("codey:plugin-routes-changed");
  browser.dispatch("codey:plugin-routes-changed");
  assert.equal(h.calls.length, 1);
  pending.resolve({ config: { ...baseline(), settingsRevision: 2 } });
  await writing; await h.flush();
  assert.deepEqual(h.calls.map(({ command }) => command), ["set_route_enabled", "load_codey_config"]);
});

import assert from "node:assert/strict";
import test from "node:test";
import { createControllerHarness, deferred, installControllerWindow } from "./helpers/controller-harness.mjs";
import { createModuleGraph } from "./helpers/jsx-tree.mjs";

const feature = new URL("../src/features/configuration/", import.meta.url);
const state = createModuleGraph(new URL("state.ts", feature)).exports;
const subagents = createModuleGraph(new URL("../subagents/state.ts", feature)).exports;
const config = (patch = {}) => ({ settingsRevision: 1, codeyUpdateDownloadSource: "github", profiles: [], activeProfileId: "", streamMaxRetries: 2, subagentRoles: {}, retained: "saved", ...patch });
const provider = { changed: false, provider: { id: "test", name: "Test", official: false, baseUrl: "https://api.example.com" } };
const models = { officialModels: [], officialModelIds: [], thirdPartyModels: [], manualThirdPartyModels: [], upstreamModels: [], defaultModel: "" };
const loadResult = (patch = {}) => ({ config: config(), providerStatus: provider, modelState: models, ...patch });

test("draft changes reverted to saved values clear dirty without weakening revision protection", () => {
  const owner = createControllerHarness(new URL("../src/useDraftConfig.ts", import.meta.url), "useDraftConfig");
  const saved = config({ localRouterEnabled: true });
  owner.render().setPersistedConfig(saved);
  owner.render().editConfig({ ...saved, streamMaxRetries: 5 });
  assert.equal(owner.render().dirty, true);
  owner.render().editConfig({ ...saved, settingsRevision: 9 });
  assert.equal(owner.render().dirty, false);
  owner.render().editConfig({ ...saved, streamMaxRetries: 4 });
  owner.render().setPersistedConfig({ ...saved, settingsRevision: 0 });
  assert.equal(owner.render().config.streamMaxRetries, 4);
  assert.equal(owner.render().dirty, true);
  owner.render().setPersistedConfig({ ...saved, settingsRevision: 2 });
  assert.equal(owner.render().dirty, false);
  owner.unmount();
});

function fixture(t, extra = {}) {
  const browser = installControllerWindow(t);
  const calls = [], notices = [], changes = [], marketplaceGuards = [];
  let busy = null, runtimeStatus = { running: true }, providerStatus = null, modelState = null, refreshes = 0;
  window.addEventListener("codey:config-changed", event => changes.push(event.detail.config));
  const owner = createControllerHarness(new URL("../src/useDraftConfig.ts", import.meta.url), "useDraftConfig");
  const options = { active: true, isBusy: false,
    setBusy(update) { busy = typeof update === "function" ? update(busy) : update; },
    setNotice: notice => notices.push(notice),
    setProviderStatus(update) { providerStatus = typeof update === "function" ? update(providerStatus) : update; },
    setModelState(update) { modelState = typeof update === "function" ? update(modelState) : update; },
    setStatus(update) { runtimeStatus = typeof update === "function" ? update(runtimeStatus) : update; },
    async refreshStatus() { refreshes++; return runtimeStatus; },
    async refreshStatusForLoad() { return runtimeStatus; },
    async refreshPluginMarketplaceStatus(current) { marketplaceGuards.push(current); },
    ...extra,
  };
  const h = createControllerHarness(new URL("useConfigurationController.ts", feature), "useConfigurationController", {
    "../subagents": subagents,
    "../../api": { invoke(command, args) { const call = { command, args, ...deferred() }; calls.push(call); return call.promise; } },
  });
  const render = () => {
    options.status = runtimeStatus;
    const draft = owner.render();
    for (const key of ["config", "persistedConfigRef", "adoptRouteConfig", "adoptSavedConfig", "setDirty"]) options[key] = draft[key];
    return h.render(options);
  };
  const flush = async () => { await h.flush(); return render(); };
  const unmount = () => { h.unmount(); owner.unmount(); };
  t.after(unmount);
  render();
  return { ...h, ...browser, owner, calls, notices, changes, marketplaceGuards, options, render, flush, unmount,
    get busy() { return busy; }, get runtimeStatus() { return runtimeStatus; }, get providerStatus() { return providerStatus; },
    get modelState() { return modelState; }, get refreshes() { return refreshes; },
    get writesAfterUnmount() { return h.writesAfterUnmount + owner.writesAfterUnmount; },
    async ready(patch = {}) { calls.at(-1).resolve(loadResult(patch)); return flush(); },
    edit(patch) { owner.render().editConfig({ ...owner.render().config, ...patch }); return render(); },
    saveResult(patch = {}) { const call = calls.at(-1); const result = { config: { ...call.args.config, settingsRevision: call.args.config.settingsRevision + 1 }, ...patch }; call.resolve(result); return result; },
  };
}

test("加载经请求层采纳共享配置和可选状态，缺少 FastCtx 状态时保守降级", async t => {
  const h = fixture(t);
  assert.deepEqual(h.calls.map(call => call.command), ["load_codey_config"]);
  await h.ready({ officialAccountAvailable: true });
  assert.deepEqual(h.owner.render().config, config());
  assert.equal(h.owner.render().dirty, false);
  assert.equal(h.providerStatus, provider);
  assert.equal(h.modelState, models);
  assert.equal(h.runtimeStatus.officialAccountAvailable, true);
  assert.deepEqual(h.render().fastContextToolsStatus, state.UNKNOWN_FAST_CONTEXT_TOOLS_STATUS);
  assert.equal(h.timers.size, 0);
  assert.equal(h.marketplaceGuards[0](), true);
  assert.deepEqual(h.notices, []);
  h.options.active = false; h.render(); h.options.active = true; h.render();
  assert.equal(h.calls.length, 1, "初始化完成后普通重开的线路刷新仍由现有线路 controller 负责");
});

test("旧配置缺少下载源时规范化为官方，保存新来源并保留后续草稿", async t => {
  const h = fixture(t);
  const legacy = config(); delete legacy.codeyUpdateDownloadSource;
  await h.ready({ config: legacy });
  assert.equal(h.owner.render().config.codeyUpdateDownloadSource, "github");
  assert.equal(h.owner.render().dirty, false);
  const work = h.edit({ codeyUpdateDownloadSource: "ghProxy" }).saveCurrent();
  assert.equal(h.calls.at(-1).command, "save_codey_config");
  assert.equal(h.calls.at(-1).args.config.codeyUpdateDownloadSource, "ghProxy");
  h.edit({ retained: "new draft" }); h.saveResult(); await work;
  assert.equal(h.owner.render().persistedConfigRef.current.codeyUpdateDownloadSource, "ghProxy");
  assert.equal(h.owner.render().config.codeyUpdateDownloadSource, "ghProxy");
  assert.equal(h.owner.render().config.retained, "new draft");
  assert.equal(h.owner.render().dirty, true);
});

test("隐藏页面不初始化或写入，激活后加载；缺失服务配置与请求失败可重试", async t => {
  const h = fixture(t, { active: false });
  const c = h.render();
  await c.load(); await c.saveCurrent();
  assert.equal(c.applySavedConfig(loadResult()), false);
  await assert.rejects(c.persist(config()), /页面已关闭/);
  assert.equal(h.calls.length, 0);
  h.options.active = true; h.render();
  await h.ready({ providerStatus: undefined });
  assert.equal(h.render().loadFailed, true);
  assert.equal(h.owner.render().config, null);
  assert.match(h.notices.at(-1).text, /未能读取当前服务配置/);
  const retry = h.render().load(); h.calls.at(-1).reject(new Error("读取失败")); await retry;
  assert.equal(h.notices.at(-1).text, "读取失败");
  const recovered = h.render().load();
  await h.ready({ fastContextToolsStatus: { userConfigured: true, detectionFailed: false } }); await recovered;
  assert.equal(h.render().loadFailed, false);
  assert.equal(h.render().fastContextToolsStatus.userConfigured, true);
});

test("加载超时释放计时器，重试后迟到结果不能覆盖当前配置", async t => {
  const h = fixture(t);
  h.tick(); await h.flush();
  assert.equal(h.render().loadFailed, true);
  assert.match(h.notices.at(-1).text, /加载配置超时/);
  const retry = h.render().load();
  await h.ready({ config: config({ settingsRevision: 3, retained: "fresh" }) }); await retry;
  h.calls[0].resolve(loadResult({ config: config({ settingsRevision: 10, retained: "late" }) })); await h.flush();
  assert.equal(h.owner.render().config.retained, "fresh");
  assert.equal(h.timers.size, 0);
});

for (const failed of [false, true]) {
  test(`隐藏重开作废旧加载的${failed ? "错误" : "成功"}，旧清理不影响新加载`, async t => {
    const h = fixture(t);
    h.options.active = false; h.render(); assert.equal(h.timers.size, 0);
    h.options.active = true; h.render(); assert.equal(h.calls.length, 2);
    if (failed) h.calls[0].reject(new Error("stale")); else h.calls[0].resolve(loadResult({ config: config({ settingsRevision: 9 }) }));
    await h.flush();
    assert.equal(h.owner.render().config, null); assert.equal(h.timers.size, 1); assert.deepEqual(h.notices, []);
    await h.ready(); assert.equal(h.owner.render().config.settingsRevision, 1);
  });
}

test("刷新保留新草稿，拒绝旧版本及其附带状态", async t => {
  const h = fixture(t); await h.ready();
  const refresh = h.render().load(); h.edit({ retained: "draft" });
  await h.ready({ config: config({ settingsRevision: 2, streamMaxRetries: 5 }) }); await refresh;
  const draft = h.owner.render();
  assert.equal(draft.config.retained, "draft"); assert.equal(draft.config.streamMaxRetries, 5); assert.equal(draft.dirty, true);
  const stale = h.render().load();
  await h.ready({ config: config(), providerStatus: { provider: { id: "old" } }, modelState: { defaultModel: "old" }, officialAccountAvailable: true }); await stale;
  assert.equal(h.providerStatus, provider); assert.equal(h.modelState, models); assert.equal(h.runtimeStatus.officialAccountAvailable, undefined);
  assert.equal(h.owner.render().config.settingsRevision, 2);
});

test("保存同步防重、沿用提交基线合并新草稿并广播已确认配置", async t => {
  const h = fixture(t); await h.ready();
  const c = h.edit({ retained: "submitted" });
  const work = c.saveCurrent(); await c.saveCurrent();
  await assert.rejects(c.persist(config()), /正在保存/);
  assert.equal(h.calls.length, 2); assert.equal(h.busy, "save");
  assert.equal(h.calls[1].command, "save_codey_config"); assert.equal(h.calls[1].args.config.retained, "submitted");
  h.edit({ retained: "new draft" });
  const result = h.saveResult({ restartRequired: true, fastContextToolsStatus: { userConfigured: true, detectionFailed: false } });
  await work;
  const draft = h.owner.render();
  assert.equal(draft.config.retained, "new draft"); assert.equal(draft.dirty, true);
  assert.equal(draft.persistedConfigRef.current.retained, "submitted");
  assert.equal(h.runtimeStatus.restartRequired, true); assert.equal(h.render().fastContextToolsStatus.userConfigured, true);
  assert.deepEqual(h.changes, [result.config]); assert.equal(h.refreshes, 1); assert.equal(h.busy, null);
  assert.match(h.notices.at(-1).text, /已保存.*重启/);
});

test("保存失败保留草稿和基线，finally 不清除其他操作的忙碌状态", async t => {
  const h = fixture(t); await h.ready();
  const work = h.edit({ retained: "unsaved" }).saveCurrent();
  h.options.setBusy("restart"); h.calls.at(-1).reject(new Error("版本冲突")); await work;
  const draft = h.owner.render();
  assert.equal(draft.config.retained, "unsaved"); assert.equal(draft.dirty, true); assert.equal(draft.persistedConfigRef.current.settingsRevision, 1);
  assert.deepEqual(h.changes, []); assert.equal(h.notices.at(-1).text, "版本冲突"); assert.equal(h.busy, "restart");
});

test("旧版本保存响应不会覆盖较新配置、状态或显示成功", async t => {
  const h = fixture(t); await h.ready(); const work = h.edit({ retained: "submitted" }).saveCurrent();
  h.owner.render().setPersistedConfig(config({ settingsRevision: 5, retained: "newest" })); h.render();
  h.saveResult({ restartRequired: true, providerStatus: { provider: { id: "old" } }, modelState: { defaultModel: "old" } }); await work;
  assert.equal(h.owner.render().config.retained, "newest"); assert.equal(h.providerStatus, provider); assert.equal(h.modelState, models);
  assert.equal(h.runtimeStatus.restartRequired, undefined); assert.deepEqual(h.changes, []); assert.deepEqual(h.notices, []);
});

test("保存开始和局部保存采纳都作废关联读取，后台状态失败不撤销保存", async t => {
  const h = fixture(t, { refreshStatus: async () => { throw new Error("status unavailable"); } }); await h.ready();
  const stale = h.render().load(); const work = h.edit({ retained: "submitted" }).saveCurrent();
  assert.equal(h.timers.size, 0); h.saveResult(); await work;
  h.calls[1].reject(new Error("old read")); await stale;
  assert.equal(h.notices.at(-1).tone, "success"); assert.equal(h.render().loadFailed, false);
  const read = h.render().load();
  const result = loadResult({ config: config({ settingsRevision: 4, retained: "notification saved" }) });
  assert.equal(h.render().applySavedConfig(result), true);
  h.calls.at(-1).resolve(loadResult({ config: config({ settingsRevision: 9, retained: "stale" }) })); await read;
  assert.equal(h.owner.render().config.retained, "notification saved");
  assert.equal(h.render().applySavedConfig(loadResult()), false);
  assert.equal(h.changes.length, 2);
});

for (const failed of [false, true]) {
  test(`隐藏重开后保存${failed ? "失败" : "成功"}只重读，不重放写入且保留草稿`, async t => {
    const h = fixture(t); await h.ready();
    const work = h.edit({ retained: "submitted" }).saveCurrent();
    h.options.active = false; h.render(); h.options.active = true; h.render();
    await h.render().saveCurrent(); assert.equal(h.calls.length, 2);
    if (failed) h.calls[1].reject(new Error("stale failure")); else h.saveResult();
    await work; await h.flush();
    assert.equal(h.calls.length, 3); assert.equal(h.calls[2].command, "load_codey_config");
    assert.deepEqual(h.changes, []); assert.deepEqual(h.notices, []);
    await h.ready({ config: failed ? config() : config({ settingsRevision: 2, retained: "submitted" }) });
    assert.equal(h.owner.render().config.retained, "submitted"); assert.equal(h.owner.render().dirty, failed);
    assert.equal(h.calls.filter(call => call.command === "save_codey_config").length, 1);
    assert.equal(h.changes.length, 1); assert.equal(h.busy, null);
  });
}

test("保存期间的刷新排队，隐藏时等待重开，重读失败不会允许自动重放", async t => {
  const h = fixture(t); await h.ready(); const work = h.edit({ retained: "submitted" }).saveCurrent();
  await h.render().load(); assert.equal(h.calls.length, 2);
  h.options.active = false; h.render(); h.saveResult(); await work; await h.flush(); assert.equal(h.calls.length, 2);
  h.options.active = true; h.render(); h.calls[2].reject(new Error("读取失败")); await h.flush();
  await h.render().saveCurrent(); assert.equal(h.calls.length, 3); assert.match(h.notices.at(-1).text, /保存结果尚未确认/);
  h.options.active = false; h.render(); h.options.active = true; h.render();
  await h.ready({ config: config({ settingsRevision: 2, retained: "submitted" }) });
  const retry = h.edit({ retained: "next" }).saveCurrent(); h.saveResult(); await retry;
  assert.equal(h.owner.render().config.settingsRevision, 3);
});

test("忙碌时不提交，卸载清理计时器，迟到读取与保留的动作不回写", async t => {
  const h = fixture(t, { isBusy: true });
  const actions = h.render(); h.unmount(); assert.equal(h.timers.size, 0);
  h.calls[0].resolve(loadResult()); await h.flush(); await actions.load(); await actions.saveCurrent();
  assert.equal(actions.applySavedConfig(loadResult()), false);
  await assert.rejects(actions.persist(config()), /页面已关闭/);
  assert.equal(h.calls.length, 1); assert.equal(h.writesAfterUnmount, 0); assert.deepEqual(h.notices, []);
});

for (const failed of [false, true]) {
  test(`卸载后保存${failed ? "失败" : "成功"}不回写或清除共享状态`, async t => {
    const h = fixture(t); await h.ready(); h.options.isBusy = true;
    await h.edit({ retained: "unsaved" }).saveCurrent(); assert.equal(h.calls.length, 1);
    h.options.isBusy = false; const work = h.render().saveCurrent(); h.unmount();
    if (failed) h.calls.at(-1).reject(new Error("late")); else h.saveResult();
    await work; assert.equal(h.writesAfterUnmount, 0); assert.equal(h.busy, "save"); assert.deepEqual(h.notices, []); assert.deepEqual(h.changes, []);
  });
}

test("加载的附属查询失败可恢复，隐藏后迟到状态与错误不产生提示", async t => {
  const status = deferred(); const h = fixture(t, { refreshStatusForLoad: () => status.promise });
  await h.ready(); h.options.active = false; h.render();
  assert.equal(h.marketplaceGuards[0](), false);
  status.reject(new Error("stale status")); await h.flush(); assert.deepEqual(h.notices, []);
  h.options.refreshStatusForLoad = async () => { throw new Error("current status"); };
  h.options.active = true; h.render(); await h.ready();
  assert.equal(h.render().loadFailed, true); assert.equal(h.notices.at(-1).text, "current status");
  h.options.refreshStatusForLoad = async () => ({ running: false });
  const retry = h.render().load(); await h.ready(); await retry;
  assert.equal(h.notices.at(-1).text, "CodeyX 运行时已就绪");
});

test("加载提示区分启动失败、配置损坏、待重启和就绪，空状态不误报", () => {
  assert.deepEqual(state.configLoadNotice(loadResult({ startupError: "fallback", configLoadError: "配置损坏" }), { running: false, startupError: "current", restartRequired: true }),
    { tone: "error", text: "自动启动失败：current；配置损坏" });
  assert.deepEqual(state.configLoadNotice(loadResult({ startupError: "fallback" }), null), { tone: "error", text: "自动启动失败：fallback" });
  assert.equal(state.configLoadNotice(loadResult(), null), null);
  assert.equal(state.configLoadNotice(loadResult(), { running: true }), null);
  assert.match(state.configLoadNotice(loadResult(), { running: true, restartRequired: true }).text, /需重启/);
  assert.match(state.configLoadNotice(loadResult(), { running: false }).text, /已就绪/);
});

test("启动代理警告优先于普通成功和重启提示，实际错误仍优先", () => {
  const startupWarning = "代理未应用，已继续启动";
  for (const status of [{ running: true }, { running: true, restartRequired: true },
    { running: true, configApply: { settingsRevision: 1, phase: "applied" } }]) {
    assert.deepEqual(state.configLoadNotice(loadResult(), { ...status, startupWarning }), { tone: "info", text: startupWarning });
  }
  assert.deepEqual(state.configLoadNotice(loadResult(), { running: false, startupError: "启动失败", startupWarning }),
    { tone: "error", text: "自动启动失败：启动失败" });
  assert.deepEqual(state.configLoadNotice(loadResult(), { running: true, startupWarning,
    configApply: { settingsRevision: 1, phase: "failed", applyError: "设置应用失败" } }),
  { tone: "error", text: "CodeyX 设置已保存；设置应用失败" });
  assert.equal(state.configLoadNotice(loadResult(), { running: true, startupWarning: null }), null);
});

test("保存提示保留热更新、生效失败、被新设置取代和重启语义", () => {
  const cases = [
    [{}, false, "success", "CodeyX 设置已保存"],
    [{ warning: "模型状态未刷新：读取失败" }, false, "info", "CodeyX 设置已保存；模型状态未刷新：读取失败"],
    [{ modelHotReloadError: "刷新失败" }, false, "info", "CodeyX 设置已保存；模型列表未能实时更新：刷新失败"],
    [{ restartRequired: true }, false, "info", "CodeyX 设置已保存，启动参数将在重启 Codex 后生效"],
    [{ subagentConfigRepaired: true, subagentConfigHotReloaded: true }, false, "success", "CodeyX 设置已保存；子代理配置已同步"],
    [{ subagentConfigHotReloaded: true }, false, "success", "CodeyX 设置已保存；子代理配置已实时更新"],
    [{ subagentConfigHotReloadError: "错误" }, false, "info", "CodeyX 设置已保存；子代理配置未能实时更新：错误"],
    [{ routeRequestLogHealth: "failed" }, false, "error", "CodeyX 设置已保存；请求日志记录未能实时更新"],
    [{ routeRequestLogHealth: "failed", routeRequestLogHotReloadError: "日志错误" }, false, "error", "CodeyX 设置已保存；日志错误"],
    [{ routeRequestLogHealth: "superseded" }, false, "info", "CodeyX 设置已保存；请求日志配置被更新的设置取代，请确认当前开关状态"],
    [{ routeRequestLogHealth: "superseded", routeRequestLogHotReloadError: "已替换" }, false, "info", "CodeyX 设置已保存；已替换"],
    [{ routeRequestLogHealth: "enabled" }, false, "success", "CodeyX 设置已保存；请求日志记录已实时开启，无需重启"],
    [{ routeRequestLogHealth: "disabled", restartRequired: true }, false, "info", "CodeyX 设置已保存；请求日志记录已实时关闭，无需重启；其他启动参数将在重启 Codex 后生效"],
    [{ restartRequired: true }, true, "info", "CodeyX 设置已保存；会话重试次数将在重启 Codex 后生效"],
  ];
  for (const [result, retryChanged, tone, text] of cases) assert.deepEqual(state.configSaveNotice({ config: config(), ...result }, retryChanged), { tone, text });
  assert.equal(state.configSaveNotice({ config: config(), subagentConfigHealth: "pending_restart" }, false).tone, "info");
  assert.equal(state.configSaveNotice({ config: config(), routeRequestLogHealth: "failed", subagentConfigHotReloadError: "error" }, false).tone, "error");
});

test("配置功能只公开 controller，传输和纯规则留在功能内部", () => {
  assert.deepEqual(Object.keys(createModuleGraph(new URL("index.ts", feature), { stubs: { "../subagents": subagents } }).exports), ["useConfigurationController"]);
});

test("后台应用不占用保存按钮，连续保存拒绝旧应用结果并保留新草稿", async t => {
  const h = fixture(t); await h.ready();
  h.options.setStatus({ running: true, restartRequired: true });
  const first = h.edit({ retained: "first" }).saveCurrent();
  h.saveResult({ configApply: { settingsRevision: 2, phase: "pending" } });
  await first; await h.flush();
  assert.equal(h.busy, null);
  assert.equal(h.owner.render().dirty, false);
  assert.equal(h.runtimeStatus.restartRequired, false);
  assert.match(h.notices.at(-1).text, /已保存.*后台应用/);
  const second = h.edit({ retained: "second" }).saveCurrent();
  h.saveResult({ configApply: { settingsRevision: 3, phase: "pending" } });
  await second; await h.flush();
  h.edit({ retained: "new draft" });
  const notices = h.notices.length;
  h.options.setStatus({ running: true, configApply: { settingsRevision: 2, phase: "failed", applyError: "旧错误" } }); h.render();
  assert.equal(h.notices.length, notices);
  h.options.setStatus({ running: true, configApply: { settingsRevision: 3, phase: "failed", applyError: "应用失败" } }); h.render();
  assert.equal(h.notices.at(-1).tone, "error");
  assert.match(h.notices.at(-1).text, /已保存.*应用失败/);
  assert.equal(h.owner.render().config.retained, "new draft");
  assert.equal(h.owner.render().persistedConfigRef.current.retained, "second");
  assert.equal(h.calls.filter(call => call.command === "save_codey_config").length, 2);
});

test("后台应用完成只更新附属状态，隐藏期间保持静默，重开后补齐结果", async t => {
  const h = fixture(t); await h.ready();
  const work = h.edit({ retained: "saved" }).saveCurrent();
  h.saveResult({ configApply: { settingsRevision: 2, phase: "pending" } }); await work; await h.flush();
  h.options.active = false; h.render();
  const notices = h.notices.length;
  const nextModels = { ...models, defaultModel: "new" };
  h.options.setStatus({ running: true, configApply: { settingsRevision: 2, phase: "applied", modelState: nextModels } }); h.render();
  assert.equal(h.notices.length, notices);
  h.options.active = true; h.render();
  assert.equal(h.modelState, nextModels);
  assert.equal(h.notices.at(-1).text, "CodeyX 设置已保存并应用");
  h.render(); assert.equal(h.notices.length, notices + 1);
});

test("应用状态提示区分等待、成功、失败与需重启，重新加载保留后台状态", () => {
  for (const phase of ["pending", "applying", "applied", "failed", "restart_required"]) {
    const application = { settingsRevision: 1, phase, restartRequired: phase === "restart_required", modelHotReloadError: phase === "failed" ? "测试失败" : undefined };
    const notice = state.configApplyNotice(application);
    assert.equal(notice.tone, phase === "failed" ? "error" : phase === "applied" ? "success" : "info");
    assert.deepEqual(state.configLoadNotice(loadResult(), { running: true, configApply: application }), notice);
  }
});

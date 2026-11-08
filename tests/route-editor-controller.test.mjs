import assert from "node:assert/strict";
import test from "node:test";
import { createControllerHarness, deferred } from "./helpers/controller-harness.mjs";
import { createModuleGraph } from "./helpers/jsx-tree.mjs";

const { createRouteDraft } = createModuleGraph(new URL("../src/features/routes/draft.ts", import.meta.url)).exports;
const route = (id = "route") => ({ ...createRouteDraft(id), name: "测试线路", shortName: "主", baseUrl: "https://example.com/v1", apiKeyConfigured: true });
function setup(t, overrides = {}) {
  const writes = [], officialWrites = [], notices = [], refreshes = [];
  const h = createControllerHarness(new URL("../src/features/routes/useRouteEditorController.ts", import.meta.url), "useRouteEditorController");
  const options = { active: true, isBusy: false, config: { localRouterEnabled: true, profiles: [route()], selectedModelsByProvider: {}, modelContextByProvider: {} },
    officialAccounts: null, officialCatalog: ["alpha", "beta"], showAccountUsageInHeader: true,
    onSaveRoute(profile) { const pending = deferred(); writes.push({ ...pending, profile }); return pending.promise; },
    onSaveOfficialRouteSettings(...args) { const pending = deferred(); officialWrites.push({ ...pending, args }); return pending.promise; },
    onNotice: notice => notices.push(notice), refreshOfficialAccounts: async () => { refreshes.push(true); }, ...overrides };
  h.render(options);
  t.after(() => h.unmount());
  return { h, options, writes, officialWrites, notices, refreshes };
}

test("新线路校验先于写入，协议切换清理能力且未知协议不改变草稿", async t => {
  const { h, writes } = setup(t);
  h.render().openNewRouteDialog();
  assert.equal(await h.render().saveRouteDraft(), "route");
  assert.equal(writes.length, 0);
  assert.equal(h.render().routeValidationAttempted, true);
  assert.match(h.render().routeDraft.id, /^route-/);
  h.render().updateRouteDraft({ supportsWebsockets: true, supportsRemoteCompaction: true, supportsNativeWebSearch: true });
  h.render().changeProtocol("gemini");
  const draft = h.render().routeDraft;
  assert.equal(draft.upstreamProtocol, "gemini");
  for (const key of ["supportsWebsockets", "supportsRemoteCompaction", "supportsNativeWebSearch"]) assert.equal(draft[key], false);
  h.render().changeProtocol("unknown");
  assert.deepEqual(h.render().routeDraft, draft);
});

test("New API 导入只允许新建线路，失败保留草稿，填充后仍须显式保存", async t => {
  const { h, options, writes } = setup(t);
  const payload = JSON.stringify({ _type: "newapi_channel_conn", key: "fixture-key", url: "https://api.demo.test/v1" });
  assert.ok(h.render().importConnection(payload));
  h.render().openRouteDialog(route());
  assert.ok(h.render().importConnection(payload));
  h.render().closeRouteDialog();
  h.render().openNewRouteDialog();
  const draft = h.render().routeDraft;
  assert.ok(h.render().importConnection("invalid"));
  assert.deepEqual(h.render().routeDraft, draft);
  assert.equal(h.render().importConnection(payload), null);
  assert.equal(h.render().routeDraft.apiKey, "fixture-key");
  assert.equal(h.render().routeDraft.shortName, "demo");
  assert.equal(writes.length, 0);
  h.render({ ...options, active: false });
  assert.ok(h.render().importConnection(payload));
  h.render(options);
  const save = h.render().saveRouteDraft();
  assert.equal(writes.length, 1);
  assert.equal(writes[0].profile.baseUrl, "https://api.demo.test/v1");
  writes[0].resolve(true); await save;
});

test("第三方保存合并请求头，重复提交与保存期间改稿被阻止，失败保留草稿", async t => {
  const { h, writes, notices } = setup(t);
  h.render().openRouteDialog(route());
  h.render().changeHeaders('{"X-Test":"value"}');
  const save = h.render().saveRouteDraft();
  await h.render().saveRouteDraft();
  h.render().updateRouteDraft({ name: "不应修改" });
  h.render().closeRouteDialog();
  assert.equal(writes.length, 1);
  assert.equal(h.render().saving, true);
  assert.equal(h.render().routeDraft.name, "测试线路");
  assert.deepEqual(writes[0].profile.modelRequestHeaders, { "x-test": "value" });
  writes[0].reject(new Error("保存失败"));
  await save;
  assert.equal(h.render().saving, false);
  assert.equal(h.render().routeDialogOpen, true);
  assert.deepEqual(notices, [{ tone: "error", text: "保存失败" }]);
  const refused = h.render().saveRouteDraft();
  writes[1].resolve(false); await refused;
  assert.equal(h.render().routeDialogOpen, true);
  const retry = h.render().saveRouteDraft();
  writes[2].resolve(true); await retry;
  assert.equal(h.render().routeDialogOpen, false);
});

test("请求头错误不写入，清空与删除语义保留，取消不改配置", async t => {
  const { h, options, writes } = setup(t);
  h.render().openHeadersDialog(route());
  h.render().changeHeaders("invalid");
  await h.render().saveHeaders();
  assert.ok(h.render().headerError);
  assert.equal(writes.length, 0);
  h.render().changeHeaders('{"X-Remove":null,"X-Blank":""}');
  assert.equal(h.render().headerError, "");
  const save = h.render().saveHeaders();
  await h.render().saveHeaders();
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].profile.modelRequestHeaders, { "x-remove": "", "x-blank": "" });
  writes[0].resolve(false); await save;
  assert.ok(h.render().headerDialogProfile);
  h.render().closeHeadersDialog();
  assert.equal(h.render().headerDialogProfile, null);
  assert.deepEqual(options.config.profiles[0].modelRequestHeaders, {});
  h.render().openRouteDialog(route());
  h.render().changeHeaders("invalid");
  await h.render().saveRouteDraft();
  assert.ok(h.render().headerError);
  assert.equal(h.render().routeValidationAttempted, true);
  assert.equal(writes.length, 1);
});

test("官方连接编辑保留空名称及模型上下文，模型编辑省略账号设置", async t => {
  const profile = { ...route(), authMode: "officialAccount", officialAccountId: "account", sourceProviderId: "provider" };
  const { h, options, officialWrites, refreshes } = setup(t, { officialAccounts: [{ id: "account", routeName: "", routeShortName: "官", baseUrl: "" }] });
  options.config = { ...options.config, profiles: [profile], selectedModelsByProvider: { provider: ["BETA", "retired"] }, modelContextByProvider: { provider: { BETA: { contextWindowTokens: 128000 } } } };
  h.render(options).openRouteDialog(profile, "settings");
  assert.equal(h.render().officialRouteDraft.routeName, "");
  h.render().updateOfficialRouteDraft({ routeShortName: " 官 " });
  let save = h.render().saveRouteDraft();
  assert.deepEqual(officialWrites[0].args, [profile.id, ["BETA", "retired"], true, true, undefined, { accountId: "account", routeName: "", routeShortName: "官", baseUrl: "" }]);
  officialWrites[0].resolve(true); await save;
  assert.equal(refreshes.length, 1);
  assert.equal(h.render().routeDraft, null);
  h.render().openRouteDialog(profile, "models");
  assert.deepEqual(h.render().officialModelDraft, ["BETA"]);
  h.render().toggleOfficialModel("BETA", false);
  assert.deepEqual(h.render().officialModelDraft, ["BETA"]);
  h.render().toggleOfficialModel("alpha", true);
  h.render().toggleOfficialModel("beta", false);
  h.render().updateOfficialModelContext("beta", { contextWindowTokens: 256000 });
  assert.deepEqual(h.render().officialModelContextDraft, { beta: { contextWindowTokens: 256000 } });
  save = h.render().saveRouteDraft();
  assert.deepEqual(officialWrites[1].args, [profile.id, ["alpha"], true, true, { beta: { contextWindowTokens: 256000 } }, undefined]);
  officialWrites[1].resolve(true); await save;
});

test("官方校验失败、空模型目录与缺失保存能力均保留草稿", async t => {
  const profile = { ...route(), authMode: "officialAccount" };
  const { h, options, officialWrites } = setup(t);
  h.render().openRouteDialog(profile, "settings");
  h.render().updateOfficialRouteDraft({ routeShortName: "" });
  assert.equal(await h.render().saveRouteDraft(), "official");
  assert.equal(officialWrites.length, 0);
  h.render({ ...options, officialCatalog: [] }).openRouteDialog(profile, "models");
  await h.render().saveRouteDraft();
  assert.equal(officialWrites.length, 0);
  h.render({ ...options, onSaveOfficialRouteSettings: undefined }).openRouteDialog(profile, "models");
  await h.render().saveRouteDraft();
  assert.equal(h.render().routeDialogOpen, true);
  assert.equal(h.render().saving, false);
});

test("隐藏重开使旧保存结果失效且不重放写入，失败与成功均保留草稿", async t => {
  for (const failed of [false, true]) {
    const { h, options, writes, notices } = setup(t);
    h.render().openRouteDialog(route());
    const save = h.render().saveRouteDraft();
    h.render({ ...options, active: false });
    await h.render().saveRouteDraft();
    h.render(options);
    await h.render().saveRouteDraft();
    assert.equal(writes.length, 1);
    if (failed) writes[0].reject(new Error("迟到失败")); else writes[0].resolve(true);
    await save;
    assert.equal(h.render().routeDialogOpen, true);
    assert.equal(h.render().saving, false);
    assert.deepEqual(notices, []);
    assert.equal(writes.length, 1);
  }
});

test("只读切换清理编辑器并屏蔽旧回调，卸载后不写状态", async t => {
  for (const unmount of [false, true]) {
    const { h, options, writes, notices } = setup(t);
    h.render().openHeadersDialog(route());
    const save = h.render().saveHeaders();
    if (unmount) h.unmount();
    else {
      h.render({ ...options, config: { ...options.config, localRouterEnabled: false } });
      assert.equal(h.render().headerDialogProfile, null);
      h.render().openNewRouteDialog();
      assert.equal(h.render().routeDraft, null);
      h.render(options);
      h.render().openHeadersDialog(route("new"));
      assert.equal(h.render().headerDialogProfile, null);
    }
    writes[0].reject(new Error("迟到错误")); await save;
    assert.deepEqual(notices, []);
    assert.equal(h.writesAfterUnmount, 0);
  }
});

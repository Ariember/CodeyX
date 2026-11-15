import assert from "node:assert/strict";
import test from "node:test";
import { autoStubModule, collectElements, createModuleGraph, createStub, elementProps, elementType, textContent } from "./helpers/jsx-tree.mjs";

const ui = autoStubModule("ui");
const components = Object.fromEntries(["ExtensionScope", "ExtensionFilters", "ExtensionList", "ExtensionEditor", "ConfirmationDialog", "SkillCacheDialog"].map(name => [name, createStub(name)]));
const common = { "../../components/ui": ui, "@tabler/icons-react": autoStubModule("icon"), "@heroui/react": { toast: { success() {}, warning() {} } },
  "../../SettingsPageHeader": { SettingsPageHeader: createStub("SettingsPageHeader") },
  "./ExtensionToolbar": components, "./ExtensionList": components, "./ExtensionEditor": components, "./ConfirmationDialog": components, "./SkillCacheDialog": components };
const propsOf = (tree, name) => elementProps(collectElements(tree, node => elementType(node) === components[name])[0]);

test("扩展页面将编辑、比对、确认和筛选事件接到 controller", () => {
  const calls = [];
  const action = name => (...args) => { calls.push([name, ...args]); };
  const controller = {
    inventory: { revision: "r1", warnings: [] }, scope: { kind: "user" }, entries: [], filtered: [], currentPage: { entries: [], page: 1, pages: 1 },
    selected: [], query: "", filter: "all", source: "all", sort: "name", projectPath: "", projectMode: false, canSelectPage: true, deselectPage: true,
    draft: { kind: "mcp", id: "fixture", content: "{}", isNew: true }, comparison: { content: "latest", revision: "r2" },
    confirmation: { title: "确认", description: "fixture" }, discard: null, busy: false, loading: false, saving: false, error: "", notice: "", noticeSeq: 0,
    ...Object.fromEntries(["refresh", "changeMode", "setProjectPath", "pickProject", "changeScope", "setQuery", "setFilter", "setSource", "setSort", "clearFilters", "selectPage", "selectEntry", "onAction", "changeDraft", "save", "closeDraft", "pickSkill", "loadLatest", "adoptComparison", "cancelConfirmation", "confirmAction"].map(name => [name, action(name)])),
  };
  const graph = createModuleGraph(new URL("../src/features/codex-extensions/CodexExtensionsPage.tsx", import.meta.url), {
    stubs: { ...common, "./useExtensionsPageController": { useExtensionsPageController: options => { assert.equal(options.active, true); assert.equal(typeof options.onDownload, "function"); return controller; } } },
  });
  const tree = graph.exports.CodexExtensionsPage({ kind: "mcp", active: true });
  const selectionButton = collectElements(tree, node => elementType(node) === ui.Button && textContent(node) === "取消本页")[0];
  assert.equal(elementProps(selectionButton).disabled, false);
  elementProps(selectionButton).onClick();
  const editor = propsOf(tree, "ExtensionEditor");
  editor.onChange({ content: "draft" }); editor.onSave(); editor.onCancel(); editor.onPick(); editor.onReload();
  const filters = propsOf(tree, "ExtensionFilters"); filters.onQuery("query"); filters.onClear();
  const scope = propsOf(tree, "ExtensionScope"); scope.onMode(true); scope.onRead(); scope.onPick();
  const list = propsOf(tree, "ExtensionList"); list.onAction("edit", { id: "fixture" }); list.onSelect("fixture");
  propsOf(tree, "ConfirmationDialog").onConfirm();
  const compare = collectElements(tree, node => elementType(node) === ui.Button && textContent(node).includes("已比对"))[0];
  elementProps(compare).onClick();
  assert.deepEqual(calls.map(call => call[0]), ["selectPage", "changeDraft", "save", "closeDraft", "pickSkill", "loadLatest", "setQuery", "clearFilters", "changeMode", "changeScope", "pickProject", "onAction", "selectEntry", "confirmAction", "adoptComparison"]);
});

test("缓存弹窗将读取、刷新和确认删除接到 controller，删除时禁止关闭", () => {
  const calls = [];
  const entry = { id: "cache", name: "fixture", sourcePath: "/fixture", description: "fixture" };
  const state = { cache: { skills: [entry], warnings: [] }, busy: "", error: "", notice: "", blocked: false,
    confirmation: entry, document: null, unavailable: false, refresh: () => calls.push("refresh"), read: item => calls.push(["read", item.id]),
    askRemove: item => calls.push(["askRemove", item.id]), remove: () => calls.push("remove"), cancelRemove: () => calls.push("cancel") };
  const graph = createModuleGraph(new URL("../src/features/codex-extensions/SkillCacheDialog.tsx", import.meta.url), {
    stubs: { ...common, "./useSkillCacheController": { useSkillCacheController: () => state } },
  });
  let closed = 0;
  const tree = graph.exports.SkillCacheDialog({ open: true, onClose: () => closed++ });
  for (const label of ["刷新缓存", "查看", "删除"]) {
    const button = collectElements(tree, node => elementType(node) === ui.Button && textContent(node) === label)[0];
    elementProps(button).onClick();
  }
  propsOf(tree, "ConfirmationDialog").onConfirm();
  assert.deepEqual(calls, ["refresh", ["read", "cache"], ["askRemove", "cache"], "remove"]);
  const dialog = collectElements(tree, node => elementType(node) === ui.Dialog)[0];
  elementProps(dialog).onOpenChange(false); assert.equal(closed, 0);
  assert.equal(graph.exports.SkillCacheDialog({ open: false, onClose() {} }), null);
});

test("本地 MCP 共享控件接线并展示聚合状态，读取失败不显示健康零值", () => {
  const calls = [];
  const graph = createModuleGraph(new URL("../src/features/codex-extensions/ExtensionList.tsx", import.meta.url), {
    stubs: { "../../components/ui": ui, "@tabler/icons-react": autoStubModule("icon") },
  });
  const entry = { id: "local", name: "local", sourcePath: "/config", enabled: true, transport: "stdio", readOnly: false,
    sharing: { enabled: true, maxInstances: 4, registrationId: "registered" } };
  const props = { kind: "mcp", entries: [entry, { ...entry, id: "http", transport: "http" }], busy: false,
    onAction() {}, onSharing: (...args) => calls.push(args), sharingStatus: { pools: [
      { registrationId: "registered", id: "local", sourcePath: "/config", instances: 2, running: 1, queued: 3 },
    ] } };
  const tree = graph.exports.ExtensionList(props);
  const share = collectElements(tree, node => elementType(node) === ui.Switch && elementProps(node)["aria-label"] === "共享 local 实例");
  assert.equal(share.length, 1);
  elementProps(share[0]).onCheckedChange(false);
  const limit = collectElements(tree, node => elementType(node) === ui.Select)[0];
  assert.deepEqual(elementProps(limit).optionList.map(item => item.value), ["1", "2", "3", "4", "5", "6", "7", "8"]);
  elementProps(limit).onChange("8");
  assert.deepEqual(calls, [[entry, false], [entry, true, 8]]);
  assert.match(textContent(tree), /执行 1 · 排队 3/);
  const failed = graph.exports.ExtensionList({ ...props, sharingStatus: null, sharingStatusError: "未能读取共享运行状态，请刷新后重试。" });
  assert.match(textContent(failed), /未能读取共享运行状态/);
  assert.doesNotMatch(textContent(failed), /实例 0/);
});

test("内置 MCP 显示共享限制，已共享时只允许关闭且不可调整上限", () => {
  const graph = createModuleGraph(new URL("../src/features/codex-extensions/ExtensionList.tsx", import.meta.url), {
    stubs: { "../../components/ui": ui, "@tabler/icons-react": autoStubModule("icon") },
  });
  for (const enabled of [false, true]) {
    const entry = { id: "codey_fastctx", name: "codey_fastctx", transport: "stdio", readOnly: false,
      sharing: { enabled, maxInstances: 4, canShare: false, reason: "内置服务不支持共享" } };
    const tree = graph.exports.ExtensionList({ kind: "mcp", entries: [entry], busy: false, onAction() {}, onSharing() {} });
    const toggle = collectElements(tree, node => elementType(node) === ui.Switch && elementProps(node)["aria-label"] === "共享 codey_fastctx 实例")[0];
    assert.equal(elementProps(toggle).disabled, !enabled);
    assert.match(textContent(tree), /内置服务不支持共享/);
    if (enabled) assert.equal(elementProps(collectElements(tree, node => elementType(node) === ui.Select)[0]).disabled, true);
  }
});

test("共享器卡片连接总开关和释放操作，未知状态不显示关闭开关，Skill 页隐藏卡片", () => {
  const calls = [];
  const controller = {
    inventory: { revision: "r1", warnings: [] }, scope: { kind: "user" }, entries: [], filtered: [], currentPage: { entries: [], page: 1, pages: 1 },
    selected: [], query: "", filter: "all", source: "all", sort: "name", busy: false, loading: false, notice: "", noticeSeq: 0,
    sharingStatus: { enabled: true, pools: [] }, sharingLoading: false, sharingStatusError: "",
    setMcpSchedulerEnabled: value => calls.push(["enabled", value]), releaseMcpIdle: () => calls.push(["release"]),
  };
  const graph = createModuleGraph(new URL("../src/features/codex-extensions/CodexExtensionsPage.tsx", import.meta.url), {
    stubs: { ...common, "./useExtensionsPageController": { useExtensionsPageController: () => controller } },
  });
  let tree = graph.exports.CodexExtensionsPage({ kind: "mcp" });
  const switchOf = tree => collectElements(tree, node => elementType(node) === ui.Switch && elementProps(node)["aria-label"] === "启用共享器");
  assert.equal(elementProps(switchOf(tree)[0]).checked, true);
  elementProps(switchOf(tree)[0]).onCheckedChange(false);
  elementProps(collectElements(tree, node => elementType(node) === ui.Button && textContent(node) === "释放空闲实例")[0]).onClick();
  assert.deepEqual(calls, [["enabled", false], ["release"]]);
  controller.unavailable = true;
  assert.equal(elementProps(switchOf(graph.exports.CodexExtensionsPage({ kind: "mcp" }))[0]).disabled, true);
  controller.sharingStatus = null;
  controller.sharingStatusError = "未能读取共享运行状态，请刷新后重试。";
  tree = graph.exports.CodexExtensionsPage({ kind: "mcp" });
  assert.equal(switchOf(tree).length, 0);
  assert.match(textContent(tree), /状态待确认/);
  assert.doesNotMatch(textContent(tree), /已关闭 · 全局/);
  assert.equal(switchOf(graph.exports.CodexExtensionsPage({ kind: "skill" })).length, 0);
});

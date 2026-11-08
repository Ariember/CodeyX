import assert from "node:assert/strict";
import test from "node:test";
import { createControllerHarness, deferred, installControllerWindow } from "./helpers/controller-harness.mjs";
import { loadTypeScriptModule } from "./helpers/load-typescript-module.mjs";
import { elementProps } from "./helpers/jsx-tree.mjs";

const api = await loadTypeScriptModule(new URL("../src/api.ts", import.meta.url));
const ready = { status: "ready", computerUse: { supported: true, ready: true } };
const fallbackStatus = { running: true, clientPlatform: "windows", maintenance: { startupInjectionMode: "cli" } };
function fixture(extra = {}) {
  const calls = [], notices = [], busy = [], saves = [], statuses = [], restartErrors = [];
  let confirmation = null, restarts = 0;
  const options = {
    active: true, config: { retained: "draft" }, dirty: false, isBusy: false,
    onConfigChange: config => { options.config = config; },
    status: { running: true }, restartStatusError: null,
    persist: async config => { saves.push(config); },
    refreshStatus: async () => options.status,
    markRestartInProgress: () => { restarts++; options.status = { ...options.status, restartInProgress: true }; },
    setRestartStatusError: error => { restartErrors.push(error); options.restartStatusError = error; },
    setStatus: update => { options.status = update(options.status); statuses.push(options.status); },
    setBusy: name => { busy.push(name); options.isBusy = name !== null; },
    setNotice: notice => notices.push(notice), setConfirmation: value => { confirmation = value; }, ...extra,
  };
  const h = createControllerHarness(new URL("../src/features/runtime-maintenance/useRuntimeMaintenanceController.ts", import.meta.url), "useRuntimeMaintenanceController", {
    "../../api": { invoke(command, args) { const call = { command, args, ...deferred() }; calls.push(call); return call.promise; } },
  });
  return { ...h, options, calls, notices, busy, saves, statuses, restartErrors,
    render: () => h.render(options), dismissConfirmation: () => { confirmation?.onDismiss?.(); confirmation = null; },
    get confirmation() { return confirmation; }, get restarts() { return restarts; } };
}

test("市场读取独立于修复，过期成功、错误和加载轮次均不覆盖最新状态", async t => {
  installControllerWindow(t);
  for (const failed of [false, true]) {
    const h = fixture(); const c = h.render();
    const first = c.refreshPluginMarketplaceStatus();
    const second = c.refreshPluginMarketplaceStatus();
    h.calls[1].resolve(ready); await second;
    if (failed) h.calls[0].reject(new Error("old")); else h.calls[0].resolve({ status: "needs_repair" });
    await first; assert.deepEqual(h.render().pluginMarketplaceStatus, ready);
    let current = true;
    const stale = h.render().refreshPluginMarketplaceStatus(() => current); current = false;
    h.calls[2].resolve({ status: "error" }); await stale;
    assert.deepEqual(h.render().pluginMarketplaceStatus, ready);
    assert.ok(h.calls.every(call => call.command === "plugin_marketplace_status")); h.unmount();
  }
});

test("市场读取超时可恢复，写入作废旧读且同一轮重复提交被阻止", async t => {
  const browser = installControllerWindow(t);
  const h = fixture(); const read = h.render().refreshPluginMarketplaceStatus();
  browser.tick(); await read; assert.match(h.render().pluginMarketplaceStatus.message, /查询超时/);
  const oldRead = h.render().refreshPluginMarketplaceStatus(); const old = h.calls.at(-1);
  const c = h.render(); const write = c.repairPluginMarketplace();
  await c.repairPluginMarketplace(); await c.prepareComputerUse();
  assert.equal(h.calls.length, 3);
  h.calls.at(-1).resolve({ ...ready, initializedRemote: true }); await write;
  old.reject(new Error("old read")); await oldRead;
  assert.equal(h.render().pluginMarketplaceStatus.status, "ready");
  assert.match(h.notices.at(-1).text, /立即生效，无需重启/);
  assert.deepEqual(h.busy, ["repair-plugin-marketplace", null]);
  h.calls[0].resolve({ status: "error" }); await h.flush();
  assert.equal(h.render().pluginMarketplaceStatus.status, "ready"); h.unmount();
});

test("插件修复保留正常、未完成、失败语义，桌面准备反馈独立展示", async t => {
  installControllerWindow(t);
  const h = fixture();
  for (const [result, tone, text] of [[ready, "success", /状态正常/], [{ status: "needs_repair" }, "error", /仍有缺失项/], [new Error("repair failed"), "error", /repair failed/]]) {
    const work = h.render().repairPluginMarketplace();
    if (result instanceof Error) h.calls.at(-1).reject(result); else h.calls.at(-1).resolve(result);
    await work; assert.equal(h.notices.at(-1).tone, tone); assert.match(h.notices.at(-1).text, text);
  }
  for (const [result, tone] of [[ready, "success"], [{ status: "needs_repair" }, "error"], [new Error("prepare failed"), "error"]]) {
    const before = h.notices.length; const work = h.render().prepareComputerUse();
    assert.equal(h.calls.at(-1).command, "prepare_computer_use");
    if (result instanceof Error) h.calls.at(-1).reject(result); else h.calls.at(-1).resolve(result);
    await work; assert.equal(h.render().computerUseNotice.tone, tone); assert.equal(h.notices.length, before);
  }
  assert.deepEqual(h.options.config, { retained: "draft" }); h.unmount();
});

test("隐藏暂停读取和写入，重开丢弃旧结果并在后台写入结束后刷新", async t => {
  installControllerWindow(t);
  for (const mutation of [false, true]) for (const failed of [false, true]) {
    const h = fixture(); const c = h.render();
    const work = mutation ? c.prepareComputerUse() : c.refreshPluginMarketplaceStatus(); const old = h.calls[0];
    h.options.active = false; h.render();
    await h.render().refreshPluginMarketplaceStatus(); await h.render().prepareComputerUse(); assert.equal(h.calls.length, 1);
    h.options.active = true; h.render();
    if (mutation) { await h.render().prepareComputerUse(); assert.equal(h.calls.length, 1); }
    if (failed) old.reject(new Error("late")); else old.resolve(ready);
    await work; await h.flush();
    assert.equal(h.render().pluginMarketplaceStatus, null); assert.equal(h.render().computerUseNotice, null);
    assert.equal(h.notices.length, 0); assert.equal(h.calls.at(-1).command, "plugin_marketplace_status");
    h.calls.at(-1).resolve(ready); await h.flush(); assert.deepEqual(h.render().pluginMarketplaceStatus, ready);
    h.unmount();
  }
});

test("全局忙碌、隐藏与卸载不提交维护命令；卸载释放超时并屏蔽迟到回写", async t => {
  const browser = installControllerWindow(t);
  for (const extra of [{ active: false }, { isBusy: true }]) {
    const h = fixture(extra); const c = h.render();
    c.askRestartCodex(); c.askRepairCodexConfig();
    await c.prepareComputerUse(); await c.repairPluginMarketplace(); await c.analyzeDiagnosticStorage("trace");
    assert.equal(h.confirmation, null); assert.equal(h.calls.length, 0); h.unmount();
  }
  for (const action of ["refreshPluginMarketplaceStatus", "prepareComputerUse", "repairPluginMarketplace", "analyzeDiagnosticStorage"]) {
    for (const failed of [false, true]) {
      const h = fixture(); const work = h.render()[action](...(action === "analyzeDiagnosticStorage" ? ["trace"] : []));
      h.unmount(); assert.equal(browser.timers.size, 0);
      const before = [h.notices.length, h.busy.length, h.statuses.length];
      if (failed) h.calls[0].reject(new Error("late")); else h.calls[0].resolve(ready);
      await work; assert.equal(h.writesAfterUnmount, 0);
      assert.deepEqual([h.notices.length, h.busy.length, h.statuses.length], before);
    }
  }
});

test("重启确认使用最新草稿，先保存再重启；保存失败保留草稿且不重启", async t => {
  installControllerWindow(t);
  const save = deferred(); const h = fixture({ dirty: true, persist: config => { h.saves.push(config); return save.promise; } });
  h.render().askRestartCodex(); assert.equal(h.confirmation.action, "restart"); assert.equal(h.calls.length, 0);
  const latest = { retained: "latest draft" }; h.options.config = latest; h.render(); h.confirmation.run();
  h.confirmation.run(); assert.deepEqual(h.saves, [latest]); assert.equal(h.calls.length, 0);
  save.resolve(); await h.flush(); assert.equal(h.calls[0].command, "restart_codey");
  h.calls[0].resolve(); await h.flush(); assert.equal(h.restarts, 1); h.unmount();
  const failed = fixture({ dirty: true, persist: async () => { throw new Error("save failed"); } });
  failed.render().askRestartCodex(); failed.confirmation.run(); await failed.flush();
  assert.equal(failed.calls.length, 0); assert.match(failed.notices.at(-1).text, /save failed/);
  assert.deepEqual(failed.options.config, { retained: "draft" }); failed.unmount();
});

test("重启请求超时只查询状态，不自动重放命令", async t => {
  const browser = installControllerWindow(t); const h = fixture();
  h.render().askRestartCodex(); h.confirmation.run(); browser.tick(); await h.flush();
  assert.match(h.restartErrors[0], /无法确认/); assert.equal(h.restarts, 0);
  h.render().askRestartCodex(); await h.flush(); assert.equal(h.calls.length, 1); assert.match(h.notices.at(-1).text, /Codex 已运行/);
  h.calls[0].resolve(); await h.flush(); assert.equal(h.restarts, 0); h.unmount();
});

test("配置修复可在配置加载失败时确认执行，结果保留路径、备份和连接失败提示", async t => {
  installControllerWindow(t); const h = fixture({ config: null });
  for (const result of [{ repaired: true, configPath: "test/config.toml", backupPath: "test/backup.toml", message: "已修复" }, { repaired: false, configPath: "test/config.toml" }, new Error("disconnected")]) {
    h.render().askRepairCodexConfig(); assert.equal(h.confirmation.action, "repair-codex-config");
    const count = h.calls.length; h.confirmation.run(); h.confirmation.run(); assert.equal(h.calls.length, count + 1);
    assert.equal(h.calls.at(-1).command, "repair_codex_config"); assert.equal(h.render().configRepairNotice.tone, "info");
    if (result instanceof Error) h.calls.at(-1).reject(result); else h.calls.at(-1).resolve(result);
    await h.flush(); const notice = h.render().configRepairNotice;
    assert.deepEqual(notice, h.notices.at(-1));
    assert.match(notice.text, result instanceof Error ? /未完成.*disconnected.*连接中断/ : result.repaired ? /重启[\s\S]*备份文件：test\/backup.toml/ : /无需修改/);
  }
  h.unmount();
});

test("目录选择验证后才更新最新草稿，取消或失败保留原目录且不自动保存重启", async t => {
  installControllerWindow(t);
  for (const result of [null, new Error("不是 Codex 桌面应用"), "C:/New Codex"]) {
    const h = fixture({ config: { codexAppPath: "C:/Old Codex", retained: "draft" } });
    const c = h.render(); const work = c.selectCodexDirectory();
    await c.selectCodexDirectory(); assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0].command, "select_codex_app_directory");
    h.options.config = { ...h.options.config, retained: "latest" }; h.render();
    if (result instanceof Error) h.calls[0].reject(result); else h.calls[0].resolve(result);
    await work;
    assert.deepEqual(h.options.config, { codexAppPath: typeof result === "string" ? result : "C:/Old Codex", retained: "latest" });
    assert.equal(h.saves.length, 0); assert.equal(h.restarts, 0); assert.equal(h.options.isBusy, false);
    const notice = h.render().codexDirectoryNotice;
    if (result instanceof Error) assert.match(notice.text, /已保留原目录.*不是 Codex/);
    else if (result) assert.match(notice.text, /保存后/);
    else assert.equal(notice, null);
    h.unmount();
  }
});

test("目录选择在隐藏重开或卸载后不采纳迟到结果", async t => {
  installControllerWindow(t);
  for (const mode of ["hidden", "unmount"]) for (const failed of [false, true]) {
    const h = fixture({ config: { codexAppPath: "C:/Old Codex" } });
    const work = h.render().selectCodexDirectory();
    if (mode === "unmount") h.unmount();
    else { h.options.active = false; h.render(); h.options.active = true; h.render(); }
    if (failed) h.calls[0].reject(new Error("late")); else h.calls[0].resolve("C:/New Codex");
    await work;
    assert.equal(h.options.config.codexAppPath, "C:/Old Codex");
    assert.equal(h.writesAfterUnmount, 0);
    if (mode === "hidden") { assert.equal(h.render().codexDirectoryNotice, null); h.unmount(); }
  }
});

test("注入修复须确认，取消无副作用，确认后才保存最新草稿并提交一次", async t => {
  installControllerWindow(t);
  const save = deferred();
  const h = fixture({ status: fallbackStatus, dirty: true, persist: config => { h.saves.push(config); return save.promise; } });
  h.render().repairMainProcessInjection();
  assert.equal(h.confirmation.action, "repair-main-process-injection");
  assert.match(h.confirmation.description, /退出并重启 Codex[\s\S]*先备份[\s\S]*主进程调试[\s\S]*原厂签名失效[\s\S]*回滚/);
  assert.deepEqual([h.calls.length, h.saves.length, h.restarts, h.busy.length], [0, 0, 0, 0]);
  h.dismissConfirmation(); await h.flush();
  assert.deepEqual([h.calls.length, h.saves.length, h.restarts, h.busy.length], [0, 0, 0, 0]);
  h.render().repairMainProcessInjection();
  const latest = { retained: "latest draft" }; h.options.config = latest; h.render();
  h.confirmation.run(); h.confirmation.run();
  assert.deepEqual(h.saves, [latest]); assert.equal(h.calls.length, 0);
  save.resolve(); await h.flush(); assert.equal(h.calls[0].command, "repair_main_process_injection");
  h.calls[0].resolve({ status: "repairing" }); await h.flush(); assert.equal(h.restarts, 1); h.unmount();
});

test("注入修复遵守平台、运行状态、忙碌和重启边界", async t => {
  installControllerWindow(t);
  for (const extra of [{ config: null }, { active: false }, { isBusy: true }, { restartStatusError: "unknown" },
    ...[{ running: false }, { clientPlatform: "macos" }, { clientPlatform: "linux" }, { restartInProgress: true },
      { maintenance: { startupInjectionMode: "inspector" } }, { maintenance: { startupInjectionMode: "node_options" } },
      { maintenance: { startupInjectionMode: "unknown" } }, { maintenance: undefined }].map(patch => ({ status: { ...fallbackStatus, ...patch } }))]) {
    const h = fixture({ status: fallbackStatus, ...extra }); h.render().repairMainProcessInjection();
    assert.equal(h.confirmation, null); assert.equal(h.calls.length, 0); assert.equal(h.saves.length, 0); h.unmount();
  }
});

test("注入修复确认重校验最新状态，隐藏重开和卸载使旧确认失效", async t => {
  installControllerWindow(t);
  for (const mode of ["status", "restarting", "hidden", "unmount"]) {
    const h = fixture({ status: fallbackStatus, dirty: true }); h.render().repairMainProcessInjection();
    const confirmation = h.confirmation;
    if (mode === "unmount") h.unmount();
    else if (mode === "hidden") { h.options.active = false; h.render(); h.options.active = true; h.render(); }
    else { h.options.status = { ...fallbackStatus, ...(mode === "status" ? { maintenance: { startupInjectionMode: "inspector" } } : { restartInProgress: true }) }; h.render(); }
    confirmation.run(); await h.flush();
    assert.equal(h.calls.filter(call => call.command === "repair_main_process_injection").length, 0);
    assert.equal(h.saves.length, 0); assert.equal(h.restarts, 0); assert.equal(h.writesAfterUnmount, 0);
    if (mode !== "unmount") h.unmount();
  }
  const save = deferred(); const h = fixture({ status: fallbackStatus, dirty: true, persist: () => save.promise });
  h.render().repairMainProcessInjection(); h.confirmation.run();
  h.options.status = { ...fallbackStatus, restartInProgress: true }; h.render();
  save.resolve(); await h.flush(); assert.equal(h.calls.length, 0); assert.equal(h.restarts, 0); h.unmount();
});

test("注入修复保留保存失败、后端拒绝与连接中断语义", async t => {
  installControllerWindow(t);
  const failed = fixture({ status: fallbackStatus, dirty: true, persist: async () => { throw new Error("save failed"); } });
  failed.render().repairMainProcessInjection(); failed.confirmation.run(); await failed.flush();
  assert.equal(failed.calls.length, 0); assert.equal(failed.restarts, 0); assert.match(failed.notices.at(-1).text, /save failed/); failed.unmount();
  for (const error of [null, new api.CodeyApiError("rejected"), new Error("disconnected")]) {
    const h = fixture({ status: fallbackStatus }); h.render().repairMainProcessInjection(); h.confirmation.run();
    assert.equal(h.calls[0].command, "repair_main_process_injection");
    if (error) h.calls[0].reject(error); else h.calls[0].resolve({ status: "repairing" }); await h.flush();
    if (error instanceof api.CodeyApiError) { assert.equal(h.restarts, 0); assert.match(h.notices.at(-1).text, /被拒绝/); }
    else {
      assert.equal(h.restarts, 1);
      assert.equal(h.render().injectionRepairRequested, true);
      if (error) assert.match(h.notices.at(-1).text, /待确认/);
    }
    h.unmount();
  }
});

test("注入修复仅以运行中的主进程注入标记确认成功，CLI或启动失败保留错误", async t => {
  installControllerWindow(t);
  for (const [mode, running, startupError, tone] of [["inspector", true, undefined, "success"], ["node_options", true, undefined, "success"],
    ["cli", true, undefined, "error"], ["inspector", false, undefined, "error"], ["inspector", true, "修复失败，已恢复启动", "error"]]) {
    const h = fixture({ status: fallbackStatus }); h.render().repairMainProcessInjection(); h.confirmation.run();
    h.calls[0].resolve({ status: "restarting" }); await h.flush();
    assert.equal(h.render().injectionRepairRequested, true);
    assert.equal(h.notices.some(notice => notice.tone === "success"), false);
    h.options.status = { running, restartInProgress: false, startupError, maintenance: { startupInjectionMode: mode } };
    h.render(); assert.equal(h.notices.at(-1).tone, tone);
    assert.match(h.notices.at(-1).text, tone === "success" ? /已修复.*已自动重启/ : startupError ? /修复失败/ : /尚未确认/);
    assert.equal(h.render().injectionRepairRequested, false); h.unmount();
  }
});

test("诊断清理传递目标并保留其他运行状态，失败与隐藏不回写旧结果", async t => {
  installControllerWindow(t); const h = fixture();
  for (const target of ["trace", "crashpad"]) {
    const work = h.render().analyzeDiagnosticStorage(target);
    assert.deepEqual(h.calls.at(-1).args, { target }); assert.equal(h.render().diagnosticCleanup.phase, "running");
    h.calls.at(-1).resolve({ status: "partial", errors: ["locked"], traceLogWriteProtectionActive: true }); await work;
    assert.equal(h.render().diagnosticCleanup.phase, "complete"); assert.equal(h.options.status.running, true);
    assert.equal(h.options.status.traceLogWriteProtectionActive, true);
  }
  const failed = h.render().analyzeDiagnosticStorage("trace"); h.calls.at(-1).reject(new Error("unknown")); await failed;
  assert.deepEqual(h.render().diagnosticCleanup, { phase: "failed", target: "trace", error: "unknown" });
  const work = h.render().analyzeDiagnosticStorage("trace"); const old = h.calls.at(-1); const count = h.statuses.length;
  h.options.active = false; h.render(); old.resolve({ status: "ok", errors: [] }); await work;
  assert.equal(h.render().diagnosticCleanup, null); assert.equal(h.statuses.length, count); h.unmount();
});

test("诊断 Toast 替换进行态，保留部分成功和错误呈现，卸载关闭提示", () => {
  const shown = [], closed = [];
  const toast = (title, options) => { const key = String(shown.length); shown.push({ key, title, ...options }); return key; };
  toast.danger = (title, options) => toast(title, { ...options, variant: "danger" }); toast.close = key => closed.push(key);
  const h = createControllerHarness(new URL("../src/features/runtime-maintenance/DiagnosticCleanupToast.tsx", import.meta.url), "DiagnosticCleanupToast", {
    "@heroui/react": { toast }, "../../DiagnosticCleanupNotice": { DiagnosticCleanupNotice: () => null },
  });
  h.render({ state: null }); assert.equal(shown.length, 0);
  h.render({ state: { target: "trace", phase: "running" } }); assert.equal(shown[0].isLoading, true); assert.equal(shown[0].timeout, 0);
  const result = { status: "partial", errors: ["locked"] };
  h.render({ state: { target: "trace", phase: "complete", result } }); assert.deepEqual(closed, ["0"]);
  assert.equal(shown[1].variant, "warning"); assert.deepEqual(elementProps(shown[1].description), { result, target: "trace" });
  h.render({ state: { target: "crashpad", phase: "complete", result: { status: "ok", errors: [] } } }); assert.equal(shown[2].variant, "success");
  h.render({ state: { target: "crashpad", phase: "failed", error: "unknown" } }); assert.match(shown[3].description, /无法确认.*unknown/);
  h.unmount(); assert.deepEqual(closed, ["0", "1", "2", "3"]);
});

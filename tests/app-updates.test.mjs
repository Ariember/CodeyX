import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

import { createModuleGraph } from "./helpers/jsx-tree.mjs";

const source = await readFile(new URL("../src/features/app-updates/useAppUpdatesController.ts", import.meta.url), "utf8");
const state = createModuleGraph(new URL("../src/features/app-updates/state.ts", import.meta.url)).exports;
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

function harness(enabled, installReport = null, initialOptions = {}) {
  const hooks = [], effects = [], timers = new Map(), requests = [];
  let cursor = 0, timerId = 0, result;
  const options = {
    embedded: !enabled, configLoaded: true, codeyUpdatePolicy: "stable",
    isBusy: false, setBusy() {}, setNotice() {}, setConfirmation() {}, beforeInstall: async () => {},
    ...initialOptions,
  };
  const react = {
    useState(initial) {
      const index = cursor++;
      if (!(index in hooks)) hooks[index] = initial;
      return [hooks[index], next => { hooks[index] = typeof next === "function" ? next(hooks[index]) : next; }];
    },
    useRef(initial) { return react.useState({ current: initial })[0]; },
    useCallback(callback) { return react.useState(callback)[0]; },
    useEffect(effect, deps) {
      const index = cursor++, previous = hooks[index];
      if (previous && deps.every((value, i) => Object.is(value, previous.deps[i]))) return;
      effects.push(() => {
        previous?.cleanup?.();
        hooks[index] = { deps, cleanup: effect() };
      });
    },
  };
  const window = new EventTarget();
  window.setTimeout = callback => { timers.set(++timerId, callback); return timerId; };
  window.clearTimeout = id => timers.delete(id);
  const storage = new Map();
  const sessionStorage = {
    getItem: key => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: key => storage.delete(key),
  };
  window.sessionStorage = sessionStorage;
  const exports = {};
  new Function("require", "exports", "window", compiled)(name => {
    if (name === "react") return react;
    if (name === "./requests") {
      return createModuleGraph(new URL("../src/features/app-updates/requests.ts", import.meta.url), { stubs: { "../../api": {
        invoke: (command, args) => command === "update_install_report"
          // 安装结果查询不占用更新检查的请求队列，测试里直接返回预置结果。
          ? Promise.resolve(installReport)
          : new Promise((resolve, reject) => requests.push({ command, args, resolve, reject })),
      } } }).exports;
    }
    if (name === "./state") return state;
    if (name === "../../useStableEvent") return { useStableEvent(callback) {
      const ref = react.useRef(callback); ref.current = callback;
      return react.useCallback((...args) => ref.current(...args));
    } };
    if (name === "../../appUtils") return { withTimeout: promise => promise, errorText: String };
    if (name === "../../formatters") return { formatBytes: String };
    throw new Error(`Unexpected import ${name}`);
  }, exports, window);
  const render = () => {
    cursor = 0;
    result = exports.useAppUpdatesController(options);
    effects.splice(0).forEach(effect => effect());
    return result;
  };
  render();
  return { options, render, requests, timers, window, sessionStorage, storage };
}

const available = { currentVersion: "1.0.0", latestVersion: "1.0.1", updateAvailable: true };
const settle = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

test("嵌入页面不重复定时检查，仍可手动检查", async () => {
  const h = harness(false);
  assert.equal(h.requests.length, 0);
  const checking = h.render().checkForUpdates();
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].command, "check_for_updates");
  assert.deepEqual(h.requests[0].args, { forceRefresh: true, manual: true });
  h.requests[0].resolve(available);
  await checking;
  assert.deepEqual(h.render().updateCheck, available);
});

for (const automaticFirst of [true, false]) {
  test(`手动检查发起新请求，${automaticFirst ? "先" : "后"}返回的自动检查不覆盖结果`, async () => {
    const h = harness(true);
    let confirmation = null;
    h.options.setConfirmation = value => { confirmation = value; };
    const manual = h.render().checkForUpdates();
    assert.equal(h.requests.length, 2);
    assert.deepEqual(h.requests[0].args, { forceRefresh: false });
    assert.deepEqual(h.requests[1].args, { forceRefresh: true, manual: true });
    const oldUpdate = {
      ...available,
      selectedAsset: { fileName: "Codey-1.0.1.dmg", size: 1048576, url: "https://example.com/old" },
    };
    const newUpdate = {
      ...oldUpdate,
      latestVersion: "1.0.2",
      selectedAsset: { ...oldUpdate.selectedAsset, fileName: "Codey-1.0.2.dmg", url: "https://example.com/new" },
    };
    if (automaticFirst) {
      h.requests[0].resolve(oldUpdate);
      await settle();
      assert.equal(h.render().updateCheck, null);
      assert.equal(confirmation, null);
    }
    h.requests[1].resolve(newUpdate);
    await manual;
    if (!automaticFirst) {
      h.requests[0].resolve(oldUpdate);
      await settle();
    }
    assert.deepEqual(h.render().updateCheck, newUpdate);
    assert.deepEqual(h.window.__codeyUpdateAvailability, newUpdate);
    assert.match(confirmation.title, /1\.0\.2/);
  });
}

test("手动重新检查可清除之前发现的更新", async () => {
  const h = harness(false);
  const first = h.render().checkForUpdates();
  h.requests[0].resolve(available);
  await first;
  const second = h.render().checkForUpdates();
  assert.equal(h.requests.length, 2);
  assert.deepEqual(h.requests[1].args, { forceRefresh: true, manual: true });
  const latest = { currentVersion: "1.0.0", latestVersion: "1.0.0", updateAvailable: false };
  h.requests[1].resolve(latest);
  await second;
  assert.deepEqual(h.render().updateCheck, latest);
  assert.equal(h.window.__codeyUpdateAvailability, null);
});

for (const scenario of [
  { name: "版本与安装包一致", change: {}, action: "install-update" },
  { name: "发布了更新版本", change: { latestVersion: "1.0.2" }, action: "download-update" },
  { name: "同版本安装包已变更", change: { sha256: "b".repeat(64) }, action: "download-update" },
  { name: "Release 已重新创建", change: { releaseId: "release-2" }, action: "download-update" },
  { name: "安装包地址已变更", change: { url: "https://example.com/replaced.dmg" }, action: "download-update" },
]) {
  test(`安装包已下载时仍先手动查询：${scenario.name}`, async () => {
    const h = harness(false);
    let confirmation = null;
    h.options.setConfirmation = value => { confirmation = value; };
    const asset = {
      platform: "macos", arch: "aarch64", packageType: "dmg",
      fileName: "Codey-1.0.1.dmg", size: 1048576,
      url: "https://example.com/update.dmg", sha256: "a".repeat(64),
    };
    const update = { ...available, selectedAsset: asset, releaseId: "release-1" };
    const first = h.render().checkForUpdates();
    h.requests[0].resolve(update);
    await first;
    const downloaded = {
      latestVersion: update.latestVersion, releaseId: update.releaseId,
      filePath: "/updates/Codey-1.0.1.dmg", fileName: asset.fileName,
      size: asset.size, sha256: asset.sha256, asset,
    };
    const download = h.render().downloadUpdate();
    assert.equal(h.requests[1].command, "download_update");
    assert.deepEqual(h.requests[1].args, {
      expectedVersion: update.latestVersion, expectedReleaseId: update.releaseId, expectedSha256: asset.sha256,
    });
    h.requests[1].resolve(downloaded);
    await download;
    assert.deepEqual(h.render().downloadedUpdate, downloaded);
    confirmation = null;

    const checking = h.render().checkForUpdates();
    assert.equal(h.requests.length, 3);
    assert.deepEqual(h.requests[2].args, { forceRefresh: true, manual: true });
    assert.equal(confirmation, null);
    h.requests[2].resolve({
      ...update,
      latestVersion: scenario.change.latestVersion ?? update.latestVersion,
      releaseId: scenario.change.releaseId ?? update.releaseId,
      selectedAsset: { ...asset, sha256: scenario.change.sha256 ?? asset.sha256, url: scenario.change.url ?? asset.url },
    });
    await checking;
    assert.equal(confirmation.action, scenario.action);
    assert.deepEqual(
      h.render().downloadedUpdate,
      scenario.action === "install-update" ? downloaded : null,
    );
  });
}

for (const releaseId of [undefined, null]) {
  test(`下载更新时将 ${releaseId} Release 标识转换为 null`, async () => {
    const h = harness(false);
    const asset = { fileName: "Codey-1.0.1.dmg", size: 1048576, url: "https://example.com/update.dmg", sha256: "a".repeat(64) };
    const update = { ...available, selectedAsset: asset, releaseId };
    const checking = h.render().checkForUpdates();
    h.requests[0].resolve(update);
    await checking;
    const download = h.render().downloadUpdate();
    assert.equal(h.requests[1].command, "download_update");
    assert.deepEqual(h.requests[1].args, {
      expectedVersion: update.latestVersion, expectedReleaseId: null, expectedSha256: asset.sha256,
    });
    const downloaded = { latestVersion: update.latestVersion, filePath: "/updates/Codey-1.0.1.dmg", ...asset };
    h.requests[1].resolve(downloaded);
    await download;
    assert.deepEqual(h.render().downloadedUpdate, downloaded);
  });
}

test("disabling an in-flight automatic check ignores its result and clears pending", async () => {
  const h = harness(true);
  assert.equal(h.render().automaticallyChecking, true);
  h.options.codeyUpdatePolicy = "off";
  h.render();
  assert.equal(h.render().automaticallyChecking, false);
  h.requests[0].resolve(available);
  await settle();
  assert.equal(h.render().updateCheck, null);
  assert.equal(h.window.__codeyUpdateAvailability, null);
  assert.equal(h.timers.size, 0);
});

test("disabling cancels the next automatic check and enabling starts again", async () => {
  const h = harness(true);
  h.requests[0].resolve({ ...available, updateAvailable: false });
  await settle();
  h.render();
  assert.equal(h.timers.size, 1);
  h.options.codeyUpdatePolicy = "off";
  h.render();
  assert.equal(h.timers.size, 0);
  h.options.codeyUpdatePolicy = "stable";
  h.render();
  assert.equal(h.requests.length, 2);
});

test("detecting an update with an asset prompts the confirmation dialog", async () => {
  const h = harness(false);
  let confirmation = null;
  h.options.setConfirmation = (c) => {
    confirmation = c;
  };
  const updateWithAsset = {
    ...available,
    selectedAsset: { fileName: "Codey-1.0.1.dmg", size: 1048576, url: "https://example.com" },
  };
  const checking = h.render().checkForUpdates();
  assert.equal(h.requests.length, 1);
  h.requests[0].resolve(updateWithAsset);
  await checking;
  assert.ok(confirmation);
  assert.equal(confirmation.action, "download-update");
  assert.match(confirmation.title, /1\.0\.1/);
});

test("完整发布公告在弹窗显示，状态提示不再塞入 Markdown 源码", async () => {
  const h = harness(false);
  let confirmation = null;
  h.options.setConfirmation = value => { confirmation = value; };
  const update = {
    ...available,
    releaseNotes: "- 修复启动稳定性\n- 优化更新说明",
    selectedAsset: { fileName: "Codey-1.0.1.dmg", size: 1048576, url: "https://example.com" },
  };
  const checking = h.render().checkForUpdates();
  h.requests[0].resolve(update);
  await checking;
  assert.ok(confirmation);
  assert.equal(confirmation.releaseNotes, update.releaseNotes);
  assert.doesNotMatch(confirmation.description, /修复启动稳定性/);
  assert.match(confirmation.description, /当前版本/);
  assert.match(confirmation.description, /是否立即下载更新/);
  assert.doesNotMatch(h.render().updateResult.text, /修复启动稳定性/);
});

test("下载和安装确认使用同一份完整公告与发布页信息", async () => {
  const h = harness(false);
  let confirmation;
  h.options.setConfirmation = value => { confirmation = value; };
  const asset = { fileName: "setup.exe", size: 100, url: "https://example.test/setup.exe", sha256: "a".repeat(64) };
  const update = { ...available, releaseId: "42", selectedAsset: asset, releaseNotes: "    保留代码缩进\n\n## 完整公告\n\n**最后一段**\n", releaseTitle: "CodeyX v1.0.1 · 更新公告", releaseUrl: "https://github.com/Ariember/CodeyX/releases/tag/v1.0.1" };
  const checking = h.render().checkForUpdates();
  h.requests[0].resolve(update);
  await checking;
  for (const key of ["releaseNotes", "releaseTitle", "releaseUrl"]) assert.equal(confirmation[key], update[key]);
  confirmation.run();
  h.requests[1].resolve({ ...asset, asset, latestVersion: "1.0.1", releaseId: "42", filePath: "/updates/setup.exe" });
  await settle();
  assert.equal(confirmation.action, "install-update");
  for (const key of ["releaseNotes", "releaseTitle", "releaseUrl"]) assert.equal(confirmation[key], update[key]);
});

for (const updateAvailable of [true, false]) {
  test(`没有安装包或无需升级时仍能阅读完整公告：${updateAvailable}`, async () => {
    const h = harness(false);
    let confirmation;
    h.options.setConfirmation = value => { confirmation = value; };
    const update = { ...available, updateAvailable, releaseNotes: "## 本次亮点\n\n完整说明" };
    const checking = h.render().checkForUpdates();
    h.requests[0].resolve(update);
    await checking;
    assert.equal(confirmation.action, "view-update-notes");
    assert.equal(confirmation.releaseNotes, update.releaseNotes);
    confirmation.run();
    assert.equal(h.requests.length, 1);
  });
}

test("原生后台发现的更新等待配置加载后交给图文弹窗，不重复查询或提示", async () => {
  const h = harness(false);
  const confirmations = [];
  h.options.setConfirmation = value => { confirmations.push(typeof value === "function" ? value(null) : value); };
  h.options.configLoaded = false;
  h.render();
  const update = { ...available, selectedAsset: { fileName: "setup.exe" }, releaseNotes: "## 完整发布公告\n\n正文" };
  h.window.__codeyPendingUpdatePrompt = update;
  h.window.dispatchEvent(new Event("codey-update-prompt"));
  assert.equal(confirmations.length, 0);
  h.options.configLoaded = true;
  h.render();
  assert.equal(confirmations.length, 1);
  assert.equal(confirmations[0].releaseNotes, update.releaseNotes);
  assert.equal(h.window.__codeyPendingUpdatePrompt, null);
  assert.equal(h.requests.length, 0);
  h.window.__codeyPendingUpdatePrompt = update;
  h.window.dispatchEvent(new Event("codey-update-prompt"));
  assert.equal(confirmations.length, 1);
});

test("首次加载不会采纳旧实验版公告", () => {
  const h = harness(false, null, { configLoaded: false });
  let confirmation = null;
  h.options.setConfirmation = value => { confirmation = typeof value === "function" ? value(confirmation) : value; };
  h.render();
  const update = { ...available, latestVersion: "1.0.1-beta.1", prerelease: true, selectedAsset: { fileName: "beta.exe" }, releaseNotes: "## 实验版公告\n\n完整正文" };
  h.window.__codeyPendingUpdatePrompt = update;
  h.window.dispatchEvent(new Event("codey-update-prompt"));
  assert.equal(confirmation, null);
  h.options.codeyUpdatePolicy = "stable";
  h.options.configLoaded = true;
  h.render();
  assert.equal(confirmation, null);
  assert.equal(h.render().updateCheck, null);
});

test("后台公告不会覆盖正在等待用户确认的其他操作", () => {
  const h = harness(false);
  const pending = { action: "delete-route", title: "确认删除线路" };
  let confirmation = pending;
  h.options.setConfirmation = value => { confirmation = typeof value === "function" ? value(confirmation) : value; };
  h.render();
  h.window.__codeyPendingUpdatePrompt = { ...available, selectedAsset: { fileName: "setup.exe" }, releaseNotes: "## 更新公告" };
  h.window.dispatchEvent(new Event("codey-update-prompt"));
  assert.equal(confirmation, pending);
  assert.equal(h.render().updateCheck.latestVersion, available.latestVersion);
});

test("用户手动检查后，迟到的后台公告不能替换新结果", async () => {
  const h = harness(false);
  let confirmation = null;
  h.options.setConfirmation = value => { confirmation = typeof value === "function" ? value(confirmation) : value; };
  const current = { ...available, latestVersion: "1.0.2", selectedAsset: { fileName: "new.exe" } };
  const checking = h.render().checkForUpdates();
  h.requests[0].resolve(current);
  await checking;
  const manualConfirmation = confirmation;
  h.window.__codeyPendingUpdatePrompt = { ...available, selectedAsset: { fileName: "old.exe" } };
  h.window.dispatchEvent(new Event("codey-update-prompt"));
  assert.equal(h.render().updateCheck, current);
  assert.equal(h.window.__codeyUpdateAvailability, current);
  assert.equal(confirmation, manualConfirmation);
});

for (const policy of ["off", "stable"]) {
  test(`后台更新公告同样遵守更新策略：${policy}`, () => {
    const h = harness(false);
    let confirmation = null;
    h.options.codeyUpdatePolicy = policy;
    h.options.setConfirmation = value => { confirmation = typeof value === "function" ? value(confirmation) : value; };
    h.render();
    h.window.__codeyPendingUpdatePrompt = { ...available, prerelease: true, selectedAsset: { fileName: "setup.exe" } };
    h.window.dispatchEvent(new Event("codey-update-prompt"));
    assert.equal(confirmation, null);
    assert.equal(h.requests.length, 0);
  });
}

test("发现更新后定时器链仍在，可用更新被清空后继续自动检查", async () => {
  const h = harness(true);
  h.requests[0].resolve({ ...available, updateAvailable: true });
  await settle();
  h.render();
  // 暂停只影响本次检查：下一次 tick 必须仍然排程，否则手动清空状态后自动检查会永久失效。
  assert.equal(h.timers.size, 1, "发现可用更新后仍要保留下一次检查");

  const manual = h.render().checkForUpdates();
  h.requests[1].resolve({ currentVersion: "1.0.0", latestVersion: "1.0.0", updateAvailable: false });
  await manual;
  await settle();
  h.render();

  const [tick] = [...h.timers.values()];
  assert.ok(tick, "下一次检查必须已排程");
  h.timers.clear();
  tick();
  await settle();
  assert.equal(h.requests.length, 3, "状态清空后自动检查必须重新发起请求");
});

test("Release 安装包尚未就绪时继续轮询，上传完成后再提示", async () => {
  const h = harness(false);
  let confirmation = null;
  h.options.setConfirmation = value => { confirmation = value; };
  h.options.embedded = false;
  h.render();
  h.requests[0].resolve(available);
  await settle();
  h.render();
  assert.equal(confirmation, null);
  const [tick] = [...h.timers.values()];
  h.timers.clear();
  tick();
  await settle();
  assert.equal(h.requests.length, 2);
  h.requests[1].resolve({ ...available, selectedAsset: { fileName: "setup.exe" } });
  await settle();
  assert.equal(confirmation.action, "download-update");
});

test("点「稍后」会记下这个版本，自动检查不再重复弹窗", async () => {
  const h = harness(true);
  await settle();
  const updateWithAsset = {
    ...available,
    selectedAsset: { fileName: "Codey-1.0.1-setup.exe", size: 1048576, url: "https://example.com" },
  };

  // 「稍后」按钮 = 对话框关闭回调，这里直接驱动它。
  let confirmation = null;
  h.options.setConfirmation = (value) => {
    confirmation = value;
  };
  h.render().askDownloadUpdate(updateWithAsset);
  assert.ok(confirmation, "应当弹出下载确认");
  assert.equal(confirmation.action, "download-update");
  confirmation.onDismiss();
  assert.equal(
    h.window.sessionStorage.getItem("codey.deferredUpdateVersion"),
    "1.0.1",
    "推迟必须被记录",
  );

  // 首次自动检查返回"无更新"，hook 收尾并排程下一次检查。
  h.requests[0].resolve({ ...available, updateAvailable: false });
  await settle();
  h.render();
  assert.equal(
    h.window.sessionStorage.getItem("codey.deferredUpdateVersion"),
    "1.0.1",
    "推迟必须被记录",
  );

  // 下一次检查发现同一个版本：检查照常进行，但不该再打扰用户。
  const [tick] = [...h.timers.values()];
  assert.ok(tick, "自动检查必须已排程");
  h.timers.clear();
  confirmation = null;
  tick();
  await settle();
  assert.equal(h.requests.length, 2, "自动检查本身仍然继续");
  h.requests[1].resolve(updateWithAsset);
  await settle();
  assert.equal(confirmation, null, "已推迟的版本不应再次弹窗");
});

test("上一次安装失败会在下次启动时提示而不是静默", async () => {
  const notices = [];
  const h = harness(false, {
    version: "1.0.1",
    status: "failed",
    message: "安装没有生效：Codey.exe 未更新到 v1.0.1",
    writtenAt: 100,
  });
  h.options.setNotice = (notice) => {
    notices.push(notice);
  };
  h.render();
  await settle();

  assert.equal(notices.length, 1);
  assert.equal(notices[0].tone, "error");
  assert.match(notices[0].text, /1\.0\.1/);
  assert.match(notices[0].text, /安装没有生效/);
});

test("安装成功的报告不打扰用户，卡在 started 的报告按未完成提示", async () => {
  const installed = [];
  const installedHarness = harness(false, {
    version: "1.0.1", status: "installed", message: "", writtenAt: 100,
  });
  installedHarness.options.setNotice = (notice) => installed.push(notice);
  installedHarness.render();
  await settle();
  assert.equal(installed.length, 0, "安装成功本身不需要额外提示");

  const started = [];
  const startedHarness = harness(false, {
    version: "1.0.1", status: "started", message: "正在安装更新", writtenAt: 100,
  });
  startedHarness.options.setNotice = (notice) => started.push(notice);
  startedHarness.render();
  await settle();
  assert.equal(started.length, 1);
  assert.equal(started[0].tone, "info");
  assert.match(started[0].text, /更新未完成/);
});

test("Release 下载与安装仍需分别确认，下载携带版本和摘要", async () => {
  const h = harness(false);
  let confirmation;
  let saved = false;
  h.options.setConfirmation = value => { confirmation = value; };
  h.options.beforeInstall = async () => { saved = true; };
  const asset = { fileName: "CodeyX-1.0.1-windows-x64-setup.exe", size: 1024, sha256: "a".repeat(64) };
  const update = { ...available, releaseId: "123", selectedAsset: asset };
  const checking = h.render().checkForUpdates();
  h.requests[0].resolve(update);
  await checking;
  assert.equal(confirmation.title, "发现 CodeyX 新版本 v1.0.1");
  assert.doesNotMatch(confirmation.description, /管理员|回退|授权/);
  confirmation.run();
  assert.equal(h.requests[1].command, "download_update");
  assert.deepEqual(h.requests[1].args, {
    expectedVersion: "1.0.1", expectedReleaseId: "123", expectedSha256: asset.sha256,
  });
  h.requests[1].resolve({ ...update, ...asset, asset, filePath: "/updates/setup.exe" });
  await settle();
  h.render();
  assert.equal(confirmation.action, "install-update");
  assert.equal(confirmation.confirmLabel, "安装并重启");
  assert.equal(h.requests.length, 2);
  confirmation.run();
  await settle();
  assert.equal(saved, true);
  assert.equal(h.requests[2].command, "install_downloaded_update");
  h.requests[2].resolve();
  await settle();
});

test("Release 或安装包变化时展示错误且不进入安装确认", async () => {
  const h = harness(false);
  let confirmation;
  h.options.setConfirmation = value => { confirmation = value; };
  const checking = h.render().checkForUpdates();
  h.requests[0].resolve({ ...available, selectedAsset: { fileName: "setup.exe", sha256: "a".repeat(64) } });
  await checking;
  const download = h.render().downloadUpdate();
  h.requests[1].reject(new Error("Release 或安装包已变化，请重新检查更新"));
  await download;
  assert.equal(h.render().updateResult.tone, "error");
  assert.match(h.render().updateResult.text, /Release 或安装包已变化/);
  assert.equal(h.render().downloadedUpdate, null);
  assert.equal(confirmation.action, "download-update");
});

for (const policy of ["stable", "off"]) {
  test(`GitHub 的 prerelease 标记不能被正式版样式的标签绕过：${policy}`, async () => {
    const h = harness(false);
    let confirmation = null;
    h.options.setConfirmation = value => { confirmation = typeof value === "function" ? value(confirmation) : value; };
    h.options.codeyUpdatePolicy = policy;
    const checking = h.render().checkForUpdates();
    h.requests[0].resolve({ ...available, prerelease: true, selectedAsset: { fileName: "setup.exe" } });
    await checking;
    assert.equal(confirmation, null);
    assert.equal(h.render().updateCheck, null);
  });
}

test("不检查策略停止自动检查，仍可手动检查、下载和安装稳定版", async () => {
  const fixture = harness(false);
  let confirmation = null;
  let saved = false;
  fixture.options.setConfirmation = value => { confirmation = typeof value === "function" ? value(confirmation) : value; };
  fixture.options.beforeInstall = async () => { saved = true; };
  fixture.options.codeyUpdatePolicy = "off";
  fixture.options.embedded = false;
  fixture.render();
  assert.equal(fixture.requests.length, 0);
  assert.equal(fixture.timers.size, 0);
  const checking = fixture.render().checkForUpdates();
  assert.equal(fixture.requests.length, 1);
  assert.deepEqual(fixture.requests[0].args, { forceRefresh: true, manual: true });
  const stable = { ...available, selectedAsset: { fileName: "Codey-1.0.1.dmg", size: 1024, sha256: "a".repeat(64) } };
  fixture.requests[0].resolve(stable);
  await checking;
  assert.deepEqual(fixture.render().updateCheck, stable);
  assert.equal(confirmation.action, "download-update");
  confirmation.run();
  assert.equal(fixture.requests[1].command, "download_update");
  assert.deepEqual(fixture.requests[1].args, { expectedVersion: "1.0.1", expectedReleaseId: null, expectedSha256: stable.selectedAsset.sha256 });
  const downloaded = { latestVersion: "1.0.1", filePath: "/updates/Codey-1.0.1.dmg", fileName: "Codey-1.0.1.dmg", size: 1024 };
  fixture.requests[1].resolve(downloaded);
  await settle();
  assert.equal(confirmation.action, "install-update");
  confirmation.run();
  await settle();
  assert.equal(saved, true);
  assert.equal(fixture.requests[2].command, "install_downloaded_update");
  fixture.requests[2].resolve();
  await settle();
  assert.equal(fixture.timers.size, 0);
});

test("不检查策略的手动检查不接受实验版", async () => {
  const fixture = harness(false);
  let confirmation = null;
  fixture.options.setConfirmation = value => { confirmation = typeof value === "function" ? value(confirmation) : value; };
  fixture.options.codeyUpdatePolicy = "off";
  const checking = fixture.render().checkForUpdates();
  fixture.requests[0].resolve({ ...available, latestVersion: "1.0.1-beta.1", selectedAsset: { fileName: "beta.dmg" } });
  await checking;
  assert.equal(fixture.render().updateCheck, null);
  assert.equal(confirmation, null);
  assert.match(fixture.render().updateResult.text, /仅检查稳定版/);
});

test("关闭更新丢弃旧请求并清除已发现的版本，重新开启后恢复检查", async () => {
  const fixture = harness(false);
  const checking = fixture.render().checkForUpdates();
  fixture.options.codeyUpdatePolicy = "off";
  fixture.render();
  fixture.requests[0].resolve(available);
  await checking;
  assert.equal(fixture.render().updateCheck, null);
  assert.equal(fixture.window.__codeyUpdateAvailability, null);
  fixture.options.embedded = false;
  fixture.render();
  assert.equal(fixture.requests.length, 1);
  fixture.options.codeyUpdatePolicy = "stable";
  fixture.render();
  assert.equal(fixture.requests.length, 2);
});

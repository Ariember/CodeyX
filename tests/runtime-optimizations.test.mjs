import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../public/runtime-optimizations.js", import.meta.url), "utf8");
function fixture({ slimPet = true, module, load } = {}) {
  const messages = [];
  const listeners = new Map();
  const timers = new Map();
  const cleared = [];
  const tracker = {
    activeInteractions: new Map(), heartbeatTimer: 42,
    beginCpuSampling() { return "native sampler"; },
    ensureHeartbeat() { this.heartbeatTimer = 43; },
    recordHeartbeat() {},
  };
  const messenger = {
    postMessage(message) {
      // Native semantic anchors: sendMessageFromView, codex-message-from-view.
      messages.push([this, message]);
      return "sent";
    },
    getState() {}, setState() {},
  };
  const native = module ?? { tracker, messenger };
  const window = {
    location: { origin: "app://-" },
    __codeyNativeRuntime: { discoverAppAssetUrls: async () => ["app://-/assets/app-shared-test.js"] },
    __codeyImportCodexAsset: load || (async () => native),
    addEventListener(type, handler, capture) { listeners.set(type, { handler, capture }); },
    removeEventListener(type, handler) { if (listeners.get(type)?.handler === handler) listeners.delete(type); },
    clearInterval(id) { cleared.push(id); },
    setTimeout(fn) { const id = Symbol(); timers.set(id, fn); return id; },
    clearTimeout(id) { timers.delete(id); },
  };
  const context = vm.createContext({ window, Map });
  const install = (enabled = slimPet) => vm.runInContext(source.replaceAll("__CODEY_SLIM_PET__", String(enabled)), context);
  install();
  return { window, tracker, messenger, messages, listeners, timers, cleared, install };
}

test("disables native CPU/heartbeat samplers without removing active spans", async () => {
  const f = fixture();
  let cancelled = 0;
  const interaction = { cpuSampling: { cancel: () => { cancelled += 1; } }, startedAt: 10 };
  f.tracker.activeInteractions.set("span", interaction);
  await f.window.__codeyRuntimeOptimizations.refresh();
  assert.equal(f.tracker.beginCpuSampling(), null);
  assert.equal(f.tracker.heartbeatTimer, null);
  assert.deepEqual(f.cleared, [42]);
  f.tracker.ensureHeartbeat();
  assert.equal(f.tracker.heartbeatTimer, null);
  assert.equal(cancelled, 1);
  assert.equal(interaction.cpuSampling, null);
  assert.equal(f.tracker.activeInteractions.get("span").startedAt, 10);
  f.window.__codeyRuntimeOptimizations.dispose();
  assert.equal(f.tracker.beginCpuSampling(), "native sampler");
  assert.equal(f.tracker.heartbeatTimer, 43);
  assert.equal(f.listeners.size, 0);
});

test("pet slimming changes only automatic prewarm and preserves caller objects and voice messages", async () => {
  const f = fixture();
  await f.window.__codeyRuntimeOptimizations.refresh();
  const ready = Object.freeze({ type: "electron-avatar-overlay-restore-ready", shouldPrewarmAvatarOverlay: true, onDemandEnabled: true });
  assert.equal(f.messenger.postMessage(ready), "sent");
  assert.equal(ready.shouldPrewarmAvatarOverlay, true);
  assert.equal(f.messages[0][0], f.messenger);
  assert.equal(f.messages[0][1].shouldPrewarmAvatarOverlay, false);
  assert.equal(f.messages[0][1].onDemandEnabled, true);
  for (const type of ["avatar-overlay-show", "realtime-start", "app-server-request"]) {
    const message = { type, shouldPrewarmAvatarOverlay: true };
    f.messenger.postMessage(message);
    assert.equal(f.messages.at(-1)[1], message);
  }
  assert.equal(f.window.__codeyRuntimeOptimizations.snapshot().suppressedPrewarms, 1);
});

test("Rspack entry discovers cached non-enumerable exports without executing lazy modules", async () => {
  const f = fixture({ module: {} });
  f.window.__codeyRuntimeOptimizations.dispose();
  const entry = "app://-/assets/348410.4b841496e2.js";
  const imported = [];
  const messengerExports = Object.defineProperty({}, "F", { get: () => f.messenger });
  const trackerExports = Object.defineProperties({}, {
    y: { get: () => f.tracker },
    pending: { get: () => { throw new ReferenceError("not initialized"); } },
  });
  const require = () => { assert.fail("must not execute native modules"); };
  require.c = {
    messenger: { exports: messengerExports },
    tracker: { exports: trackerExports },
    failed: { error: new Error("native module failed"), exports: { other: { ...f.messenger } } },
  };
  f.window.document = { scripts: [{ src: entry }], addEventListener() {}, removeEventListener() {} };
  f.window.__codeyNativeRuntime.discoverAppAssetUrls = async () => [];
  f.window.__codeyImportCodexAsset = async url => {
    imported.push(url);
    return { __webpack_require__: require };
  };
  f.install();
  await f.window.__codeyRuntimeOptimizations.refresh();
  assert.deepEqual(imported, [entry]);
  const status = f.window.__codeyRuntimeOptimizations.snapshot();
  for (const key of ["cpuSamplingDisabled", "interactionHeartbeatDisabled", "appStateHeartbeatDisabled", "petPrewarmDisabled"]) {
    assert.equal(status[key], true, key);
  }
  const voice = { type: "realtime-start", shouldPrewarmAvatarOverlay: true };
  f.messenger.postMessage(voice);
  assert.equal(f.messages.at(-1)[1], voice);
  f.messenger.postMessage({ type: "electron-avatar-overlay-restore-ready", shouldPrewarmAvatarOverlay: true });
  assert.equal(f.messages.at(-1)[1].shouldPrewarmAvatarOverlay, false);
  f.window.__codeyRuntimeOptimizations.dispose();
});

test("disabled pet policy leaves prewarm untouched and reinstalls cleanly when toggled", async () => {
  const f = fixture({ slimPet: false });
  const original = f.messenger.postMessage;
  await f.window.__codeyRuntimeOptimizations.refresh();
  assert.equal(f.messenger.postMessage, original);
  assert.equal(f.window.__codeyRuntimeOptimizations.snapshot().petPrewarmDisabled, false);
  f.install(true);
  await f.window.__codeyRuntimeOptimizations.refresh();
  assert.notEqual(f.messenger.postMessage, original);
  f.install(false);
  await f.window.__codeyRuntimeOptimizations.refresh();
  assert.equal(f.messenger.postMessage, original);
});

test("filters only native periodic snapshot requests, preserving diagnostic and foreign events", () => {
  const f = fixture();
  const { handler, capture } = f.listeners.get("message");
  assert.equal(capture, true);
  const request = { type: "electron-app-state-snapshot-request", reason: "heartbeat" };
  let blocked = 0;
  const event = { data: request, origin: "app://-", source: f.window, stopImmediatePropagation: () => { blocked += 1; } };
  handler(event);
  handler({ ...event, origin: "null", source: null });
  handler({ ...event, origin: "https://example.test" });
  handler({ ...event, source: {} });
  handler({ ...event, data: { ...request, reason: "manual" } });
  handler({ ...event, data: { type: "realtime-event", reason: "heartbeat" } });
  assert.equal(blocked, 2);
  assert.equal(f.window.__codeyRuntimeOptimizations.snapshot().suppressedHeartbeats, 2);
  f.window.__codeyRuntimeOptimizations.dispose();
  handler(event);
  assert.equal(blocked, 2);
});

test("unknown native exports fail open with bounded retries", async () => {
  const f = fixture({ module: {} });
  for (let index = 0; index < 8; index += 1) {
    await f.window.__codeyRuntimeOptimizations.refresh();
    await Promise.resolve();
    const scheduled = [...f.timers.values()];
    f.timers.clear();
    scheduled.forEach(fn => fn());
  }
  const status = f.window.__codeyRuntimeOptimizations.snapshot();
  assert.equal(status.cpuSamplingDisabled, false);
  assert.equal(status.petPrewarmDisabled, false);
  assert.equal(f.timers.size, 0);
});

test("ambiguous and frozen native instances are not reported as optimized", async () => {
  const f = fixture();
  f.window.__codeyRuntimeOptimizations.dispose();
  Object.freeze(f.tracker);
  Object.freeze(f.messenger);
  f.install();
  await f.window.__codeyRuntimeOptimizations.refresh();
  assert.equal(f.window.__codeyRuntimeOptimizations.snapshot().cpuSamplingDisabled, false);
  assert.equal(f.window.__codeyRuntimeOptimizations.snapshot().petPrewarmDisabled, false);
  f.window.__codeyRuntimeOptimizations.dispose();
  const one = { ...f.tracker }, two = { ...f.tracker };
  f.window.__codeyImportCodexAsset = async () => ({ one, two });
  f.install();
  await f.window.__codeyRuntimeOptimizations.refresh();
  assert.equal(f.window.__codeyRuntimeOptimizations.snapshot().cpuSamplingDisabled, false);
});

test("reinjection is idempotent and disposal preserves newer native methods", async () => {
  const f = fixture();
  await f.window.__codeyRuntimeOptimizations.refresh();
  const api = f.window.__codeyRuntimeOptimizations;
  const wrapper = f.messenger.postMessage;
  f.install();
  assert.equal(f.window.__codeyRuntimeOptimizations, api);
  assert.equal(f.messenger.postMessage, wrapper);
  const replacement = () => "updated";
  f.messenger.postMessage = replacement;
  f.tracker.beginCpuSampling = replacement;
  assert.equal(api.snapshot().petPrewarmDisabled, false);
  assert.equal(api.snapshot().cpuSamplingDisabled, false);
  api.dispose();
  assert.equal(f.messenger.postMessage, replacement);
  assert.equal(f.tracker.beginCpuSampling, replacement);
});

test("late discovery cannot modify native objects after disposal", async () => {
  let resolve;
  const f = fixture({ load: () => new Promise(done => { resolve = done; }) });
  const pending = f.window.__codeyRuntimeOptimizations.refresh();
  await new Promise(done => setImmediate(done));
  f.window.__codeyRuntimeOptimizations.dispose();
  resolve({ tracker: f.tracker, messenger: f.messenger });
  await pending;
  assert.equal(f.tracker.beginCpuSampling(), "native sampler");
  assert.equal(f.tracker.heartbeatTimer, 42);
  assert.equal(f.timers.size, 0);
});

test("prototype methods are restored without leaving shadow properties", async () => {
  const f = fixture();
  f.window.__codeyRuntimeOptimizations.dispose();
  const heartbeat = f.tracker.ensureHeartbeat;
  delete f.tracker.ensureHeartbeat;
  Object.setPrototypeOf(f.tracker, { ensureHeartbeat: heartbeat });
  f.install();
  await f.window.__codeyRuntimeOptimizations.refresh();
  assert.equal(Object.hasOwn(f.tracker, "ensureHeartbeat"), true);
  f.window.__codeyRuntimeOptimizations.dispose();
  assert.equal(Object.hasOwn(f.tracker, "ensureHeartbeat"), false);
  assert.equal(f.tracker.ensureHeartbeat, heartbeat);
});

test("a failed in-flight cancellation does not break the native span", async () => {
  const f = fixture();
  const sampler = { cancel() { throw new Error("native sampler already finished"); } };
  const interaction = { cpuSampling: sampler };
  f.tracker.activeInteractions.set("span", interaction);
  await f.window.__codeyRuntimeOptimizations.refresh();
  assert.equal(interaction.cpuSampling, sampler);
  assert.equal(f.window.__codeyRuntimeOptimizations.snapshot().cpuSamplingDisabled, true);
});

test("discovery does not import lazy pet or settings routes", async () => {
  const f = fixture();
  f.window.__codeyRuntimeOptimizations.dispose();
  const imported = [];
  f.window.__codeyNativeRuntime.discoverAppAssetUrls = async () => [
    "app://-/assets/pets-settings-route-test.js", "app://-/assets/codex-avatar-test.js", "app://-/assets/app-shared-test.js",
  ];
  f.window.__codeyImportCodexAsset = async url => { imported.push(url); throw new Error("module unavailable"); };
  f.install();
  await f.window.__codeyRuntimeOptimizations.refresh();
  assert.deepEqual(imported, ["app://-/assets/app-shared-test.js"]);
  assert.equal(f.window.__codeyRuntimeOptimizations.snapshot().cpuSamplingDisabled, false);
  f.window.__codeyRuntimeOptimizations.dispose();
});

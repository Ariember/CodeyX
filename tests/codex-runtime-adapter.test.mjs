import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../public/codex-runtime-adapter.js", import.meta.url), "utf8");
const settle = () => new Promise((resolve) => setImmediate(resolve));

function fixture(globals = {}) {
  const timers = new Map();
  let sequence = 0;
  const window = {
    setTimeout(callback) { const id = ++sequence; timers.set(id, callback); return id; },
    clearTimeout(id) { timers.delete(id); },
  };
  // Installation and cached operations must work even when the host UI is absent.
  const document = new Proxy({}, { get() { throw new Error("unexpected DOM access"); } });
  const context = vm.createContext({ window, document, ...globals });
  return { window, timers, load: () => vm.runInContext(source, context) };
}

function discoveryFixture() {
  class Element {}
  const root = new Element();
  const manager = { async sendRequest() {} };
  const scope = { get: () => ({ forHost: () => manager }), set() {}, watch() {}, when() {}, query: {} };
  root.__reactFiber$fixture = { memoizedProps: { scope } };
  const runtime = fixture({
    HTMLElement: Element,
    document: {
      scripts: [{ src: "app://-/assets/app-initial-fixture.js" }],
      querySelectorAll: () => [],
      querySelector: (selector) => selector === "#root" ? root : null,
    },
  });
  function resolve(scope, hostId) {
    const registry = scope.get("registry");
    if (!registry) throw new Error("AppServerManager RPC is not connected");
    return registry.forHost(hostId);
  }
  return { ...runtime, module: { resolve }, manager };
}

function moduleClientFixture({ registry = false, hostId = "local" } = {}) {
  class Client {
    hostId = hostId;
    enqueueRequest(method, params) { return { method, params }; }
    createRequest() { assert.fail("discovery must not create requests"); }
    onResult() {}
  }
  const manager = {
    requestClient: new Client(),
    getHostId: () => hostId,
    sendRequest() { assert.fail("discovery must not send requests"); },
  };
  const family = { kind: "signal-family" };
  const scope = Object.assign(function scope() {}, {
    node: { familyBindings: new Map([[family, new Map([["local", {}]])]]) },
    get(_key, requestedHost) { return requestedHost === "local" ? manager : null; },
    query: null, set() {}, watch() {}, when() {},
  });
  const module = { container: { scope } };
  if (registry) {
    delete scope.node;
    module.Registry = class {
      getAll() { return this.scope.get("managers"); }
      getForHostId(host) { return this.scope.get("manager", host); }
    };
  }
  const runtime = fixture({
    HTMLElement: class {},
    document: {
      scripts: [{ src: "app://-/assets/app-initial-startup.js" }],
      querySelectorAll: () => [], querySelector: () => null,
    },
  });
  runtime.window.__codeyImportCodexAsset = async () => module;
  runtime.window.fetch = () => assert.fail("local module discovery must not fetch the network");
  return { ...runtime, module, scope, manager, Client };
}

test("request gate discovery reads data fields without evaluating unknown React getters", async () => {
  const { scope, manager } = moduleClientFixture();
  let getterCalls = 0;
  const decoy = Object.defineProperties({}, {
    get: { enumerable: true, get() { getterCalls += 1; return () => {}; } },
    nested: { enumerable: true, get() { getterCalls += 1; return scope; } },
  });
  class Element {}
  const root = new Element();
  root.__reactFiber$fixture = { memoizedProps: { decoy, scope } };
  const runtime = fixture({
    HTMLElement: Element,
    document: { scripts: [], querySelectorAll: () => [], querySelector: () => root },
  });
  runtime.load();
  vm.runInNewContext(readFileSync(new URL("../public/model-request-gate.js", import.meta.url), "utf8"), { window: runtime.window });
  const gate = runtime.window.__codeyCreateModelRequestGate({
    rewriteRequest: (method, params) => ({ method, params: { ...params, checked: true } }),
  });
  assert.equal(await gate.ensure(), true);
  assert.equal(manager.requestClient.enqueueRequest("thread/start", {}).params.checked, true);
  assert.equal(getterCalls, 0);
  gate.dispose();
});

test("one request-client discovery shares its graph budget across every React ancestor", async () => {
  let inspections = 0;
  const branch = () => new Proxy({ children: Array.from({ length: 6 }, () => ({})) }, {
    ownKeys(target) { inspections += 1; return Reflect.ownKeys(target); },
  });
  let fiber = null;
  for (let index = 0; index < 24; index += 1) {
    fiber = { memoizedProps: { noise: Array.from({ length: 120 }, branch) }, return: fiber };
  }
  class Element {}
  const root = new Element();
  root.__reactFiber$fixture = fiber;
  const runtime = fixture({
    HTMLElement: Element,
    document: { scripts: [], querySelectorAll: () => [], querySelector: () => root },
  });
  runtime.load();
  await assert.rejects(runtime.window.__codeyLoadCodexRequestClient(), /模型请求校验/);
  assert.ok(inspections > 0 && inspections <= 2_400, `shared budget inspected ${inspections} branches`);
  assert.equal(runtime.timers.size, 0);
});

for (const topology of ["wide earlier ancestors", "a shared object reached at different depths"]) {
  test(`request gate discovery still reaches the provider after ${topology}`, async () => {
    const { scope, manager } = moduleClientFixture();
    let roots;
    if (topology === "wide earlier ancestors") {
      roots = [
        ...Array.from({ length: 4 }, () => ({
          noise: Array.from({ length: 120 }, () => ({
            children: Array.from({ length: 120 }, () => ({})),
          })),
        })),
        { scope },
      ];
    } else {
      const shared = { nested: { scope } };
      let deep = shared;
      for (let index = 0; index < 6; index += 1) deep = { child: deep };
      roots = [deep, shared];
    }
    class Element {}
    const root = new Element();
    root.__reactFiber$fixture = roots.reduceRight((parent, memoizedProps) => ({ memoizedProps, return: parent }), null);
    const runtime = fixture({
      HTMLElement: Element,
      document: { scripts: [], querySelectorAll: () => [], querySelector: () => root },
    });
    runtime.load();
    vm.runInNewContext(readFileSync(new URL("../public/model-request-gate.js", import.meta.url), "utf8"), { window: runtime.window });
    const gate = runtime.window.__codeyCreateModelRequestGate({
      rewriteRequest: (method, params) => ({ method, params: { ...params, checked: true } }),
    });
    assert.equal(await gate.ensure(), true);
    assert.equal(manager.requestClient.enqueueRequest("thread/start", {}).params.checked, true);
    gate.dispose();
  });
}

for (const registry of [false, true]) {
  test(`model routing finds the ${registry ? "exported registry" : "cached signal"} before React mounts`, async () => {
    const runtime = moduleClientFixture({ registry });
    runtime.load();
    assert.equal(await runtime.window.__codeyLoadCodexRequestClient(), runtime.manager.requestClient);
    assert.equal(runtime.window.__codeyPageCapabilities.modelRouting.status, "available");
  });
}

test("a module-discovered client installs the real gate before the page mounts", async () => {
  const runtime = moduleClientFixture();
  runtime.load();
  vm.runInNewContext(readFileSync(new URL("../public/model-request-gate.js", import.meta.url), "utf8"), { window: runtime.window });
  const gate = runtime.window.__codeyCreateModelRequestGate({
    rewriteRequest: (method, params) => ({ method, params: { ...params, modelProvider: "codey_router" } }),
  });
  assert.equal(await gate.ensure(), true);
  assert.equal(runtime.manager.requestClient.enqueueRequest("thread/start", {}).params.modelProvider, "codey_router");
  const remote = new runtime.Client();
  remote.hostId = "ssh";
  assert.equal(remote.enqueueRequest("thread/start", {}).params.modelProvider, undefined);
  gate.dispose();
});

test("module discovery retries when initialization publishes its scope later", async () => {
  const runtime = moduleClientFixture();
  runtime.module.container.scope = null;
  runtime.load();
  await assert.rejects(runtime.window.__codeyLoadCodexRequestClient(), /模型请求校验/);
  runtime.module.container.scope = runtime.scope;
  assert.equal(await runtime.window.__codeyLoadCodexRequestClient(), runtime.manager.requestClient);
});

for (const invalid of ["remote", "incomplete", "ambiguous", "getter"]) {
  test(`module discovery rejects ${invalid} candidates without reporting readiness`, async () => {
    const runtime = moduleClientFixture({ hostId: invalid === "remote" ? "ssh" : "local" });
    let getterCalls = 0;
    if (invalid === "incomplete") runtime.Client.prototype.onResult = undefined;
    if (invalid === "ambiguous") runtime.module.other = moduleClientFixture().module.container;
    if (invalid === "getter") Object.defineProperty(runtime.module.container, "scope", {
      get() { getterCalls += 1; return runtime.scope; },
    });
    runtime.load();
    await assert.rejects(runtime.window.__codeyLoadCodexRequestClient(), /模型请求校验/);
    assert.equal(runtime.window.__codeyPageCapabilities.modelRouting.status, "unavailable");
    assert.equal(getterCalls, 0, "discovery must not invoke unknown accessors");
  });
}

test("a late module discovery cannot republish a disposed adapter's client", async () => {
  const runtime = moduleClientFixture();
  let finish;
  runtime.window.__codeyImportCodexAsset = () => new Promise(resolve => { finish = resolve; });
  runtime.load();
  const pending = runtime.window.__codeyLoadCodexRequestClient();
  await settle();
  runtime.window.__codeyNativeRuntime.dispose();
  finish(runtime.module);
  await assert.rejects(pending, { code: "codey_capability_unavailable" });
  assert.equal(runtime.window.__codeyCodexSessionController, undefined);
});

test("a timed-out capability probe cannot replace a newer cached manager", async () => {
  const runtime = discoveryFixture();
  let finish;
  runtime.window.__codeyImportCodexAsset = () => new Promise(resolve => { finish = resolve; });
  runtime.load();
  const pending = runtime.window.__codeyLoadCodexSessionController({ feature: "usage" });
  const rejected = assert.rejects(pending, { code: "codey_capability_unavailable" });
  await settle();
  assert.equal(typeof finish, "function");
  for (const callback of runtime.timers.values()) callback();
  await rejected;
  const replacement = { async sendRequest() {} };
  runtime.window.__codeyCodexSessionController = { manager: replacement };
  await runtime.window.__codeyLoadCodexSessionController({ feature: "usage" });
  finish(runtime.module);
  await settle();
  assert.equal(runtime.window.__codeyCodexSessionController.manager, replacement);
  assert.equal(runtime.window.__codeyPageCapabilities.usage.status, "available");
});

test("MCP reload never chooses a remote client when the local client is absent", async () => {
  const runtime = fixture();
  const calls = [];
  runtime.window.__codeyAppServerRequestClients = new Map([
    ["ssh-host", { sendRequest() { calls.push("remote"); } }],
  ]);
  runtime.window.__codeyCodexSessionController = { manager: {
    async sendRequest() { calls.push("local"); },
  } };
  runtime.load();
  assert.equal((await runtime.window.__codeyReloadMcpServers()).ok, true);
  assert.deepEqual(calls, ["local"]);
});

test("an unconfirmed MCP reload is not submitted again through the manager", async () => {
  const runtime = fixture();
  let calls = 0;
  const client = { async sendRequest() { calls += 1; throw new Error("connection closed"); } };
  runtime.window.__codeyAppServerRequestClients = new Map([["local", client]]);
  runtime.window.__codeyCodexSessionController = { manager: client };
  runtime.load();
  await assert.rejects(runtime.window.__codeyReloadMcpServers(), /connection closed/);
  assert.equal(calls, 1);
});

test("installation only registers the native adapter and is idempotent", () => {
  const runtime = fixture();
  runtime.load();
  const adapter = runtime.window.__codeyNativeRuntime;
  const reload = runtime.window.__codeyReloadMcpServers;
  assert.equal(adapter.isActive(), true);
  assert.equal(runtime.timers.size, 0);
  assert.equal(runtime.window.__codeySessionToolsInjectLoaded, undefined);
  assert.equal(runtime.window.__codeySessionToolsInstall, undefined);
  runtime.load();
  assert.equal(runtime.window.__codeyNativeRuntime, adapter);
  assert.equal(runtime.window.__codeyReloadMcpServers, reload);
  adapter.dispose();
  adapter.dispose();
  assert.equal(adapter.isActive(), false);
  assert.equal(runtime.window.__codeyNativeRuntime, undefined);
  assert.equal(runtime.window.__codeyReloadMcpServers, undefined);
  runtime.load();
  assert.notEqual(runtime.window.__codeyNativeRuntime, adapter);
});

test("usage, MCP reload and remote resume do not require session UI", async () => {
  const runtime = fixture();
  runtime.window.__codeyModelWhitelistPatch = {
    ensureRequestGate: async () => true,
    requestGateReady: () => true,
  };
  const calls = [];
  const limits = { rateLimits: { primary: { usedPercent: 25 } } };
  runtime.window.__codeyCodexSessionController = { manager: {
    async sendRequest(method, params) {
      calls.push({ method, params });
      return limits;
    },
    async resumeConversation(params) {
      calls.push({ method: "resume", params });
      return { status: "ready" };
    },
  } };
  runtime.load();
  assert.equal(await runtime.window.__codeyReadAccountRateLimits(), limits);
  assert.equal((await runtime.window.__codeyReloadMcpServers()).ok, true);
  assert.equal((await runtime.window.__codeyRemoteControl({ action: "resume", threadId: "thread-1" }, Date.now() + 5_000)).status, "ok");
  assert.deepEqual(calls.map(({ method }) => method), ["account/rateLimits/read", "config/mcpServer/reload", "resume"]);
  assert.equal(calls[2].params.conversationId, "thread-1");
  assert.equal(runtime.window.__codeyPageCapabilities.usage.status, "available");
  assert.equal(runtime.window.__codeySessionToolsInstall, undefined);
  assert.equal(runtime.timers.size, 0);
});

test("a hanging request gate times out without resuming the native conversation", async () => {
  const runtime = fixture();
  let finish;
  let calls = 0;
  runtime.window.__codeyModelWhitelistPatch = {
    ensureRequestGate: () => new Promise(resolve => { finish = resolve; }),
    requestGateReady: () => true,
  };
  runtime.window.__codeyCodexSessionController = { manager: {
    async resumeConversation() { calls += 1; return { status: "ready" }; },
  } };
  runtime.load();
  const pending = runtime.window.__codeyRemoteControl({ action: "resume", threadId: "thread" }, Date.now() + 60_000);
  await settle();
  const rejected = assert.rejects(pending, /模型线路尚未就绪/);
  for (const callback of runtime.timers.values()) callback();
  await rejected;
  finish(true);
  await settle();
  assert.equal(calls, 0);
  assert.equal(runtime.timers.size, 0);
});

test("disposal prevents queued operations from using a stale native client", async () => {
  const runtime = fixture();
  let calls = 0;
  runtime.window.__codeyCodexSessionController = { manager: {
    sendRequest() { calls += 1; },
    requestClient: { hostId: "local", enqueueRequest() {}, createRequest() {}, onResult() {} },
  } };
  runtime.load();
  const usage = runtime.window.__codeyReadAccountRateLimits();
  const client = runtime.window.__codeyLoadCodexRequestClient();
  const operation = runtime.window.__codeyNativeRuntime.waitForOperation(() => { calls += 1; });
  const reload = runtime.window.__codeyReloadMcpServers;
  runtime.window.__codeyNativeRuntime.dispose();
  assert.equal((await usage).status, "unavailable");
  await assert.rejects(client, { code: "codey_capability_unavailable" });
  await assert.rejects(operation, /适配已重新加载/);
  await assert.rejects(reload(), { code: "codey_capability_unavailable" });
  await settle();
  assert.equal(calls, 0);
  assert.equal(runtime.timers.size, 0);
});

for (const succeeds of [false, true]) {
  test(`a pending MCP ${succeeds ? "success" : "failure"} cannot change the replacement adapter`, async () => {
    const runtime = fixture();
    let complete;
    runtime.window.__codeyCodexSessionController = { manager: {
      sendRequest: () => new Promise((resolve, reject) => { complete = succeeds ? resolve : reject; }),
    } };
    runtime.load();
    const pending = runtime.window.__codeyReloadMcpServers();
    await settle();
    assert.equal(typeof complete, "function");
    runtime.window.__codeyNativeRuntime.dispose();
    runtime.load();
    const replacement = { manager: { async sendRequest() {} } };
    runtime.window.__codeyCodexSessionController = replacement;
    const capabilities = runtime.window.__codeyPageCapabilities;
    complete(succeeds ? {} : new Error("old reload failed"));
    if (succeeds) assert.equal((await pending).ok, true);
    else await assert.rejects(pending, /old reload failed/);
    assert.equal(runtime.window.__codeyCodexSessionController, replacement);
    assert.equal(runtime.window.__codeyPageCapabilities, capabilities);
    assert.equal(capabilities.mcpReload, undefined);
  });
}

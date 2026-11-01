import assert from "node:assert/strict";
import { readSessionToolsSource } from "./helpers/session-tools-source.mjs";
import test from "node:test";

import { flushMicrotasks } from "./helpers/flush.mjs";
import { TextEncoder } from "node:util";
import vm from "node:vm";

import { FakeElementCore } from "./helpers/fake-element.mjs";

const source = readSessionToolsSource();

class FakeElement extends FakeElementCore {
  constructor(attributes = {}) {
    super("div", { attributes });
    this.removed = false;
    this.querySelectorAllCalls = [];
    const classes = new Set();
    this.classList = {
      add: (className) => classes.add(className),
      contains: (className) => classes.has(className),
      remove: (className) => classes.delete(className),
      toggle: (className) => (
        classes.has(className) ? (classes.delete(className), false) : (classes.add(className), true)
      ),
    };
  }

  querySelector(selector) {
    if (selector === "[data-local-conversation-final-assistant]") return {};
    return super.querySelector(selector);
  }

  querySelectorAll(selector) {
    this.querySelectorAllCalls.push(selector);
    if (this.getAttribute("data-terminal-error") === "true") {
      return [new FakeElement({ "data-status": "failed" })];
    }
    return [];
  }

  matches(selector) {
    const selectors = String(selector).split(",").map((candidate) => candidate.trim());
    return selectors.some((candidate) => (
      candidate === "[data-turn-key]" && this.hasAttribute("data-turn-key")
    ) || (
      candidate === "[data-message-author-role]" && this.hasAttribute("data-message-author-role")
    ) || (
      candidate === "[data-testid=conversation-turn]" && this.getAttribute("data-testid") === "conversation-turn"
    ) || (
      candidate === "[data-testid=\"conversation-turn\"]" && this.getAttribute("data-testid") === "conversation-turn"
    ) || (
      candidate === "[data-message-id]" && this.hasAttribute("data-message-id")
    ));
  }

  closest() {
    return null;
  }

  getClientRects() {
    return this.layoutHidden ? [] : [1];
  }

  appendChild() {}

  remove() {
    this.removed = true;
  }
}

class TreeElement extends FakeElement {
  querySelectorAll(selector) {
    this.querySelectorAllCalls.push(selector);
    return FakeElementCore.prototype.querySelectorAll.call(this, selector);
  }

  closest(selector) {
    return FakeElementCore.prototype.closest.call(this, selector);
  }

  appendChild(child) {
    if (child.parentElement) {
      const siblings = child.parentElement.children;
      const index = siblings.indexOf(child);
      if (index >= 0) siblings.splice(index, 1);
    }
    child.parentElement = this;
    child.isConnected = this.isConnected;
    child.removed = false;
    this.children.push(child);
    return child;
  }
}

function loadInjection({
  initialNow = 1_000_000,
  initialSessionId = "session-1",
  turnIds = ["turn-1"],
  sessionTitle = "排查飞书通知",
  bridgeHandler = null,
  codexSessionController = null,
  codexSignalDispatcher = null,
  discoveredAppServerManager = null,
  localAppServerManager = null,
  nativeAppServerScope = null,
  hiddenTurnIds = [],
  sessionElements = {},
} = {}) {
  const rows = turnIds.map((turnId) => new TreeElement({ "data-turn-key": turnId }));
  rows.forEach((row) => {
    row.layoutHidden = hiddenTurnIds.includes(row.getAttribute("data-turn-key"));
  });
  const sidebarThread = new FakeElement({
    "data-app-action-sidebar-thread-id": "local:session-1",
    "data-app-action-sidebar-thread-title": sessionTitle,
  });
  let now = initialNow;
  let sessionId = initialSessionId;
  const bridgeCalls = [];
  const alerts = [];
  let reloadCount = 0;
  const timers = [];
  const placeholder = new FakeElement();
  const documentElement = new FakeElement();
  const documentBody = new TreeElement();
  const managerAssetUrl = "app://-/assets/app-initial-completion-reconcile.js";
  let managerModule = null;
  if (discoveredAppServerManager || localAppServerManager) {
    const scope = {
      query: null,
      get(_key, hostId) { return hostId === "local" ? localAppServerManager : null; },
      set() {},
      watch() {},
      when() {},
      forHost() {},
    };
    documentBody.__reactFiber$test = {
      dependencies: null,
      memoizedProps: null,
      memoizedState: { scope },
      return: null,
      updateQueue: null,
    };
    function resolveManager(candidateScope, hostId) {
      candidateScope.get();
      candidateScope.forHost();
      if (hostId !== "local") throw new Error("AppServerManager RPC is not connected");
      return discoveredAppServerManager;
    }
    managerModule = { resolveManager };
    if (localAppServerManager) {
      managerModule.LocalRegistry = class {
        constructor() { throw new Error("registry constructors must not run during discovery"); }
        getAll() { return this.scope.get("managers"); }
        getForHostId(hostId) { return this.scope.get("manager", hostId); }
      };
    }
  }
  if (nativeAppServerScope) {
    documentBody.__reactFiber$native = {
      memoizedState: { scope: nativeAppServerScope },
      return: null,
    };
  }
  const document = {
    documentElement,
    body: documentBody,
    scripts: managerModule ? [{ src: managerAssetUrl }] : [],
    visibilityState: "visible",
    getElementById(id) {
      if (id === "codey-injected-style" || id === "codey-settings-button") return placeholder;
      return documentBody.children.find((child) => child.id === id) || null;
    },
    querySelector(selector) {
      if (selector in sessionElements) return sessionElements[selector][0] || null;
      if (selector === "[data-session-id]") {
        return new FakeElement({ "data-session-id": sessionId });
      }
      return null;
    },
    querySelectorAll(selector) {
      if (selector in sessionElements) return sessionElements[selector];
      if (selector === "[data-turn-key]") {
        return rows.filter((row) => !row.removed && row.hasAttribute("data-turn-key"));
      }
      if (selector === "[data-turn-key], [data-message-author-role], [data-testid=conversation-turn], [data-message-id]") {
        return rows.filter((row) => !row.removed && row.matches(selector));
      }
      if (
        selector === "[data-message-id]"
        || selector === "[data-testid=conversation-turn]"
        || selector === "[data-testid=\"conversation-turn\"]"
      ) {
        return rows.filter((row) => !row.removed && row.matches(selector));
      }
      if (selector === "[data-app-action-sidebar-thread-id][data-app-action-sidebar-thread-title]") {
        return [sidebarThread];
      }
      return [];
    },
    createElement() {
      return new FakeElement();
    },
  };
  let mutationHandler = null;
  const window = {
    __codexSessionDeleteBridge: async (path, payload, options = {}) => {
      bridgeCalls.push({ options, path, payload });
      if (bridgeHandler) return bridgeHandler(path, payload, options);
      return { status: "ok" };
    },
    __codeyCodexSessionController: codexSessionController,
    __codeyCodexSignalDispatcher: codexSignalDispatcher,
    addEventListener: () => {},
    alert: (message) => alerts.push(String(message)),
    clearTimeout: () => {},
    dispatchEvent: () => true,
    getComputedStyle: () => ({ display: "block", visibility: "visible" }),
    requestIdleCallback: (callback) => {
      callback({ didTimeout: false, timeRemaining: () => 50 });
      return 1;
    },
    setTimeout: (callback) => {
      timers.push(callback);
      return timers.length;
    },
    localStorage: {
      length: 0,
      key: () => null,
      getItem: () => null,
      setItem: () => {},
    },
  };
  if (managerModule) {
    window.__codeyImportCodexAsset = async (url) => {
      assert.equal(url, managerAssetUrl);
      return managerModule;
    };
  }
  window.window = window;
  const MutationObserver = class {
    constructor(handler) {
      mutationHandler = handler;
    }

    observe() {}
  };
  class ControlledDate extends Date {
    constructor(...args) {
      super(...(args.length ? args : [now]));
    }

    static now() {
      return now;
    }
  }
  vm.runInNewContext(source, {
    atob: (value) => Buffer.from(value, "base64").toString("binary"),
    btoa: (value) => Buffer.from(value, "binary").toString("base64"),
    console,
    CustomEvent: class {
      constructor(type, options = {}) {
        this.type = type;
        this.detail = options.detail;
      }
    },
    Date: ControlledDate,
    document,
    HTMLElement: FakeElement,
    location: {
      pathname: "/",
      search: "",
      reload: () => {
        reloadCount += 1;
      },
    },
    MutationObserver,
    TextEncoder,
    URL,
    URLSearchParams,
    window,
  });
  return {
    advanceTime: (milliseconds) => {
      now += milliseconds;
    },
    appendExistingRow: (row) => {
      rows.push(row);
      return row;
    },
    alerts,
    bridgeCalls,
    document,
    emitMutations: (mutations) => mutationHandler?.(mutations),
    flushTimers: () => {
      while (timers.length) timers.shift()();
    },
    getReloadCount: () => reloadCount,
    getTurnRow: (index = 0) => rows[index] || null,
    getVisibleTurnIds: () => rows
      .filter((row) => !row.removed)
      .map((row) => row.getAttribute("data-turn-key")),
    setSessionId: (value) => {
      sessionId = String(value);
    },
    window,
  };
}

const createRecoveryController = (events, overrides = {}) => ({
  kind: "manager",
  async refreshRecentConversations() {},
  async reconcileCompletedConversation(payload) {
    events.push({ payload, type: "reconcile" });
    return true;
  },
  ...overrides,
});

test("session tools leave conversation turns unchanged without selection or deletion controls", async () => {
  const runtime = loadInjection({
    turnIds: ["turn-1", "turn-2"],
    hiddenTurnIds: ["turn-2"],
    codexSessionController: createRecoveryController([]),
  });
  await flushMicrotasks();
  const assertNoControls = (row) => {
    assert.equal(row.children.length, 0);
    assert.equal(row.dataset.codeyMessageId, undefined);
    assert.equal(row.removed, false);
  };
  assertNoControls(runtime.getTurnRow(0));
  assertNoControls(runtime.getTurnRow(1));

  const added = runtime.appendExistingRow(new TreeElement({ "data-turn-key": "turn-3" }));
  runtime.emitMutations([{
    type: "childList", target: runtime.document.body, addedNodes: [added], removedNodes: [],
  }]);
  runtime.getTurnRow(1).layoutHidden = false;
  runtime.emitMutations([{
    type: "attributes", target: runtime.getTurnRow(1), attributeName: "hidden",
  }]);
  runtime.flushTimers();
  await flushMicrotasks();

  assertNoControls(added);
  assertNoControls(runtime.getTurnRow(1));
  assert.equal(runtime.document.getElementById("codey-message-toolbar"), null);
  assert.equal(runtime.window.__codeyDeleteSelectedMessages, undefined);
  assert.equal(runtime.window.__codeyInstallMessageSelection, undefined);
  assert.equal(runtime.bridgeCalls.some((call) => call.path === "/session/delete-messages"), false);
  assert.deepEqual(runtime.getVisibleTurnIds(), ["turn-1", "turn-2", "turn-3"]);
});

test("reconciles the current session through AppServerManager without a completion bridge", async () => {
  const events = [];
  const runtime = loadInjection({
    codexSessionController: createRecoveryController(events),
  });

  await flushMicrotasks();

  assert.deepEqual(JSON.parse(JSON.stringify(events)), [{
    payload: {
      collaborationMode: null,
      conversationId: "session-1",
      model: null,
      reasoningEffort: null,
      serviceTier: null,
      showThreadGoalResumeConfirmation: false,
      workspaceRoots: [],
    },
    type: "reconcile",
  }]);
  assert.equal(
    runtime.bridgeCalls.some((call) => call.path === "/session/completion-state"),
    false,
  );
  assert.equal(await runtime.window.__codeyReconcileStaleCompletedTask(), false);
  assert.equal(events.length, 1);
});

test("reconciles when the conversation appears after renderer startup", async () => {
  const events = [];
  const runtime = loadInjection({
    initialSessionId: "",
    codexSessionController: createRecoveryController(events),
  });

  await flushMicrotasks();
  assert.equal(events.length, 0);

  runtime.setSessionId("session-1");
  runtime.emitMutations([{
    type: "childList",
    target: new FakeElement(),
    addedNodes: [],
    removedNodes: [],
  }]);
  await flushMicrotasks();

  assert.deepEqual(events.map((event) => event.payload.conversationId), ["session-1"]);
});

test("usage-only manager remains available when reconciliation is missing", async () => {
  const requests = [];
  const runtime = loadInjection({
    discoveredAppServerManager: { sendRequest(method) { requests.push(method); return { rateLimits: {} }; } },
  });
  await flushMicrotasks();
  assert.equal(runtime.window.__codeyPageCapabilities.reconcile.status, "unavailable");
  assert.ok((await runtime.window.__codeyReadAccountRateLimits()).rateLimits);
  assert.deepEqual(requests, ["account/rateLimits/read"]);
  assert.equal(runtime.alerts.length, 0);
  assert.deepEqual(runtime.getVisibleTurnIds(), ["turn-1"]);
});

test("native model routing discovers the local request client without sending a request", async () => {
  const client = { hostId: "local", enqueueRequest() { throw Error("must not send"); }, createRequest() {}, onResult() {} };
  const manager = { requestClient: client, sendRequest() { throw Error("must not send"); } };
  const runtime = loadInjection({ localAppServerManager: manager, initialSessionId: "" });
  assert.equal(await runtime.window.__codeyLoadCodexRequestClient(), client);
  assert.equal(runtime.window.__codeyPageCapabilities.modelRouting.status, "available");
});

function cachedManagerScope(managers) {
  const values = new Map(managers.map((manager) => [
    { kind: "signal-family" },
    new Map([["local", manager]]),
  ]));
  const reads = [];
  return {
    node: { familyBindings: values },
    chain: new Map(),
    query: null,
    reads,
    get(family, hostId) {
      reads.push(hostId);
      assert.ok(values.get(family)?.has(hostId), "discovery must not instantiate a signal");
      return values.get(family).get(hostId);
    },
    set() { assert.fail("discovery must not write native state"); },
    watch() { assert.fail("discovery must not subscribe"); },
    when() { assert.fail("discovery must not wait on native state"); },
  };
}

function nativeRoutingManager(hostId = "local") {
  return {
    requestClient: {
      hostId,
      enqueueRequest() { assert.fail("discovery must not send a request"); },
      createRequest() { assert.fail("discovery must not create a request"); },
      onResult() {},
    },
    getHostId() { return hostId; },
    sendRequest() { assert.fail("discovery must not send a request"); },
  };
}

test("native model routing finds cached local state when the registry class is no longer exported", async () => {
  const manager = nativeRoutingManager();
  const scope = cachedManagerScope([manager, manager]);
  const parent = scope.node;
  scope.chain.set("parent", parent);
  scope.chain.set("same-parent", parent);
  scope.node = { familyBindings: new Map() };
  parent.familyBindings.set({ kind: "signal-family" }, new Map([["remote", nativeRoutingManager("remote")]]));
  parent.familyBindings.set({ kind: "signal-family" }, new Map());
  parent.familyBindings.set({ kind: "query-family" }, new Map([["local", manager]]));
  const runtime = loadInjection({ nativeAppServerScope: scope, initialSessionId: "" });
  runtime.window.__codeyImportCodexAsset = () => assert.fail("cached native state needs no module import");

  assert.equal(await runtime.window.__codeyLoadCodexRequestClient(), manager.requestClient);
  assert.equal(runtime.window.__codeyPageCapabilities.modelRouting.status, "available");
  assert.deepEqual(scope.reads, ["local", "local"]);
  assert.equal(await runtime.window.__codeyLoadCodexRequestClient(), manager.requestClient);
  assert.equal(scope.reads.length, 2, "the verified manager is reused");
});

for (const incompatible of ["remote", "incomplete", "ambiguous", "rpc"]) {
  test(`cached native state rejects ${incompatible} request clients`, async () => {
    const manager = nativeRoutingManager(incompatible === "remote" ? "remote" : "local");
    let rpcReads = 0;
    if (incompatible === "incomplete") delete manager.requestClient.onResult;
    if (incompatible === "rpc") {
      manager.requestClient = new Proxy({}, {
        get() { rpcReads += 1; return () => {}; },
      });
    }
    const scope = cachedManagerScope(incompatible === "ambiguous"
      ? [manager, nativeRoutingManager()] : [manager]);
    const runtime = loadInjection({ nativeAppServerScope: scope, initialSessionId: "" });

    await assert.rejects(runtime.window.__codeyLoadCodexRequestClient(), /模型请求校验/);
    assert.equal(runtime.window.__codeyPageCapabilities.modelRouting.status, "unavailable");
    assert.equal(rpcReads, 0, "discovery must not invoke an RPC proxy");
  });
}

test("native model routing retries when the local manager is cached after the first probe", async () => {
  const scope = cachedManagerScope([]);
  const runtime = loadInjection({ nativeAppServerScope: scope, initialSessionId: "" });
  await assert.rejects(runtime.window.__codeyLoadCodexRequestClient(), /模型请求校验/);

  const manager = nativeRoutingManager();
  scope.node.familyBindings.set({ kind: "signal-family" }, new Map([["local", manager]]));
  assert.equal(await runtime.window.__codeyLoadCodexRequestClient(), manager.requestClient);
  assert.equal(runtime.window.__codeyPageCapabilities.modelRouting.status, "available");
});

test("request-client discovery reuses parsed assets while retrying a late manager", async () => {
  const manager = nativeRoutingManager();
  const runtime = loadInjection({ localAppServerManager: manager, initialSessionId: "" });
  const importAsset = runtime.window.__codeyImportCodexAsset;
  let ready = false;
  let imports = 0;
  const fetched = [];
  runtime.document.scripts = [{ src: "app://-/assets/index-startup.js" }];
  runtime.window.fetch = async (url) => {
    fetched.push(url);
    return { ok: true, text: async () => 'import "./app-initial-completion-reconcile.js";' };
  };
  runtime.window.__codeyImportCodexAsset = async (url) => {
    imports += 1;
    return ready ? importAsset(url) : {};
  };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await assert.rejects(runtime.window.__codeyLoadCodexRequestClient(), /模型请求校验/);
  }
  assert.equal(imports, 3, "a cached asset must not freeze capability discovery");
  assert.equal(fetched.length, 1, "startup retries must not reread the same bundle");
  runtime.document.scripts.push({ src: "app://-/assets/index-late.js" });
  ready = true;
  assert.equal(await runtime.window.__codeyLoadCodexRequestClient(), manager.requestClient);
  assert.deepEqual(fetched, ["app://-/assets/index-startup.js", "app://-/assets/index-late.js"]);
});

for (const failure of ["http", "network", "body"]) {
  test(`request-client asset discovery retries a failed ${failure} read`, async () => {
    const manager = nativeRoutingManager();
    const runtime = loadInjection({ localAppServerManager: manager, initialSessionId: "" });
    runtime.document.scripts = [{ src: "app://-/assets/index-startup.js" }];
    let reads = 0;
    runtime.window.fetch = async () => {
      reads += 1;
      if (reads === 1 && failure === "network") throw new Error("not ready");
      return {
        ok: reads > 1 || failure !== "http",
        text: async () => {
          if (reads === 1 && failure === "body") throw new Error("interrupted");
          return 'import "./app-initial-completion-reconcile.js";';
        },
      };
    };
    await assert.rejects(runtime.window.__codeyLoadCodexRequestClient(), /模型请求校验/);
    assert.equal(await runtime.window.__codeyLoadCodexRequestClient(), manager.requestClient);
    assert.equal(reads, 2, "failed reads must remain retryable");
  });
}

test("request-client discovery caches empty assets but observes newly loaded modules", async () => {
  const manager = nativeRoutingManager();
  const runtime = loadInjection({ localAppServerManager: manager, initialSessionId: "" });
  runtime.document.scripts = [{ src: "app://-/assets/index-empty.js" }];
  let reads = 0;
  runtime.window.fetch = async () => {
    reads += 1;
    return { ok: true, text: async () => "export {};" };
  };
  await assert.rejects(runtime.window.__codeyLoadCodexRequestClient(), /模型请求校验/);
  await assert.rejects(runtime.window.__codeyLoadCodexRequestClient(), /模型请求校验/);
  runtime.document.scripts.push({ src: "app://-/assets/app-initial-completion-reconcile.js" });
  assert.equal(await runtime.window.__codeyLoadCodexRequestClient(), manager.requestClient);
  assert.equal(reads, 1);
});

test("manager discovery scans shared ancestors once and refreshes them on the next probe", () => {
  const scope = cachedManagerScope([]);
  const runtime = loadInjection({ initialSessionId: "", turnIds: ["one", "two"] });
  let reads = 0;
  const shared = {
    get memoizedState() { reads += 1; return { scope }; },
    return: null,
  };
  runtime.document.body.__reactFiber$test = shared;
  for (let index = 0; index < 2; index += 1) {
    runtime.getTurnRow(index).__reactFiber$test = { return: shared };
  }
  assert.equal(runtime.window.__codeyAppServerManagerFromReact(() => null), null);
  assert.equal(reads, 1);
  const manager = nativeRoutingManager();
  assert.equal(runtime.window.__codeyAppServerManagerFromReact((candidate) => (
    candidate === scope ? manager : null
  )), manager);
  assert.equal(reads, 2, "each probe must observe current page state");
});

test("native model routing cannot use a remote or incomplete client", async () => {
  const manager = { requestClient: { hostId: "remote" }, getConversation() { return null; } };
  const runtime = loadInjection({ localAppServerManager: manager, initialSessionId: "" });
  await assert.rejects(runtime.window.__codeyLoadCodexRequestClient(), /模型请求校验/);
});

for (const feature of ["remote", "modelRouting"]) {
  test(`${feature} requires a native manager instead of falling back to legacy signals`, async () => {
    const calls = [];
    const runtime = loadInjection({
      initialSessionId: "",
      codexSignalDispatcher(...args) { calls.push(args); },
    });
    const controller = await runtime.window.__codeyLoadCodexSessionController({ feature: "refresh" });
    assert.equal(controller.kind, "signals");
    await assert.rejects(
      runtime.window.__codeyLoadCodexSessionController({ feature }),
      { code: "codey_capability_unavailable" },
    );
    assert.equal(runtime.window.__codeyPageCapabilities[feature].status, "unavailable");
    assert.equal(runtime.window.__codeyCodexSessionController, controller);
    assert.deepEqual(calls, []);
  });
}

test("native model routing retries a real discovery inside the failure backoff", async () => {
  const runtime = loadInjection({ initialSessionId: "" });
  await assert.rejects(runtime.window.__codeyLoadCodexRequestClient(), /模型请求校验/);

  // 第一次失败把 retryAt 推到了将来；模型请求校验的重试节奏由宿主注入流程
  // 控制，所以下一次调用必须重新走发现流程，而不是被退避直接拒绝。
  const client = {
    hostId: "local",
    enqueueRequest() { throw Error("must not send"); },
    createRequest() {},
    onResult() {},
  };
  const manager = { requestClient: client, sendRequest() { throw Error("must not send"); } };
  const scope = {
    query: null,
    get(_key, hostId) { return hostId === "local" ? manager : null; },
    set() {},
    watch() {},
    when() {},
    forHost() {},
  };
  runtime.document.body.__reactFiber$late = {
    dependencies: null,
    memoizedProps: null,
    memoizedState: { scope },
    return: null,
    updateQueue: null,
  };
  runtime.document.scripts.push({ src: "app://-/assets/app-initial-late.js" });
  runtime.window.__codeyImportCodexAsset = async () => ({
    LocalRegistry: class {
      getAll() { return this.scope.get("managers"); }
      getForHostId(hostId) { return this.scope.get("manager", hostId); }
    },
  });

  assert.equal(await runtime.window.__codeyLoadCodexRequestClient(), client);
  assert.equal(runtime.window.__codeyPageCapabilities.modelRouting.status, "available");
});

test("MCP reload prefers the patched AppServerRequestClient over fiber discovery", async () => {
  const requests = [];
  const runtime = loadInjection({ initialSessionId: "" });
  runtime.window.__codeyAppServerRequestClients = new Map([
    ["local", {
      sendRequest(...args) {
        requests.push(args);
        return {};
      },
    }],
  ]);
  assert.equal((await runtime.window.__codeyReloadMcpServers()).ok, true);
  assert.equal(JSON.stringify(requests), JSON.stringify([["config/mcpServer/reload", {}]]));
  assert.equal(runtime.window.__codeyCodexSessionController, null);
});

test("MCP reload awaits the native request without restarting or resuming a task", async () => {
  const requests = [];
  let finish;
  const runtime = loadInjection({
    initialSessionId: "",
    discoveredAppServerManager: {
      sendRequest(...args) {
        requests.push(args);
        return new Promise((resolve) => { finish = resolve; });
      },
    },
  });
  let completed = false;
  const reload = runtime.window.__codeyReloadMcpServers().then((value) => {
    completed = true;
    return value;
  });
  await flushMicrotasks();
  assert.equal(JSON.stringify(requests), JSON.stringify([["config/mcpServer/reload", {}]]));
  assert.equal(completed, false);
  finish({});
  assert.equal((await reload).ok, true);
  assert.equal(runtime.window.__codeyPageCapabilities.mcpReload.status, "available");
});

test("MCP reload propagates protocol errors and can be retried", async () => {
  let fail = true;
  const runtime = loadInjection({
    initialSessionId: "",
    discoveredAppServerManager: {
      sendRequest() {
        return fail ? Promise.reject(new Error("Unknown method")) : Promise.resolve({});
      },
    },
  });
  await assert.rejects(runtime.window.__codeyReloadMcpServers(), /Unknown method/);
  fail = false;
  assert.equal((await runtime.window.__codeyReloadMcpServers()).ok, true);
});

test("MCP reload reports an unavailable manager instead of using legacy session signals", async () => {
  const runtime = loadInjection({ initialSessionId: "" });
  runtime.window.__codeyCodexSignalDispatcher = () => { throw new Error("unexpected signal"); };
  await assert.rejects(runtime.window.__codeyReloadMcpServers(), { code: "codey_capability_unavailable" });
  assert.equal(runtime.window.__codeyPageCapabilities.mcpReload.status, "unavailable");
});

test("MCP reload discovery is not capped by the native session timeout", async () => {
  const requests = [];
  const manager = {
    sendRequest(...args) {
      requests.push(args);
      return {};
    },
  };
  const runtime = loadInjection({
    discoveredAppServerManager: manager,
    initialSessionId: "",
  });
  runtime.window.__codeyCodexSessionController = null;
  const originalImport = runtime.window.__codeyImportCodexAsset;
  let release;
  runtime.window.__codeyImportCodexAsset = (...args) => new Promise((resolve) => {
    release = () => resolve(originalImport(...args));
  });
  const reload = runtime.window.__codeyReloadMcpServers();
  await flushMicrotasks();
  runtime.flushTimers();
  await flushMicrotasks();
  assert.equal(requests.length, 0);
  release();
  assert.equal((await reload).ok, true);
  assert.equal(JSON.stringify(requests), JSON.stringify([["config/mcpServer/reload", {}]]));
});

test("failed discovery backs off independently and recovers when a manager appears", async () => {
  let imports = 0;
  // Exercise discovery through an already discoverable manager asset.
  const manager = { sendRequest() { return { rateLimits: {} }; } };
  const discovered = loadInjection({ discoveredAppServerManager: manager, initialSessionId: "" });
  const originalImport = discovered.window.__codeyImportCodexAsset;
  discovered.window.__codeyImportCodexAsset = async (...args) => { imports += 1; return originalImport(...args); };
  await assert.rejects(discovered.window.__codeyLoadCodexSessionController({ feature: "reconcile" }), { code: "codey_capability_unavailable" });
  const firstImports = imports;
  await assert.rejects(discovered.window.__codeyLoadCodexSessionController({ feature: "reconcile" }));
  assert.equal(imports, firstImports);
  discovered.advanceTime(1_000);
  await assert.rejects(discovered.window.__codeyLoadCodexSessionController({ feature: "reconcile" }));
  assert.ok(imports > firstImports);
  const secondImports = imports;
  discovered.advanceTime(1_000);
  await assert.rejects(discovered.window.__codeyLoadCodexSessionController({ feature: "reconcile" }));
  assert.equal(imports, secondImports, "second failure waits two seconds");
  manager.codeyReconcileCompletedConversation = async () => true;
  const controller = await discovered.window.__codeyLoadCodexSessionController({ feature: "reconcile" });
  assert.equal(controller.manager, manager);
  assert.equal(discovered.window.__codeyPageCapabilities.reconcile.status, "available");
  assert.ok((await discovered.window.__codeyReadAccountRateLimits()).rateLimits);
});

test("timed out discovery cannot later publish a controller", async () => {
  const manager = { sendRequest() { assert.fail("discovery must not send requests"); } };
  const runtime = loadInjection({ discoveredAppServerManager: manager, initialSessionId: "" });
  const originalImport = runtime.window.__codeyImportCodexAsset;
  let release;
  runtime.window.__codeyImportCodexAsset = (...args) => new Promise((resolve) => { release = () => resolve(originalImport(...args)); });
  const pending = runtime.window.__codeyLoadCodexSessionController({ feature: "usage" });
  const rejected = assert.rejects(pending, { code: "codey_capability_unavailable" });
  await flushMicrotasks();
  runtime.flushTimers();
  await rejected;
  release();
  await flushMicrotasks();
  assert.equal(runtime.window.__codeyCodexSessionController, null);
  assert.equal(runtime.window.__codeyPageCapabilities.usage.status, "unavailable");
});

test("disposed capability discovery cannot replace a new installation's controller or status", async () => {
  const manager = { sendRequest() { return { rateLimits: {} }; } };
  const runtime = loadInjection({ discoveredAppServerManager: manager, initialSessionId: "" });
  const originalImport = runtime.window.__codeyImportCodexAsset;
  let release;
  runtime.window.__codeyImportCodexAsset = (...args) => new Promise((resolve) => {
    release = () => resolve(originalImport(...args));
  });
  const pending = runtime.window.__codeyLoadCodexSessionController({ feature: "usage" });
  await flushMicrotasks();
  runtime.window.__codeyNativeRuntime.dispose();
  const replacement = { kind: "manager", manager: { sendRequest() {} } };
  const replacementStatus = { usage: { status: "available", message: "" } };
  runtime.window.__codeyCodexSessionController = replacement;
  runtime.window.__codeyPageCapabilities = replacementStatus;
  release();
  await assert.rejects(pending, { code: "codey_capability_unavailable" });
  assert.equal(runtime.window.__codeyCodexSessionController, replacement);
  assert.equal(runtime.window.__codeyPageCapabilities, replacementStatus);
  assert.equal(replacementStatus.usage.status, "available");
});

test("rediscovers a patched manager cached before completion reconciliation was available", async () => {
  const managerEvents = [];
  const discoveredAppServerManager = {
    codeyReconcileCompletedConversation(payload) {
      managerEvents.push(payload.conversationId);
      return Promise.resolve(true);
    },
    discardConversationFromCache() {},
    handleThreadDeletion() {},
    refreshRecentConversations() {},
    resumeConversation() {},
  };
  loadInjection({
    codexSessionController: {
      kind: "manager",
      discardConversation() {},
      notifyConversationDeleted() {},
      refreshRecentConversations() {},
      resumeConversation() {},
    },
    discoveredAppServerManager,
  });

  await flushMicrotasks();

  assert.deepEqual(managerEvents, ["session-1"]);
});

test("resets the reconciliation interval when the visible session changes", async () => {
  const events = [];
  const runtime = loadInjection({
    codexSessionController: createRecoveryController(events),
  });
  await flushMicrotasks();

  assert.equal(events.length, 1);
  runtime.setSessionId("session-2");
  assert.equal(await runtime.window.__codeyReconcileStaleCompletedTask(), true);
  assert.deepEqual(
    events.map((event) => event.payload.conversationId),
    ["session-1", "session-2"],
  );
});

test("rejects a stale result and reconciles the task opened while a request was in flight", async () => {
  const events = [];
  let deferReconcile = false;
  let resolveReconcile;
  const runtime = loadInjection({
    codexSessionController: createRecoveryController(events, {
      async reconcileCompletedConversation(payload) {
        events.push({ payload, type: "reconcile" });
        if (!deferReconcile || payload.conversationId !== "session-1") return false;
        return new Promise((resolve) => {
          resolveReconcile = resolve;
        });
      },
    }),
  });
  await flushMicrotasks();

  deferReconcile = true;
  runtime.advanceTime(15_000);
  const reconciliation = runtime.window.__codeyReconcileStaleCompletedTask();
  await flushMicrotasks();
  runtime.setSessionId("session-2");
  runtime.emitMutations([{
    type: "childList",
    target: new FakeElement(),
    addedNodes: [],
    removedNodes: [],
  }]);
  await flushMicrotasks();
  assert.deepEqual(events.map((event) => event.payload.conversationId), ["session-1", "session-1"]);
  resolveReconcile(true);

  assert.equal(await reconciliation, false);
  await flushMicrotasks();
  assert.deepEqual(
    events.map((event) => event.payload.conversationId),
    ["session-1", "session-1", "session-2"],
  );
});

test("retries AppServerManager discovery when a signals controller was cached first", async () => {
  const managerEvents = [];
  const signalEvents = [];
  const discoveredAppServerManager = {
    codeyReconcileCompletedConversation(payload) {
      managerEvents.push("reconcile:" + payload.conversationId);
      return Promise.resolve(true);
    },
    discardConversationFromCache() {},
    handleThreadDeletion() {},
    refreshRecentConversations() {},
    resumeConversation() {},
  };
  const runtime = loadInjection({
    codexSessionController: {
      kind: "signals",
      discardConversation: () => signalEvents.push("discard"),
      notifyConversationDeleted: () => signalEvents.push("delete"),
      refreshRecentConversations: () => signalEvents.push("refresh"),
      resumeConversation: () => signalEvents.push("resume"),
    },
    discoveredAppServerManager,
  });

  await flushMicrotasks();

  assert.deepEqual(managerEvents, ["reconcile:session-1"]);
  assert.deepEqual(signalEvents, []);
  assert.equal(runtime.window.__codeyCodexSessionController.kind, "manager");
});

test("syncs Codex sidebar titles to the notification backend", async () => {
  const runtime = loadInjection({ sessionTitle: "修复飞书会话标题" });
  await new Promise((resolve) => setImmediate(resolve));

  const titleSync = runtime.bridgeCalls.find((call) => call.path === "/session/titles");
  assert.deepEqual(JSON.parse(JSON.stringify(titleSync?.payload)), {
    titles: [{ sessionId: "session-1", title: "修复飞书会话标题" }],
  });

  runtime.window.__codeySyncSidebarTitles();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    runtime.bridgeCalls.filter((call) => call.path === "/session/titles").length,
    1,
  );
});

test("bounds long-lived sidebar title cache entries", () => {
  const runtime = loadInjection();
  const rows = Array.from({ length: 2_049 }, (_, index) => new FakeElement({
    "data-app-action-sidebar-thread-id": `cache-session-${index}`,
    "data-app-action-sidebar-thread-title": `Cache title ${index}`,
  }));
  const root = {
    querySelectorAll(selector) {
      return selector ===
        "[data-app-action-sidebar-thread-id][data-app-action-sidebar-thread-title]"
        ? rows
        : [];
    },
  };

  runtime.window.__codeySyncSidebarTitles(root);

  assert.equal(runtime.window.__codeyGetSessionTitle("cache-session-0"), "");
  assert.equal(
    runtime.window.__codeyGetSessionTitle("cache-session-2048"),
    "Cache title 2048",
  );
});

test("resolves a local project path from the current opaque project row id", () => {
  const runtime = loadInjection();
  const project = new FakeElement({
    "data-app-action-sidebar-project-id": "local-project-hash",
    "data-app-action-sidebar-project-row": "",
  });
  project.__reactFiber$test = {
    memoizedProps: {
      children: [{
        props: {
          group: {
            projectId: "local-project-hash",
            path: "/Users/test/workspace",
            projectKind: "local",
          },
        },
      }],
    },
    return: null,
  };

  assert.equal(
    runtime.window.__codeyProjectPathFromRow(project),
    "/Users/test/workspace",
  );
});

test("exports a session through ordered chunks and finalizes the transfer", async () => {
  const exported = Buffer.from("{\"format\":\"codey.session\",\"version\":1}");
  const chunkBytes = 11;
  const conversationId = "019f8339-ddc1-7652-8922-13e2b52d0d00";
  const written = [];
  const runtime = loadInjection({
    bridgeHandler: async (path, payload) => {
      if (path === "/session/export/start") {
        return {
          status: "ready",
          transferId: "export-transfer",
          filename: "session.codey-session.json",
          size: exported.length,
        };
      }
      if (path === "/session/export/chunk") {
        const bytes = exported.subarray(payload.offset, payload.offset + chunkBytes);
        const nextOffset = payload.offset + bytes.length;
        return {
          status: "ok",
          offset: payload.offset,
          nextOffset,
          data: bytes.toString("base64"),
          done: nextOffset === exported.length,
        };
      }
      if (path === "/session/export/finish") return { status: "ok" };
      return { status: "failed", message: `unexpected path: ${path}` };
    },
  });
  runtime.window.showSaveFilePicker = async () => ({
    createWritable: async () => ({
      abort: async () => {},
      close: async () => {},
      write: async (bytes) => written.push(Buffer.from(bytes)),
    }),
  });
  const thread = new FakeElement({
    "data-app-action-sidebar-thread-id": "local:client-new-thread:temporary-id",
  });
  thread.__reactFiber$test = {
    memoizedProps: {
      entry: { conversationId },
    },
    pendingProps: null,
    return: null,
  };
  const button = new FakeElement();

  await runtime.window.__codeyExportSession(thread, button);

  assert.equal(Buffer.concat(written).toString("utf8"), exported.toString("utf8"));
  assert.deepEqual(
    JSON.parse(JSON.stringify(
      runtime.bridgeCalls.find((call) => call.path === "/session/export/start")?.payload,
    )),
    { sessionId: conversationId },
  );
  assert.deepEqual(
    runtime.bridgeCalls
      .map((call) => call.path)
      .filter((path) => path.startsWith("/session/export/")),
    [
      "/session/export/start",
      "/session/export/chunk",
      "/session/export/chunk",
      "/session/export/chunk",
      "/session/export/chunk",
      "/session/export/finish",
    ],
  );
  assert.equal(button.disabled, false);
});

test("refreshes Codex recent sessions after importing instead of reloading", async () => {
  const signalCalls = [];
  const runtime = loadInjection({
    bridgeHandler: async (path, payload) => {
      if (path === "/session/import/start") {
        return {
          status: "ready",
          transferId: "transfer-1",
          chunkSize: 1024,
          maxBytes: 1024 * 1024,
        };
      }
      if (path === "/session/import/chunk") {
        return {
          status: "ok",
          nextOffset: payload.offset + Buffer.from(payload.data, "base64").length,
        };
      }
      if (path === "/session/import/finish") {
        return {
          status: "imported",
          sessionId: "imported-session",
          message: "会话数据已导入",
        };
      }
      return { status: "ok" };
    },
    codexSignalDispatcher: async (name, payload) => {
      signalCalls.push({ name, payload });
    },
  });
  const button = new FakeElement();

  await runtime.window.__codeyImportSessionFile(
    "/Users/test/workspace",
    { text: async () => "{\"format\":\"codey.session\"}" },
    button,
  );

  assert.deepEqual(JSON.parse(JSON.stringify(signalCalls)), [{
    name: "refresh-recent-conversations-for-host",
    payload: { hostId: "local" },
  }]);
  const chunkCall = runtime.bridgeCalls.find((call) => call.path === "/session/import/chunk");
  assert.equal(Buffer.from(chunkCall?.payload.data, "base64").toString("utf8"), "{\"format\":\"codey.session\"}");
  const finishCall = runtime.bridgeCalls.find((call) => call.path === "/session/import/finish");
  assert.deepEqual(JSON.parse(JSON.stringify(finishCall?.payload)), {
    transferId: "transfer-1",
    projectPath: "/Users/test/workspace",
  });
  assert.equal(runtime.getReloadCount(), 0);
  assert.equal(button.disabled, false);
});

test("imports from the tasks header using the project stored in the file", async () => {
  const runtime = loadInjection({
    bridgeHandler: async (path, payload) => {
      if (path === "/session/import/start") {
        return {
          status: "ready",
          transferId: "transfer-2",
          chunkSize: 1024,
          maxBytes: 1024 * 1024,
        };
      }
      if (path === "/session/import/chunk") {
        return {
          status: "ok",
          nextOffset: payload.offset + Buffer.from(payload.data, "base64").length,
        };
      }
      if (path === "/session/import/finish") {
        return {
          status: "imported",
          sessionId: "imported-session",
          projectPath: "/Users/test/task-project",
          message: "会话数据已导入",
        };
      }
      return { status: "ok" };
    },
    codexSignalDispatcher: async () => {},
  });
  const button = new FakeElement();

  await runtime.window.__codeyImportSessionFile(
    "",
    { text: async () => "{\"format\":\"codey.session\"}" },
    button,
  );

  const finishCall = runtime.bridgeCalls.find((call) => call.path === "/session/import/finish");
  assert.deepEqual(JSON.parse(JSON.stringify(finishCall?.payload)), {
    transferId: "transfer-2",
    projectPath: "",
  });
  assert.equal(button.disabled, false);
});

test("hidden windows skip layout-based session detection until they become visible", async () => {
  const events = [];
  const runtime = loadInjection({
    initialSessionId: "",
    codexSessionController: createRecoveryController(events),
  });
  await flushMicrotasks();
  const getClientRects = FakeElement.prototype.getClientRects;
  let layoutReads = 0;
  FakeElement.prototype.getClientRects = function () {
    layoutReads += 1;
    return getClientRects.call(this);
  };
  try {
    runtime.document.visibilityState = "hidden";
    runtime.setSessionId("session-1");
    runtime.emitMutations([{ type: "childList", target: new FakeElement(), addedNodes: [], removedNodes: [] }]);
    await flushMicrotasks();
    assert.equal(layoutReads, 0);
    assert.equal(events.length, 0);

    runtime.document.visibilityState = "visible";
    runtime.emitMutations([{ type: "childList", target: new FakeElement(), addedNodes: [], removedNodes: [] }]);
    await flushMicrotasks();
    assert.ok(layoutReads > 0);
    assert.deepEqual(events.map((event) => event.payload.conversationId), ["session-1"]);
  } finally {
    FakeElement.prototype.getClientRects = getClientRects;
  }
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

import { flushTimers } from "./helpers/flush.mjs";
import { FakeElementCore } from "./helpers/fake-element.mjs";

const source = readFileSync(
  new URL("../public/conversation-stats-inject.js", import.meta.url),
  "utf8",
);

class FakeElement extends FakeElementCore {
  constructor(tagName = "div", { visible = true } = {}) {
    super(tagName);
    this.visible = visible;
  }

  matches(selector) {
    if (selector === ":popover-open") {
      if (typeof this.showPopover !== "function") throw new SyntaxError("Unsupported popover selector");
      return this.popoverOpen === true;
    }
    const match = selector.match(/^(\w+)?\.([\w-]+)$/);
    if (match) return (!match[1] || this.tagName === match[1].toUpperCase())
      && String(this.className || "").split(/\s+/).includes(match[2]);
    return super.matches(selector);
  }

  focus() {
    if (this.ownerDocument) this.ownerDocument.activeElement = this;
  }

  getClientRects() {
    return this.visible ? [{ bottom: 10, left: 0, right: 10, top: 0 }] : [];
  }

  getBoundingClientRect() {
    return this.visible
      ? { bottom: 160, height: 60, left: 0, right: 600, top: 100, width: 600 }
      : { bottom: 0, height: 0, left: 0, right: 0, top: 0, width: 0 };
  }
}

const createEnvironment = (options = {}) => {
  const documentElement = new FakeElement("html");
  const body = new FakeElement("body");
  const scope = new FakeElement("div");
  const anchor = new FakeElement("div", { visible: options.anchorVisible !== false });
  anchor.setAttribute(
    "data-above-composer-conversation-id",
    options.conversationId ?? "conversation-1",
  );
  const textarea = new FakeElement("textarea", {
    visible: options.inputVisible !== false,
  });
  documentElement.appendChild(body);
  body.appendChild(scope);
  if (options.anchor !== false) {
    scope.appendChild(anchor);
    scope.appendChild(textarea);
  }

  const findById = (root, id) => {
    if (root.id === id || root.getAttribute?.("id") === id) return root;
    for (const child of root.children || []) {
      const found = findById(child, id);
      if (found) return found;
    }
    return null;
  };

  let latestObserver = null;
  class FakeMutationObserver {
    constructor(callback) {
      this.callback = callback;
      this.observed = false;
      latestObserver = this;
    }

    observe(_target, options) {
      this.observed = true;
      this.options = options;
    }

    disconnect() {
      this.observed = false;
    }
  }

  const document = {
    body,
    documentElement,
    visibilityState: options.visibilityState ?? "visible",
    activeElement: body,
    createElement: (tagName) => Object.assign(new FakeElement(tagName), { ownerDocument: document }, options.popover ? {
      showPopover() { this.popoverOpen = true; },
      hidePopover() { this.popoverOpen = false; },
    } : {}),
    getElementById: (id) => findById(documentElement, id),
    querySelector: (selector) => documentElement.querySelector(selector),
    querySelectorAll: (selector) => documentElement.querySelectorAll(selector),
    listeners: new Map(),
    addEventListener: FakeElementCore.prototype.addEventListener,
    removeEventListener: FakeElementCore.prototype.removeEventListener,
    dispatchEvent: FakeElementCore.prototype.dispatchEvent,
  };
  for (const element of [documentElement, body, scope, anchor, textarea]) element.ownerDocument = document;

  const location = {
    pathname: options.pathname ?? "/",
    search: options.search ?? "",
  };

  const statsBySession = new Map(Object.entries(options.statsBySession ?? {}));
  const calls = [];
  const bridge = async (path, payload) => {
    calls.push({ path, payload });
    if (path === "/session/stats") {
      if (options.request) return options.request(payload.sessionId);
      return {
        status: "ok",
        stats: statsBySession.get(payload.sessionId) ?? null,
      };
    }
    return { status: "ok" };
  };

  const window = {
    __codexSessionDeleteBridge: options.bridgeReady === false ? undefined : bridge,
    innerHeight: 800,
    innerWidth: 1000,
    location,
    listeners: new Map(),
    addEventListener: FakeElementCore.prototype.addEventListener,
    removeEventListener: FakeElementCore.prototype.removeEventListener,
  };

  const timers = new Map();
  let timerId = 0;
  let timerCallbacks = 0;
  const testSetTimeout = (callback, delay, ...args) => {
    if (options.manualTimers) {
      const id = ++timerId;
      timers.set(id, { delay, callback: () => { timerCallbacks += 1; callback(...args); } });
      return id;
    }
    const timer = setTimeout(callback, delay, ...args);
    timer.unref?.();
    return timer;
  };
  const sandbox = {
    document,
    window,
    location,
    URLSearchParams,
    MutationObserver: FakeMutationObserver,
    HTMLElement: FakeElement,
    setTimeout: testSetTimeout,
    clearTimeout: options.manualTimers ? id => timers.delete(id) : clearTimeout,
  };
  const context = vm.createContext(sandbox);
  vm.runInContext(source, context);
  const observer = latestObserver;

  return {
    anchor,
    textarea,
    document,
    scope,
    calls,
    statsBySession,
    timers,
    timerCallbacks: () => timerCallbacks,
    runTimer: (delay) => {
      const entry = [...timers].find(([, timer]) => timer.delay === delay);
      assert.ok(entry, `expected a ${delay} ms timer`);
      timers.delete(entry[0]);
      entry[1].callback();
    },
    setVisibility: (state) => {
      document.visibilityState = state;
      document.dispatchEvent({ type: "visibilitychange" });
    },
    bar: () => findById(documentElement, "codey-conversation-stats"),
    snapshot: () => context.window.__codeyConversationStats?.snapshot(),
    refresh: () => context.window.__codeyConversationStats.refresh(),
    setStats: (sessionId, value) => statsBySession.set(sessionId, value),
    setConversation: (id) => {
      anchor.setAttribute("data-above-composer-conversation-id", id);
    },
    emitMutation: (mutations = [{ type: "childList", target: documentElement }]) => {
      if (observer?.observed) observer.callback(mutations.filter(mutation => mutation.type !== "attributes"
        || observer.options?.attributeFilter?.includes(mutation.attributeName)));
    },
    emitAnchorMutation: () => {
      observer?.callback?.([
        { type: "attributes", target: anchor, attributeName: "data-above-composer-conversation-id" },
      ]);
    },
    rerun: () => vm.runInContext(source, context),
    dispose: () => context.window.__codeyConversationStats.dispose(),
    markPreviousVersion: () => { context.window.__codeyConversationStats.version = 3; },
    window,
  };
};

const LAST_TURN = {
  id: "turn-1", status: "completed", stepCount: 2,
  modelDurationMs: 10000, toolDurationMs: 3000, averageTtftMs: 500,
  averageOutputTokensPerSecond: 187.52, speedIsEstimate: false,
  inFlight: 0, speedState: null, coverage: "runtime",
};
const STATS = {
  lastTurn: LAST_TURN,
  turnCount: 4,
  usageSource: "runtime",
  usageScope: "runtime",
  requestsScope: "runtime",
  model: "gpt-5",
  requests: 2,
  inFlight: 0,
  lastStatus: "succeeded",
  outputTokensPerSecond: 999,
  averageOutputTokensPerSecond: 187.52,
  averageSpeedIsEstimate: false,
  averageSpeedSource: "runtime",
  averageSpeedScope: "runtime",
  averageSpeedRequestCount: 2,
  inputTokens: 128_400,
  outputTokens: 3_100,
  cachedInputTokens: 120_000,
  cacheWriteInputTokens: 2_000,
  totalTokens: 131_500,
  updatedAtUnixMs: 1_760_000_000_000,
};

const metric = (bar, name) => name === "status" ? bar.dataset.status : bar.querySelector(`.codey-cs-${name}`).textContent;
const field = (bar, name) => bar.__codeyCs.fields[name].textContent;
const summary = (env) => env.bar().querySelector("button.codey-cs-summary");
const panel = (env) => env.document.getElementById("codey-conversation-stats-activity");
const click = (element) => element.dispatchEvent({ type: "click", preventDefault() {} });
const assertExpanded = (env, expanded) => {
  assert.equal(summary(env).getAttribute("aria-expanded"), String(expanded));
  assert.equal(panel(env).hidden, !expanded);
};

test("mounts promptly when a textarea itself is inserted beside the composer marker", async () => {
  const env = createEnvironment({ inputVisible: false, statsBySession: { "conversation-1": STATS } });
  try {
    env.textarea.remove();
    await flushTimers(30);
    assert.equal(env.bar(), null);
    env.textarea.visible = true;
    env.scope.appendChild(env.textarea);
    env.emitMutation([{ type: "childList", target: env.scope, addedNodes: [env.textarea] }]);
    await flushTimers(160);
    assert.equal(metric(env.bar(), "total"), "132k tok");
    assert.equal(env.calls.length, 1);
  } finally { env.dispose(); }
});

test("restores a composer promptly when its hidden attribute is removed", async () => {
  const env = createEnvironment({ statsBySession: { "conversation-1": STATS } });
  try {
    await flushTimers(30);
    env.scope.setAttribute("hidden", "");
    env.emitMutation([{ type: "attributes", target: env.scope, attributeName: "hidden" }]);
    await flushTimers(160);
    assert.equal(env.bar().hidden, true);
    env.scope.removeAttribute("hidden");
    env.emitMutation([{ type: "attributes", target: env.scope, attributeName: "hidden" }]);
    await flushTimers(160);
    assert.equal(env.bar().hidden, false);
    assert.equal(metric(env.bar(), "total"), "132k tok");
  } finally { env.dispose(); }
});

for (const attribute of ["data-session-id", "data-thread-id", "data-app-action-sidebar-thread-id", "data-app-action-sidebar-thread-active"]) {
  test(`refreshes fallback session context on ${attribute} changes`, async () => {
    const env = createEnvironment({ anchor: false, statsBySession: {
      "conversation-1": STATS, "conversation-2": { ...STATS, totalTokens: 42 },
    } });
    try {
      const marker = env.document.createElement("div");
      if (attribute.startsWith("data-app-action-sidebar-thread-")) {
        marker.setAttribute("data-app-action-sidebar-thread-id", "conversation-1");
        marker.setAttribute("data-app-action-sidebar-thread-active", "true");
      } else marker.setAttribute(attribute, "conversation-1");
      env.scope.appendChild(marker);
      await flushTimers(30);
      assert.equal(env.snapshot().sessionId, "conversation-1");
      if (attribute === "data-app-action-sidebar-thread-active") {
        marker.setAttribute(attribute, "false");
        const active = env.document.createElement("div");
        active.setAttribute("data-app-action-sidebar-thread-id", "conversation-2");
        active.setAttribute(attribute, "true");
        env.scope.appendChild(active);
      } else marker.setAttribute(attribute, "conversation-2");
      env.emitMutation([{ type: "attributes", target: marker, attributeName: attribute }]);
      await flushTimers(160);
      assert.equal(env.snapshot().sessionId, "conversation-2");
      assert.equal(env.snapshot().stats.totalTokens, 42);
    } finally { env.dispose(); }
  });
}

test("refreshes fallback context when an active sidebar item itself is inserted", async () => {
  const env = createEnvironment({ anchor: false, statsBySession: { "conversation-1": STATS } });
  try {
    await flushTimers(30);
    assert.equal(env.snapshot().sessionId, "");
    const active = env.document.createElement("div");
    active.setAttribute("data-app-action-sidebar-thread-id", "conversation-1");
    active.setAttribute("data-app-action-sidebar-thread-active", "true");
    env.scope.appendChild(active);
    env.emitMutation([{ type: "childList", target: env.scope, addedNodes: [active] }]);
    await flushTimers(160);
    assert.equal(env.snapshot().sessionId, "conversation-1");
    assert.equal(env.snapshot().stats.totalTokens, STATS.totalTokens);
  } finally { env.dispose(); }
});

test("ignores child mutations inside the stats panel", async () => {
  const env = createEnvironment({ statsBySession: { "conversation-1": STATS } });
  try {
    await flushTimers(30);
    const counts = observeRenderWork(env);
    const nested = env.document.createElement("div");
    nested.setAttribute("data-thread-id", "unrelated");
    panel(env).appendChild(nested);
    env.emitMutation([{ type: "childList", target: panel(env), addedNodes: [nested] }]);
    await flushTimers(160);
    assert.equal(counts.composerScans, 0);
    assert.equal(env.calls.length, 1);
  } finally { env.dispose(); }
});

test("rejects fractional or imprecise token and step counts", async () => {
  const env = createEnvironment();
  try {
    for (const value of [1.5, "42", Number.MAX_SAFE_INTEGER + 1, -1]) {
      env.setStats("conversation-1", { ...STATS, turnCount: value, totalTokens: value,
        inputTokens: value, cachedInputTokens: value, outputTokens: value,
        lastTurn: { ...LAST_TURN, stepCount: value } });
      env.refresh();
      await flushTimers(30);
      assert.equal(metric(env.bar(), "total"), "—");
      assert.equal(metric(env.bar(), "activity"), "— 轮 · — 步");
      assert.equal(field(env.bar(), "outputTokens"), "—");
      assert.equal(metric(env.bar(), "cache-rate"), "—");
    }
  } finally { env.dispose(); }
});

const observeRenderWork = (env) => {
  const counts = { composerScans: 0, textWrites: 0 };
  const querySelectorAll = env.document.querySelectorAll;
  env.document.querySelectorAll = (selector) => {
    if (selector === "[data-above-composer-conversation-id]") counts.composerScans += 1;
    return querySelectorAll(selector);
  };
  const refs = env.bar().__codeyCs;
  for (const element of [refs.speed, refs["cache-rate"], refs.total, refs.activity,
    ...Object.values(refs.fields), ...Object.values(refs.notes)]) {
    let value = element.textContent;
    Object.defineProperty(element, "textContent", {
      configurable: true,
      get: () => value,
      set: (next) => { counts.textWrites += 1; value = next; },
    });
  }
  return counts;
};

const observeAttributeWrites = (env) => {
  const counts = { attributes: 0, properties: 0 };
  const refs = env.bar().__codeyCs;
  for (const element of Object.values(refs.buttons)) {
    const original = element.setAttribute;
    element.setAttribute = function (...args) {
      counts.attributes += 1;
      original.apply(this, args);
    };
  }
  const watch = (object, key) => {
    let value = object[key];
    Object.defineProperty(object, key, {
      configurable: true,
      get: () => value,
      set: next => { counts.properties += 1; value = next; },
    });
  };
  for (const element of [env.bar(), ...Object.values(refs.panels), refs.buttons.codegraph]) watch(element, "hidden");
  for (const panel of Object.values(refs.panels)) {
    for (const key of ["left", "maxHeight", "top"]) watch(panel.style, key);
  }
  watch(refs.speed, "title");
  for (const key of ["status", "state", "running"]) watch(env.bar().dataset, key);
  return counts;
};

test("streaming content and visibility changes inside a turn do not rescan the composer", async () => {
  const env = createEnvironment({ manualTimers: true, statsBySession: { "conversation-1": STATS } });
  try {
    env.runTimer(0);
    await flushTimers(0);
    const turn = env.document.createElement("div");
    turn.setAttribute("data-turn-key", "turn-1");
    env.scope.appendChild(turn);
    const streamedNode = turn.appendChild(env.document.createElement("span"));
    streamedNode.querySelector = () => { throw new Error("streamed text must not be searched"); };
    env.emitMutation([{ type: "childList", target: turn, addedNodes: [streamedNode] }]);
    turn.setAttribute("aria-hidden", "true");
    env.emitMutation([{ type: "attributes", target: turn, attributeName: "aria-hidden" }]);
    assert.equal([...env.timers.values()].some(timer => timer.delay === 120), false);
  } finally { env.dispose(); }
});

test("unchanged rescans do not rewrite attributes and changed values update immediately", async () => {
  const env = createEnvironment({ manualTimers: true, statsBySession: { "conversation-1": STATS } });
  try {
    env.runTimer(0);
    await flushTimers(0);
    click(summary(env));
    const counts = observeAttributeWrites(env);
    for (let index = 0; index < 5; index += 1) {
      env.emitAnchorMutation();
      env.runTimer(120);
    }
    assert.deepEqual(counts, { attributes: 0, properties: 0 });
    env.setStats("conversation-1", { ...STATS, lastTurn: { ...LAST_TURN, status: "running", speedIsEstimate: true } });
    env.refresh();
    env.runTimer(0);
    await flushTimers(0);
    assert.equal(env.bar().dataset.running, "true");
    assert.match(env.bar().__codeyCs.speed.title, /含生成中的 Token 估算/);
    assert.match(summary(env).getAttribute("aria-label"), /本轮进行中/);
    assert.ok(counts.attributes > 0 && counts.properties > 0);
  } finally { env.dispose(); }
});

test("unchanged idle statistics back off and submission, visibility and session changes reset polling", async () => {
  const env = createEnvironment({ manualTimers: true, statsBySession: { "conversation-1": STATS } });
  try {
    for (const delay of [0, 3000, 6000, 12000]) {
      env.runTimer(delay); await flushTimers(0);
    }
    assert.ok([...env.timers.values()].some(timer => timer.delay === 12000));
    for (const event of [
      { type: "keydown", target: env.textarea, key: "Enter", shiftKey: true },
      { type: "keydown", target: env.textarea, key: "Enter", isComposing: true },
      { type: "keydown", target: env.document.body, key: "Enter" },
    ]) env.document.dispatchEvent(event);
    assert.ok([...env.timers.values()].some(timer => timer.delay === 12000));
    env.document.dispatchEvent({ type: "keydown", target: env.textarea, key: "Enter" });
    env.runTimer(300); await flushTimers(0);
    assert.ok([...env.timers.values()].some(timer => timer.delay === 3000));
    env.runTimer(3000); await flushTimers(0);
    env.setVisibility("hidden");
    assert.equal(env.timers.size, 0);
    env.setVisibility("visible"); env.runTimer(0); await flushTimers(0);
    assert.ok([...env.timers.values()].some(timer => timer.delay === 3000));
    env.runTimer(3000); await flushTimers(0);
    env.setConversation("conversation-2"); env.emitAnchorMutation();
    env.runTimer(120); env.runTimer(0); await flushTimers(0);
    assert.equal(env.snapshot().sessionId, "conversation-2");
    assert.ok([...env.timers.values()].some(timer => timer.delay === 3000));
  } finally { env.dispose(); }
});

test("changed CodeGraph status and failed statistics reads reset idle backoff", async () => {
  let response = { status: "ok", stats: STATS, codegraph: { phase: "indexing" } };
  const env = createEnvironment({ manualTimers: true, request: async () => {
    if (response instanceof Error) throw response;
    return response;
  } });
  try {
    env.runTimer(0); await flushTimers(0);
    env.runTimer(3000); await flushTimers(0);
    response = { ...response, codegraph: { phase: "watching" } };
    env.runTimer(6000); await flushTimers(0);
    assert.ok([...env.timers.values()].some(timer => timer.delay === 3000));
    for (const failure of [{ status: "failed" }, new Error("mock failure")]) {
      env.runTimer(3000); await flushTimers(0);
      response = failure;
      env.runTimer(6000); await flushTimers(0);
      assert.equal(env.snapshot().lastFetchOk, false);
      assert.ok([...env.timers.values()].some(timer => timer.delay === 3000));
      response = { status: "ok", stats: STATS };
      env.runTimer(3000); await flushTimers(0);
    }
  } finally { env.dispose(); }
});

test("submission during an in-flight read discards old statistics and queues one refresh", async () => {
  const pending = [];
  const env = createEnvironment({ manualTimers: true, request: () => new Promise(resolve => pending.push(resolve)) });
  try {
    env.runTimer(0); await flushTimers(0);
    env.document.dispatchEvent({ type: "keydown", target: env.textarea, key: "Enter" });
    pending.shift()({ status: "ok", stats: STATS }); await flushTimers(0);
    assert.equal(env.snapshot().stats, null);
    env.runTimer(0); await flushTimers(0);
    assert.equal(env.calls.length, 2);
    pending.shift()({ status: "ok", stats: { ...STATS, inFlight: 1 } }); await flushTimers(0);
    assert.ok([...env.timers.values()].some(timer => timer.delay === 1100));
    env.dispose();
    env.document.dispatchEvent({ type: "keydown", target: env.textarea, key: "Enter" });
    assert.equal(env.timers.size, 0);
  } finally { env.dispose(); }
});

test("initially hidden pages schedule no work and visible polling preserves both intervals", async () => {
  const env = createEnvironment({ manualTimers: true, visibilityState: "hidden", statsBySession: { "conversation-1": STATS } });
  try {
    assert.equal(env.timers.size, 0);
    assert.equal(env.bar(), null);
    env.emitAnchorMutation();
    env.refresh();
    assert.equal(env.timers.size, 0);
    env.setVisibility("visible");
    env.runTimer(0);
    await flushTimers(0);
    assert.deepEqual([...env.timers.values()].map(timer => timer.delay), [3000]);
    env.setStats("conversation-1", { ...STATS, lastTurn: { ...LAST_TURN, status: "running" } });
    env.runTimer(3000);
    await flushTimers(0);
    assert.deepEqual([...env.timers.values()].map(timer => timer.delay), [1100]);
    env.emitAnchorMutation();
    assert.equal(env.timers.size, 2);
    env.setVisibility("hidden");
    const callbacks = env.timerCallbacks();
    for (let index = 0; index < 5; index += 1) {
      env.emitAnchorMutation();
      env.refresh();
      for (const type of ["focus", "pageshow"]) FakeElementCore.prototype.dispatchEvent.call(env.window, { type });
    }
    assert.equal(env.timers.size, 0);
    assert.equal(env.timerCallbacks(), callbacks);
    env.setConversation("conversation-2");
    env.setVisibility("visible");
    env.runTimer(0);
    await flushTimers(0);
    assert.equal(env.calls.at(-1).payload.sessionId, "conversation-2");
  } finally { env.dispose(); }
});

for (const failure of [false, true]) {
  test(`hidden in-flight ${failure ? "failure" : "response"} does not render or restart timers`, async () => {
    let settle;
    const env = createEnvironment({ manualTimers: true, request: () => new Promise((resolve, reject) => {
      settle = failure ? () => reject(new Error("offline")) : () => resolve({ status: "ok", stats: STATS });
    }) });
    try {
      env.runTimer(0);
      const counts = observeRenderWork(env);
      env.setVisibility("hidden");
      env.setConversation("conversation-2");
      env.emitAnchorMutation();
      settle();
      await flushTimers(0);
      assert.equal(env.timers.size, 0);
      assert.deepEqual(counts, { composerScans: 0, textWrites: 0 });
      assert.equal(env.snapshot().stats, null);
      env.setVisibility("visible");
      env.runTimer(0);
      assert.equal(env.calls.length, 2);
      assert.equal(env.calls[1].payload.sessionId, "conversation-2");
    } finally { env.dispose(); settle(); await flushTimers(0); }
  });
}

test("rapid hide and show waits for one old request then refreshes immediately", async () => {
  const pending = [];
  const env = createEnvironment({ manualTimers: true, request: () => new Promise(resolve => pending.push(resolve)) });
  try {
    env.runTimer(0);
    for (let index = 0; index < 3; index += 1) {
      env.setVisibility("hidden");
      env.setVisibility("visible");
    }
    assert.equal(env.calls.length, 1);
    assert.equal(env.timers.size, 0);
    pending[0]({ status: "ok", stats: STATS });
    await flushTimers(0);
    assert.equal(env.snapshot().stats, null);
    assert.deepEqual([...env.timers.values()].map(timer => timer.delay), [0]);
    env.runTimer(0);
    assert.equal(env.calls.length, 2);
    pending[1]({ status: "ok", stats: { ...STATS, totalTokens: 700 } });
    await flushTimers(0);
    assert.equal(metric(env.bar(), "total"), "700 tok");
    env.setVisibility("hidden");
    const oldBar = env.bar();
    oldBar.remove();
    env.emitMutation([{ type: "childList", removedNodes: [oldBar] }]);
    env.markPreviousVersion();
    env.rerun();
    assert.equal(env.timers.size, 0);
    env.setVisibility("visible");
    env.runTimer(0);
    assert.equal(env.calls.length, 3);
    pending[2]({ status: "ok", stats: STATS });
    await flushTimers(0);
    assert.ok(env.bar());
    assert.equal(env.document.querySelectorAll("#codey-conversation-stats-overlay").length, 1);
  } finally { env.dispose(); }
  assert.equal(env.timers.size, 0);
});

test("refreshes with one composer scan per async phase and only writes changed text", async () => {
  const env = createEnvironment({ statsBySession: { "conversation-1": STATS } });
  try {
    await flushTimers(30);
    const counts = observeRenderWork(env);
    const initialCalls = env.calls.length;
    env.refresh();
    await flushTimers(30);
    assert.deepEqual(counts, { composerScans: 2, textWrites: 0 });
    assert.equal(env.calls.length, initialCalls + 1);
    env.setStats("conversation-1", { ...STATS, totalTokens: 500, lastTurn: { ...LAST_TURN, averageOutputTokensPerSecond: 50 } });
    env.refresh();
    await flushTimers(30);
    assert.deepEqual(counts, { composerScans: 4, textWrites: 4 });
    assert.equal(metric(env.bar(), "total"), "500 tok");
    assert.equal(field(env.bar(), "totalTokens"), "500 tok");
    assert.equal(metric(env.bar(), "speed"), "50.0 tok/s");
    assert.equal(field(env.bar(), "speed"), "50.0 tok/s");
  } finally {
    env.dispose();
  }
});

test("remounts into a replacement composer after an in-flight stats response", async () => {
  let resolve;
  const env = createEnvironment({ request: () => new Promise(done => { resolve = done; }) });
  try {
    await flushTimers(30);
    const originalBar = env.bar();
    env.scope.remove();
    const replacement = env.document.createElement("div");
    const anchor = env.document.createElement("div");
    anchor.setAttribute("data-above-composer-conversation-id", "conversation-1");
    replacement.append(anchor, env.document.createElement("textarea"));
    env.document.body.appendChild(replacement);
    // 不发 MutationObserver 通知，确保完成异步读取时主动重新定位。
    resolve({ status: "ok", stats: STATS });
    await flushTimers(30);
    assert.equal(env.bar(), originalBar);
    assert.equal(env.bar().parentElement, replacement);
    assert.equal(metric(env.bar(), "total"), "132k tok");
  } finally {
    env.dispose();
  }
});

test("discards a response after navigation without a mutation notification", async () => {
  const pending = [];
  const env = createEnvironment({ request: sessionId => new Promise(resolve => pending.push({ sessionId, resolve })) });
  try {
    await flushTimers(30);
    env.setConversation("conversation-2");
    pending[0].resolve({ status: "ok", stats: STATS });
    await flushTimers(30);
    assert.equal(metric(env.bar(), "total"), "—");
    assert.equal(pending[1].sessionId, "conversation-2");
    pending[1].resolve({ status: "ok", stats: { ...STATS, totalTokens: 700 } });
    await flushTimers(30);
    assert.equal(metric(env.bar(), "total"), "700 tok");
  } finally {
    env.dispose();
  }
});

test("mounts cached stats when the composer appears after the initial response", async () => {
  const env = createEnvironment({ anchor: false, pathname: "/c/conversation-1", statsBySession: { "conversation-1": STATS } });
  try {
    await flushTimers(30);
    assert.equal(env.bar(), null);
    assert.equal(env.calls.length, 1);
    env.scope.append(env.anchor, env.textarea);
    env.emitAnchorMutation();
    await flushTimers(160);
    assert.equal(env.bar().parentElement, env.scope);
    assert.equal(metric(env.bar(), "total"), "132k tok");
    assert.equal(env.calls.length, 1, "mounting must not refetch the same session");
  } finally {
    env.dispose();
  }
});

test("mounts the stats bar under the composer and renders speed/cache/total", async () => {
  const env = createEnvironment({ statsBySession: { "conversation-1": STATS } });
  await flushTimers(30);

  const bar = env.bar();
  assert.ok(bar, "stats bar should exist");
  assert.equal(bar.parentElement, env.scope);
  assert.equal(bar.hidden, false);
  assert.equal(metric(bar, "speed"), "188 tok/s");
  assert.equal(metric(bar, "activity"), "4 轮 · 2 步");
  assert.match(bar.__codeyCs.activity.title, /轮数为会话总轮数，步骤和速度为最近一轮/);
  assert.equal(metric(bar, "cache-rate"), "93%");
  assert.equal(metric(bar, "total"), "132k tok");
  assert.equal(field(bar, "outputTokens"), "3,100 tok");
  assert.equal(summary(env).querySelectorAll(".codey-cs-metric").length, 2);
  for (const selector of [".codey-cs-meta", ".codey-cs-status", '[data-field="model"]']) {
    assert.equal(summary(env).querySelector(selector), null);
  }
  assert.equal(field(bar, "totalTokens"), "131,500 tok");
  assert.equal(field(bar, "cachedInputTokens"), "120,000 tok");
  assert.match(summary(env).getAttribute("aria-label"), /最近一轮统计/);
  assert.match(summary(env).getAttribute("aria-label"), /会话总轮数 4 轮，最近一轮统计 2 步/);
  assert.match(summary(env).getAttribute("aria-label"), /查看统计详情/);
  assert.equal(
    env.calls.filter((call) => call.path === "/session/stats").at(-1).payload.sessionId,
    "conversation-1",
  );
});

test("keeps the bar visible while the current conversation has no stats", async () => {
  const env = createEnvironment();
  await flushTimers(30);
  assert.equal(env.bar()?.hidden, false);
  assert.equal(metric(env.bar(), "status"), "暂无统计");
  assert.equal(metric(env.bar(), "total"), "—");
});

test("shows unknown values when upstream omits speed and cache", async () => {
  const env = createEnvironment({
    statsBySession: {
      "conversation-1": {
        ...STATS,
        lastTurn: { ...LAST_TURN, averageOutputTokensPerSecond: null },
        cachedInputTokens: null,
        inputTokens: null,
      },
    },
  });
  await flushTimers(30);
  const bar = env.bar();
  assert.equal(bar.hidden, false);
  assert.equal(metric(bar, "speed"), "—");
  assert.equal(metric(bar, "cache-rate"), "—");
  assert.equal(field(bar, "cachedInputTokens"), "—");
  assert.equal(metric(bar, "total"), "132k tok");
});

test("switches stats context when the conversation changes", async () => {
  const env = createEnvironment({
    statsBySession: {
      "conversation-1": STATS,
      "conversation-2": { ...STATS, totalTokens: 900, model: "claude-sonnet" },
    },
  });
  await flushTimers(30);
  assert.equal(metric(env.bar(), "total"), "132k tok");

  env.setConversation("conversation-2");
  env.emitAnchorMutation();
  await flushTimers(200);

  const bar = env.bar();
  assert.equal(metric(bar, "total"), "900 tok");
  assert.equal(env.calls.at(-1).payload.sessionId, "conversation-2");
});

test("clears stale numbers immediately on a session switch before refetch", async () => {
  const env = createEnvironment({ statsBySession: { "conversation-1": STATS } });
  await flushTimers(30);
  assert.equal(env.bar().hidden, false);

  env.setConversation("conversation-3");
  env.emitAnchorMutation();
  await flushTimers(160);

  const bar = env.bar();
  assert.equal(bar.hidden, false);
  assert.equal(metric(bar, "total"), "—", "previous session totals must be cleared");
  assert.equal(metric(bar, "activity"), "— 轮 · — 步");
  assert.equal(metric(bar, "status"), "暂无统计");
  assert.match(summary(env).getAttribute("aria-label"), /最近一轮统计/);
  assert.doesNotMatch(summary(env).getAttribute("aria-label"), /132k/);
});

test("remounts the bar after Codex rebuilds the composer DOM", async () => {
  const env = createEnvironment({ statsBySession: { "conversation-1": STATS } });
  await flushTimers(30);
  const bar = env.bar();
  assert.ok(bar);
  bar.remove();
  env.emitMutation([
    { type: "childList", target: env.scope, removedNodes: [bar], addedNodes: [] },
  ]);
  await flushTimers(200);
  const remounted = env.bar();
  assert.ok(remounted, "bar should be re-created after removal");
  assert.equal(remounted.parentElement, env.scope);
  assert.equal(remounted.hidden, false);
});

test("marks in-flight requests as running", async () => {
  const env = createEnvironment({
    statsBySession: { "conversation-1": { ...STATS, lastTurn: { ...LAST_TURN, status: "running", inFlight: 1 } } },
  });
  await flushTimers(30);
  const bar = env.bar();
  assert.equal(bar.hidden, false);
  assert.equal(bar.dataset.running, "true");
});

test("does not fetch in a hidden page and refreshes when visibility returns", async () => {
  const env = createEnvironment({ statsBySession: { "conversation-1": { ...STATS, inFlight: 1 } } });
  await flushTimers(30);
  const calls = env.calls.length;
  env.document.visibilityState = "hidden";
  env.refresh();
  await flushTimers(30);
  assert.equal(env.calls.length, calls);
  env.document.visibilityState = "visible";
  env.document.dispatchEvent({ type: "visibilitychange" });
  await flushTimers(30);
  assert.equal(env.calls.length, calls + 1);
});

test("shows the turn state independently of old request state", async () => {
  const env = createEnvironment();
  for (const [status, label] of [
    ["aborted", "本轮已中止"],
    ["running", "本轮进行中"],
    ["completed", "运行期统计"],
  ]) {
    env.setStats("conversation-1", { ...STATS, lastStatus: "failed", lastTurn: { ...LAST_TURN, status } });
    env.refresh();
    await flushTimers(30);
    assert.equal(metric(env.bar(), "status"), label);
    assert.ok(summary(env).getAttribute("aria-label").includes(label));
  }
});

test("ignores hidden composer anchors and stays empty without a session", async () => {
  const env = createEnvironment({ inputVisible: false });
  await flushTimers(30);
  assert.equal(env.snapshot().sessionId, "");
});

test("does not double-install on repeated injection", async () => {
  const env = createEnvironment({ statsBySession: { "conversation-1": STATS } });
  await flushTimers(30);
  // 同一上下文再次执行整个脚本：installed 标记应阻止重复挂载。
  env.rerun();
  await flushTimers(30);
  const count = env.scope.children.filter(
    (child) => child.id === "codey-conversation-stats",
  ).length;
  assert.equal(count, 1);
  assert.equal(env.snapshot().installed !== false, true);
});

test("keeps a waiting bar without a session and does not request stats", async () => {
  const env = createEnvironment({
    conversationId: "", pathname: "/c/previous-conversation",
    statsBySession: { "previous-conversation": STATS },
  });
  await flushTimers(30);
  assert.equal(env.bar().hidden, false);
  assert.equal(metric(env.bar(), "status"), "等待会话");
  assert.equal(metric(env.bar(), "total"), "—");
  assert.equal(env.calls.length, 0);
  click(summary(env));
  assertExpanded(env, true);
});

test("preserves reported zero tokens and zero cache hit rate", async () => {
  const env = createEnvironment({ statsBySession: { "conversation-1": {
    requests: 1, totalTokens: 0, inputTokens: 100, outputTokens: 0,
    cachedInputTokens: 0, cacheWriteInputTokens: 0, inFlight: 0,
  } } });
  await flushTimers(30);
  assert.equal(metric(env.bar(), "total"), "0 tok");
  assert.equal(field(env.bar(), "outputTokens"), "0 tok");
  assert.equal(metric(env.bar(), "cache-rate"), "0%");
  assert.equal(metric(env.bar(), "status"), "运行期统计");
});

for (const stats of [{}, { requests: 0 }]) {
  test(`treats ${JSON.stringify(stats)} as an empty session`, async () => {
    const env = createEnvironment({ statsBySession: { "conversation-1": stats } });
    await flushTimers(30);
    assert.equal(env.bar().hidden, false);
    assert.equal(metric(env.bar(), "status"), "暂无统计");
    assert.equal(metric(env.bar(), "total"), "—");
  });
}

test("pins each independent panel and switches between both groups", async () => {
  const env = createEnvironment({ statsBySession: { "conversation-1": STATS } });
  await flushTimers(30);
  assert.equal(summary(env).getAttribute("aria-controls"), panel(env).id);
  click(summary(env));
  assertExpanded(env, true);
  const tokens = env.bar().querySelector(".codey-cs-tokens-summary");
  click(tokens);
  assertExpanded(env, false);
  assert.equal(tokens.getAttribute("aria-expanded"), "true");
  click(tokens);
  assert.equal(tokens.getAttribute("aria-expanded"), "false");
});

test("centers the details immediately above the trigger and clamps the viewport", async () => {
  const env = createEnvironment({ statsBySession: { "conversation-1": STATS } });
  await flushTimers(30);
  summary(env).getBoundingClientRect = () => ({ left: 200, top: 700, width: 400, height: 28 });
  panel(env).getBoundingClientRect = () => ({ width: 420, height: 300 });
  env.textarea.getBoundingClientRect = () => ({ left: 100, top: 520, width: 600, height: 140 });
  click(summary(env));
  assert.equal(panel(env).style.left, "190px");
  assert.equal(panel(env).style.top, "392px");
  click(summary(env));
  summary(env).getBoundingClientRect = () => ({ left: 0, top: 700, width: 200, height: 28 });
  click(summary(env));
  assert.equal(panel(env).style.left, "12px");
});

test("unchanged rescans skip panel measurements while movement and content changes reposition it", async () => {
  const env = createEnvironment({ manualTimers: true, statsBySession: { "conversation-1": STATS } });
  try {
    env.runTimer(0);
    await flushTimers(0);
    let entry = { left: 200, top: 700, width: 400, height: 28 };
    let measurements = 0;
    summary(env).getBoundingClientRect = () => entry;
    panel(env).getBoundingClientRect = () => { measurements += 1; return { width: 420, height: 300 }; };
    click(summary(env));
    assert.equal(measurements, 1);
    for (let index = 0; index < 5; index += 1) {
      env.emitAnchorMutation();
      env.runTimer(120);
    }
    assert.equal(measurements, 1);
    entry = { ...entry, left: 300 };
    env.emitAnchorMutation();
    env.runTimer(120);
    assert.equal(measurements, 2);
    assert.equal(panel(env).style.left, "290px");

    env.setStats("conversation-1", { ...STATS, lastTurn: { ...LAST_TURN, stepCount: 3, toolDurationMs: 6000 } });
    env.refresh();
    env.runTimer(0);
    await flushTimers(0);
    assert.equal(measurements, 3);
    assert.equal(field(env.bar(), "toolDurationMs"), "6秒");
  } finally { env.dispose(); }
});

test("CodeGraph details changes remeasure an open panel", async () => {
  let codegraph = { projectPath: "E:/project", phase: "watching", message: "已接入" };
  const env = createEnvironment({ manualTimers: true, request: async () => ({ status: "ok", stats: STATS, codegraph }) });
  try {
    env.runTimer(0);
    await flushTimers(0);
    const refs = env.bar().__codeyCs;
    let measurements = 0;
    refs.panels.codegraph.getBoundingClientRect = () => { measurements += 1; return { width: 420, height: 300 }; };
    click(refs.buttons.codegraph);
    assert.equal(measurements, 1);
    codegraph = { ...codegraph, projectPath: "E:/another-project", message: "索引更新中" };
    env.refresh();
    env.runTimer(0);
    await flushTimers(0);
    assert.equal(measurements, 2);
    assert.equal(refs.projectPath.textContent, codegraph.projectPath);
    assert.equal(refs.notes.codegraph.textContent, codegraph.message);
  } finally { env.dispose(); }
});

test("formats token totals around the million boundary without displaying 1000k", async () => {
  const env = createEnvironment({ manualTimers: true });
  try {
    for (const [totalTokens, label] of [[999_499, "999k"], [999_500, "1.0M"], [999_999, "1.0M"], [1_000_000, "1.0M"]]) {
      env.setStats("conversation-1", { ...STATS, totalTokens });
      env.refresh();
      env.runTimer(0);
      await flushTimers(0);
      assert.equal(metric(env.bar(), "total"), `${label} tok`);
    }
  } finally { env.dispose(); }
});

test("Escape restores focus only when focus was inside the stats bar", async () => {
  const env = createEnvironment();
  await flushTimers(30);
  for (const inside of [true, false]) {
    click(summary(env));
    const target = inside ? summary(env) : env.textarea;
    target.focus();
    let prevented = false;
    let stopped = false;
    env.document.dispatchEvent({
      type: "keydown", key: "Escape",
      preventDefault: () => { prevented = true; },
      stopPropagation: () => { stopped = true; },
    });
    assertExpanded(env, false);
    assert.equal(env.document.activeElement, inside ? summary(env) : env.textarea);
    assert.equal(prevented, inside);
    assert.equal(stopped, inside);
  }
});

test("pointerdown inside details keeps them open, outside closes them", async () => {
  const env = createEnvironment();
  await flushTimers(30);
  click(summary(env));
  assert.equal(panel(env).parentElement.parentElement, env.document.body);
  assert.equal(env.bar().contains(panel(env)), false, "details must escape the clipping composer");
  env.document.dispatchEvent({ type: "pointerdown", target: panel(env).querySelector("dd") });
  assertExpanded(env, true);
  env.textarea.focus();
  env.document.dispatchEvent({ type: "pointerdown", target: env.textarea });
  assertExpanded(env, false);
  assert.equal(env.document.activeElement, env.textarea);
});

test("Escape from the independent panel restores its trigger focus", async () => {
  const env = createEnvironment();
  await flushTimers(30);
  click(summary(env));
  panel(env).focus();
  env.document.dispatchEvent({ type: "keydown", key: "Escape", preventDefault() {}, stopPropagation() {} });
  assertExpanded(env, false);
  assert.equal(env.document.activeElement, summary(env));
});

test("native popovers switch and close together with their triggers", async () => {
  const env = createEnvironment({ popover: true });
  await flushTimers(30);
  click(summary(env));
  assert.equal(panel(env).popoverOpen, true);
  assert.equal(summary(env).getAttribute("aria-expanded"), null);
  assert.equal(summary(env).getAttribute("data-codey-expanded"), "true");
  assert.equal(summary(env).popoverTargetElement, panel(env));
  const tokens = env.bar().__codeyCs.panels.tokens;
  click(env.bar().__codeyCs.buttons.tokens);
  assert.equal(panel(env).popoverOpen, false);
  assert.equal(tokens.popoverOpen, true);
  env.document.dispatchEvent({ type: "pointerdown", target: env.textarea });
  assert.equal(tokens.popoverOpen, false);
});

test("reuses one detached bar and overlay and closes panels on remount", async () => {
  const env = createEnvironment({ statsBySession: { "conversation-1": STATS } });
  await flushTimers(30);
  const originalBar = env.bar();
  const overlay = panel(env).parentElement;
  click(summary(env));
  originalBar.remove();
  env.emitMutation([{ type: "childList", target: env.scope, removedNodes: [originalBar] }]);
  await flushTimers(160);
  assert.equal(env.bar(), originalBar);
  assert.equal(panel(env).parentElement, overlay);
  assert.equal(env.document.querySelectorAll("#codey-conversation-stats-overlay").length, 1);
  assertExpanded(env, false);
  overlay.remove();
  env.emitMutation([{ type: "childList", target: env.document.body, removedNodes: [overlay] }]);
  await flushTimers(160);
  assert.equal(overlay.parentElement, env.document.body);
  assert.equal(metric(env.bar(), "total"), "132k tok");
});

test("dispose removes portal, listeners and pending response without resurrecting UI", async () => {
  let resolve;
  const env = createEnvironment({ request: () => new Promise(done => { resolve = done; }) });
  await flushTimers(30);
  env.dispose();
  assert.equal(env.bar(), null);
  assert.equal(env.document.getElementById("codey-conversation-stats-overlay"), null);
  assert.equal(env.document.getElementById("codey-conversation-stats-styles"), null);
  assert.ok([...env.document.listeners.values(), ...env.window.listeners.values()].every(list => list.length === 0));
  resolve({ status: "ok", stats: STATS });
  await flushTimers(30);
  assert.equal(env.bar(), null);
  assert.equal(env.calls.length, 1);
});

test("version replacement disposes previous ownership before installing one new portal", async () => {
  const env = createEnvironment();
  await flushTimers(30);
  const originalBar = env.bar();
  env.markPreviousVersion();
  env.rerun();
  await flushTimers(30);
  assert.notEqual(env.bar(), originalBar);
  assert.equal(env.document.querySelectorAll("#codey-conversation-stats-overlay").length, 1);
  assert.equal(env.document.listeners.get("pointerdown").length, 1);
  click(summary(env));
  assertExpanded(env, true);
});

test("hiding the composer closes its open details", async () => {
  const env = createEnvironment();
  await flushTimers(30);
  click(summary(env));
  env.textarea.visible = false;
  env.textarea.setAttribute("hidden", "");
  env.emitMutation([{ type: "attributes", target: env.textarea, attributeName: "hidden" }]);
  await flushTimers(160);
  assert.equal(env.bar().hidden, true);
  assertExpanded(env, false);
});

test("keeps current totals on failed refresh and recovers after retry", async () => {
  let response = { status: "ok", stats: STATS };
  const env = createEnvironment({ request: () => {
    if (response instanceof Error) throw response;
    return response;
  } });
  await flushTimers(30);
  for (const failure of [{ status: "failed" }, new Error("offline")]) {
    response = failure;
    env.refresh();
    await flushTimers(30);
    assert.equal(metric(env.bar(), "total"), "132k tok");
    assert.equal(metric(env.bar(), "status"), "统计暂不可用");
    assert.equal(env.bar().hidden, false);
  }
  response = { status: "ok", stats: { ...STATS, totalTokens: 200 } };
  env.refresh();
  await flushTimers(30);
  assert.equal(metric(env.bar(), "total"), "200 tok");
  assert.equal(metric(env.bar(), "status"), "运行期统计");
});

test("discards the original A response after switching A to B to A", async () => {
  const pending = [];
  const env = createEnvironment({ request: (sessionId) => new Promise((resolve) => {
    pending.push({ sessionId, resolve });
  }) });
  await flushTimers(30);
  assert.equal(pending[0].sessionId, "conversation-1");
  click(summary(env));
  env.setConversation("conversation-2");
  env.emitAnchorMutation();
  await flushTimers(160);
  assertExpanded(env, false);
  env.setConversation("conversation-1");
  env.emitAnchorMutation();
  await flushTimers(160);
  pending[0].resolve({ status: "ok", stats: STATS });
  await flushTimers(30);
  assert.equal(metric(env.bar(), "total"), "—", "old A request must not repopulate A after a round trip");
  assert.equal(pending.length, 2, "current A must fetch again immediately after the stale request settles");
  assert.equal(pending[1].sessionId, "conversation-1");
  pending[1].resolve({ status: "ok", stats: { ...STATS, totalTokens: 700 } });
  await flushTimers(30);
  assert.equal(metric(env.bar(), "total"), "700 tok");
});

test("restores historical totals without inventing historical request information", async () => {
  const history = { ...STATS, usageSource: "rollout", usageScope: "session", requestsScope: null, requests: null, inFlight: null, cacheWriteInputTokens: null };
  const env = createEnvironment({ statsBySession: { "conversation-1": history } });
  await flushTimers(30);
  assert.equal(metric(env.bar(), "total"), "132k tok");
  assert.equal(metric(env.bar(), "status"), "历史统计");
  assert.match(env.bar().querySelector(".codey-cs-tokens-summary").getAttribute("aria-label"), /会话累计 132k/);
  assert.equal(env.bar().dataset.running, "false");
});

test("historical tokens and current runtime request details keep separate scopes", async () => {
  const env = createEnvironment({ statsBySession: { "conversation-1": { ...STATS, usageSource: "rollout", usageScope: "session" } } });
  await flushTimers(30);
  assert.equal(field(env.bar(), "totalTokens"), "131,500 tok");
  assert.equal(metric(env.bar(), "speed"), "188 tok/s");
  env.setStats("conversation-1", { ...STATS, usageSource: "rollout", usageScope: "session", lastTurn: { ...LAST_TURN, averageOutputTokensPerSecond: null } });
  env.refresh();
  await flushTimers(30);
  assert.equal(metric(env.bar(), "speed"), "—");
});

test("session totals own the turn count while the last turn owns speed, steps and timing", async () => {
  const env = createEnvironment({ statsBySession: { "conversation-1": {
    ...STATS, turnCount: 99, stepCount: 500, modelDurationMs: 900000,
    toolDurationMs: 800000, averageTtftMs: 9999, averageOutputTokensPerSecond: 999,
    outputTokensPerSecond: 777,
    lastTurn: { ...LAST_TURN, stepCount: 3, averageOutputTokensPerSecond: 20 },
  } } });
  await flushTimers(30);
  assert.equal(metric(env.bar(), "activity"), "99 轮 · 3 步");
  assert.equal(field(env.bar(), "modelDurationMs"), "10秒");
  assert.equal(field(env.bar(), "toolDurationMs"), "3秒");
  assert.equal(field(env.bar(), "averageTtftMs"), "0.5秒");
  assert.equal(metric(env.bar(), "speed"), "20.0 tok/s");
  assert.equal(metric(env.bar(), "total"), "132k tok");
  assert.equal(field(env.bar(), "outputTokens"), "3,100 tok");
  assert.equal(panel(env).querySelectorAll("dt").at(-1).textContent, "平均速度（TPS）");
  assert.match(env.bar().__codeyCs.notes.activity.textContent, /本轮总输出 Token ÷ 本轮生成耗时，工具间隔不计/);
});

test("uses only the reported session turn count and preserves zero independently of last turn availability", async () => {
  const env = createEnvironment();
  try {
    for (const turnCount of [undefined, null, NaN, Infinity, -1, 1.5, "4", 0, 4]) {
      env.setStats("conversation-1", { ...STATS, turnCount, requests: 900,
        lastTurn: { ...LAST_TURN, id: "turn-50" } });
      env.refresh();
      await flushTimers(30);
      const expected = turnCount === 0 || turnCount === 4 ? String(turnCount) : "—";
      assert.equal(metric(env.bar(), "activity"), `${expected} 轮 · 2 步`);
      assert.equal(metric(env.bar(), "speed"), "188 tok/s");
    }
    env.setStats("conversation-1", { turnCount: 0 });
    env.refresh();
    await flushTimers(30);
    assert.equal(metric(env.bar(), "activity"), "0 轮 · — 步");
    assert.equal(metric(env.bar(), "speed"), "—");
    assert.notEqual(env.bar().dataset.codeyState, "empty");
  } finally {
    env.dispose();
  }
});

test("does not reuse session or request statistics without an identified turn", async () => {
  const env = createEnvironment();
  for (const lastTurn of [undefined, null, {}, { ...LAST_TURN, id: "" }, { ...LAST_TURN, id: " " }]) {
    env.setStats("conversation-1", { ...STATS, lastTurn, modelDurationMs: 500, toolDurationMs: 10, stepCount: 9 });
    env.refresh();
    await flushTimers(30);
    assert.equal(metric(env.bar(), "activity"), "4 轮 · — 步");
    for (const name of ["modelDurationMs", "toolDurationMs", "averageTtftMs", "speed"]) assert.equal(field(env.bar(), name), "—");
    assert.match(env.bar().__codeyCs.notes.activity.textContent, /暂无可识别的最近一轮/);
  }
});

test("keeps the same turn average through multiple steps and tool intervals without recreating panels", async () => {
  const env = createEnvironment({ statsBySession: { "conversation-1": STATS } });
  await flushTimers(30);
  click(summary(env));
  const originalPanel = panel(env);
  for (const inFlight of [1, 0, 1]) {
    env.setStats("conversation-1", { ...STATS, outputTokensPerSecond: null,
      lastTurn: { ...LAST_TURN, status: "running", stepCount: 3, inFlight, speedState: "waiting" } });
    env.refresh();
    await flushTimers(30);
    assert.equal(metric(env.bar(), "speed"), "188 tok/s");
    assert.equal(field(env.bar(), "speed"), "188 tok/s");
    assert.equal(env.bar().dataset.running, "true");
    assert.equal(panel(env), originalPanel);
    assertExpanded(env, true);
  }
});

test("a new user turn clears all prior turn values without clearing session tokens", async () => {
  const env = createEnvironment({ statsBySession: { "conversation-1": STATS } });
  await flushTimers(30);
  click(summary(env));
  env.setStats("conversation-1", { ...STATS, turnCount: 5, lastTurn: { id: "turn-2", status: "running", stepCount: 0,
    averageOutputTokensPerSecond: null, speedState: "waiting", coverage: "runtime" } });
  env.refresh();
  await flushTimers(30);
  assert.equal(metric(env.bar(), "speed"), "等待输出");
  assert.equal(metric(env.bar(), "activity"), "5 轮 · 0 步");
  for (const name of ["modelDurationMs", "toolDurationMs", "averageTtftMs"]) assert.equal(field(env.bar(), name), "—");
  assert.equal(metric(env.bar(), "total"), "132k tok");
  assertExpanded(env, true);
});

test("distinguishes waiting, streaming, estimated average and completed average for one turn", async () => {
  const env = createEnvironment();
  for (const [changes, expected] of [
    [{ status: "running", speedState: "waiting", averageOutputTokensPerSecond: null }, "等待输出"],
    [{ status: "running", speedState: "streaming", averageOutputTokensPerSecond: null }, "生成中"],
    [{ status: "running", speedIsEstimate: true, averageOutputTokensPerSecond: 62.35 }, "≈62.4 tok/s"],
    [{ status: "running", speedIsEstimate: false, averageOutputTokensPerSecond: 65 }, "65.0 tok/s"],
    [{ status: "completed", averageOutputTokensPerSecond: 71.2 }, "71.2 tok/s"],
    [{ status: "completed", averageOutputTokensPerSecond: null }, "—"],
  ]) {
    env.setStats("conversation-1", { ...STATS, lastTurn: { ...LAST_TURN, ...changes } });
    env.refresh();
    await flushTimers(30);
    assert.equal(metric(env.bar(), "speed"), expected);
    assert.equal(field(env.bar(), "speed"), expected);
    assert.match(summary(env).getAttribute("aria-label"), /本轮平均速度/);
    assert.equal(env.bar().__codeyCs.notes.activity.textContent.includes("含生成中的 Token 估算"), changes.speedIsEstimate === true);
  }
});

test("uses the backend weighted turn average and preserves valid zero values", async () => {
  // 两步各输出 100 token，用时 1 秒和 9 秒，轮平均为 20。
  const env = createEnvironment();
  for (const averageOutputTokensPerSecond of [200 / 10, 0]) {
    env.setStats("conversation-1", { ...STATS, lastTurn: { ...LAST_TURN,
      averageOutputTokensPerSecond, stepCount: 0, modelDurationMs: 0, toolDurationMs: 0, averageTtftMs: 0 } });
    env.refresh();
    await flushTimers(30);
    assert.equal(metric(env.bar(), "speed"), `${averageOutputTokensPerSecond.toFixed(1)} tok/s`);
    assert.equal(metric(env.bar(), "activity"), "4 轮 · 0 步");
    for (const name of ["modelDurationMs", "toolDurationMs", "averageTtftMs"]) assert.equal(field(env.bar(), name), "0秒");
  }
});

test("rejects invalid last turn values and keeps absent values unknown", async () => {
  const env = createEnvironment();
  for (const value of [undefined, null, NaN, Infinity, -5]) {
    env.setStats("conversation-1", { ...STATS, lastTurn: { ...LAST_TURN,
      averageOutputTokensPerSecond: value, stepCount: value, modelDurationMs: value, toolDurationMs: value, averageTtftMs: value } });
    env.refresh();
    await flushTimers(30);
    assert.equal(metric(env.bar(), "activity"), "4 轮 · — 步");
    for (const name of ["speed", "modelDurationMs", "toolDurationMs", "averageTtftMs"]) assert.equal(field(env.bar(), name), "—");
  }
});

test("explains limited coverage of historical and partial turn records", async () => {
  const env = createEnvironment();
  for (const [coverage, note] of [
    ["recorded", "仅覆盖本轮可恢复且有有效计时的记录"],
    ["recorded_and_runtime", "合并本轮可恢复记录与本次运行统计，缺失记录不计入"],
    ["partial", "本轮记录不完整，仅统计可恢复的部分"],
    ["runtime", "仅覆盖本轮在本次运行中可统计的步骤"],
    ["unknown", "本轮统计范围未知"],
  ]) {
    env.setStats("conversation-1", { ...STATS, requestsScope: null, requests: null,
      lastTurn: { ...LAST_TURN, coverage } });
    env.refresh();
    await flushTimers(30);
    assert.equal(metric(env.bar(), "speed"), "188 tok/s");
    assert.ok(env.bar().__codeyCs.notes.activity.textContent.includes(note));
  }
});

test("hides a frozen live turn speed after failure and resumes without changing its panel", async () => {
  const live = { ...STATS, lastTurn: { ...LAST_TURN, status: "running", speedIsEstimate: true } };
  let response = { status: "ok", stats: live };
  const env = createEnvironment({ request: () => response });
  await flushTimers(30);
  click(summary(env));
  const originalPanel = panel(env);
  assert.equal(metric(env.bar(), "speed"), "≈188 tok/s");
  response = { status: "failed" };
  env.refresh();
  await flushTimers(30);
  assert.equal(metric(env.bar(), "speed"), "更新暂停");
  assert.equal(field(env.bar(), "speed"), "更新暂停");
  assert.equal(metric(env.bar(), "total"), "132k tok");
  response = { status: "ok", stats: { ...live, lastTurn: { ...live.lastTurn, averageOutputTokensPerSecond: 54 } } };
  env.refresh();
  await flushTimers(30);
  assert.equal(metric(env.bar(), "speed"), "≈54.0 tok/s");
  assert.equal(panel(env), originalPanel);
  assertExpanded(env, true);
});

test("clears live turn speed and waiting state on conversation changes", async () => {
  const env = createEnvironment({ statsBySession: { "conversation-1": {
    ...STATS, lastTurn: { ...LAST_TURN, status: "running", speedIsEstimate: true },
  } } });
  await flushTimers(30);
  assert.equal(metric(env.bar(), "speed"), "≈188 tok/s");
  env.setConversation("conversation-2");
  env.emitAnchorMutation();
  await flushTimers(160);
  assert.equal(metric(env.bar(), "speed"), "—");
  assert.equal(env.bar().dataset.running, "false");
});

test("partial historical usage keeps absent values unknown and preserves explicit zero", async () => {
  const env = createEnvironment({ statsBySession: { "conversation-1": {
    usageSource: "rollout", usageScope: "session", requestsScope: null,
    totalTokens: null, inputTokens: 0, outputTokens: null, cachedInputTokens: null,
  } } });
  await flushTimers(30);
  assert.equal(field(env.bar(), "outputTokens"), "—");
  for (const name of ["total", "cache-rate", "speed"]) assert.equal(metric(env.bar(), name), "—");
  assert.equal(metric(env.bar(), "status"), "历史统计");
});

test("normalizes local conversation IDs before reading historical stats", async () => {
  const env = createEnvironment({ conversationId: " local:conversation-1 ", statsBySession: { "conversation-1": STATS } });
  await flushTimers(30);
  assert.equal(env.calls[0].payload.sessionId, "conversation-1");
  assert.equal(metric(env.bar(), "total"), "132k tok");
});

test("preserves the same session values while refreshing and marks failed values stale", async () => {
  let resolveRefresh;
  let first = true;
  const env = createEnvironment({ request: () => {
    if (first) { first = false; return { status: "ok", stats: STATS }; }
    return new Promise((resolve) => { resolveRefresh = resolve; });
  } });
  await flushTimers(30);
  env.refresh();
  await flushTimers(30);
  assert.equal(metric(env.bar(), "total"), "132k tok");
  assert.equal(metric(env.bar(), "status"), "更新统计中");
  resolveRefresh({ status: "failed" });
  await flushTimers(30);
  assert.equal(metric(env.bar(), "total"), "132k tok");
  assert.match(env.bar().__codeyCs.notes.activity.textContent, /可能已过期/);
});

test("shows reference activity rows and computes uncached input without double counting", async () => {
  const env = createEnvironment({ statsBySession: { "conversation-1": { ...STATS,
    lastTurn: { ...LAST_TURN, stepCount: 209, modelDurationMs: 1286000, toolDurationMs: 573000,
      averageTtftMs: 2800, coverage: "recorded" },
  } } });
  await flushTimers(30);
  assert.equal(metric(env.bar(), "activity"), "4 轮 · 209 步");
  assert.equal(field(env.bar(), "modelDurationMs"), "21分 26秒");
  assert.equal(field(env.bar(), "toolDurationMs"), "9分 33秒");
  assert.equal(field(env.bar(), "averageTtftMs"), "2.8秒");
  assert.equal(field(env.bar(), "uncachedInputTokens"), "8,400 tok");
  assert.equal(env.bar().querySelectorAll(".codey-cs-summary").filter(button => !button.hidden).length, 2);
});

test("renders merged timing of one turn without accumulating again or restoring another session response", async () => {
  // 后端已合并本轮历史与运行期计时，UI 只负责展示。
  const merged = { ...STATS, usageSource: "rollout", usageScope: "session",
    lastTurn: { ...LAST_TURN, modelDurationMs: 120500, averageTtftMs: 750,
      averageOutputTokensPerSecond: 42, coverage: "recorded_and_runtime" },
  };
  const runtime = { ...STATS, lastTurn: { ...LAST_TURN, id: "another-turn", modelDurationMs: 500, averageTtftMs: 200,
    coverage: "runtime" } };
  let pendingRefresh;
  let deferNext = false;
  const env = createEnvironment({ request: sessionId => {
    if (deferNext) {
      deferNext = false;
      return new Promise(resolve => { pendingRefresh = resolve; });
    }
    return { status: "ok", stats: sessionId === "conversation-1" ? merged : runtime };
  } });
  const assertMerged = () => {
    assert.equal(field(env.bar(), "modelDurationMs"), "2分 0秒");
    assert.equal(field(env.bar(), "averageTtftMs"), "0.8秒");
    assert.equal(field(env.bar(), "speed"), "42.0 tok/s");
    assert.equal(metric(env.bar(), "speed"), "42.0 tok/s");
    assert.match(env.bar().__codeyCs.notes.activity.textContent, /合并本轮可恢复记录与本次运行统计/);
    assert.doesNotMatch(env.bar().__codeyCs.notes.activity.textContent, /仅覆盖本轮在本次运行中/);
  };
  try {
    await flushTimers(30);
    click(summary(env));
    assertMerged();
    env.refresh();
    await flushTimers(30);
    assertMerged();
    assertExpanded(env, true);

    env.setConversation("conversation-2");
    env.emitAnchorMutation();
    await flushTimers(160);
    assert.equal(field(env.bar(), "modelDurationMs"), "0.5秒");
    assert.match(env.bar().__codeyCs.notes.activity.textContent, /仅覆盖本轮在本次运行中/);

    deferNext = true;
    env.refresh();
    await flushTimers(30);
    env.setConversation("conversation-1");
    env.emitAnchorMutation();
    await flushTimers(160);
    assert.equal(field(env.bar(), "modelDurationMs"), "—");
    pendingRefresh({ status: "ok", stats: runtime });
    await flushTimers(30);
    assertMerged();
    assert.equal(env.calls.at(-1).payload.sessionId, "conversation-1");
  } finally {
    env.dispose();
  }
});

test("preview remains open during pointer travel and click pins it", async () => {
  const env = createEnvironment();
  await flushTimers(30);
  summary(env).dispatchEvent({ type: "pointerenter" });
  assertExpanded(env, true);
  summary(env).dispatchEvent({ type: "pointerleave" });
  panel(env).dispatchEvent({ type: "pointerenter" });
  await flushTimers(380);
  assertExpanded(env, true);
  panel(env).dispatchEvent({ type: "pointerleave" });
  await flushTimers(380);
  assertExpanded(env, false);
  summary(env).dispatchEvent({ type: "focus" });
  click(summary(env));
  summary(env).dispatchEvent({ type: "pointerleave" });
  await flushTimers(380);
  assertExpanded(env, true);
});

test("does not fabricate missing activity or subtract inconsistent cache", async () => {
  const env = createEnvironment({ statsBySession: { "conversation-1": { ...STATS,
    lastTurn: { ...LAST_TURN, stepCount: null, toolDurationMs: 0, modelDurationMs: -1,
      averageTtftMs: null }, cachedInputTokens: 999999,
  } } });
  await flushTimers(30);
  assert.equal(metric(env.bar(), "activity"), "4 轮 · — 步");
  assert.equal(field(env.bar(), "toolDurationMs"), "0秒");
  for (const key of ["modelDurationMs", "averageTtftMs", "uncachedInputTokens", "cacheRate"]) assert.equal(field(env.bar(), key), "—");
});

test("explains turn boundaries and accumulated tool timing", async () => {
  const env = createEnvironment({ statsBySession: { "conversation-1": { ...STATS,
    lastTurn: { ...LAST_TURN, coverage: "recorded" },
  } } });
  await flushTimers(30);
  const note = env.bar().__codeyCs.notes.activity.textContent;
  assert.match(note, /一次提问为一轮，步数为该轮模型生成次数/);
  assert.match(note, /有有效计时的记录/);
  assert.match(note, /工具用时为本轮累计值，并行调用可能重叠/);
});

test("shows only the current project's CodeGraph phase and clears it when no project is associated", async () => {
  const project = { projectPath: "E:/projects/current", phase: "watching", message: "项目索引已接入，代码变化会自动同步。" };
  let response = { status: "ok", stats: STATS, codegraph: project };
  const env = createEnvironment({ request: () => response });
  try {
    await flushTimers(30);
    const refs = env.bar().__codeyCs;
    for (const [phase, label] of [["watching", "已接入"], ["indexing", "索引中"], ["failed", "索引失败"],
      ["waiting", "待索引"], ["disabled", "未启用"], ["uninstalled", "待安装"], ["external", "MCP 管理"]]) {
      response = { status: "ok", codegraph: { ...project, phase } };
      env.refresh();
      await flushTimers(30);
      assert.equal(refs.buttons.codegraph.hidden, false);
      assert.equal(refs.codegraph.textContent, `CodeGraph ${label}`);
      assert.equal(refs.projectPath.textContent, project.projectPath);
    }
    click(refs.buttons.codegraph);
    assert.equal(refs.panels.codegraph.hidden, false);
    response = { status: "ok", codegraph: null };
    env.refresh();
    await flushTimers(30);
    assert.equal(refs.buttons.codegraph.hidden, true);
    assert.equal(refs.panels.codegraph.hidden, true);
    assert.equal(refs.projectPath.textContent, "");
    assert.equal(refs.notes.codegraph.textContent, "");
  } finally { env.dispose(); }
});

test("CodeGraph read and transport failures never keep claiming that indexing is active", async () => {
  const project = { projectPath: "E:/projects/current", phase: "watching", message: "已接入" };
  let response = { status: "ok", stats: STATS, codegraph: project };
  const env = createEnvironment({ request: () => { if (response instanceof Error) throw response; return response; } });
  try {
    await flushTimers(30);
    const refs = env.bar().__codeyCs;
    for (const failure of [{ status: "ok", stats: STATS, codegraph: { phase: "unavailable" } }, { status: "failed" }, new Error("offline")]) {
      response = failure;
      env.refresh();
      await flushTimers(30);
      assert.equal(refs.codegraph.textContent, "CodeGraph 状态未知");
      assert.match(refs.notes.codegraph.textContent, /自动重试/);
      assert.equal(metric(env.bar(), "total"), "132k tok");
    }
    response = { status: "ok", stats: STATS, codegraph: project };
    env.refresh();
    await flushTimers(30);
    assert.equal(refs.codegraph.textContent, "CodeGraph 已接入");
  } finally { env.dispose(); }
});

test("CodeGraph drops late responses across conversation switches and never falls back to the previous folder", async () => {
  const pending = [];
  let defer = false;
  const project = { projectPath: "E:/projects/first", phase: "watching", message: "已接入" };
  const env = createEnvironment({ request: sessionId => defer
    ? new Promise(resolve => pending.push({ sessionId, resolve }))
    : { status: "ok", codegraph: project } });
  try {
    await flushTimers(30);
    const refs = env.bar().__codeyCs;
    click(refs.buttons.codegraph);
    defer = true;
    env.refresh();
    await flushTimers(30);
    env.setConversation("conversation-2");
    env.emitAnchorMutation();
    await flushTimers(160);
    assert.equal(refs.buttons.codegraph.hidden, true);
    assert.equal(refs.panels.codegraph.hidden, true);
    assert.equal(refs.projectPath.textContent, "");
    pending[0].resolve({ status: "ok", codegraph: project });
    await flushTimers(30);
    assert.equal(refs.buttons.codegraph.hidden, true);
    assert.equal(pending[1].sessionId, "conversation-2");
    pending[1].resolve({ status: "ok", codegraph: { ...project, projectPath: "E:/projects/second", phase: "indexing" } });
    await flushTimers(30);
    assert.equal(refs.projectPath.textContent, "E:/projects/second");
    assert.equal(refs.codegraph.textContent, "CodeGraph 索引中");
    env.setConversation("");
    env.emitAnchorMutation();
    await flushTimers(160);
    assert.equal(refs.buttons.codegraph.hidden, true);
    assert.equal(refs.projectPath.textContent, "");
    assert.equal(env.calls.length, 3);
  } finally { env.dispose(); }
});

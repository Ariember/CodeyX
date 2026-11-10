import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

import { FakeElementCore } from "./helpers/fake-element.mjs";

const source = readFileSync(new URL("../public/renderer-inject.js", import.meta.url), "utf8");
const bridgeSource = readFileSync(new URL("../public/codey-bridge.js", import.meta.url), "utf8");
const nativeRuntimeSource = readFileSync(new URL("../public/codex-runtime-adapter.js", import.meta.url), "utf8");

const runRenderer = (sandbox, { nativeRuntime = false } = {}) => {
  const context = vm.createContext(sandbox);
  vm.runInContext(bridgeSource, context);
  if (nativeRuntime) vm.runInContext(nativeRuntimeSource, context);
  vm.runInContext(source, context);
};

// Boots the renderer with a controllable scan timer. When subscribers are
// requested, the bridge's dispatcher is replaced so a test can drive the
// bootstrap handler directly, the way a real MutationObserver would.
const createRendererSandbox = ({ documentElement, header, rail = null }) => {
  const timers = new Map();
  let timerSequence = 0;
  const document = {
    body: new FakeElement("body"),
    documentElement,
    createElement: (tag) => new FakeElement(tag),
    getElementById: (id) => documentElement.querySelector(`#${id}`),
    // document.querySelector only ever returns elements that are still in the
    // document tree, so a detached rail must not satisfy the lookup.
    querySelector: (selector) =>
      rail && rail.isConnected === true && String(selector).includes("data-app-navigation-rail")
        ? rail
        : null,
    querySelectorAll: (selector) => selector === "header" ? [header] : [],
  };
  const window = {
    addEventListener() {},
    clearTimeout: (id) => timers.delete(id),
    dispatchEvent() {},
    getComputedStyle: () => ({ display: "flex", visibility: "visible" }),
    localStorage: { getItem: () => null, key: () => null, length: 0, setItem() {} },
    setTimeout: (handler) => {
      timerSequence += 1;
      timers.set(timerSequence, handler);
      return timerSequence;
    },
  };
  window.window = window;
  return { document, timers, window };
};

const runRendererInShell = ({ document, subscribers = null, timers, window }) => {
  const context = vm.createContext({
    console, document, HTMLElement: FakeElement, location: { pathname: "/", search: "" },
    MutationObserver: class { disconnect() {} observe() {} }, URLSearchParams, window,
  });
  vm.runInContext(bridgeSource, context);
  if (subscribers) {
    window.__codeyMutationDispatcher = {
      snapshot: () => ({ observerInstalled: true }),
      subscribe: (handler, options) => {
        subscribers.push({ handler, options });
        return () => {};
      },
    };
  }
  vm.runInContext(source, context);
  timers.clear();
};

class FakeElement extends FakeElementCore {
  get firstElementChild() { return this.children[0] || null; }
  constructor(tagName = "div", { visible = true, right = 100, width = right, height = 46, top = 0 } = {}) {
    super(tagName);
    this.right = right;
    this.width = width;
    this.height = height;
    this.top = top;
    this.visible = visible;
    this.rectReads = 0;
  }

  insertBefore(child, before) {
    child.remove();
    const index = this.children.indexOf(before);
    assert.notEqual(index, -1);
    child.parentElement = this;
    child.isConnected = true;
    this.children.splice(index, 0, child);
    return child;
  }

  getBoundingClientRect() {
    this.rectReads += 1;
    return this.visible
      ? {
          bottom: this.top + this.height,
          height: this.height,
          left: this.right - this.width,
          right: this.right,
          top: this.top,
          width: this.width,
        }
      : { bottom: 0, height: 0, left: 0, right: 0, top: 0, width: 0 };
  }

  getClientRects() {
    return this.visible ? [this.getBoundingClientRect()] : [];
  }

}

const accountUsageParts = (usage) => ({
  summary: usage.children.find((child) => child.className === "codey-usage-summary") || null,
  details: usage.children.find((child) => child.id === "codey-account-usage-details") || null,
  announcer: usage.children.find((child) => child.className === "codey-usage-announcer") || null,
});

test("mounts above the native help entry in the navigation rail footer", () => {
  const header = new FakeElement("header", { right: 1200 });
  header.appendChild(new FakeElement("button", { right: 1192, width: 28 }));
  const rail = new FakeElement("nav", { right: 52, width: 52, height: 846, top: 44 });
  rail.setAttribute("data-app-navigation-rail", "true");
  const scroller = new FakeElement("div", { right: 46, width: 40, height: 750, top: 50 });
  const cluster = new FakeElement("div", { right: 44, width: 36, height: 80, top: 806 });
  const stack = new FakeElement("div", { right: 44, width: 36, height: 80, top: 806 });
  const helpSlot = new FakeElement("span", { right: 44, width: 36, height: 36, top: 806 });
  const help = new FakeElement("button", { right: 44, width: 36, height: 36, top: 806 });
  help.setAttribute("aria-label", "帮助菜单");
  const profileSlot = new FakeElement("span", { right: 44, width: 36, height: 36, top: 850 });
  const profile = new FakeElement("button", { right: 44, width: 36, height: 36, top: 850 });
  profile.setAttribute("aria-label", "打开个人资料菜单");
  helpSlot.appendChild(help);
  profileSlot.appendChild(profile);
  stack.append(helpSlot, profileSlot);
  cluster.appendChild(stack);
  rail.append(scroller, cluster);
  const documentElement = new FakeElement("html");
  documentElement.append(header, rail);
  const { document, timers, window } = createRendererSandbox({ documentElement, header, rail });
  runRendererInShell({ document, timers, window });

  const button = document.getElementById("codey-settings-button");
  assert.equal(button.parentElement, stack);
  assert.equal(button.dataset.codeyRailSlot, "true");
  assert.equal(button.hasAttribute("data-codey-native-slot"), false);
  assert.equal(stack.children[0], button, "the CodeyX entry sits above the help entry");
  assert.equal(button.nextElementSibling, helpSlot);
  assert.equal(document.getElementById("codey-settings-button-measure"), null);
  assert.equal(header.querySelector("#codey-settings-button"), null, "the header keeps only native actions");

  const reads = rail.rectReads;
  window.__codeyRendererScan();
  assert.equal(rail.rectReads, reads, "stable rail mounts skip geometry reads");

  // React can rebuild the footer stack while keeping the rail element alive.
  const replacement = new FakeElement("div", { right: 44, width: 36, height: 80, top: 806 });
  const replacementHelp = new FakeElement("button", { right: 44, width: 36, height: 36, top: 806 });
  replacementHelp.setAttribute("aria-label", "帮助菜单");
  replacement.appendChild(replacementHelp);
  stack.remove();
  cluster.appendChild(replacement);
  window.__codeyRendererInvalidateHeaderMount();
  window.__codeyRendererScan();
  assert.equal(document.getElementById("codey-settings-button").parentElement, replacement);
  assert.equal(replacement.children[0], document.getElementById("codey-settings-button"));

  // A rebuilding rail must not move the entry back into the header.
  rail.remove();
  window.__codeyRendererInvalidateHeaderMount();
  window.__codeyRendererScan();
  assert.equal(document.getElementById("codey-settings-button"), null);
  assert.equal(header.querySelector("#codey-settings-button"), null);
  documentElement.appendChild(rail);
  window.__codeyRendererScan();
  assert.equal(document.getElementById("codey-settings-button").parentElement, replacement);
});

const createProfileRailFixture = ({ label = "打开个人资料菜单", attach = true, profileVisible = true } = {}) => {
  const header = new FakeElement("header", { right: 1200 });
  header.appendChild(new FakeElement("button", { right: 1192, width: 28 }));
  const rail = new FakeElement("nav", { right: 52, width: 52, height: 846, top: 44 });
  rail.setAttribute("data-app-navigation-rail", "true");
  const cluster = new FakeElement("div", { right: 44, width: 36, height: 36, top: 850 });
  const stack = new FakeElement("div", { right: 44, width: 36, height: 36, top: 850 });
  const profileSlot = new FakeElement("span");
  const profile = new FakeElement("button", { visible: profileVisible });
  profile.setAttribute("aria-label", label);
  profileSlot.appendChild(profile);
  stack.appendChild(profileSlot);
  cluster.appendChild(stack);
  rail.appendChild(cluster);
  const documentElement = new FakeElement("html");
  documentElement.appendChild(header);
  if (attach) documentElement.appendChild(rail);
  const sandbox = createRendererSandbox({ documentElement, header, rail });
  runRendererInShell(sandbox);
  return { ...sandbox, documentElement, header, rail, stack, profile, profileSlot };
};

test("mounts above the profile menu when the navigation rail has no help entry", () => {
  for (const label of ["打开个人资料菜单", "Open profile menu"]) {
    const { document, header, stack, profileSlot, window } = createProfileRailFixture({ label });
    const button = document.getElementById("codey-settings-button");
    assert.ok(button);
    assert.equal(button.parentElement, stack);
    assert.equal(button.nextElementSibling, profileSlot);
    assert.equal(button.dataset.codeyRailSlot, "true");
    assert.equal(header.querySelector("#codey-settings-button"), null);
    window.__codeyRendererScan();
    assert.equal(document.getElementById("codey-settings-button"), button);
  }
});

test("moves a stable header entry into a navigation rail rendered later", () => {
  const { document, documentElement, header, rail, stack, window } = createProfileRailFixture({ attach: false });
  const button = document.getElementById("codey-settings-button");
  assert.equal(button.parentElement, header);
  documentElement.appendChild(rail);
  window.__codeyRendererScan();
  assert.equal(document.getElementById("codey-settings-button"), button);
  assert.equal(button.parentElement, stack);
  assert.equal(button.dataset.codeyRailSlot, "true");
});

test("waits for a visible footer entry instead of falling back to the header", () => {
  const { document, header, profile, stack, window } = createProfileRailFixture({ profileVisible: false });
  assert.equal(document.getElementById("codey-settings-button"), null);
  assert.equal(header.querySelector("#codey-settings-button"), null);
  profile.visible = true;
  window.__codeyRendererScan();
  assert.equal(document.getElementById("codey-settings-button").parentElement, stack);
});

test("keeps the rail entry while Codex marks the rail aria-hidden for a modal", () => {
  const { document, header, rail, stack, window } = createProfileRailFixture();
  const button = document.getElementById("codey-settings-button");
  assert.equal(button.parentElement, stack);
  // Codex 的模态对话框只给背景内容补 aria-hidden，图标栏布局不变，入口应保持挂载。
  rail.setAttribute("aria-hidden", "true");
  window.__codeyRendererScan();
  assert.equal(document.getElementById("codey-settings-button"), button);
  assert.equal(button.parentElement, stack);
  assert.equal(header.querySelector("#codey-settings-button"), null);
  // 模态期间 React 重建底部堆栈时，入口也能直接挂回新容器。
  const replacement = new FakeElement("div", { right: 44, width: 36, height: 36, top: 850 });
  const replacementSlot = new FakeElement("span", { right: 44, width: 36, height: 36, top: 850 });
  const replacementProfile = new FakeElement("button", { right: 44, width: 36, height: 36, top: 850 });
  replacementProfile.setAttribute("aria-label", "打开个人资料菜单");
  replacementSlot.appendChild(replacementProfile);
  replacement.appendChild(replacementSlot);
  stack.remove();
  rail.children.at(-1).appendChild(replacement);
  window.__codeyRendererScan();
  const remounted = document.getElementById("codey-settings-button");
  assert.ok(remounted);
  assert.equal(remounted.parentElement, replacement);
  assert.equal(remounted.nextElementSibling, replacementSlot);
  rail.removeAttribute("aria-hidden");
  window.__codeyRendererScan();
  assert.equal(document.getElementById("codey-settings-button"), remounted);
  // 真实隐藏（hidden）的图标栏仍然不算可用挂载。
  rail.setAttribute("hidden", "");
  window.__codeyRendererScan();
  assert.equal(document.getElementById("codey-settings-button"), null);
  rail.removeAttribute("hidden");
  window.__codeyRendererScan();
  const restored = document.getElementById("codey-settings-button");
  assert.ok(restored);
  assert.equal(restored.parentElement, replacement);
});

test("joins the native measured action row and repairs its noninteractive mirror", () => {
  const header = new FakeElement("header", { right: 1200 });
  const slot = new FakeElement("div", { right: 1200, width: 70 });
  slot.setAttribute("data-test-id", "header-shell-slot");
  const hidden = new FakeElement();
  hidden.setAttribute("aria-hidden", "true");
  const visible = new FakeElement();
  const measureRow = new FakeElement();
  const actionRow = new FakeElement();
  hidden.appendChild(measureRow);
  visible.appendChild(actionRow);
  slot.append(hidden, visible);
  header.appendChild(slot);
  measureRow.appendChild(new FakeElement("button", { right: 1400, width: 28 }));
  actionRow.appendChild(new FakeElement("button", { right: 1192, width: 28 }));
  const documentElement = new FakeElement("html");
  documentElement.appendChild(header);
  const { document, timers, window } = createRendererSandbox({ documentElement, header });
  runRendererInShell({ document, timers, window });
  const button = document.getElementById("codey-settings-button");
  const mirror = document.getElementById("codey-settings-button-measure");
  assert.equal(button.parentElement, actionRow);
  assert.equal(button.dataset.codeyNativeSlot, "true");
  assert.equal(actionRow.children.at(-1), button, "the CodeyX button owns the trailing slot");
  assert.equal(mirror.parentElement, measureRow);
  assert.equal(mirror.tagName, "SPAN");
  assert.equal(mirror.getAttribute("aria-hidden"), "true");
  const reads = header.rectReads;
  window.__codeyRendererScan();
  assert.equal(header.rectReads, reads, "stable mounts skip geometry reads");
  // A native action rendered after the CodeyX button must not push it left.
  actionRow.appendChild(new FakeElement("button", { right: 1192, width: 28 }));
  window.__codeyRendererScan();
  assert.equal(actionRow.children.at(-1), button);
  mirror.remove();
  window.__codeyRendererScan();
  assert.equal(document.getElementById("codey-settings-button-measure").parentElement, measureRow);
  // React can replace its visible action row while retaining the outer shell.
  const replacement = new FakeElement();
  replacement.appendChild(new FakeElement("button", { right: 1192, width: 28 }));
  actionRow.remove();
  visible.appendChild(replacement);
  window.__codeyRendererInvalidateHeaderMount();
  window.__codeyRendererScan();
  assert.equal(document.getElementById("codey-settings-button").parentElement, replacement);
  hidden.remove();
  visible.remove();
  slot.appendChild(replacement);
  window.__codeyRendererInvalidateHeaderMount();
  window.__codeyRendererScan();
  assert.equal(document.getElementById("codey-settings-button").parentElement, replacement);
  assert.equal(document.getElementById("codey-settings-button-measure"), null);
  window.__codeyRendererScan();
  assert.equal(document.getElementById("codey-settings-button").parentElement, replacement);
  slot.removeAttribute("data-test-id");
  window.__codeyRendererInvalidateHeaderMount();
  window.__codeyRendererScan();
  assert.equal(document.getElementById("codey-settings-button").parentElement, header);
  assert.equal(document.getElementById("codey-settings-button-measure"), null);
});

test("joins the live action row inside a single measured host", () => {
  const header = new FakeElement("header", { right: 1200 });
  const slot = new FakeElement("div", { right: 1200, width: 70 });
  slot.setAttribute("data-test-id", "header-shell-slot");
  const liveHost = new FakeElement();
  const liveRow = new FakeElement();
  liveRow.appendChild(new FakeElement("button", { right: 1192, width: 28 }));
  liveHost.appendChild(liveRow);
  slot.appendChild(liveHost);
  header.appendChild(slot);
  const documentElement = new FakeElement("html");
  documentElement.appendChild(header);
  const { document, timers, window } = createRendererSandbox({ documentElement, header });
  runRendererInShell({ document, timers, window });
  const button = document.getElementById("codey-settings-button");
  assert.equal(button.parentElement, liveRow);
  assert.equal(liveRow.children.at(-1), button);
  assert.equal(button.dataset.codeyNativeSlot, "true");
  assert.equal(document.getElementById("codey-settings-button-measure"), null);
  const reads = header.rectReads;
  window.__codeyRendererScan();
  assert.equal(header.rectReads, reads, "stable mounts skip geometry reads");
});

test("joins a slot that holds the live action row directly", () => {
  const header = new FakeElement("header", { right: 1200 });
  const slot = new FakeElement("div", { right: 1200, width: 70 });
  slot.setAttribute("data-test-id", "header-shell-slot");
  const liveRow = new FakeElement();
  liveRow.appendChild(new FakeElement("button", { right: 1192, width: 28 }));
  slot.appendChild(liveRow);
  header.appendChild(slot);
  const documentElement = new FakeElement("html");
  documentElement.appendChild(header);
  const { document, timers, window } = createRendererSandbox({ documentElement, header });
  runRendererInShell({ document, timers, window });
  const button = document.getElementById("codey-settings-button");
  assert.equal(button.parentElement, liveRow);
  assert.equal(liveRow.children.at(-1), button);
  assert.equal(document.getElementById("codey-settings-button-measure"), null);
});

test("keeps the header mount stable when only its measurement mirror changes", () => {
  const header = new FakeElement("header", { right: 1200 });
  const slot = new FakeElement("div", { right: 1200, width: 70 });
  slot.setAttribute("data-test-id", "header-shell-slot");
  const hidden = new FakeElement();
  hidden.setAttribute("aria-hidden", "true");
  const visible = new FakeElement();
  const measureRow = new FakeElement();
  const actionRow = new FakeElement();
  hidden.appendChild(measureRow);
  visible.appendChild(actionRow);
  slot.append(hidden, visible);
  header.appendChild(slot);
  measureRow.appendChild(new FakeElement("button", { right: 1400, width: 28 }));
  actionRow.appendChild(new FakeElement("button", { right: 1192, width: 28 }));
  const documentElement = new FakeElement("html");
  documentElement.appendChild(header);
  const subscribers = [];
  const { document, timers, window } = createRendererSandbox({ documentElement, header });
  runRendererInShell({ document, subscribers, timers, window });
  const bootstrap = subscribers.find(({ options }) => options.attributes === true);
  assert.ok(bootstrap, "the bootstrap observer subscribes through the shared dispatcher");
  const button = document.getElementById("codey-settings-button");
  const mirror = document.getElementById("codey-settings-button-measure");
  const mutation = (target, addedNodes, removedNodes) => [{
    addedNodes, removedNodes, target, type: "childList",
  }];
  bootstrap.handler(mutation(measureRow, [mirror], []));
  assert.equal(timers.size, 0, "the measurement mirror does not invalidate the header mount");
  const latecomer = new FakeElement("button", { right: 1192, width: 28 });
  actionRow.appendChild(latecomer);
  bootstrap.handler(mutation(actionRow, [latecomer], []));
  assert.equal(timers.size, 1, "native header changes still invalidate the header mount");
  const [scheduled] = [...timers.values()];
  timers.clear();
  scheduled();
  assert.equal(actionRow.children.at(-1), button);
  timers.clear();
  mirror.remove();
  bootstrap.handler(mutation(measureRow, [], [mirror]));
  assert.equal(timers.size, 0, "the mirror is repaired by the mount fast path");
  window.__codeyRendererScan();
  assert.equal(document.getElementById("codey-settings-button-measure").parentElement, measureRow);
});

test("moves the CodeyX button beside the visible header's trailing action region", () => {
  const hiddenHeader = new FakeElement("header", { visible: false });
  const visibleHeader = new FakeElement("header", { right: 1200 });
  const rightRegion = new FakeElement("div", { right: 1200, width: 70 });
  const actionRow = new FakeElement("div", { right: 1192, width: 62 });
  const controlWrapper = new FakeElement("span", { right: 1192, width: 28 });
  const nativeButton = new FakeElement("button", { right: 1192, width: 28 });
  const codeyButton = new FakeElement("button", { right: 200, width: 32 });
  codeyButton.id = "codey-settings-button";
  hiddenHeader.appendChild(codeyButton);
  visibleHeader.appendChild(rightRegion);
  rightRegion.appendChild(actionRow);
  actionRow.appendChild(controlWrapper);
  controlWrapper.appendChild(nativeButton);

  const placeholders = {
    "codey-injected-style": new FakeElement("style"),
    "codey-settings-button": codeyButton,
  };
  const document = {
    body: new FakeElement("body"),
    documentElement: new FakeElement("html"),
    createElement: (tagName) => new FakeElement(tagName),
    getElementById: (id) => placeholders[id] || null,
    querySelector: () => null,
    querySelectorAll: (selector) => (selector === "header" ? [hiddenHeader, visibleHeader] : []),
  };
  const window = {
    addEventListener() {},
    clearTimeout() {},
    dispatchEvent() {},
    getComputedStyle: (element) => ({
      display: element.visible ? "flex" : "none",
      visibility: element.visible ? "visible" : "hidden",
    }),
    localStorage: { getItem: () => null, key: () => null, length: 0, setItem() {} },
    setTimeout: () => 1,
  };
  window.window = window;

  runRenderer({
    console,
    document,
    HTMLElement: FakeElement,
    location: { pathname: "/", search: "" },
    MutationObserver: class {
      disconnect() {}
      observe() {}
    },
    URLSearchParams,
    window,
  });

  assert.equal(codeyButton.parentElement, visibleHeader);
  assert.equal(codeyButton.dataset.codeyHeaderActions, "true");
  assert.equal(hiddenHeader.children.includes(codeyButton), false);
  assert.deepEqual(visibleHeader.children, [codeyButton, rightRegion]);
});

test("renders weekly and optional five-hour usage above the sidebar account", async () => {
  const visibleHeader = new FakeElement("header", { right: 1200 });
  const sessionTitle = new FakeElement("div", { right: 700, width: 240 });
  sessionTitle.textContent = "当前会话";
  const rightRegion = new FakeElement("div", { right: 1200, width: 70 });
  const nativeButton = new FakeElement("button", { right: 1192, width: 28 });
  rightRegion.appendChild(nativeButton);
  visibleHeader.appendChild(sessionTitle);
  visibleHeader.appendChild(rightRegion);

  const sidebarRoot = new FakeElement("div", {
    right: 320,
    width: 320,
    height: 800,
  });
  const sidebarNavigation = new FakeElement("nav", {
    right: 320,
    width: 320,
    height: 720,
  });
  const sidebarScroll = new FakeElement("div", {
    right: 320,
    width: 320,
    height: 620,
  });
  sidebarScroll.setAttribute("data-app-action-sidebar-scroll", "");
  sidebarNavigation.appendChild(sidebarScroll);
  const sidebarFooterHost = new FakeElement("div", {
    right: 320,
    width: 320,
    height: 64,
    top: 736,
  });
  const nativeProfileFooter = new FakeElement("div", {
    right: 320,
    width: 320,
    height: 64,
    top: 736,
  });
  nativeProfileFooter.appendChild(new FakeElement("button", {
    right: 220,
    width: 200,
    height: 40,
    top: 748,
  }));
  sidebarFooterHost.appendChild(nativeProfileFooter);
  sidebarRoot.appendChild(sidebarNavigation);
  sidebarRoot.appendChild(sidebarFooterHost);

  const documentElement = new FakeElement("html", {
    right: 1200,
    width: 1200,
    height: 800,
  });
  documentElement.appendChild(sidebarRoot);
  const findById = (id) => {
    let result = null;
    const visit = (element) => {
      if (result) return;
      if (element.id === id) {
        result = element;
        return;
      }
      element.children.forEach(visit);
    };
    visit(documentElement);
    visit(document.body);
    visit(visibleHeader);
    return result;
  };
  const document = {
    body: new FakeElement("body"),
    documentElement,
    visibilityState: "visible",
    createElement: (tagName) => new FakeElement(tagName),
    getElementById: findById,
    querySelector: (selector) => document.querySelectorAll(selector)[0] || null,
    querySelectorAll: (selector) => {
      if (selector === "header") return [visibleHeader];
      if (selector === "nav") return [sidebarNavigation];
      return documentElement.querySelectorAll(selector);
    },
  };
  const windowListeners = new Map();
  const addWindowListener = (type, handler) => {
    const handlers = windowListeners.get(type) || [];
    handlers.push(handler);
    windowListeners.set(type, handlers);
  };
  const removeWindowListener = (type, handler) => {
    const handlers = windowListeners.get(type) || [];
    windowListeners.set(type, handlers.filter((candidate) => candidate !== handler));
  };
  const dispatchWindowEvent = (event) => {
    for (const handler of [...(windowListeners.get(event.type) || [])]) {
      handler(event);
    }
  };
  const todayResetAt = new Date();
  todayResetAt.setHours(23, 45, 0, 0);
  const tomorrowResetAt = new Date(todayResetAt);
  tomorrowResetAt.setDate(todayResetAt.getDate() + 1);
  const creditExpiresAt = Math.floor(Date.now() / 1000) + 6 * 3600;
  let accountUsageResult = {
    status: "ok",
    planType: "pro",
    fetchedAt: Math.floor(Date.now() / 1000),
    primary: {
      usedPercent: 15,
      windowMinutes: 300,
      resetsAt: Math.floor(todayResetAt.getTime() / 1000),
    },
    secondary: {
      usedPercent: 40,
      windowMinutes: 10080,
      resetsAt: Math.floor(tomorrowResetAt.getTime() / 1000),
    },
    credits: {
      hasCredits: true,
      unlimited: false,
      balance: "42",
    },
    resetCredits: { availableCount: 3, nextExpiresAt: creditExpiresAt + 24 * 3600 },
  };
  let accountUsageCalls = 0;
  let appServerUsageCalls = 0;
  let appServerUsageResult = {
    rateLimits: {
      limitId: "codex",
      primary: {
        usedPercent: 20,
        windowDurationMins: 10_080,
        resetsAt: Math.floor(tomorrowResetAt.getTime() / 1000),
      },
      credits: {
        hasCredits: true,
        unlimited: false,
        balance: "77",
      },
      planType: "plus",
    },
    rateLimitResetCredits: {
      availableCount: 2,
      credits: [
        { status: "available", expiresAt: creditExpiresAt },
        { status: "redeemed", expiresAt: creditExpiresAt - 60 },
        { status: "unknown", expiresAt: creditExpiresAt - 120 },
        { status: "available", expiresAt: Math.floor(Date.now() / 1000) - 60 },
        { status: "available", expiresAt: "invalid" },
      ],
    },
    rateLimitsByLimitId: {
      codex_bengalfox: {
        limitId: "codex_bengalfox",
        primary: {
          usedPercent: 35,
          windowDurationMins: 300,
          resetsAt: Math.floor(todayResetAt.getTime() / 1000),
        },
      },
    },
  };
  const scheduledDelays = [];
  const window = {
    __codeyReadAccountRateLimits: async () => {
      appServerUsageCalls += 1;
      return appServerUsageResult;
    },
    __codeySessionToolsInjectLoaded: true,
    __codexSessionDeleteBridge: async (path, args) => {
      if (path === "/api/store_official_account_usage") {
        assert.equal(args.authGeneration, 1);
        assert.equal(args.snapshot.primary.usedPercent, 20);
        assert.equal(args.snapshot.resetCredits.availableCount, 2);
        assert.equal(args.snapshot.resetCredits.nextExpiresAt, creditExpiresAt);
        assert.ok(args.snapshot.fetchedAt > 0);
        return { status: "ok" };
      }
      if (path === "/account/usage") {
        accountUsageCalls += 1;
        return accountUsageResult;
      }
      if (path === "/backend/status") return { status: "ok", availableUpdate: null };
      if (path === "/backend/health") return { status: "ok" };
      throw new Error(`unexpected bridge path: ${path}`);
    },
    addEventListener: addWindowListener,
    alert() {},
    clearTimeout() {},
    dispatchEvent: dispatchWindowEvent,
    getComputedStyle: () => ({ display: "flex", visibility: "visible" }),
    innerHeight: 800,
    innerWidth: 1200,
    localStorage: { getItem: () => null, key: () => null, length: 0, setItem() {} },
    removeEventListener: removeWindowListener,
    setTimeout: (_callback, delay) => {
      scheduledDelays.push(delay);
      return scheduledDelays.length;
    },
  };
  window.window = window;

  runRenderer({
    console,
    document,
    HTMLElement: FakeElement,
    location: { pathname: "/", search: "" },
    MutationObserver: class {
      disconnect() {}
      observe() {}
    },
    URLSearchParams,
    window,
  });

  await window.__codeyRefreshAccountUsage();

  const usage = findById("codey-account-usage");
  const settingsButton = findById("codey-settings-button");
  const injectedStyle = findById("codey-core-injected-style");
  assert.ok(usage);
  assert.ok(settingsButton);
  assert.ok(injectedStyle);
  const css = injectedStyle.textContent;
  assert.match(css, /#codey-account-usage::before \{[^}]*background: color-mix\(in srgb, var\(--codey-usage-surface\) \d+%, transparent\);/);
  assert.match(css, /#codey-account-usage::before \{[^}]*z-index: -1;[^}]*inset: -20px 0 0;[^}]*backdrop-filter: blur\(16px\) saturate\(1\.4\);[^}]*mask-image: linear-gradient\(to bottom, transparent, #000 20px\);[^}]*pointer-events: none;/);
  assert.match(css, /#codey-account-usage \{[^}]*isolation: isolate;/);
  assert.doesNotMatch(css, /#codey-account-usage \{[^}]*(background|backdrop-filter|box-shadow):/);
  assert.doesNotMatch(css, /#codey-account-usage \.codey-usage-summary \{[^}]*(border-radius|box-shadow|background)/);
  assert.doesNotMatch(css, /#codey-account-usage \{[^}]*background:[^;}]*Canvas/);
  assert.match(css, /#codey-account-usage \{[^}]*--codey-usage-ink: var\(--color-text, CanvasText\);/);
  assert.match(css, /\.codey-usage-segment \{[^}]*grid-template-columns: subgrid;/);
  assert.match(css, /\[data-tone="warning"\] \.codey-usage-fill \{ background: var\(--codey-usage-warning\); \}/);
  assert.match(css, /\[data-tone="critical"\] \.codey-usage-fill \{ background: var\(--codey-usage-danger\); \}/);
  assert.match(css, /#codey-account-usage:hover \.codey-usage-details, #codey-account-usage:focus-visible \.codey-usage-details \{[^}]*visibility: visible;/);
  assert.match(css, /\.codey-usage-details \{[^}]*background: var\(--codey-usage-surface\);[^}]*pointer-events: none;/);
  assert.match(css, /\[data-dismissed="true"\] \.codey-usage-details \{[^}]*visibility: hidden;/);
  assert.match(css, /\[data-codey-state="stale"\] \.codey-usage-stale-note \{ display: block; \}/);
  assert.match(css, /prefers-reduced-motion: reduce[\s\S]*#codey-account-usage \*/);
  assert.equal(usage.parentElement, sidebarFooterHost);
  assert.equal(usage.nextElementSibling, nativeProfileFooter);
  assert.deepEqual(sidebarFooterHost.children, [usage, nativeProfileFooter]);
  assert.equal(sidebarFooterHost.getAttribute("data-codey-usage-host"), "true");
  assert.equal(sessionTitle.parentElement, visibleHeader);
  assert.equal(visibleHeader.children[0], sessionTitle);
  assert.equal(visibleHeader.getAttribute("data-codey-usage-host"), null);
  const { summary, details, announcer } = accountUsageParts(usage);
  assert.ok(summary);
  assert.ok(details);
  assert.ok(announcer);
  assert.deepEqual(usage.children, [summary, details, announcer]);
  assert.equal(usage.getAttribute("role"), "group");
  assert.equal(usage.getAttribute("aria-live"), null);
  assert.equal(details.getAttribute("role"), "tooltip");
  assert.equal(announcer.getAttribute("role"), "status");
  assert.equal(announcer.getAttribute("aria-live"), "polite");
  // 这一组数据的消耗节奏取决于测试运行时刻，结论只能是充足或偏快。
  assert.match(summary.innerHTML, /class="codey-usage-overview" data-tone="(?:ok|warning)">\s*<span class="codey-usage-status">(?:额度充足|消耗偏快)<\/span>\s*<span class="codey-usage-plan">Pro 20x<\/span>/);
  assert.match(summary.innerHTML, /5 小时[\s\S]*?85%[\s\S]*?(?:后重置|即将重置)[\s\S]*?每周[\s\S]*?60%[\s\S]*?(?:后重置|即将重置)/);
  assert.match(summary.innerHTML, /data-window="five-hour" data-tone="ok"/);
  assert.match(summary.innerHTML, /data-window="weekly" data-tone="ok"/);
  assert.doesNotMatch(summary.innerHTML, /Credits|余额/);
  assert.match(announcer.textContent, /^(?:额度充足|消耗偏快)；5 小时额度剩余 85%；每周额度剩余 60%$/);
  assert.match(details.innerHTML, /class="codey-usage-plan">Pro 20x<\/span>/);
  assert.match(details.innerHTML, /5 小时额度[\s\S]*?剩余[\s\S]*?85%[\s\S]*?今天 23:45 重置/);
  assert.match(details.innerHTML, /每周额度[\s\S]*?剩余[\s\S]*?60%[\s\S]*?明天 23:45 重置/);
  assert.match(details.innerHTML, /Credits 余额[\s\S]*?42/);
  assert.match(details.innerHTML, /剩余重置次数[\s\S]*?3 次[\s\S]*?过期/);
  assert.doesNotMatch(details.innerHTML, /data-expiring/);
  assert.match(details.innerHTML, /更新于 \d{2}:\d{2}/);
  assert.doesNotMatch(details.innerHTML, /class="codey-usage-pace"|codey-usage-legend|--codey-usage-time-left/);
  assert.equal(usage.dataset.codeyState, "ready");
  assert.equal(usage.dataset.windowCount, "2");
  assert.equal(usage.dataset.plan, undefined);
  assert.equal(usage.getAttribute("tabindex"), "0");
  assert.equal(usage.getAttribute("aria-describedby"), "codey-account-usage-details");
  assert.match(usage.getAttribute("aria-label"), /5 小时额度剩余 85%[\s\S]*每周额度剩余 60%/);

  usage.dispatchEvent({ type: "keydown", key: "Escape" });
  assert.equal(usage.dataset.dismissed, "true");
  usage.dispatchEvent({ type: "pointerleave" });
  assert.equal(usage.dataset.dismissed, undefined);

  // 只有更新时间变化时摘要和播报都不能重写，避免多余重排与重复朗读。
  const announcement = announcer.textContent;
  let summaryMarkup = summary.innerHTML;
  let summaryWrites = 0;
  Object.defineProperty(summary, "innerHTML", {
    configurable: true,
    get: () => summaryMarkup,
    set: (value) => {
      summaryWrites += 1;
      summaryMarkup = value;
    },
  });
  accountUsageResult = { ...accountUsageResult, fetchedAt: accountUsageResult.fetchedAt + 120 };
  await window.__codeyRefreshAccountUsage();
  assert.equal(summaryWrites, 0);
  assert.equal(accountUsageParts(usage).summary, summary);
  assert.equal(announcer.textContent, announcement);

  accountUsageResult = {
    ...accountUsageResult,
    primary: { ...accountUsageResult.primary, usedPercent: 75 },
    secondary: { ...accountUsageResult.secondary, usedPercent: 92 },
  };
  await window.__codeyRefreshAccountUsage();
  assert.equal(summaryWrites, 1);
  assert.match(summary.innerHTML, /data-tone="critical">\s*<span class="codey-usage-status">额度紧张<\/span>/);
  assert.match(summary.innerHTML, /data-window="five-hour" data-tone="warning"[\s\S]*?25%[\s\S]*?data-window="weekly" data-tone="critical"[\s\S]*?8%/);
  assert.match(announcer.textContent, /^额度紧张；5 小时额度剩余 25%；每周额度剩余 8%$/);

  accountUsageResult = {
    ...accountUsageResult,
    primary: accountUsageResult.secondary,
    secondary: null,
    resetCredits: { availableCount: 0, nextExpiresAt: creditExpiresAt },
  };
  await window.__codeyRefreshAccountUsage();
  assert.equal(usage.dataset.windowCount, "1");
  assert.match(summary.innerHTML, /每周/);
  assert.doesNotMatch(summary.innerHTML, /data-window="five-hour"/);
  assert.doesNotMatch(details.innerHTML, /剩余重置次数|data-expiring/);

  accountUsageResult = { status: "error", message: "官方额度接口返回 401", authGeneration: 1 };
  appServerUsageResult.rateLimits.primary.resetsAt = Math.floor(Date.now() / 1000) + 29.5 * 60 * 60;
  await window.__codeyRefreshAccountUsage();
  assert.equal(appServerUsageCalls, 1);
  assert.equal(usage.dataset.codeyState, "ready");
  assert.equal(usage.dataset.windowCount, "1");
  assert.match(summary.innerHTML, /每周[\s\S]*?80%/);
  assert.doesNotMatch(summary.innerHTML, /data-window="five-hour"/);
  assert.doesNotMatch(usage.getAttribute("aria-label"), /5 小时额度/);
  assert.match(usage.getAttribute("aria-label"), /1 天 5 小时后重置/);
  assert.match(details.innerHTML, /Credits 余额[\s\S]*?77/);
  assert.match(details.innerHTML, /data-expiring="true"[\s\S]*?剩余重置次数[\s\S]*?2 次[\s\S]*?过期/);
  assert.match(usage.getAttribute("aria-label"), /重置次数即将过期/);
  assert.match(announcer.textContent, /重置次数即将过期/);
  assert.match(details.innerHTML, /class="codey-usage-plan">Plus<\/span>/);

  // 后台与 Codex 都读取失败时保留上次结果并标记为过期，侧边栏重扫也不能清掉标记。
  const fallbackUsageResult = appServerUsageResult;
  accountUsageResult = { status: "error", message: "offline" };
  appServerUsageResult = {};
  await window.__codeyRefreshAccountUsage();
  window.__codeyRendererScan();
  assert.equal(appServerUsageCalls, 2);
  assert.equal(usage.dataset.codeyState, "stale");
  assert.match(summary.innerHTML, /data-tone="warning">\s*<span class="codey-usage-status">未能刷新 · 截至 \d{2}:\d{2} · 重置次数即将过期<\/span>/);
  assert.match(summary.innerHTML, /每周[\s\S]*?80%/);
  assert.match(details.innerHTML, /未能刷新 · 截至 \d{2}:\d{2}/);
  assert.match(usage.getAttribute("aria-label"), /暂未能刷新，显示上次结果/);
  appServerUsageResult = fallbackUsageResult;

  accountUsageResult = { status: "unavailable", reason: "third_party" };
  const refreshSchedulesBeforeUnavailable = scheduledDelays.filter(
    (delay) => delay === 60_000,
  ).length;
  await window.__codeyRefreshAccountUsage();
  assert.equal(findById("codey-account-usage"), null);
  assert.equal(sidebarFooterHost.getAttribute("data-codey-usage-host"), null);
  assert.equal(visibleHeader.getAttribute("data-codey-usage-host"), null);
  assert.equal(
    scheduledDelays.filter((delay) => delay === 60_000).length,
    refreshSchedulesBeforeUnavailable,
  );

  accountUsageResult = {
    status: "ok",
    planType: "plus",
    primary: {
      usedPercent: 20,
      windowMinutes: 10080,
      resetsAt: Math.floor(tomorrowResetAt.getTime() / 1000),
    },
  };
  await window.__codeyRefreshAccountUsage();
  const remountedUsage = findById("codey-account-usage");
  assert.ok(remountedUsage);
  assert.equal(accountUsageCalls, 8);
  assert.equal(appServerUsageCalls, 2);
  assert.equal(remountedUsage.parentElement, sidebarFooterHost);
  assert.equal(remountedUsage.nextElementSibling, nativeProfileFooter);
  assert.equal(remountedUsage.dataset.codeyState, "ready");
  const remounted = accountUsageParts(remountedUsage);
  assert.match(remounted.summary.innerHTML, /class="codey-usage-plan">Plus<\/span>[\s\S]*?每周/);
  assert.doesNotMatch(remounted.summary.innerHTML, /data-window="five-hour"/);
  assert.match(remounted.details.innerHTML, /class="codey-usage-plan">Plus<\/span>/);

  accountUsageResult = { status: "disabled" };
  await window.__codeyRefreshAccountUsage();
  assert.equal(findById("codey-account-usage"), null);

  // 没有可用的上次结果时显示错误摘要，原因放进详情并转义。
  accountUsageResult = { status: "error", message: "官方额度接口返回 <401>" };
  appServerUsageResult = {};
  await window.__codeyRefreshAccountUsage();
  const errorUsage = findById("codey-account-usage");
  assert.ok(errorUsage);
  assert.equal(errorUsage.dataset.codeyState, "error");
  assert.equal(errorUsage.dataset.windowCount, undefined);
  assert.equal(errorUsage.getAttribute("aria-label"), "官方账号额度暂不可用");
  const errorParts = accountUsageParts(errorUsage);
  assert.match(errorParts.summary.innerHTML, /额度暂不可用/);
  assert.match(errorParts.details.innerHTML, /官方额度接口返回 &lt;401&gt;/);
  assert.equal(errorParts.announcer.textContent, "官方账号额度暂不可用");

  // 已用完的窗口在摘要里显示恢复倒计时并成为整体结论；消耗快于时间时详情给出用尽预测。
  const now = Math.floor(Date.now() / 1000);
  accountUsageResult = {
    status: "ok",
    planType: "plus",
    fetchedAt: now,
    primary: { usedPercent: 100, windowMinutes: 300, resetsAt: now + 98 * 60 },
    secondary: { usedPercent: 74, windowMinutes: 10080, resetsAt: now + 4 * 24 * 60 * 60 },
    credits: { hasCredits: false, unlimited: false, balance: "0" },
  };
  await window.__codeyRefreshAccountUsage();
  assert.equal(errorUsage.dataset.codeyState, "ready");
  assert.match(errorParts.summary.innerHTML, /data-tone="critical">\s*<span class="codey-usage-status">5 小时额度已用完<\/span>/);
  assert.match(errorParts.summary.innerHTML, /data-window="five-hour" data-tone="critical" data-pace="empty"[\s\S]*?0%[\s\S]*?<span class="codey-usage-reset">1 小时 38 分钟后恢复<\/span>/);
  assert.match(errorParts.summary.innerHTML, /data-window="weekly" data-tone="warning" data-pace="fast"[\s\S]*?26%[\s\S]*?<span class="codey-usage-reset">4 天后重置<\/span>/);
  assert.match(errorParts.announcer.textContent, /^5 小时额度已用完；5 小时额度剩余 0%；每周额度剩余 26%$/);
  assert.match(errorParts.details.innerHTML, /data-pace="empty"[\s\S]*?已用完，1 小时 38 分钟后恢复/);
  assert.match(errorParts.details.innerHTML, /data-pace="fast"[\s\S]*?按当前速度约 1 天 1 小时后用完/);
  assert.doesNotMatch(errorParts.details.innerHTML, /class="codey-usage-pace"|codey-usage-legend|--codey-usage-time-left/);
  assert.doesNotMatch(errorParts.details.innerHTML, /Credits/);
});

const createStartupUpdateFixture = (bridge) => {
  const visibleHeader = new FakeElement("header", { right: 1200 });
  const documentElement = new FakeElement("html");
  const elementsById = new Map();
  let nextTimerId = 1;
  let clock = Date.now();
  const timers = [];
  const events = [];
  const alerts = [];
  const documentListeners = new Map();
  const windowListeners = new Map();
  const activeTimers = () => timers.filter((timer) => !timer.cleared);
  const visibleButton = () =>
    elementsById.get("codey-settings-button") || null;
  // 注入可控时钟：健康检查用排程间隔判断页面是否刚从系统睡眠中恢复。
  class FixtureDate extends Date {
    constructor(...args) {
      super(...(args.length > 0 ? args : [clock]));
    }

    static now() {
      return clock;
    }
  }
  const document = {
    body: new FakeElement("body"),
    documentElement,
    visibilityState: "visible",
    addEventListener(type, handler) {
      const handlers = documentListeners.get(type) || [];
      handlers.push(handler);
      documentListeners.set(type, handlers);
    },
    createElement: (tagName) => {
      const element = new FakeElement(tagName);
      let id = element.id;
      Object.defineProperty(element, "id", {
        configurable: true,
        get: () => id,
        set: (value) => {
          id = String(value);
          if (id) elementsById.set(id, element);
        },
      });
      const originalSetAttribute = element.setAttribute.bind(element);
      element.setAttribute = (name, value) => {
        originalSetAttribute(name, value);
        if (name === "id") elementsById.set(String(value), element);
      };
      return element;
    },
    getElementById: (id) => {
      const element = id === "codey-settings-button"
        ? visibleButton()
        : elementsById.get(id);
      return element?.isConnected ? element : null;
    },
    querySelector: () => null,
    querySelectorAll: (selector) =>
      selector === "header" ? [visibleHeader] : [],
  };
  const window = {
    __codexSessionDeleteBridge: async (path, payload, options) => {
      if (path === "/internal/codey/session-tools/load") {
        window.__codeySessionToolsInjectLoaded = true;
        return { status: "ok" };
      }
      return bridge(path, payload, options);
    },
    addEventListener(type, handler) {
      const handlers = windowListeners.get(type) || [];
      handlers.push(handler);
      windowListeners.set(type, handlers);
    },
    alert(message) {
      alerts.push(String(message));
    },
    clearTimeout(id) {
      const timer = timers.find((entry) => entry.id === id);
      if (timer) timer.cleared = true;
    },
    dispatchEvent(event) {
      events.push(event);
      for (const handler of windowListeners.get(event.type) || []) handler(event);
      return true;
    },
    getComputedStyle: () => ({ display: "flex", visibility: "visible" }),
    innerWidth: 1200,
    localStorage: { getItem: () => null, key: () => null, length: 0, setItem() {} },
    requestIdleCallback(callback, options = {}) {
      const timer = {
        id: nextTimerId,
        callback,
        delay: options.timeout ?? 0,
        cleared: false,
        idle: true,
      };
      nextTimerId += 1;
      timers.push(timer);
      return timer.id;
    },
    setTimeout(callback, delay) {
      const timer = { id: nextTimerId, callback, delay, cleared: false };
      nextTimerId += 1;
      timers.push(timer);
      return timer.id;
    },
  };
  window.window = window;

  runRenderer({
    console,
    CustomEvent: class {
      constructor(type, init = {}) {
        this.type = type;
        this.detail = init.detail;
      }
    },
    Date: FixtureDate,
    document,
    HTMLElement: FakeElement,
    location: { pathname: "/", search: "" },
    MutationObserver: class {
      disconnect() {}
      observe() {}
    },
    URLSearchParams,
    window,
  });

  return {
    activeTimers,
    advanceClock(milliseconds) {
      clock += milliseconds;
    },
    alerts,
    document,
    dispatchDocumentEvent(type) {
      for (const handler of documentListeners.get(type) || []) {
        handler({ type });
      }
    },
    elementsById,
    events,
    timers,
    window,
  };
};

for (const type of ["pointerenter", "pointerdown", "focus"]) {
  test(`passively preloads settings on ${type} and keeps clicks working`, async () => {
    const fixture = createStartupUpdateFixture(async () => ({ status: "ok" }));
    let loads = 0;
    let toggles = 0;
    const loadedOverlay = { toggle() { toggles += 1; } };
    fixture.window.__codeySettingsOverlay = {
      __codeyLazyLoader: true,
      load() {
        loads += 1;
        fixture.window.__codeySettingsOverlay = loadedOverlay;
        return Promise.resolve(loadedOverlay);
      },
    };
    const button = fixture.document.getElementById("codey-settings-button");
    assert.equal(loads, 0, "startup does not preload settings");
    button.dispatchEvent({ type });
    if (type === "pointerenter") fixture.activeTimers().find(timer => timer.delay === 120).callback();
    await new Promise(setImmediate);
    assert.equal(loads, 1);
    assert.equal(toggles, 0, "preloading does not open settings");
    button.dispatchEvent({ type: "pointerenter" });
    button.dispatchEvent({ type: "focus" });
    assert.equal(loads, 1, "the loaded overlay is not requested again");
    button.dispatchEvent({ type: "click", preventDefault() {}, stopPropagation() {} });
    assert.equal(toggles, 1);
    assert.deepEqual(fixture.alerts, []);
  });
}

test("settings preloading ignores missing and non-lazy loaders", () => {
  const fixture = createStartupUpdateFixture(async () => ({ status: "ok" }));
  const button = fixture.document.getElementById("codey-settings-button");
  let loads = 0;
  for (const overlay of [undefined, {}, { load() { loads += 1; } }, {
    __codeyLazyLoader: true, load: true,
  }]) {
    fixture.window.__codeySettingsOverlay = overlay;
    button.dispatchEvent({ type: "pointerenter" });
    button.dispatchEvent({ type: "focus" });
  }
  assert.equal(loads, 0);
  assert.deepEqual(fixture.alerts, []);
});

test("a drive-by hover cancels settings loading and a press cancels the pending dwell", async () => {
  const fixture = createStartupUpdateFixture(async () => ({ status: "ok" }));
  const button = fixture.document.getElementById("codey-settings-button");
  let loads = 0;
  fixture.window.__codeySettingsOverlay = {
    __codeyLazyLoader: true,
    load() { loads += 1; },
  };
  button.dispatchEvent({ type: "pointerenter" });
  const first = fixture.activeTimers().find(timer => timer.delay === 120);
  button.dispatchEvent({ type: "pointerleave" });
  assert.equal(first.cleared, true);
  assert.equal(loads, 0);
  button.dispatchEvent({ type: "pointerenter" });
  const second = fixture.activeTimers().find(timer => timer.delay === 120);
  button.dispatchEvent({ type: "pointerdown" });
  await new Promise(setImmediate);
  assert.equal(second.cleared, true);
  assert.equal(loads, 1);
});

for (const synchronous of [false, true]) {
  test(`settings preload ${synchronous ? "throw" : "rejection"} stays passive and preserves click`, async () => {
    const fixture = createStartupUpdateFixture(async () => ({ status: "ok" }));
    let toggles = 0;
    fixture.window.__codeySettingsOverlay = {
      __codeyLazyLoader: true,
      load() {
        if (synchronous) throw new Error("preload failed");
        return Promise.reject(new Error("preload failed"));
      },
      toggle() { toggles += 1; },
    };
    const button = fixture.document.getElementById("codey-settings-button");
    button.dispatchEvent({ type: "pointerenter" });
    fixture.activeTimers().find(timer => timer.delay === 120).callback();
    await new Promise(setImmediate);
    assert.deepEqual(fixture.alerts, []);
    assert.equal(toggles, 0);
    button.dispatchEvent({ type: "click", preventDefault() {}, stopPropagation() {} });
    assert.equal(toggles, 1);
  });
}

test("hydrates the passive update badge from startup backend state", async () => {
  const bridgeCalls = [];
  const fixture = createStartupUpdateFixture(async (path, payload) => {
    bridgeCalls.push({ path, payload });
    if (path === "/backend/status") {
      return {
        status: "ok",
        availableUpdate: {
          currentVersion: "1.0.0",
          latestVersion: "1.0.1",
          updateAvailable: true,
          selectedAsset: { fileName: "Codey-1.0.1.zip" },
        },
      };
    }
    if (path === "/backend/health") return { status: "ok" };
    throw new Error(`unexpected bridge path: ${path}`);
  });

  await new Promise((resolve) => setImmediate(resolve));

  const button = fixture.document.getElementById("codey-settings-button");
  assert.ok(button);
  assert.equal(button.getAttribute("data-codey-update-available"), "true");
  assert.equal(button.getAttribute("aria-label"), "打开 CodeyX 配置，有可用更新");
  assert.equal(fixture.window.__codeyUpdateAvailability.latestVersion, "1.0.1");
  const updateEvents = fixture.events.filter(
    (event) => event.type === "codey-update-availability-changed",
  );
  assert.equal(updateEvents.length, 1);
  assert.equal(fixture.document.getElementById("codey-update-check-status"), null);
  assert.equal(fixture.document.getElementById("codey-update-dialog"), null);
  assert.equal(
    fixture.activeTimers().some((timer) => timer.delay === 30 * 60 * 1000),
    false,
  );
  assert.deepEqual(
    bridgeCalls.map(({ path }) => path),
    ["/backend/status", "/backend/health"],
  );
  assert.equal(
    fixture.activeTimers().some((timer) => timer.delay === 30_000),
    true,
  );

  let unchangedAttributeWrites = 0;
  const originalSetAttribute = button.setAttribute.bind(button);
  button.setAttribute = (...args) => {
    unchangedAttributeWrites += 1;
    originalSetAttribute(...args);
  };
  await fixture.window.__codeyRefreshRuntimeHealth();
  assert.equal(unchangedAttributeWrites, 0);
});

test("falls back to a passive periodic check when backend update state hangs", async () => {
  const fixture = createStartupUpdateFixture(
    async () => new Promise(() => {}),
  );

  const timeoutTimer = fixture.activeTimers().find(
    (timer) => timer.delay === 10_000,
  );
  assert.ok(timeoutTimer);
  timeoutTimer.cleared = true;
  timeoutTimer.callback();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(fixture.document.getElementById("codey-update-check-status"), null);
  assert.equal(fixture.document.getElementById("codey-update-dialog"), null);
  assert.equal(fixture.window.__codeyUpdateAvailability, null);
  assert.equal(
    fixture.activeTimers().some((timer) => timer.delay === 30 * 60 * 1000),
    true,
  );
});

test("saved update policy controls renderer polling and rejects badges when off", async () => {
  const calls = [];
  const fixture = createStartupUpdateFixture(async (path) => {
    calls.push(path);
    if (path === "/backend/status") return { codeyUpdatePolicy: "off" };
    if (path === "/backend/health") return { status: "ok" };
    if (path === "/account/usage") return { status: "disabled" };
    if (path === "/api/check_for_updates") return { updateAvailable: false };
    throw new Error(`unexpected bridge path: ${path}`);
  });
  await new Promise((resolve) => setImmediate(resolve));
  const updateTimers = () => fixture.activeTimers().filter((timer) => timer.delay === 30 * 60 * 1000);
  assert.equal(updateTimers().length, 0);
  assert.equal(calls.includes("/api/check_for_updates"), false);

  fixture.window.dispatchEvent({ type: "codey:config-changed", detail: { config: { codeyUpdatePolicy: "stable" } } });
  for (const timer of fixture.activeTimers().filter((timer) => timer.delay === 0)) {
    timer.cleared = true;
    timer.callback();
  }
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.filter((path) => path === "/api/check_for_updates").length, 1);
  assert.equal(updateTimers().length, 1);

  fixture.window.dispatchEvent({ type: "codey:config-changed", detail: { config: { codeyUpdatePolicy: "off" } } });
  assert.equal(updateTimers().length, 0);
  fixture.window.dispatchEvent({ type: "codey:config-changed" });
  assert.equal(updateTimers().length, 0);
  fixture.window.dispatchEvent({ type: "codey-update-availability-changed", detail: { updateAvailable: true, latestVersion: "2.0.0" } });
  assert.equal(fixture.document.getElementById("codey-settings-button").getAttribute("data-codey-update-available"), null);
});

test("Releases without an uploaded installer keep the renderer polling", async () => {
  const update = { currentVersion: "1.0.0", latestVersion: "2.0.0", updateAvailable: true };
  const fixture = createStartupUpdateFixture(async path => {
    if (path === "/backend/status") return { codeyUpdatePolicy: "stable", availableUpdate: update };
    if (path === "/backend/health") return { status: "ok" };
    if (path === "/api/check_for_updates") return { ...update, selectedAsset: { fileName: "setup.exe" } };
    throw new Error(`unexpected bridge path: ${path}`);
  });
  await new Promise(setImmediate);
  const timer = fixture.activeTimers().find(entry => entry.delay === 30 * 60 * 1000);
  assert.ok(timer);
  timer.cleared = true;
  timer.callback();
  await new Promise(setImmediate);
  assert.equal(fixture.window.__codeyUpdateAvailability.selectedAsset.fileName, "setup.exe");
  assert.equal(fixture.activeTimers().some(entry => entry.delay === 30 * 60 * 1000), false);
});

for (const policy of ["stable", "experimental"]) for (const [latestVersion, prerelease, expected] of [
  ["2.0.0", true, false], ["2.0.0-beta.1", false, false], ["2.0.0+build-dev", false, true],
]) {
  test(`renderer only accepts stable releases including legacy policies: ${policy}/${latestVersion}/${prerelease}`, async () => {
    const fixture = createStartupUpdateFixture(async path => {
      if (path === "/backend/status") return {
        codeyUpdatePolicy: policy,
        availableUpdate: { latestVersion, prerelease, updateAvailable: true, selectedAsset: { fileName: "setup.exe" } },
      };
      if (path === "/backend/health") return { status: "ok" };
      throw new Error(`unexpected bridge path: ${path}`);
    });
    await new Promise(setImmediate);
    assert.equal(fixture.window.__codeyUpdateAvailability !== null, expected);
  });
}

test("disabling renderer automatic checks ignores an in-flight update response", async () => {
  let resolveUpdate;
  const fixture = createStartupUpdateFixture(async (path) => {
    if (path === "/backend/status") return { codeyUpdatePolicy: "stable" };
    if (path === "/backend/health") return { status: "ok" };
    if (path === "/api/check_for_updates") return new Promise((resolve) => { resolveUpdate = resolve; });
    throw new Error(`unexpected bridge path: ${path}`);
  });
  await new Promise((resolve) => setImmediate(resolve));
  const timer = fixture.activeTimers().find((entry) => entry.delay === 30 * 60 * 1000);
  assert.ok(timer);
  timer.cleared = true;
  timer.callback();
  assert.equal(typeof resolveUpdate, "function");
  fixture.window.dispatchEvent({ type: "codey:config-changed", detail: { config: { codeyUpdatePolicy: "off" } } });
  resolveUpdate({ updateAvailable: true, latestVersion: "2.0.0" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fixture.window.__codeyUpdateAvailability, null);
  assert.equal(fixture.activeTimers().some((entry) => entry.delay === 30 * 60 * 1000), false);
});

test("marks the CodeyX icon unavailable after consecutive hung health checks and recovers", async () => {
  let healthMode = "hang";
  const fixture = createStartupUpdateFixture(async (path) => {
    if (path === "/backend/status") {
      return { status: "ok", availableUpdate: null };
    }
    if (path === "/backend/health") {
      return healthMode === "healthy"
        ? { status: "ok" }
        : new Promise(() => {});
    }
    throw new Error(`unexpected bridge path: ${path}`);
  });

  const fireLatestHealthTimeout = () => {
    const timer = fixture.activeTimers()
      .filter((candidate) => candidate.delay === 3_250)
      .at(-1);
    assert.ok(timer, "health timeout should be armed");
    timer.cleared = true;
    timer.callback();
  };

  fireLatestHealthTimeout();
  await new Promise((resolve) => setImmediate(resolve));

  const button = fixture.document.getElementById("codey-settings-button");
  assert.ok(button);
  assert.equal(button.getAttribute("data-codey-runtime-state"), "checking");

  const retryTimer = fixture.activeTimers().find(
    (candidate) => candidate.delay === 1_000,
  );
  assert.ok(retryTimer, "first health failure should retry after one second");
  retryTimer.cleared = true;
  retryTimer.callback();
  fireLatestHealthTimeout();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(button.getAttribute("data-codey-runtime-state"), "unavailable");
  assert.match(button.getAttribute("aria-label"), /CodeyX 连接中断/);
  assert.match(button.title, /CodeyX 后端未响应/);
  assert.ok(fixture.activeTimers().some((timer) => timer.delay === 5_000));
  let settingsLoads = 0;
  fixture.window.__codeySettingsOverlay = {
    __codeyLazyLoader: true,
    load() { settingsLoads += 1; },
  };
  button.dispatchEvent({ type: "pointerenter" });
  button.dispatchEvent({ type: "focus" });
  assert.equal(settingsLoads, 0, "an unavailable backend must not be preloaded");
  button.dispatchEvent({
    type: "click",
    preventDefault() {},
    stopPropagation() {},
  });
  assert.deepEqual(fixture.alerts, [], "click waits for a fresh health check");
  fireLatestHealthTimeout();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(fixture.alerts, [
    "CodeyX 与 Codex 的连接已中断，当前配置面板无法连接。"
    + "CodeyX 会继续尝试自动恢复；若长时间仍未恢复，请退出 Codex 后重新启动 CodeyX。",
  ]);

  healthMode = "healthy";
  await fixture.window.__codeyRefreshRuntimeHealth();

  assert.equal(button.getAttribute("data-codey-runtime-state"), "healthy");
  assert.equal(button.getAttribute("aria-label"), "打开 CodeyX 配置");
  assert.equal(button.title, "打开 CodeyX 配置");
  assert.equal(fixture.window.__codeyRuntimeHealth.consecutiveFailures, 0);
});

test("waits for an in-flight health check before opening recovered settings", async () => {
  let healthCalls = 0;
  let resolveHealth;
  const fixture = createStartupUpdateFixture(async (path) => {
    if (path === "/backend/status") return { status: "ok", availableUpdate: null };
    if (path === "/backend/health") {
      healthCalls += 1;
      if (healthCalls === 1) return { status: "failed", code: "bridge_unavailable" };
      return new Promise((resolve) => { resolveHealth = resolve; });
    }
    throw new Error(`unexpected bridge path: ${path}`);
  });
  await new Promise((resolve) => setImmediate(resolve));
  const button = fixture.document.getElementById("codey-settings-button");
  assert.equal(button.getAttribute("data-codey-runtime-state"), "unavailable");
  let toggles = 0;
  fixture.window.__codeySettingsOverlay = { toggle() { toggles += 1; } };

  const check = fixture.window.__codeyRefreshRuntimeHealth();
  button.dispatchEvent({ type: "click", preventDefault() {}, stopPropagation() {} });
  button.dispatchEvent({ type: "click", preventDefault() {}, stopPropagation() {} });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(healthCalls, 2, "click shares the pending check");
  assert.equal(toggles, 0);
  assert.deepEqual(fixture.alerts, []);

  resolveHealth({ status: "ok" });
  await check;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(toggles, 1);
  assert.equal(button.getAttribute("data-codey-runtime-state"), "healthy");
  assert.deepEqual(fixture.alerts, []);
});

test("does not count bridge rebuilds or delayed renderer timeouts as backend failures", async () => {
  let healthResult = { status: "failed", code: "bridge_reinstalled" };
  const fixture = createStartupUpdateFixture(async (path) => {
    if (path === "/backend/status") return { status: "ok", availableUpdate: null };
    if (path === "/backend/health") return healthResult;
    throw new Error(`unexpected bridge path: ${path}`);
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fixture.window.__codeyRuntimeHealth?.consecutiveFailures ?? 0, 0);

  for (let attempt = 0; attempt < 3; attempt += 1) {
    healthResult = new Promise(() => {});
    const check = fixture.window.__codeyRefreshRuntimeHealth();
    fixture.advanceClock(10_000);
    const timeout = fixture.activeTimers().filter((timer) => timer.delay === 3_250).at(-1);
    assert.ok(timeout);
    timeout.cleared = true;
    timeout.callback();
    await check;
  }
  const button = fixture.document.getElementById("codey-settings-button");
  assert.notEqual(button.getAttribute("data-codey-runtime-state"), "unavailable");
  assert.equal(fixture.window.__codeyRuntimeHealth?.consecutiveFailures ?? 0, 0);
  assert.ok(fixture.activeTimers().some((timer) => timer.delay === 1_000));

  healthResult = { status: "failed", code: "bridge_unavailable" };
  await fixture.window.__codeyRefreshRuntimeHealth();
  assert.equal(button.getAttribute("data-codey-runtime-state"), "unavailable");
});

test("pauses CodeyX health checks while the page is hidden and resumes immediately", async () => {
  let healthCalls = 0;
  const fixture = createStartupUpdateFixture(async (path) => {
    if (path === "/backend/status") return { status: "ok", availableUpdate: null };
    if (path === "/backend/health") {
      healthCalls += 1;
      return { status: "ok" };
    }
    throw new Error(`unexpected bridge path: ${path}`);
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(healthCalls, 1);

  fixture.document.visibilityState = "hidden";
  fixture.dispatchDocumentEvent("visibilitychange");
  assert.equal(
    fixture.activeTimers().some((timer) => timer.delay === 30_000),
    false,
  );
  await fixture.window.__codeyRefreshRuntimeHealth();
  assert.equal(healthCalls, 1);

  fixture.document.visibilityState = "visible";
  fixture.dispatchDocumentEvent("visibilitychange");
  const immediateTimer = fixture.activeTimers().find((timer) => timer.delay === 0);
  assert.ok(immediateTimer);
  immediateTimer.cleared = true;
  immediateTimer.callback();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(healthCalls, 2);
  assert.equal(
    fixture.activeTimers().some((timer) => timer.delay === 30_000),
    true,
  );
});

test("widens the health check budget right after the machine resumes from sleep", async () => {
  const fixture = createStartupUpdateFixture(async (path) => {
    if (path === "/backend/status") return { status: "ok", availableUpdate: null };
    if (path === "/account/usage") return { status: "disabled" };
    if (path === "/backend/health") return new Promise(() => {});
    throw new Error(`unexpected bridge path: ${path}`);
  });
  await new Promise((resolve) => setImmediate(resolve));

  const fireLatestTimer = (delay) => {
    const timer = fixture.activeTimers()
      .filter((entry) => entry.delay === delay)
      .at(-1);
    assert.ok(timer, `expected an armed ${delay}ms timer`);
    timer.cleared = true;
    timer.callback();
  };
  // 可见性恢复会同时排程健康检查和额度检查，两者都是 0 延迟。
  const fireImmediateTimers = () => {
    for (const timer of fixture.activeTimers().filter((entry) => entry.delay === 0)) {
      timer.cleared = true;
      timer.callback();
    }
  };

  // 常规状态下沿用原预算。
  assert.ok(fixture.activeTimers().some((entry) => entry.delay === 3_250));
  fireLatestTimer(3_250);
  await new Promise((resolve) => setImmediate(resolve));

  // 合盖休眠：页面隐藏期间不排程，唤醒后由可见性恢复路径立即重新检查。
  fixture.document.visibilityState = "hidden";
  fixture.dispatchDocumentEvent("visibilitychange");
  fixture.advanceClock(8 * 60 * 60 * 1000);
  fixture.document.visibilityState = "visible";
  fixture.dispatchDocumentEvent("visibilitychange");
  fireImmediateTimers();
  await new Promise((resolve) => setImmediate(resolve));

  // 唤醒瞬间后端同样刚被拉起，检查改用加宽的往返预算。
  assert.ok(
    fixture.activeTimers().some((entry) => entry.delay === 8_250),
    "恢复宽限期内应使用加宽的往返预算",
  );
  assert.equal(
    fixture.activeTimers().some((entry) => entry.delay === 3_250),
    false,
  );

  // 宽限期内保留更多失败次数：系统仍在恢复时不能凭三次超时判定后端退出。
  const button = fixture.document.getElementById("codey-settings-button");
  assert.ok(button);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    fireLatestTimer(8_250);
    await new Promise((resolve) => setImmediate(resolve));
    fireLatestTimer(1_000);
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(button.getAttribute("data-codey-runtime-state"), "checking");
});

test("ignores sidebar nav and main content until top chrome is available", () => {
  const sidebarNav = new FakeElement("nav", { right: 84, width: 84, height: 720 });
  const main = new FakeElement("main", { right: 1200, width: 1200, height: 640, top: 80 });
  const mainContent = new FakeElement("div", { right: 1080, width: 960, height: 640, top: 80 });
  const staleButton = new FakeElement("button", { right: 60, width: 28 });
  staleButton.id = "codey-settings-button";
  sidebarNav.appendChild(staleButton);
  main.appendChild(mainContent);

  let topNav = null;
  const placeholders = {
    "codey-core-injected-style": new FakeElement("style"),
    "codey-settings-button": staleButton,
  };
  const document = {
    body: new FakeElement("body"),
    documentElement: new FakeElement("html", { right: 1200, width: 1200, height: 800 }),
    createElement: (tagName) => new FakeElement(tagName),
    getElementById: (id) => placeholders[id] || null,
    querySelector: (selector) => (selector === "main" ? main : null),
    querySelectorAll: (selector) => {
      if (selector === "header") return [];
      if (selector === "nav") return topNav ? [sidebarNav, topNav] : [sidebarNav];
      return [];
    },
  };
  const window = {
    addEventListener() {},
    alert() {},
    clearTimeout() {},
    getComputedStyle: (element) => ({
      display: element.visible ? "flex" : "none",
      visibility: element.visible ? "visible" : "hidden",
    }),
    innerWidth: 1200,
    setTimeout: () => 1,
  };
  window.window = window;

  runRenderer({
    console,
    document,
    HTMLElement: FakeElement,
    location: { pathname: "/", search: "" },
    MutationObserver: class {
      observe() {}
      disconnect() {}
    },
    URLSearchParams,
    window,
  });

  assert.equal(staleButton.parentElement, null);
  assert.equal(sidebarNav.children.includes(staleButton), false);
  assert.equal(mainContent.children.length, 0);

  topNav = new FakeElement("nav", { right: 1200, width: 96, height: 46 });
  window.__codeyRendererScan();

  assert.equal(staleButton.parentElement, topNav);
  assert.deepEqual(topNav.children, [staleButton]);
});

test("repeated scans fast-path an already mounted button without layout reads", () => {
  const visibleHeader = new FakeElement("header", { right: 1200 });
  const rightRegion = new FakeElement("div", { right: 1200, width: 70 });
  const nativeButton = new FakeElement("button", { right: 1192, width: 28 });
  const codeyButton = new FakeElement("button", { right: 1120, width: 28 });
  codeyButton.id = "codey-settings-button";
  codeyButton.dataset.codeyHeaderActions = "true";
  codeyButton.isConnected = true;
  visibleHeader.appendChild(codeyButton);
  visibleHeader.appendChild(rightRegion);
  rightRegion.appendChild(nativeButton);

  const placeholders = {
    "codey-core-injected-style": new FakeElement("style"),
    "codey-settings-button": codeyButton,
  };
  let headerQueries = 0;
  const document = {
    body: new FakeElement("body"),
    documentElement: new FakeElement("html"),
    createElement: (tagName) => new FakeElement(tagName),
    getElementById: (id) => placeholders[id] || null,
    querySelector: () => null,
    querySelectorAll: (selector) => {
      if (selector === "header" || selector === "nav") headerQueries += 1;
      return selector === "header" ? [visibleHeader] : [];
    },
  };
  const window = {
    addEventListener() {},
    alert() {},
    clearTimeout() {},
    getComputedStyle: () => ({ display: "flex", visibility: "visible" }),
    setTimeout: () => 1,
  };
  window.window = window;
  let observerCallback = null;

  runRenderer({
    console,
    document,
    HTMLElement: FakeElement,
    location: { pathname: "/", search: "" },
    MutationObserver: class {
      constructor(callback) {
        observerCallback = callback;
      }

      observe() {}
      disconnect() {}
    },
    URLSearchParams,
    window,
  });

  headerQueries = 0;
  for (const element of [visibleHeader, rightRegion, nativeButton, codeyButton]) {
    element.rectReads = 0;
  }
  for (let scan = 0; scan < 10; scan += 1) {
    window.__codeyRendererScan();
  }
  assert.equal(headerQueries, 0);
  assert.equal(visibleHeader.rectReads, 0);
  assert.equal(rightRegion.rectReads, 0);
  assert.equal(nativeButton.rectReads, 0);
  assert.equal(codeyButton.rectReads, 0);
  assert.deepEqual(visibleHeader.children, [codeyButton, rightRegion]);

  const newRightRegion = new FakeElement("div", { right: 1200, width: 50 });
  const newRightButton = new FakeElement("button", { right: 1200, width: 28 });
  newRightRegion.appendChild(newRightButton);
  visibleHeader.appendChild(newRightRegion);
  observerCallback([{
    type: "childList",
    target: visibleHeader,
    addedNodes: [newRightRegion],
    removedNodes: [],
  }]);
  window.__codeyRendererScan();

  assert.ok(headerQueries > 0);
  assert.equal(codeyButton.__codeyHeaderAnchor, newRightRegion);
  assert.equal(codeyButton.dataset.codeyHeaderActions, "true");
  assert.deepEqual(visibleHeader.children, [rightRegion, codeyButton, newRightRegion]);
});

test("mounts usage into the sidebar footer container Codex renders itself", async () => {
  const visibleHeader = new FakeElement("header", { right: 1200 });
  const sidebarRoot = new FakeElement("div", { right: 320, width: 320, height: 800 });
  const sidebarContents = new FakeElement("div", { right: 320, width: 320, height: 800 });
  const sidebarNavigation = new FakeElement("nav", { right: 320, width: 320, height: 720 });
  const sidebarScroll = new FakeElement("div", { right: 320, width: 320, height: 620 });
  sidebarScroll.setAttribute("data-app-action-sidebar-scroll", "");
  sidebarNavigation.appendChild(sidebarScroll);
  const footerSlot = new FakeElement("div", { right: 320, width: 320, height: 0, top: 800 });
  const codexFooterContent = new FakeElement("div", { right: 320, width: 320, height: 0, top: 800 });
  footerSlot.appendChild(codexFooterContent);
  sidebarContents.append(sidebarNavigation, footerSlot);
  sidebarRoot.appendChild(sidebarContents);

  const documentElement = new FakeElement("html", { right: 1200, width: 1200, height: 800 });
  documentElement.appendChild(sidebarRoot);
  const findById = (id) => {
    let result = null;
    const visit = (element) => {
      if (result) return;
      if (element.id === id) {
        result = element;
        return;
      }
      element.children.forEach(visit);
    };
    visit(documentElement);
    visit(document.body);
    visit(visibleHeader);
    return result;
  };
  const document = {
    body: new FakeElement("body"),
    documentElement,
    visibilityState: "visible",
    createElement: (tagName) => new FakeElement(tagName),
    getElementById: findById,
    querySelector: (selector) => document.querySelectorAll(selector)[0] || null,
    querySelectorAll: (selector) => {
      if (selector === "header") return [visibleHeader];
      if (selector === "nav") return [sidebarNavigation];
      return documentElement.querySelectorAll(selector);
    },
  };
  const resetsAt = Math.floor(Date.now() / 1000) + 3600;
  const usageSnapshot = {
    status: "ok",
    planType: "plus",
    fetchedAt: Math.floor(Date.now() / 1000),
    primary: { usedPercent: 20, windowMinutes: 300, resetsAt },
    secondary: { usedPercent: 45, windowMinutes: 10080, resetsAt },
  };
  const window = {
    __codeySessionToolsInjectLoaded: true,
    __codexSessionDeleteBridge: async (path) => {
      if (path === "/api/query_official_account_usage") return usageSnapshot;
      if (path === "/account/usage") return usageSnapshot;
      if (path === "/api/store_official_account_usage") return { status: "ok" };
      if (path === "/backend/status") return { status: "ok", availableUpdate: null };
      if (path === "/backend/health") return { status: "ok" };
      throw new Error(`unexpected bridge path: ${path}`);
    },
    addEventListener() {},
    alert() {},
    clearTimeout() {},
    dispatchEvent() {},
    getComputedStyle: (element) => ({
      display: element.visible ? "flex" : "none",
      position: element === footerSlot ? "absolute" : "static",
      visibility: element.visible ? "visible" : "hidden",
      bottom: element === footerSlot ? "0px" : "auto",
    }),
    innerHeight: 800,
    innerWidth: 1200,
    localStorage: { getItem: () => null, key: () => null, length: 0, setItem() {} },
    setTimeout: () => 1,
  };
  window.window = window;

  runRenderer({
    console,
    document,
    HTMLElement: FakeElement,
    location: { pathname: "/", search: "" },
    MutationObserver: class {
      disconnect() {}
      observe() {}
    },
    URLSearchParams,
    window,
  });

  await window.__codeyRefreshAccountUsage();

  const usage = findById("codey-account-usage");
  assert.ok(usage, "the quota block mounts even when the footer holds no controls yet");
  assert.equal(usage.parentElement, footerSlot);
  assert.equal(usage.nextElementSibling, codexFooterContent);
  assert.equal(footerSlot.getAttribute("data-codey-usage-host"), "true");
  assert.equal(sidebarRoot.getAttribute("data-codey-usage-host"), null);
  const { summary } = accountUsageParts(usage);
  assert.match(summary.innerHTML, /每周/);
  assert.match(summary.innerHTML, /data-window="five-hour"/);
});

test("the native adapter reloads MCP without loading session UI", async () => {
  const requests = [];
  const window = {
    __codeyRendererCoreLoaded: true,
    __codeyAppServerRequestClients: new Map([
      ["local", {
        sendRequest(...args) {
          requests.push(args);
          return {};
        },
      }],
    ]),
    addEventListener() {},
  };
  window.window = window;
  runRenderer({
    console,
    document: {
      documentElement: new FakeElement("html"),
      body: new FakeElement("body"),
      addEventListener() {},
      createElement: (tag) => new FakeElement(tag),
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => [],
    },
    HTMLElement: FakeElement,
    location: { pathname: "/", search: "" },
    MutationObserver: class {
      disconnect() {}
      observe() {}
    },
    URLSearchParams,
    window,
  }, { nativeRuntime: true });
  assert.equal((await window.__codeyReloadMcpServers()).ok, true);
  assert.equal(window.__codeySessionToolsInjectLoaded, undefined);
  assert.equal(JSON.stringify(requests), JSON.stringify([["config/mcpServer/reload", {}]]));
});

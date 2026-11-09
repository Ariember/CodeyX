// CLI-only launches cannot install the main-process startup patch. Operate on
// the native shared instances instead; keep application and voice RPCs intact.
(() => {
  const version = 4;
  const slimPet = ["__CODEY_SLIM_PET__"][0] === "true";
  const previous = window.__codeyRuntimeOptimizations;
  if (previous?.version === version && previous.slimPet === slimPet && previous.isActive?.()) return;
  previous?.dispose?.();
  let disposed = false;
  let pending = null;
  let retryTimer = null;
  let attempt = 0;
  const restores = [];
  const trackers = new Set();
  const messengers = new Map();
  const noSampling = () => null;
  const noHeartbeat = () => {};
  let suppressedHeartbeats = 0;
  let suppressedPrewarms = 0;
  const document = window.document;
  const checkedStyleSheets = new WeakSet();
  const markedTabs = new Map();
  const tabsAttribute = "data-app-shell-tabs";
  const expandedAttribute = "data-browser-sidebar-chrome-expanded";
  const expandedMarker = "data-codey-sidebar-expanded";
  const tabsSelector = `[${tabsAttribute}="true"]`;
  const expandedSelector = `[${expandedAttribute}="true"]`;
  const titlebarStateSelector = `${tabsSelector}, ${expandedSelector}`;
  const nativeTitlebarSelector = `[data-codex-window-type="electron"] :is([data-app-shell-titlebar], ${tabsSelector}:has(${expandedSelector})) [data-app-shell-tab-strip-controller]`;
  let titlebarObserver = null;

  const syncTabs = (tabs) => {
    const expanded = tabs.isConnected && tabs.matches(tabsSelector)
      && tabs.querySelector(expandedSelector);
    if (expanded) {
      if (tabs.getAttribute(expandedMarker) !== "true") tabs.setAttribute(expandedMarker, "true");
      markedTabs.set(tabs, expanded);
    } else if (markedTabs.delete(tabs) && tabs.getAttribute(expandedMarker) === "true") {
      tabs.removeAttribute(expandedMarker);
    }
  };
  const ensureTitlebarObserver = () => {
    if (titlebarObserver) return true;
    if (!document || typeof window.MutationObserver !== "function") return false;
    titlebarObserver = new window.MutationObserver((records) => {
      const candidates = new Set();
      const addAncestorTabs = (element) => {
        for (let tabs = element?.closest(tabsSelector); tabs; tabs = tabs.parentElement?.closest(tabsSelector)) {
          candidates.add(tabs);
        }
      };
      for (const record of records) {
        const target = record.target;
        if (target.nodeType !== 1) continue;
        if (record.attributeName === tabsAttribute) candidates.add(target);
        if (record.attributeName === expandedAttribute) addAncestorTabs(target.parentElement);
        for (const node of record.addedNodes || []) {
          if (node.nodeType !== 1) continue;
          const elements = [...node.querySelectorAll(titlebarStateSelector)];
          if (node.matches(titlebarStateSelector)) elements.push(node);
          for (const element of elements) {
            if (element.matches(tabsSelector)) candidates.add(element);
            if (element.matches(expandedSelector)) addAncestorTabs(element.parentElement);
          }
        }
      }
      // Keep one matching descendant so unrelated message/list removals need no subtree scan.
      for (const [tabs, expanded] of markedTabs) {
        if (!tabs.isConnected || !tabs.contains(expanded) || !expanded.matches(expandedSelector)) candidates.add(tabs);
      }
      for (const tabs of candidates) syncTabs(tabs);
    });
    titlebarObserver.observe(document, {
      subtree: true, childList: true, attributes: true,
      attributeFilter: [tabsAttribute, expandedAttribute],
    });
    for (const tabs of document.querySelectorAll(tabsSelector)) syncTabs(tabs);
    return true;
  };
  const patchStyleRules = (rules) => {
    for (const rule of rules) {
      const original = rule.selectorText;
      if ((original === nativeTitlebarSelector || original === `${nativeTitlebarSelector} *`)
        && ensureTitlebarObserver()) {
        // Native :has() invalidates the entire window on unrelated childList changes.
        const replacement = original.replace(`:has(${expandedSelector})`, `[${expandedMarker}="true"]`);
        rule.selectorText = replacement;
        if (rule.selectorText === replacement) restores.push(() => {
          if (rule.selectorText === replacement) rule.selectorText = original;
        });
      }
      if (rule.cssRules?.length) patchStyleRules(rule.cssRules);
    }
  };
  const patchStyleSheet = (sheet) => {
    if (disposed || !sheet || checkedStyleSheets.has(sheet)) return;
    try {
      const rules = sheet.cssRules;
      checkedStyleSheets.add(sheet);
      patchStyleRules(rules);
    } catch { /* Cross-origin and unknown native styles remain unchanged. */ }
  };
  const onStylesheetLoad = (event) => {
    if (event.target?.tagName === "LINK") patchStyleSheet(event.target.sheet);
  };
  document?.addEventListener("load", onStylesheetLoad, true);
  for (const sheet of document?.styleSheets || []) patchStyleSheet(sheet);

  const replaceMethod = (target, key, replacement) => {
    const own = Object.getOwnPropertyDescriptor(target, key);
    const original = target[key];
    if (typeof original !== "function" || (own && (!own.writable || own.get))) return false;
    try {
      target[key] = replacement;
      if (target[key] !== replacement) return false;
    } catch { return false; }
    restores.push(() => {
      if (target[key] !== replacement) return;
      if (own) Object.defineProperty(target, key, own);
      else delete target[key];
    });
    return true;
  };

  const patchTracker = (tracker) => {
    if (trackers.has(tracker)) return;
    if (!replaceMethod(tracker, "beginCpuSampling", noSampling)) return;
    if (replaceMethod(tracker, "ensureHeartbeat", noHeartbeat)) {
      if (tracker.heartbeatTimer != null) window.clearInterval(tracker.heartbeatTimer);
      tracker.heartbeatTimer = null;
    }
    // Spans already in progress keep their timestamps and lifecycle. Cancel
    // only their optional CPU sampler, just as the native cancellation path does.
    for (const interaction of tracker.activeInteractions.values()) {
      const sampler = interaction?.cpuSampling;
      if (!sampler || typeof sampler.cancel !== "function") continue;
      try {
        sampler.cancel();
        if (interaction.cpuSampling === sampler) interaction.cpuSampling = null;
      } catch { /* A native in-flight sampler can still finish normally. */ }
    }
    trackers.add(tracker);
  };

  const patchMessenger = (messenger) => {
    if (messengers.has(messenger) || !slimPet) return;
    const original = messenger.postMessage;
    const wrapped = function (message, ...args) {
      // This is the real send boundary. codex-message-from-view is emitted
      // AFTER IPC and cannot prevent prewarming on frozen Electron bridges.
      if (!disposed && message?.type === "electron-avatar-overlay-restore-ready"
        && message.shouldPrewarmAvatarOverlay === true) {
        message = { ...message, shouldPrewarmAvatarOverlay: false };
        suppressedPrewarms += 1;
      }
      return Reflect.apply(original, this, [message, ...args]);
    };
    if (replaceMethod(messenger, "postMessage", wrapped)) messengers.set(messenger, wrapped);
  };

  const onMessage = (event) => {
    if (disposed || (event.source != null && event.source !== window)) return;
    if (event.origin !== window.location.origin && event.origin !== "null") return;
    if (event.data?.type !== "electron-app-state-snapshot-request"
      || event.data.reason !== "heartbeat") return;
    // Host memory diagnostics are collected only after the renderer responds.
    // Manual/error-triggered snapshots and every other native event pass through.
    event.stopImmediatePropagation();
    suppressedHeartbeats += 1;
  };
  window.addEventListener("message", onMessage, true);

  const matchesTracker = (value) => value && typeof value === "object"
    && value.activeInteractions instanceof Map
    && typeof value.beginCpuSampling === "function"
    && typeof value.ensureHeartbeat === "function"
    && typeof value.recordHeartbeat === "function"
    && "heartbeatTimer" in value;
  const matchesMessenger = (value) => value && typeof value === "object"
    && typeof value.postMessage === "function"
    && typeof value.getState === "function" && typeof value.setState === "function"
    && /sendMessageFromView/.test(Function.prototype.toString.call(value.postMessage))
    && /codex-message-from-view/.test(Function.prototype.toString.call(value.postMessage));

  const discover = async () => {
    const urls = new Set(await window.__codeyNativeRuntime?.discoverAppAssetUrls?.() || []);
    // Rspack exposes its module cache from the already loaded numeric entry.
    for (const script of document?.scripts || []) {
      if (/\/assets\/\d+\.[\w-]+\.js(?:\?[^#]*)?$/.test(script.src)) urls.add(script.src);
    }
    if (disposed) return;
    const trackerCandidates = new Set();
    const messengerCandidates = new Set();
    for (const url of urls) {
      // Only inspect shared modules or entries already loaded by the native app.
      if (!/\/(?:app-shared-[^/?#]+|\d+\.[\w-]+)\.js(?:\?[^#]*)?$/.test(url)) continue;
      try {
        const module = typeof window.__codeyImportCodexAsset === "function"
          ? await window.__codeyImportCodexAsset(url) : await import(url);
        if (disposed) return;
        const cache = module.__webpack_require__?.c;
        const exports = cache
          ? Object.values(cache).filter(entry => !entry.error).map(entry => entry.exports)
          : [module];
        for (const exported of exports) {
          // Rspack's ESM exports are non-enumerable getters.
          for (const key of Object.getOwnPropertyNames(exported || {})) {
            try {
              const value = exported[key];
              if (matchesTracker(value)) trackerCandidates.add(value);
              if (matchesMessenger(value)) messengerCandidates.add(value);
            } catch { /* A partially initialized export can be retried later. */ }
          }
        }
      } catch { /* Unknown native shapes are left untouched. */ }
    }
    if (trackerCandidates.size === 1) patchTracker([...trackerCandidates][0]);
    if (messengerCandidates.size === 1) patchMessenger([...messengerCandidates][0]);
  };
  const refresh = () => {
    if (disposed) return Promise.resolve();
    if (pending) return pending;
    pending = discover().catch(() => {}).finally(() => { pending = null; });
    return pending;
  };
  const snapshot = () => ({
    cpuSamplingDisabled: !disposed && [...trackers].some(value => value.beginCpuSampling === noSampling),
    interactionHeartbeatDisabled: !disposed && [...trackers].some(value => value.ensureHeartbeat === noHeartbeat && value.heartbeatTimer == null),
    appStateHeartbeatDisabled: !disposed && (trackers.size > 0 || messengers.size > 0 || suppressedHeartbeats > 0),
    petPrewarmDisabled: !disposed && slimPet && [...messengers].some(([value, wrapped]) => value.postMessage === wrapped),
    suppressedHeartbeats,
    suppressedPrewarms,
  });
  const retry = () => {
    retryTimer = null;
    void refresh().then(() => {
      if (disposed) return;
      const status = snapshot();
      if (status.cpuSamplingDisabled && status.interactionHeartbeatDisabled
        && (!slimPet || status.petPrewarmDisabled)) return;
      const delay = [100, 300, 1_000, 3_000, 10_000][attempt++];
      if (delay != null) retryTimer = window.setTimeout(retry, delay);
    });
  };
  const api = Object.freeze({
    version, slimPet, snapshot, refresh,
    isActive: () => !disposed,
    dispose() {
      if (disposed) return;
      disposed = true;
      window.clearTimeout(retryTimer);
      window.removeEventListener("message", onMessage, true);
      document?.removeEventListener("load", onStylesheetLoad, true);
      titlebarObserver?.disconnect();
      for (const restore of restores.reverse()) {
        try { restore(); } catch { /* Do not overwrite native replacements. */ }
      }
      for (const tabs of markedTabs.keys()) {
        if (tabs.getAttribute(expandedMarker) === "true") tabs.removeAttribute(expandedMarker);
      }
      markedTabs.clear();
      // Restore heartbeat scheduling only when native interactions still exist.
      for (const tracker of trackers) {
        if (tracker.activeInteractions.size > 0 && tracker.ensureHeartbeat !== noHeartbeat) {
          try { tracker.ensureHeartbeat(); } catch { /* Native shutdown. */ }
        }
      }
      if (window.__codeyRuntimeOptimizations === api) delete window.__codeyRuntimeOptimizations;
    },
  });
  window.__codeyRuntimeOptimizations = api;
  retry();
})();

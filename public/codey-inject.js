// Sidebar/session tools loaded by renderer-inject.js after Codex's sidebar is
// present. Manual CDP tests should load codex-runtime-adapter.js first.
(() => {
  if (window.__codeySessionToolsInjectLoaded) return;
  if (window.__codeySessionToolsInjectLoading) return;
  window.__codeySessionToolsInjectLoading = true;
  let disposeInstall;
  try {
  // Release a failed installation before publishing any replacement callbacks.
  window.__codeySessionToolsInstall?.dispose?.();
  // 旧安装已销毁，先摘除引用：中途抛错时全局不会留下一个已销毁的安装对象，
  // 下一轮加载也不会对着它重复销毁。
  delete window.__codeySessionToolsInstall;
  let disposed = false;
  const rendererSettingsButtonSelector = "#codey-settings-button";
  const toastId = "codey-runtime-toast";
  const styleId = "codey-injected-style";
  const sessionExportAttribute = "data-codey-session-export";
  const tasksImportAttribute = "data-codey-tasks-import";
  const projectImportAttribute = "data-codey-project-import";
  const sessionDeleteAttribute = "data-codey-session-delete";
  const sidebarActionTooltipId = "codey-sidebar-action-tooltip";
  const threadUpdatedAtAttribute = "data-codey-thread-updated-at";
  const threadUpdatedAtMsAttribute = "data-codey-thread-updated-at-ms";
  const threadRunningAttribute = "data-codey-thread-running";
  const sessionExportIcon = `
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
      <polyline points="17 8 12 3 7 8"></polyline>
      <line x1="12" x2="12" y1="3" y2="15"></line>
    </svg>
  `;
  const projectImportIcon = `
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
      <polyline points="7 10 12 15 17 10"></polyline>
      <line x1="12" x2="12" y1="15" y2="3"></line>
    </svg>
  `;
  const sessionDeleteIcon = `
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
      <path d="M3 6h18"></path>
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"></path>
      <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
      <line x1="10" x2="10" y1="11" y2="17"></line>
      <line x1="14" x2="14" y1="11" y2="17"></line>
    </svg>
  `;
  let scanTimer = 0;
  let initialScanHandle = 0;
  let initialScanUsesIdleCallback = false;
  let scanDeadline = 0;
  const scanDebounceMs = 60;
  const maxScanLatencyMs = 250;
  const sidebarTitleCache = new Map();
  let watcherWakeTimer = 0;
  let completionReconcileInFlight = false;
  let completionNextReconcileAt = 0;
  let completionReconcileSessionId = "";
  let sidebarActionTooltipTimer = 0;
  let sidebarActionTooltipAnchor = null;
  let threadUpdatedAtFetchTimer = 0;
  let threadUpdatedAtFetchInFlight = false;
  const threadUpdatedAtCache = new Map();
  const threadWorkStateByRow = new WeakMap();
  // 同一主机和会话可出现在多个列表中。运行状态统一维护，行记录只保留
  // 原生状态观测，不能用已显示的置顶标记恢复上一轮任务。
  const threadRunningStateByCacheKey = new Map();
  const threadRunningRecheckTimers = new Map();
  const projectRunningRecoveryClickedAt = new WeakMap();
  const threadUpdatedAtRequestedAt = new Map();
  const pendingThreadUpdatedAtRefs = new Map();
  const threadUpdatedAtRows = new Set();
  const sidebarScanRootSelector = [
    "header",
    "nav",
    "[data-app-action-sidebar-section]",
    "[data-app-action-sidebar-thread-row]",
    "[data-app-action-sidebar-project-row]",
    "[data-app-action-sidebar-project-list-id]",
  ].join(", ");
  const sidebarThreadRowSelector = "[data-app-action-sidebar-thread-row]";
  const sidebarProjectListSelector = "[data-app-action-sidebar-project-list-id]";
  const sidebarProjectShowAllAttribute = "data-app-action-sidebar-project-show-all";
  const taskListSectionHeadings = new Set(["task", "tasks", "recent", "recents", "任务", "最近"]);
  const threadRunningLossGraceMs = 2_000;
  const threadTimestampRefreshIntervalMs = 60_000;
  // 桥接应答丢失（如注入重试期间桥接被重装）时不能永久占住 inFlight，
  // 一次超时置失败后按常规周期重试即可。
  const threadTimestampFetchTimeoutMs = 10_000;
  const completedTaskReconcileIntervalMs = 15_000;
  const threadTimestampBridgePath = "/session/timestamps";
  const maxPendingThreadTimestampRefs = 200;
  const fallbackSessionExportMaxBytes = 64 * 1024 * 1024;
  const maxSessionCacheEntries = 2_048;
  const maxPendingScanRoots = 64;
  const projectRunningRecoveryClickCooldownMs = 1_000;
  const rememberBoundedMapValue = (cache, key, value, limit = maxSessionCacheEntries) => {
    cache.delete(key);
    cache.set(key, value);
    while (cache.size > limit) {
      cache.delete(cache.keys().next().value);
    }
  };
  const queryWithin = (root, selector) => {
    const matches = [];
    if (root instanceof HTMLElement && typeof root.matches === "function" && root.matches(selector)) {
      matches.push(root);
    }
    if (root && typeof root.querySelectorAll === "function") {
      matches.push(...root.querySelectorAll(selector));
    }
    return matches;
  };

  const callBridge = (path, payload = {}, options = {}) => {
    if (typeof window.__codexSessionDeleteBridge === "function") {
      return window.__codexSessionDeleteBridge(path, payload, options);
    }
    return Promise.resolve({ status: "failed", message: "CodeyX bridge unavailable" });
  };

  const isRenderedSessionElement = (element) => (
    element instanceof HTMLElement
    && element.getClientRects().length > 0
  );

  const visibleSessionElement = (selector) => {
    const first = document.querySelector(selector);
    if (isRenderedSessionElement(first)) return first;
    return [...document.querySelectorAll(selector)].find(isRenderedSessionElement);
  };

  const getSessionId = () => {
    const attributes = [
      // Codex keeps inactive conversations mounted. Prefer the visible
      // composer, and never use an identifier from a hidden conversation.
      "data-above-composer-conversation-id",
      "data-session-id",
      "data-conversation-id",
      "data-thread-id",
      "data-request-user-input-auto-resolution-conversation-id",
      "data-response-annotation-conversation",
    ];
    for (const attribute of attributes) {
      const value = visibleSessionElement(`[${attribute}]`)?.getAttribute(attribute);
      if (value) return value.replace(/^local:/, "");
    }
    const activeThread = visibleSessionElement('[data-app-action-sidebar-thread-active="true"]')
      ?.getAttribute("data-app-action-sidebar-thread-id");
    if (activeThread) return activeThread.replace(/^local:/, "");
    const match = location.pathname.match(/(?:\/c\/|\/conversation\/|\/session\/)([A-Za-z0-9_-]+)/);
    if (match) return match[1];
    return new URLSearchParams(location.search).get("conversation_id") || new URLSearchParams(location.search).get("session_id") || "";
  };

  const sidebarTitles = (root = document) => queryWithin(root,
    "[data-app-action-sidebar-thread-id][data-app-action-sidebar-thread-title]",
  ).map((thread) => ({
    sessionId: String(thread.getAttribute("data-app-action-sidebar-thread-id") || "").replace(/^local:/, "").trim(),
    title: String(thread.getAttribute("data-app-action-sidebar-thread-title") || "").trim(),
  })).filter(({ sessionId, title }) => sessionId && title);

  const getSessionTitle = (sessionId) => {
    const normalizedSessionId = String(sessionId || "").replace(/^local:/, "");
    return sidebarTitleCache.get(normalizedSessionId)
      || sidebarTitles().find((thread) => thread.sessionId === normalizedSessionId)?.title
      || "";
  };

  const syncSidebarTitles = (root = document) => {
    if (disposed) return;
    const titles = sidebarTitles(root).filter(({ sessionId, title }) => (
      sidebarTitleCache.get(sessionId) !== title
    ));
    if (!titles.length) return;
    const previousTitles = titles.map(({ sessionId }) => (
      [sessionId, sidebarTitleCache.get(sessionId)]
    ));
    titles.forEach(({ sessionId, title }) => (
      rememberBoundedMapValue(sidebarTitleCache, sessionId, title)
    ));
    void callBridge("/session/titles", { titles })
      .then((result) => {
        if (disposed) return;
        if (result?.status !== "failed") return;
        previousTitles.forEach(([sessionId, previousTitle], index) => {
          if (sidebarTitleCache.get(sessionId) !== titles[index].title) return;
          if (previousTitle === undefined) sidebarTitleCache.delete(sessionId);
          else rememberBoundedMapValue(sidebarTitleCache, sessionId, previousTitle);
        });
      })
      .catch(() => {
        if (disposed) return;
        previousTitles.forEach(([sessionId, previousTitle], index) => {
          if (sidebarTitleCache.get(sessionId) !== titles[index].title) return;
          if (previousTitle === undefined) sidebarTitleCache.delete(sessionId);
          else rememberBoundedMapValue(sidebarTitleCache, sessionId, previousTitle);
        });
      });
  };

  const wakeSessionWatcher = () => {
    if (disposed || document.visibilityState === "hidden" || watcherWakeTimer) return;
    void callBridge("/session/wake-watcher").catch(() => {});
    watcherWakeTimer = window.setTimeout(() => {
      watcherWakeTimer = 0;
    }, 30_000);
  };

  const wakeSessionWatcherFromKey = (event) => {
    if (event.key === "Enter" && !event.isComposing) wakeSessionWatcher();
  };

  const addStyle = () => {
    if (document.getElementById(styleId)) return;
    const style = document.createElement("style");
    style.id = styleId;
    style.textContent = `
      #${toastId} { -webkit-app-region: no-drag !important; position: fixed; right: 20px; bottom: 22px; z-index: 2147483645; max-width: 360px; border: 1px solid rgba(124, 140, 255, .4); border-radius: 11px; padding: 10px 13px; background: rgba(20, 24, 36, .97); color: #eef2ff; box-shadow: 0 12px 36px rgba(0,0,0,.4); font: 12px/1.45 system-ui, sans-serif; }
      #${toastId}[data-tone="error"] { border-color: rgba(248, 113, 113, .6); color: #fecaca; }
      [data-app-action-sidebar-thread-id][data-app-action-sidebar-thread-title],
      [data-app-action-sidebar-project-row][data-app-action-sidebar-project-id] { position: relative; }
      [data-app-action-sidebar-thread-row] [${threadUpdatedAtAttribute}] { display: block; flex: 0 0 auto; min-width: 26px; margin-inline-start: auto; color: inherit; font: 400 12px/16px system-ui, sans-serif; font-variant-numeric: tabular-nums; letter-spacing: 0; text-align: end; opacity: .52; pointer-events: none; white-space: nowrap; }
      [data-app-action-sidebar-thread-row]:hover [${threadUpdatedAtAttribute}],
      [data-app-action-sidebar-thread-row]:has(:focus-visible) [${threadUpdatedAtAttribute}] { opacity: 0; }
      [role="list"] > [${threadRunningAttribute}="true"],
      [data-app-action-sidebar-project-list-id] > [${threadRunningAttribute}="true"] { order: -1 !important; }
      [${sessionExportAttribute}], [${tasksImportAttribute}], [${sessionDeleteAttribute}] { -webkit-app-region: no-drag !important; flex: 0 0 auto; pointer-events: auto !important; }
      [${projectImportAttribute}] { -webkit-app-region: no-drag !important; position: absolute; top: 50%; right: 62px; z-index: 35; flex: 0 0 auto; transform: translateY(-50%); opacity: 0; pointer-events: auto !important; transition: opacity .15s ease; }
      [data-app-action-sidebar-project-row][data-app-action-sidebar-project-id]:hover > [${projectImportAttribute}],
      [${projectImportAttribute}]:focus-visible,
      [${projectImportAttribute}][data-busy="true"] { opacity: .9; }
      [${projectImportAttribute}]:hover { opacity: 1 !important; }
      [data-codey-session-action-row] { display: inline-flex !important; align-items: center !important; flex: 0 0 auto !important; flex-flow: row nowrap !important; gap: 1px !important; width: auto !important; min-width: max-content !important; white-space: nowrap !important; }
      #${sidebarActionTooltipId} { position: fixed; z-index: 2147483647; max-width: min(20rem, calc(100vw - 16px)); pointer-events: none; }
      [data-codey-pet-control-blocked="true"] { display: none !important; pointer-events: none !important; }
    `;
    document.documentElement.appendChild(style);
  };

  const showRuntimeToast = (message, tone = "success") => {
    const sharedToast = window.__codeyShowRuntimeToast;
    if (typeof sharedToast === "function" && sharedToast !== showRuntimeToast) {
      sharedToast(message, tone);
      return;
    }
    if (disposed) return;
    document.getElementById(toastId)?.remove();
    const toast = document.createElement("div");
    toast.id = toastId;
    toast.dataset.tone = tone;
    toast.setAttribute("role", tone === "error" ? "alert" : "status");
    toast.setAttribute("aria-live", tone === "error" ? "assertive" : "polite");
    toast.textContent = message;
    document.documentElement.appendChild(toast);
    window.setTimeout(() => toast.remove(), tone === "error" ? 8000 : 3500);
  };
  if (typeof window.__codeyShowRuntimeToast !== "function") {
    window.__codeyShowRuntimeToast = showRuntimeToast;
  }

  const stopSidebarActionEvent = (event) => {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation?.();
  };

  // Codex 原生按钮的尺寸与前景色由 data-* 属性驱动（data-size 决定 --button-icon-size，
  // data-color/data-variant 决定次级前景色），只复制 class 会让注入按钮退回默认值、
  // 图标偏大且是纯黑，所以按参考按钮逐项复制属性，并补上内层容器。
  const inheritNativeButtonClass = (button, reference) => {
    if (!(reference instanceof HTMLElement)) return;
    const className = String(reference.getAttribute("class") || "").trim();
    if (className) button.setAttribute("class", className);
    for (const name of ["data-color", "data-variant", "data-pill", "data-uniform", "data-size", "data-icon-size"]) {
      const value = reference.getAttribute(name);
      if (value === null) button.removeAttribute(name);
      else button.setAttribute(name, value);
    }
  };

  // 原生图标统一放在 _ButtonInner 内：它负责 flex 居中，并把图标压到
  // --button-icon-size（3xs 按钮即 14px）。
  const wrapNativeButtonIcon = (button, reference) => {
    const icon = button.querySelector("svg");
    if (!icon) return;
    const template = reference instanceof HTMLElement
      ? reference.querySelector("span")
      : null;
    const inner = template instanceof HTMLElement
      ? document.createElement(template.tagName.toLowerCase())
      : document.createElement("span");
    if (template instanceof HTMLElement) {
      const innerClass = String(template.getAttribute("class") || "").trim();
      if (innerClass) inner.setAttribute("class", innerClass);
    } else {
      inner.className = "_ButtonInner_f5tnh_2";
    }
    inner.appendChild(icon);
    button.appendChild(inner);
  };

  const hideSidebarActionTooltip = () => {
    if (sidebarActionTooltipTimer) {
      window.clearTimeout(sidebarActionTooltipTimer);
      sidebarActionTooltipTimer = 0;
    }
    document.getElementById(sidebarActionTooltipId)?.remove();
    if (sidebarActionTooltipAnchor?.getAttribute("aria-describedby") === sidebarActionTooltipId) {
      sidebarActionTooltipAnchor.removeAttribute("aria-describedby");
    }
    sidebarActionTooltipAnchor = null;
  };

  const scheduleSidebarActionTooltip = (button, label, delay) => {
    if (disposed) return;
    hideSidebarActionTooltip();
    sidebarActionTooltipAnchor = button;
    sidebarActionTooltipTimer = window.setTimeout(() => {
      sidebarActionTooltipTimer = 0;
      if (disposed || sidebarActionTooltipAnchor !== button) return;
      if (button.isConnected === false || button.getClientRects().length === 0) {
        hideSidebarActionTooltip();
        return;
      }
      const tooltip = document.createElement("div");
      tooltip.setAttribute("id", sidebarActionTooltipId);
      tooltip.setAttribute("role", "tooltip");
      tooltip.setAttribute("data-side", "top");
      tooltip.setAttribute(
        "class",
        "z-50 w-fit select-none text-sm whitespace-normal break-words rounded-lg border border-token-border bg-token-dropdown-background text-token-foreground px-2 py-1",
      );
      const row = document.createElement("div");
      row.setAttribute("class", "flex items-center gap-2");
      const text = document.createElement("div");
      text.setAttribute("class", "min-w-0");
      text.textContent = label;
      row.appendChild(text);
      tooltip.appendChild(row);
      document.body.appendChild(tooltip);

      const anchorRect = button.getBoundingClientRect();
      const tooltipRect = tooltip.getBoundingClientRect();
      const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 1024;
      const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 768;
      const left = Math.min(
        viewportWidth - tooltipRect.width - 8,
        Math.max(8, anchorRect.left + ((anchorRect.width - tooltipRect.width) / 2)),
      );
      const topAbove = anchorRect.top - tooltipRect.height - 8;
      const placeAbove = topAbove >= 8;
      const top = placeAbove
        ? topAbove
        : Math.min(viewportHeight - tooltipRect.height - 8, anchorRect.bottom + 8);
      tooltip.setAttribute("data-side", placeAbove ? "top" : "bottom");
      tooltip.style.left = `${left}px`;
      tooltip.style.top = `${Math.max(8, top)}px`;
      button.setAttribute("aria-describedby", sidebarActionTooltipId);
    }, delay);
  };

  const attachSidebarActionTooltip = (button, label) => {
    // Existing action buttons survive reinjection. Dispatch their interactions
    // through the current installation instead of reviving a disposed timer.
    const show = (delay) => window.__codeySessionToolsInstall?.tooltip?.show(button, label, delay);
    const hide = () => window.__codeySessionToolsInstall?.tooltip?.hide(button);
    const hideAll = () => window.__codeySessionToolsInstall?.tooltip?.hide();
    button.addEventListener("mouseenter", () => {
      show(400);
    });
    button.addEventListener("mouseleave", hide);
    button.addEventListener("focus", () => {
      show(0);
    });
    button.addEventListener("blur", hide);
    button.addEventListener("pointerdown", hideAll);
    button.addEventListener("click", hideAll);
  };

  const encodeBase64Bytes = (bytes) => {
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    }
    return btoa(binary);
  };

  const decodeBase64Bytes = (encoded) => {
    const binary = atob(String(encoded || ""));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  };

  const downloadSessionFallback = (filename, chunks) => {
    const blob = new Blob(chunks, { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const openSessionExportWriter = async (filename) => {
    if (typeof window.showSaveFilePicker !== "function") return null;
    const handle = await window.showSaveFilePicker({
      suggestedName: filename,
      types: [{
        description: "CodeyX 会话数据",
        accept: { "application/json": [".json"] },
      }],
    });
    return handle.createWritable();
  };

  const exportSession = async (thread, button) => {
    const sessionId = threadSessionIdFromRow(thread);
    if (!sessionId || sessionId.startsWith("client-new-thread:")) {
      showRuntimeToast("导出失败：无法识别会话 ID", "error");
      return;
    }
    button.disabled = true;
    button.dataset.busy = "true";
    let transferId = "";
    let writable = null;
    try {
      const start = await callBridge("/session/export/start", { sessionId });
      if (start?.status === "failed") {
        throw new Error(start.message || "未知错误");
      }
      if (start?.status !== "ready" || !start.transferId || !start.filename) {
        throw new Error("导出准备结果不完整");
      }
      transferId = start.transferId;
      try {
        writable = await openSessionExportWriter(start.filename);
      } catch (error) {
        if (error?.name === "AbortError") return;
        throw error;
      }
      const exportSize = Number(start.size);
      if (!Number.isSafeInteger(exportSize) || exportSize < 0) {
        throw new Error("导出文件大小无效");
      }
      if (!writable && exportSize > fallbackSessionExportMaxBytes) {
        throw new Error("当前环境不支持大文件流式保存，请升级 Codex 后重试");
      }

      const fallbackChunks = [];
      let offset = 0;
      while (true) {
        const chunk = await callBridge("/session/export/chunk", {
          transferId,
          offset,
        });
        if (chunk?.status === "failed") {
          throw new Error(chunk.message || "读取导出分块失败");
        }
        if (chunk?.status !== "ok" || chunk.offset !== offset || typeof chunk.data !== "string") {
          throw new Error("导出分块结果不完整");
        }
        const bytes = decodeBase64Bytes(chunk.data);
        if (writable) await writable.write(bytes);
        else fallbackChunks.push(bytes);
        const nextOffset = Number(chunk.nextOffset);
        if (
          !Number.isSafeInteger(nextOffset)
          || nextOffset !== offset + bytes.length
          || nextOffset > exportSize
          || Boolean(chunk.done) !== (nextOffset === exportSize)
        ) {
          throw new Error("导出分块偏移无效");
        }
        offset = nextOffset;
        if (chunk.done) break;
      }
      if (writable) {
        await writable.close();
        writable = null;
      } else {
        downloadSessionFallback(start.filename, fallbackChunks);
      }
      const finish = await callBridge("/session/export/finish", { transferId });
      if (finish?.status !== "ok") {
        throw new Error(finish?.message || "清理导出临时文件失败");
      }
      transferId = "";
      showRuntimeToast(`已导出会话：${start.filename}`);
    } catch (error) {
      try {
        await writable?.abort?.();
      } catch {}
      showRuntimeToast(`导出失败：${error instanceof Error ? error.message : String(error)}`, "error");
    } finally {
      if (transferId) {
        void callBridge("/session/export/abort", { transferId }).catch(() => {});
      }
      button.disabled = false;
      delete button.dataset.busy;
    }
  };

  const installSessionExportButtons = (root = document) => {
    queryWithin(root,
      "[data-app-action-sidebar-thread-id][data-app-action-sidebar-thread-title]",
    ).forEach((thread) => {
      if (
        !(thread instanceof HTMLElement)
        || thread.querySelector(`[${sessionExportAttribute}]`)
      ) return;
      const sessionId = String(thread.getAttribute("data-app-action-sidebar-thread-id") || "").trim();
      if (!sessionId) return;
      const archiveControl = findArchiveControl(thread);
      if (!(archiveControl instanceof HTMLElement)) return;
      const placementTarget = archivePlacementTarget(thread, archiveControl);
      if (placementTarget.parentElement instanceof HTMLElement && placementTarget.parentElement !== thread) {
        placementTarget.parentElement.setAttribute("data-codey-session-action-row", "true");
      }
      const button = document.createElement("button");
      button.type = "button";
      button.setAttribute(sessionExportAttribute, "true");
      button.setAttribute("aria-label", "导出会话数据");
      inheritNativeButtonClass(button, archiveControl);
      button.innerHTML = sessionExportIcon;
      wrapNativeButtonIcon(button, archiveControl);
      attachSidebarActionTooltip(button, "导出会话数据");
      ["pointerdown", "mousedown", "mouseup", "touchstart"].forEach((eventName) => {
        button.addEventListener(eventName, stopSidebarActionEvent, true);
      });
      button.addEventListener("click", (event) => {
        stopSidebarActionEvent(event);
        void exportSession(thread, button);
      }, true);
      placementTarget.insertAdjacentElement("beforebegin", button);
    });
  };

  const installTasksImportButton = (root = document) => {
    queryWithin(root, "[data-app-action-sidebar-section]").forEach((section) => {
      if (!(section instanceof HTMLElement) || section.querySelector(`[${tasksImportAttribute}]`)) return;
      const heading = String(
        section.getAttribute("data-app-action-sidebar-section-heading") || "",
      ).trim().toLowerCase();
      const sectionToggle = section.querySelector("[data-app-action-sidebar-section-toggle]");
      const localizedHeading = String(sectionToggle?.textContent || "").trim().toLowerCase();
      if (!taskListSectionHeadings.has(heading) && !taskListSectionHeadings.has(localizedHeading)) return;
      const titleRow = sectionToggle?.parentElement?.parentElement?.parentElement;
      if (!(titleRow instanceof HTMLElement)) return;
      const headerControls = [...titleRow.querySelectorAll("button, [role=button]")]
        .filter((control) => control instanceof HTMLElement && control !== sectionToggle);
      const optionsControl = headerControls.find((control) => {
        const label = String(control.getAttribute("aria-label") || "").trim();
        return /任务侧边栏选项|聊天侧边栏选项|task sidebar options|chat sidebar options/i.test(label);
      });
      const newTaskControl = headerControls.find((control) => {
        const label = String(control.getAttribute("aria-label") || "").trim();
        return /新建任务|新对话|new task|new chat/i.test(label);
      });
      if (!(optionsControl instanceof HTMLElement) || !(optionsControl.parentElement instanceof HTMLElement)) return;
      const button = document.createElement("button");
      button.type = "button";
      button.setAttribute(tasksImportAttribute, "true");
      button.setAttribute("aria-label", "导入会话数据");
      inheritNativeButtonClass(button, newTaskControl || optionsControl);
      button.innerHTML = projectImportIcon;
      wrapNativeButtonIcon(button, newTaskControl || optionsControl);
      attachSidebarActionTooltip(button, "导入会话数据");
      ["pointerdown", "mousedown", "mouseup", "touchstart"].forEach((eventName) => {
        button.addEventListener(eventName, stopSidebarActionEvent, true);
      });
      button.addEventListener("click", (event) => {
        stopSidebarActionEvent(event);
        chooseSessionImportFile("", button);
      }, true);
      optionsControl.insertAdjacentElement("beforebegin", button);
    });
  };

  const isLocalProjectPath = (value) => {
    const path = String(value || "").trim();
    return path.startsWith("/") || path.startsWith("\\\\") || /^[A-Za-z]:[\\/]/.test(path);
  };

  const projectPathFromReactValue = (value, projectId, depth = 0, seen = new WeakSet()) => {
    if (!value || (typeof value !== "object" && typeof value !== "function") || depth > 6) return "";
    if (seen.has(value)) return "";
    seen.add(value);
    const valueProjectId = String(value.projectId || value.id || "");
    if (valueProjectId === projectId) {
      const path = [
        value.path,
        value.rootPaths?.[0],
        value.repoPath,
        value.cwd,
      ].find(isLocalProjectPath);
      if (path) return String(path).trim();
    }
    const priorityKeys = ["group", "groups", "actions", "children", "tooltipContent"];
    const keys = [
      ...priorityKeys.filter((key) => Object.prototype.hasOwnProperty.call(value, key)),
      ...Object.keys(value).filter((key) => !priorityKeys.includes(key)),
    ].slice(0, 120);
    for (const key of keys) {
      if (["return", "child", "sibling", "stateNode", "_owner"].includes(key)) continue;
      let path = "";
      try {
        path = projectPathFromReactValue(value[key], projectId, depth + 1, seen);
      } catch {
        continue;
      }
      if (path) return path;
    }
    return "";
  };

  const projectPathFromRow = (project) => {
    const projectId = String(project.getAttribute("data-app-action-sidebar-project-id") || "").trim();
    if (isLocalProjectPath(projectId)) return projectId;
    const reactKey = Object.keys(project).find((key) => (
      key.startsWith("__reactFiber$") || key.startsWith("__reactInternalInstance$")
    ));
    let fiber = reactKey ? project[reactKey] : null;
    for (let depth = 0; fiber && depth < 18; depth += 1, fiber = fiber.return) {
      const path = projectPathFromReactValue(fiber.memoizedProps, projectId)
        || projectPathFromReactValue(fiber.pendingProps, projectId);
      if (path) return path;
    }
    return "";
  };

  const normalizeThreadSessionId = (value) => (
    String(value || "").trim().replace(/^local:/, "")
  );

  const isCanonicalThreadSessionId = (value) => (
    /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value)
  );

  const canonicalThreadSessionIdFromReactValue = (
    value,
    depth = 0,
    seen = new WeakSet(),
  ) => {
    if (!value || typeof value !== "object" || depth > 5 || seen.has(value)) return "";
    seen.add(value);
    const direct = normalizeThreadSessionId(value.conversationId);
    if (isCanonicalThreadSessionId(direct)) return direct;
    if (Array.isArray(value)) {
      for (const item of value.slice(0, 32)) {
        const nested = canonicalThreadSessionIdFromReactValue(item, depth + 1, seen);
        if (nested) return nested;
      }
      return "";
    }
    for (const key of ["entry", "tooltipContent", "children", "props"]) {
      const nested = canonicalThreadSessionIdFromReactValue(value[key], depth + 1, seen);
      if (nested) return nested;
    }
    return "";
  };

  const threadSessionIdFromRow = (row) => {
    const rowSessionId = normalizeThreadSessionId(
      row.getAttribute("data-app-action-sidebar-thread-id"),
    );
    if (!rowSessionId.startsWith("client-new-thread:")) return rowSessionId;
    const reactKey = Object.keys(row).find((key) => (
      key.startsWith("__reactFiber$") || key.startsWith("__reactInternalInstance$")
    ));
    let fiber = reactKey ? row[reactKey] : null;
    for (let depth = 0; fiber && depth < 18; depth += 1, fiber = fiber.return) {
      const sessionId = canonicalThreadSessionIdFromReactValue(fiber.memoizedProps)
        || canonicalThreadSessionIdFromReactValue(fiber.pendingProps);
      if (sessionId) return sessionId;
    }
    return rowSessionId;
  };

  const threadIdentityNode = (row) => (
    row?.hasAttribute?.("data-app-action-sidebar-thread-id")
      ? row
      : row?.querySelector?.("[data-app-action-sidebar-thread-id]")
  );

  const numericThreadTimestamp = (value) => {
    const timestamp = Number(value);
    return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : 0;
  };

  const threadTimestampValueToMs = (value) => {
    const timestamp = numericThreadTimestamp(value);
    if (!timestamp) return 0;
    return timestamp < 1_000_000_000_000 ? timestamp * 1_000 : timestamp;
  };

  const uuidV7ThreadTimestampMs = (sessionId) => {
    const id = normalizeThreadSessionId(sessionId).replaceAll("-", "");
    if (!/^[0-9a-fA-F]{12}/.test(id)) return 0;
    const timestamp = Number.parseInt(id.slice(0, 12), 16);
    return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : 0;
  };

  const threadTimestampMsFromPayload = (payload) => (
    numericThreadTimestamp(payload?.recency_at_ms ?? payload?.recencyAtMs)
    || threadTimestampValueToMs(payload?.recency_at ?? payload?.recencyAt)
    || numericThreadTimestamp(payload?.updated_at_ms ?? payload?.updatedAtMs)
    || threadTimestampValueToMs(payload?.updated_at ?? payload?.updatedAt)
    || numericThreadTimestamp(payload?.created_at_ms ?? payload?.createdAtMs)
    || threadTimestampValueToMs(payload?.created_at ?? payload?.createdAt)
    || uuidV7ThreadTimestampMs(
      payload?.id ?? payload?.thread_id ?? payload?.threadId
      ?? payload?.conversation_id ?? payload?.conversationId
      ?? payload?.session_id ?? payload?.sessionId,
    )
  );

  const formatRelativeThreadTime = (timestampMs, nowMs = Date.now()) => {
    const timestamp = numericThreadTimestamp(timestampMs);
    if (!timestamp) return "";
    const elapsedSeconds = Math.max(0, Math.floor((nowMs - timestamp) / 1_000));
    if (elapsedSeconds < 60) return "刚刚";
    const minutes = Math.floor(elapsedSeconds / 60);
    if (minutes < 60) return `${minutes} 分`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours} 小时`;
    const days = Math.floor(hours / 24);
    if (days < 7) return `${days} 天`;
    const weeks = Math.floor(days / 7);
    if (weeks < 5) return `${weeks} 周`;
    const months = Math.floor(days / 30);
    if (days < 365) return `${Math.max(1, months)} 月`;
    return `${Math.max(1, Math.floor(days / 365))} 年`;
  };

  const threadUpdatedAtPlacement = (row, label) => {
    const contentRoot = [...(row.children || [])].find((child) => (
      String(child.className || "").includes("h-full w-full items-center")
    ));
    if (contentRoot) {
      const children = [...(contentRoot.children || [])].filter((child) => child !== label);
      const mainContentIndex = children.findIndex((child) => {
        const className = String(child.className || "");
        return className.includes("min-w-0") && className.includes("flex-1");
      });
      const trailing = mainContentIndex >= 0 ? children.slice(mainContentIndex + 1) : [];
      return {
        before: mainContentIndex >= 0 ? children[mainContentIndex + 1] || null : null,
        mount: contentRoot,
        statusRail: trailing[0] || null,
        trailing,
      };
    }
    const titleNode = row.querySelector?.(
      "[data-thread-title], [data-app-action-sidebar-thread-title], .truncate.select-none, .truncate.text-base",
    );
    return { before: null, mount: titleNode?.parentElement || row, statusRail: null, trailing: [] };
  };

  const hasNativeThreadStatus = (row, label) => {
    if (nativeReactThreadStatusVisible(row)) return true;
    const { trailing } = threadUpdatedAtPlacement(row, label);
    const candidates = (trailing || []).filter((child) => (
      child instanceof HTMLElement
      && child !== label
      && !child.hasAttribute?.(threadUpdatedAtAttribute)
    ));
    for (const candidate of candidates) {
      if (nativeElementLooksLikeThreadStatus(candidate)) return true;
    }
    return false;
  };

  const nativeReactThreadStatusState = (row) => {
    if (!(row instanceof HTMLElement)) return null;
    // Codex owns the canonical loading/unread flags even when its status icon
    // is moved or updated without adding a new element to the trailing rail.
    const fiberKey = Object.keys(row).find((key) => key.startsWith("__reactFiber$"));
    let fiber = fiberKey ? row[fiberKey] : null;
    for (let depth = 0; fiber && depth < 12; depth += 1, fiber = fiber.return) {
      const statusState = fiber.memoizedProps?.statusState || fiber.pendingProps?.statusState;
      if (!statusState || typeof statusState !== "object") continue;
      return statusState;
    }
    return null;
  };

  const nativeThreadStatusTypeLooksActive = (value) => (
    /^(?:loading|processing|running|working|streaming|generating|in(?:[_ -]?progress))$/i
      .test(String(value || "").trim())
  );

  const nativeReactThreadStatusVisible = (row) => {
    const statusState = nativeReactThreadStatusState(row);
    if (!statusState) return false;
    return statusState.unread === true || nativeThreadStatusTypeLooksActive(statusState.type);
  };

  const nativeThreadStatusClassPattern = /\b(?:animate-|spinner)\b/i;

  const nativeElementLooksLikeThreadStatus = (element) => {
    if (!(element instanceof HTMLElement)) return false;
    if (element.matches?.("button, [role=button], [role=menuitem]")) return false;
    const statusText = [
      element.textContent || "",
      element.getAttribute?.("aria-label") || "",
      element.getAttribute?.("role") || "",
      element.getAttribute?.("title") || "",
      element.title || "",
    ].join(" ");
    // A completed marker can remain on the active row until another thread is
    // selected. Only active work should temporarily displace the timestamp.
    if (/(running|processing|working|loading|streaming|generating|in progress|运行中|进行中|处理中|加载中|生成中)/i.test(statusText)) return true;
    const className = String(element.className || "");
    if (nativeThreadStatusClassPattern.test(className)) return true;
    return [...(element.children || [])].some((child) => nativeElementLooksLikeThreadStatus(child));
  };

  const nativeThreadWorkState = (row) => {
    const statusState = nativeReactThreadStatusState(row);
    const completed = /^(?:complete(?:d)?|finished|done|error|failed|failure|interrupted|cancelled|canceled|stopped)$/i
      .test(String(statusState?.type || "").trim());
    const { trailing } = threadUpdatedAtPlacement(row);
    return {
      completed,
      workInProgress: !completed && (
        nativeThreadStatusTypeLooksActive(statusState?.type)
        || (trailing || []).some((candidate) => nativeElementLooksLikeThreadStatus(candidate))
      ),
    };
  };

  const threadKindFromRow = (row) => {
    const identity = threadIdentityNode(row);
    return String(
      identity?.getAttribute?.("data-app-action-sidebar-thread-kind")
      || row?.getAttribute?.("data-app-action-sidebar-thread-kind")
      || "",
    ).trim();
  };

  const threadHostIdFromRow = (row) => {
    if (threadKindFromRow(row) === "remote") return "remote";
    const identity = threadIdentityNode(row);
    return String(
      identity?.getAttribute?.("data-app-action-sidebar-thread-host-id")
      || row?.getAttribute?.("data-app-action-sidebar-thread-host-id")
      || "local",
    ).trim() || "local";
  };

  const remoteThreadTaskFromRow = (row, sessionId) => {
    const identity = threadIdentityNode(row) || row;
    if (!(identity instanceof HTMLElement)) return null;
    const expectedTaskId = normalizeThreadSessionId(sessionId).replace(/^remote:/, "");
    const reactKey = Object.keys(identity).find((key) => (
      key.startsWith("__reactFiber$") || key.startsWith("__reactInternalInstance$")
    ));
    let fiber = reactKey ? identity[reactKey] : null;
    for (let depth = 0; fiber && depth < 18; depth += 1, fiber = fiber.return) {
      for (const props of [fiber.memoizedProps, fiber.pendingProps]) {
        const task = props?.task ?? props?.entry?.task;
        if (!task || typeof task !== "object") continue;
        const taskId = String(task.id || "").trim();
        if (!expectedTaskId || !taskId || taskId === expectedTaskId) return task;
      }
    }
    return null;
  };

  const threadTimestampCacheKey = (hostId, sessionId) => (
    `${String(hostId || "local").trim() || "local"}\u0000${normalizeThreadSessionId(sessionId)}`
  );

  const threadProjectListIdFromRow = (row) => String(
    row?.closest?.(sidebarProjectListSelector)
      ?.getAttribute?.("data-app-action-sidebar-project-list-id")
    || "",
  ).trim();

  const cancelThreadRunningRecheck = (cacheKey) => {
    if (!threadRunningRecheckTimers.has(cacheKey)) return;
    window.clearTimeout(threadRunningRecheckTimers.get(cacheKey));
    threadRunningRecheckTimers.delete(cacheKey);
  };

  const threadObservationMatchesRow = (row, observation, cacheKey) => (
    observation?.cacheKey === cacheKey
    && observation.hostId === threadHostIdFromRow(row)
    && observation.sessionId === threadSessionIdFromRow(threadIdentityNode(row) || row)
  );

  const syncThreadRunningRows = (cacheKey, workInProgress) => {
    forEachTrackedThreadRow((row) => {
      const observation = threadWorkStateByRow.get(row);
      if (!threadObservationMatchesRow(row, observation, cacheKey)) return;
      // 其他列表未更新的运行图标仍属于上一轮，需先观测到非运行状态，
      // 该行后续的运行信号才可启动新一轮。
      if (!workInProgress && observation.detectedWorkInProgress) observation.suppressed = true;
      updateThreadRunningPriority(row, workInProgress);
    });
  };

  const finishThreadRunningState = (cacheKey, state) => {
    state.workInProgress = false;
    state.missingSince = null;
    state.completionVersion = (state.completionVersion || 0) + 1;
    rememberBoundedMapValue(threadRunningStateByCacheKey, cacheKey, state);
    cancelThreadRunningRecheck(cacheKey);
    syncThreadRunningRows(cacheKey, false);
    return false;
  };

  const hasObservedThreadWorkInProgress = (cacheKey) => {
    let running = false;
    forEachTrackedThreadRow((row) => {
      const observation = threadWorkStateByRow.get(row);
      if (observation?.detectedWorkInProgress && !observation.suppressed
        && threadObservationMatchesRow(row, observation, cacheKey)) running = true;
    });
    return running;
  };

  const scheduleThreadRunningRecheck = (cacheKey, delayMs) => {
    if (disposed || !cacheKey || threadRunningRecheckTimers.has(cacheKey)) return;
    const timer = window.setTimeout(() => {
      threadRunningRecheckTimers.delete(cacheKey);
      if (disposed) return;
      const state = threadRunningStateByCacheKey.get(cacheKey);
      if (!state || !Number.isFinite(state.missingSince)) return;
      const remainingMs = threadRunningLossGraceMs - (Date.now() - state.missingSince);
      if (remainingMs > 0) {
        scheduleThreadRunningRecheck(cacheKey, remainingMs);
        return;
      }
      refreshTrackedThreadUpdatedTimes();
      const current = threadRunningStateByCacheKey.get(cacheKey);
      if (current?.workInProgress && Number.isFinite(current.missingSince)
        && Date.now() - current.missingSince >= threadRunningLossGraceMs) {
        finishThreadRunningState(cacheKey, current);
      }
    }, Math.max(0, Number(delayMs) || 0));
    threadRunningRecheckTimers.set(cacheKey, timer);
  };

  const stableThreadWorkInProgress = (
    cacheKey,
    detectedWorkInProgress,
    completed = false,
    runningContext = {},
    now = Date.now(),
  ) => {
    if (!cacheKey) return detectedWorkInProgress;
    const state = threadRunningStateByCacheKey.get(cacheKey);
    if (completed) return finishThreadRunningState(cacheKey, { ...state, ...runningContext });
    if (detectedWorkInProgress) {
      rememberBoundedMapValue(
        threadRunningStateByCacheKey,
        cacheKey,
        {
          ...(threadRunningStateByCacheKey.get(cacheKey) || {}),
          ...runningContext,
          missingSince: null,
          workInProgress: true,
        },
      );
      cancelThreadRunningRecheck(cacheKey);
      return true;
    }
    if (!state?.workInProgress) return false;
    if (runningContext.sessionId) state.sessionId = runningContext.sessionId;
    if (runningContext.hostId) state.hostId = runningContext.hostId;
    if (runningContext.projectListId) state.projectListId = runningContext.projectListId;
    if (hasObservedThreadWorkInProgress(cacheKey)) {
      state.missingSince = null;
      cancelThreadRunningRecheck(cacheKey);
      return true;
    }
    if (!Number.isFinite(state.missingSince)) {
      state.missingSince = now;
      rememberBoundedMapValue(threadRunningStateByCacheKey, cacheKey, state);
    }
    const remainingMs = threadRunningLossGraceMs - (now - state.missingSince);
    if (remainingMs > 0) {
      scheduleThreadRunningRecheck(cacheKey, remainingMs);
      return true;
    }
    return finishThreadRunningState(cacheKey, state);
  };

  const sidebarThreadTimestampState = (row, now = Date.now()) => {
    const nativeState = nativeThreadWorkState(row);
    const detectedWorkInProgress = nativeState.workInProgress;
    const identity = threadIdentityNode(row);
    if (!(identity instanceof HTMLElement)) {
      return {
        cacheKey: "",
        completedWork: false,
        hostId: "local",
        sessionId: "",
        workInProgress: detectedWorkInProgress,
      };
    }
    const sessionId = normalizeThreadSessionId(threadSessionIdFromRow(identity));
    const hostId = threadHostIdFromRow(row);
    const kind = threadKindFromRow(row);
    if (!sessionId) {
      return {
        cacheKey: "",
        completedWork: false,
        hostId,
        kind,
        sessionId: "",
        workInProgress: detectedWorkInProgress,
      };
    }
    const cacheKey = threadTimestampCacheKey(hostId, sessionId);
    const previous = threadWorkStateByRow.get(row);
    // 仅在临时会话获得正式 ID 时迁移状态；复用行或切换主机不能迁移其他
    // 会话的运行状态，也不能取消其复查定时器。
    if (previous?.cacheKey !== cacheKey && previous?.hostId === hostId
      && previous?.sessionId?.startsWith("client-new-thread:")
      && !sessionId.startsWith("client-new-thread:")) {
      const previousRunningState = threadRunningStateByCacheKey.get(previous.cacheKey);
      if (previousRunningState && !threadRunningStateByCacheKey.has(cacheKey)) {
        rememberBoundedMapValue(
          threadRunningStateByCacheKey,
          cacheKey,
          { ...previousRunningState, hostId, sessionId },
        );
      }
      threadRunningStateByCacheKey.delete(previous.cacheKey);
      cancelThreadRunningRecheck(previous.cacheKey);
    }
    const shared = threadRunningStateByCacheKey.get(cacheKey);
    const sameIdentity = previous?.cacheKey === cacheKey;
    const observation = {
      cacheKey,
      completionVersion: shared?.completionVersion || 0,
      detectedWorkInProgress,
      hostId,
      nativeCompleted: nativeState.completed,
      sessionId,
      suppressed: detectedWorkInProgress && sameIdentity && (
        previous.suppressed === true
        || (previous.detectedWorkInProgress && (
          shared?.workInProgress === false
          || (previous.completionVersion || 0) < (shared?.completionVersion || 0)
        ))
      ),
    };
    threadWorkStateByRow.set(row, observation);
    const previouslyRunning = shared?.workInProgress === true;
    const workInProgress = stableThreadWorkInProgress(
      cacheKey,
      detectedWorkInProgress && !observation.suppressed,
      nativeState.completed && (!sameIdentity || !previous.nativeCompleted),
      {
        hostId,
        projectListId: threadProjectListIdFromRow(row),
        sessionId,
      },
      now,
    );
    const completedWork = previouslyRunning && !workInProgress;
    if (!previouslyRunning && workInProgress) syncThreadRunningRows(cacheKey, true);
    return {
      cacheKey,
      completedWork,
      hostId,
      kind,
      sessionId,
      workInProgress,
    };
  };

  const syncRemoteThreadUpdatedAt = (row, state) => {
    if (state.kind !== "remote") return false;
    pendingThreadUpdatedAtRefs.delete(state.cacheKey);
    threadUpdatedAtRequestedAt.delete(state.cacheKey);
    const task = remoteThreadTaskFromRow(row, state.sessionId);
    if (!task) return true;
    const timestamp = threadTimestampMsFromPayload(task);
    if (!timestamp) {
      threadUpdatedAtCache.delete(state.cacheKey);
    } else {
      rememberBoundedMapValue(threadUpdatedAtCache, state.cacheKey, timestamp);
    }
    updateThreadUpdatedAt(row, timestamp);
    return true;
  };

  const sidebarThreadListItem = (row) => {
    let current = threadIdentityNode(row) || row;
    while (current instanceof HTMLElement) {
      if (
        current.getAttribute?.("role") === "listitem"
        && !current.querySelector?.("[data-app-action-sidebar-project-row]")
      ) return current;
      const parent = current.parentElement;
      if (!(parent instanceof HTMLElement)) break;
      if (
        parent.getAttribute?.("role") === "list"
        || parent.hasAttribute?.("data-app-action-sidebar-project-list-id")
      ) return current;
      current = parent;
    }
    return row instanceof HTMLElement ? row : null;
  };

  const updateThreadRunningPriority = (row, workInProgress) => {
    const item = sidebarThreadListItem(row);
    if (!(item instanceof HTMLElement)) return;
    if (workInProgress) {
      if (item.getAttribute(threadRunningAttribute) !== "true") {
        item.setAttribute(threadRunningAttribute, "true");
      }
    } else if (item.hasAttribute(threadRunningAttribute)) {
      item.removeAttribute(threadRunningAttribute);
    }
  };

  const projectThreadSessionIdsFromReact = (projectList) => {
    const sessionIds = new Set();
    if (!(projectList instanceof HTMLElement)) return sessionIds;
    const reactKey = Object.keys(projectList).find((key) => (
      key.startsWith("__reactFiber$") || key.startsWith("__reactInternalInstance$")
    ));
    let fiber = reactKey ? projectList[reactKey] : null;
    for (let depth = 0; fiber && depth < 8; depth += 1, fiber = fiber.return) {
      for (const props of [fiber.memoizedProps, fiber.pendingProps]) {
        const threadKeys = Array.isArray(props?.threadKeys)
          ? props.threadKeys
          : props?.group?.threadKeys;
        if (!Array.isArray(threadKeys)) continue;
        threadKeys.slice(0, maxSessionCacheEntries).forEach((threadKey) => {
          const sessionId = normalizeThreadSessionId(
            typeof threadKey === "string"
              ? threadKey
              : threadKey?.sessionId ?? threadKey?.threadId ?? threadKey?.id,
          );
          if (sessionId) sessionIds.add(sessionId);
        });
        return sessionIds;
      }
    }
    return sessionIds;
  };

  const visibleProjectThreadSessionIds = (projectList) => new Set(
    queryWithin(projectList, sidebarThreadRowSelector)
      .map((row) => threadIdentityNode(row) || row)
      .filter((row) => row instanceof HTMLElement)
      .map((row) => normalizeThreadSessionId(threadSessionIdFromRow(row)))
      .filter(Boolean),
  );

  const projectListIsExpanded = (projectList) => {
    const projectItem = projectList.closest?.('[role="listitem"]');
    if (!(projectItem instanceof HTMLElement)) return true;
    const toggle = queryWithin(projectItem, "button, [role=button]").find((button) => (
      !button.closest?.(sidebarProjectListSelector)
      && button.getAttribute?.("aria-expanded") != null
    ));
    return !toggle || toggle.getAttribute("aria-expanded") === "true";
  };

  const projectShowAllButtonText = (button) => String(
    button?.textContent
    || button?.innerText
    || button?.getAttribute?.("aria-label")
    || button?.getAttribute?.("title")
    || "",
  ).replace(/\s+/g, " ").trim();

  const projectShowAllButton = (projectList) => queryWithin(
    projectList,
    "button, [role=button]",
  ).find((button) => (
    !button.disabled
    && button.getAttribute?.("aria-disabled") !== "true"
    && !button.closest?.(sidebarThreadRowSelector)
    && /^(?:展开显示|继续展开|显示更多|查看更多|加载更多|全部显示|显示全部|Show more|Load more|Show all)$/i
      .test(projectShowAllButtonText(button))
  )) || null;

  const projectListsForRunningRecovery = (root) => {
    const directLists = queryWithin(root, sidebarProjectListSelector);
    if (directLists.length || !(root instanceof HTMLElement)) return directLists;
    const projectItem = root.closest?.('[role="listitem"]');
    return projectItem instanceof HTMLElement
      ? queryWithin(projectItem, sidebarProjectListSelector)
      : directLists;
  };

  const recoverHiddenRunningThreads = (root = document) => {
    if (!threadRunningStateByCacheKey.size) return;
    const runningStates = [...threadRunningStateByCacheKey.values()]
      .filter((state) => state?.sessionId && state.workInProgress);
    if (!runningStates.length) return;
    const now = Date.now();
    projectListsForRunningRecovery(root).forEach((projectList) => {
      if (!(projectList instanceof HTMLElement)) return;
      if (projectList.getAttribute(sidebarProjectShowAllAttribute) === "true") return;
      if (!projectListIsExpanded(projectList)) return;
      const projectListId = String(
        projectList.getAttribute("data-app-action-sidebar-project-list-id") || "",
      ).trim();
      const allSessionIds = projectThreadSessionIdsFromReact(projectList);
      const visibleSessionIds = visibleProjectThreadSessionIds(projectList);
      const hasHiddenRunningThread = runningStates.some((state) => {
        const sessionId = normalizeThreadSessionId(state.sessionId);
        if (!sessionId || visibleSessionIds.has(sessionId)) return false;
        if (allSessionIds.has(sessionId)) return true;
        return !allSessionIds.size
          && Boolean(projectListId)
          && state.projectListId === projectListId;
      });
      if (!hasHiddenRunningThread) return;
      const lastClickedAt = projectRunningRecoveryClickedAt.get(projectList) || 0;
      if (now - lastClickedAt < projectRunningRecoveryClickCooldownMs) return;
      const button = projectShowAllButton(projectList);
      if (!(button instanceof HTMLElement) || typeof button.click !== "function") return;
      projectRunningRecoveryClickedAt.set(projectList, now);
      try {
        button.click();
      } catch {
        projectRunningRecoveryClickedAt.delete(projectList);
      }
    });
  };

  const placeThreadUpdatedAt = (row, label) => {
    const { before, mount } = threadUpdatedAtPlacement(row, label);
    if (!(mount instanceof HTMLElement)) return;
    const children = [...(mount.children || [])];
    const labelIndex = children.indexOf(label);
    if (before instanceof HTMLElement) {
      const beforeIndex = children.indexOf(before);
      if (label.parentElement !== mount || labelIndex !== beforeIndex - 1) {
        mount.insertBefore(label, before);
      }
    } else if (label.parentElement !== mount || labelIndex !== children.length - 1) {
      mount.appendChild(label);
    }
  };

  const updateThreadUpdatedAt = (row, timestampMs) => {
    if (!(row instanceof HTMLElement)) return;
    const timestamp = numericThreadTimestamp(timestampMs);
    const labels = [...(row.querySelectorAll?.(`[${threadUpdatedAtAttribute}]`) || [])];
    let label = labels.shift() || null;
    labels.forEach((duplicate) => duplicate.remove());
    if (!timestamp) {
      label?.remove();
      return;
    }
    if (hasNativeThreadStatus(row, label)) {
      label?.remove();
      return;
    }
    if (!(label instanceof HTMLElement)) {
      label = document.createElement("time");
      label.setAttribute(threadUpdatedAtAttribute, "true");
    }
    // Codex reserves the native status/action rail with trailing siblings and
    // absolutely positioned icons. Keep the time immediately after the flexible
    // title region so it stays before that rail instead of covering its icons.
    placeThreadUpdatedAt(row, label);
    const relative = formatRelativeThreadTime(timestamp);
    const timestampText = String(timestamp);
    if (
      label.getAttribute(threadUpdatedAtMsAttribute) === timestampText
      && label.textContent === relative
    ) return;
    const date = new Date(timestamp);
    const fullTime = Number.isNaN(date.getTime()) ? "" : date.toLocaleString();
    const datetime = Number.isNaN(date.getTime()) ? "" : date.toISOString();
    const ariaLabel = `最后消息：${relative}${fullTime ? `（${fullTime}）` : ""}`;
    const title = fullTime ? `最后消息：${fullTime}` : "最后消息时间";
    label.setAttribute(threadUpdatedAtMsAttribute, timestampText);
    label.setAttribute("datetime", datetime);
    label.setAttribute("aria-label", ariaLabel);
    label.title = title;
    label.textContent = relative;
  };

  const renderCachedThreadUpdatedAt = (row) => {
    const identity = threadIdentityNode(row);
    if (!(identity instanceof HTMLElement)) return "";
    const sessionId = normalizeThreadSessionId(threadSessionIdFromRow(identity));
    if (!sessionId) return "";
    threadUpdatedAtRows.add(row);
    const timestamp = threadUpdatedAtCache.get(
      threadTimestampCacheKey(threadHostIdFromRow(row), sessionId),
    );
    updateThreadUpdatedAt(row, timestamp || 0);
    return sessionId;
  };

  const forEachTrackedThreadRow = (callback) => {
    threadUpdatedAtRows.forEach((row) => {
      if (!(row instanceof HTMLElement) || row.isConnected === false) {
        threadUpdatedAtRows.delete(row);
        return;
      }
      callback(row);
    });
  };

  const flushThreadUpdatedAtFetch = async () => {
    if (disposed || threadUpdatedAtFetchInFlight || !pendingThreadUpdatedAtRefs.size) return;
    const refs = [...pendingThreadUpdatedAtRefs.values()].slice(0, maxPendingThreadTimestampRefs);
    refs.forEach(({ cacheKey }) => pendingThreadUpdatedAtRefs.delete(cacheKey));
    threadUpdatedAtFetchInFlight = true;
    try {
      const sessionIds = [...new Set(refs.map(({ sessionId }) => sessionId))];
      const result = await callBridge(
        threadTimestampBridgePath,
        { sessionIds },
        { timeoutMs: threadTimestampFetchTimeoutMs },
      );
      if (disposed) return;
      if (result?.status !== "ok" || !result.timestamps || typeof result.timestamps !== "object") {
        throw new Error(result?.message || "CodeyX thread timestamp bridge is unavailable");
      }
      const refreshedCacheKeys = new Set();
      refs.forEach((ref) => {
        const timestamp = threadTimestampValueToMs(result.timestamps[ref.sessionId]);
        if (!timestamp) {
          threadUpdatedAtCache.delete(ref.cacheKey);
        } else {
          rememberBoundedMapValue(threadUpdatedAtCache, ref.cacheKey, timestamp);
        }
        rememberBoundedMapValue(threadUpdatedAtRequestedAt, ref.cacheKey, Date.now());
        refreshedCacheKeys.add(ref.cacheKey);
      });
      forEachTrackedThreadRow((row) => {
        const identity = threadIdentityNode(row);
        const sessionId = identity instanceof HTMLElement
          ? normalizeThreadSessionId(threadSessionIdFromRow(identity))
          : "";
        const cacheKey = threadTimestampCacheKey(threadHostIdFromRow(row), sessionId);
        if (refreshedCacheKeys.has(cacheKey)) renderCachedThreadUpdatedAt(row);
      });
    } catch {
      // A failed read keeps the previous label and waits for the ordinary
      // one-minute refresh. Never retry in a tight loop on the renderer thread.
      if (disposed) return;
      refs.forEach(({ cacheKey }) => {
        rememberBoundedMapValue(threadUpdatedAtRequestedAt, cacheKey, Date.now());
      });
    } finally {
      threadUpdatedAtFetchInFlight = false;
      if (!disposed && pendingThreadUpdatedAtRefs.size) {
        threadUpdatedAtFetchTimer = window.setTimeout(() => {
          threadUpdatedAtFetchTimer = 0;
          void flushThreadUpdatedAtFetch();
        }, 40);
      }
    }
  };

  const scheduleThreadUpdatedAtFetch = () => {
    if (disposed || threadUpdatedAtFetchTimer || threadUpdatedAtFetchInFlight || !pendingThreadUpdatedAtRefs.size) return;
    threadUpdatedAtFetchTimer = window.setTimeout(() => {
      threadUpdatedAtFetchTimer = 0;
      void flushThreadUpdatedAtFetch();
    }, 40);
  };

  const refreshThreadUpdatedAtRow = (row, now, forceRefresh = false) => {
    if (!(row instanceof HTMLElement)) return;
    const {
      cacheKey,
      completedWork,
      hostId,
      kind,
      sessionId,
      workInProgress,
    } = sidebarThreadTimestampState(row, now);
    updateThreadRunningPriority(row, workInProgress);
    renderCachedThreadUpdatedAt(row);
    if (!sessionId || sessionId.startsWith("client-new-thread:")) return;
    if (syncRemoteThreadUpdatedAt(row, {
      cacheKey,
      hostId,
      kind,
      sessionId,
    })) return;
    if (completedWork) threadUpdatedAtRequestedAt.delete(cacheKey);
    if (
      !forceRefresh
      && now - (threadUpdatedAtRequestedAt.get(cacheKey) || 0)
        < threadTimestampRefreshIntervalMs
    ) return;
    pendingThreadUpdatedAtRefs.set(cacheKey, {
      cacheKey,
      hostId,
      sessionId,
    });
    rememberBoundedMapValue(threadUpdatedAtRequestedAt, cacheKey, now);
  };

  const installThreadUpdatedTimes = (root = document, forceRefresh = false) => {
    const now = Date.now();
    // Virtualized sidebar rows can be replaced without another metadata
    // response. Release detached rows whenever an incremental/full scan runs.
    forEachTrackedThreadRow(() => {});
    queryWithin(root, "[data-app-action-sidebar-thread-row]").forEach((row) => {
      refreshThreadUpdatedAtRow(row, now, forceRefresh);
    });
    scheduleThreadUpdatedAtFetch();
  };

  const refreshTrackedThreadUpdatedTimes = (forceRefresh = false) => {
    if (disposed) return;
    const now = Date.now();
    // The mutation observer and deferred initial scan register visible rows.
    // Periodic and focus/page recovery only revisit those tracked rows, keeping
    // full-document work away from interaction-sensitive renderer events.
    forEachTrackedThreadRow((row) => {
      refreshThreadUpdatedAtRow(row, now, forceRefresh);
    });
    scheduleThreadUpdatedAtFetch();
  };

  const nativeRuntime = () => {
    const adapter = window.__codeyNativeRuntime;
    if (!adapter?.isActive?.()) throw new Error("Codex 原生接口适配尚未就绪");
    return adapter;
  };
  const loadCodexSessionController = async (options) => {
    if (disposed) throw new Error("会话工具已重新加载");
    const controller = await nativeRuntime().loadSessionController(options);
    if (disposed) throw new Error("会话工具已重新加载");
    return controller;
  };
  const getCodexSessionController = (feature) => loadCodexSessionController({ feature });

  const reconcileStaleCompletedTask = async () => {
    if (disposed || document.visibilityState === "hidden") return false;
    const sessionId = getSessionId();
    if (!sessionId) {
      completionReconcileSessionId = "";
      completionNextReconcileAt = 0;
      return false;
    }
    if (completionReconcileSessionId !== sessionId) {
      completionReconcileSessionId = sessionId;
      completionNextReconcileAt = 0;
    }
    const now = Date.now();
    if (completionReconcileInFlight || now < completionNextReconcileAt) return false;

    completionReconcileInFlight = true;
    completionNextReconcileAt = now + completedTaskReconcileIntervalMs;
    try {
      return await callNativeCompletionReconcileOperation(async (controller) => {
        if (
          disposed
          || controller?.kind !== "manager"
          || typeof controller.reconcileCompletedConversation !== "function"
          || document.visibilityState === "hidden"
          || getSessionId() !== sessionId
        ) return false;
        const reconciled = await controller.reconcileCompletedConversation({
          conversationId: sessionId,
          model: null,
          serviceTier: null,
          reasoningEffort: null,
          workspaceRoots: [],
          collaborationMode: null,
          showThreadGoalResumeConfirmation: false,
        });
        return reconciled === true
          && !disposed
          && document.visibilityState !== "hidden"
          && getSessionId() === sessionId;
      });
    } catch {
      // Asset discovery can race renderer patch injection. Retry on the next
      // lifecycle or DOM event instead of waiting for the 15 s interval.
      completionNextReconcileAt = Date.now() + 1_000;
      return false;
    } finally {
      completionReconcileInFlight = false;
      // A navigation event can arrive while the previous task is reconciling.
      // Check the newly visible task as soon as that operation settles.
      if (!disposed && getSessionId() !== sessionId) {
        completionNextReconcileAt = 0;
        void reconcileStaleCompletedTask();
      }
    }
  };

  const waitForNativeSessionOperation = (operation) => nativeRuntime().waitForOperation(operation);

  const callNativeCompletionReconcileOperation = async (operation) => {
    const controller = await loadCodexSessionController({ requireCompletionReconcile: true });
    return waitForNativeSessionOperation(() => operation(controller));
  };

  const refreshRecentLocalSessions = async () => {
    try {
      const controller = await getCodexSessionController("refresh");
      await waitForNativeSessionOperation(() => controller.refreshRecentConversations());
      return true;
    } catch {
      return false;
    }
  };

  const importSessionFile = async (projectPath, file, button) => {
    button.disabled = true;
    button.dataset.busy = "true";
    let transferId = "";
    try {
      const start = await callBridge("/session/import/start", {});
      if (start?.status === "failed") {
        throw new Error(start.message || "无法准备会话导入");
      }
      if (start?.status !== "ready" || !start.transferId || !start.chunkSize) {
        throw new Error("导入准备结果不完整");
      }
      transferId = start.transferId;
      const chunkSize = Number(start.chunkSize);
      if (!Number.isSafeInteger(chunkSize) || chunkSize <= 0) {
        throw new Error("导入分块大小无效");
      }
      const fileSize = Number(file?.size);
      if (
        Number.isFinite(fileSize)
        && Number.isFinite(Number(start.maxBytes))
        && fileSize > Number(start.maxBytes)
      ) {
        throw new Error(`导入文件超过 ${Math.floor(Number(start.maxBytes) / 1024 / 1024)} MB`);
      }

      let offset = 0;
      if (
        typeof file?.slice === "function"
        && Number.isSafeInteger(fileSize)
        && fileSize >= 0
      ) {
        while (offset < fileSize) {
          const bytes = new Uint8Array(
            await file.slice(offset, Math.min(offset + chunkSize, fileSize)).arrayBuffer(),
          );
          const progress = await callBridge("/session/import/chunk", {
            transferId,
            offset,
            data: encodeBase64Bytes(bytes),
          });
          if (progress?.status === "failed") {
            throw new Error(progress.message || "写入导入分块失败");
          }
          if (progress?.status !== "ok" || progress.nextOffset !== offset + bytes.length) {
            throw new Error("导入分块进度不一致");
          }
          offset = progress.nextOffset;
        }
      } else {
        const bytes = typeof file?.arrayBuffer === "function"
          ? new Uint8Array(await file.arrayBuffer())
          : new TextEncoder().encode(await file.text());
        while (offset < bytes.length) {
          const chunk = bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length));
          const progress = await callBridge("/session/import/chunk", {
            transferId,
            offset,
            data: encodeBase64Bytes(chunk),
          });
          if (progress?.status === "failed") {
            throw new Error(progress.message || "写入导入分块失败");
          }
          if (progress?.status !== "ok" || progress.nextOffset !== offset + chunk.length) {
            throw new Error("导入分块进度不一致");
          }
          offset = progress.nextOffset;
        }
      }

      const result = await callBridge("/session/import/finish", {
        transferId,
        projectPath,
      });
      if (result?.status === "failed") {
        throw new Error(result.message || "未知错误");
      }
      if (result?.status !== "imported" || !result.sessionId) {
        throw new Error("导入结果不完整");
      }
      transferId = "";
      const refreshed = await refreshRecentLocalSessions();
      showRuntimeToast(result.message || "会话数据已导入");
      if (!disposed && !refreshed) window.setTimeout(() => {
        if (!disposed) location.reload();
      }, 700);
    } catch (error) {
      showRuntimeToast(`导入失败：${error instanceof Error ? error.message : String(error)}`, "error");
    } finally {
      if (transferId) {
        void callBridge("/session/import/abort", { transferId }).catch(() => {});
      }
      button.disabled = false;
      delete button.dataset.busy;
    }
  };

  const chooseSessionImportFile = (projectPath, button) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json,application/json";
    input.hidden = true;
    input.addEventListener("change", () => {
      const file = input.files?.[0];
      input.remove();
      if (file) void importSessionFile(projectPath, file, button);
    }, { once: true });
    document.body.appendChild(input);
    input.click();
    window.setTimeout(() => {
      if (!input.files?.length) input.remove();
    }, 60_000);
  };

  const installProjectImportButtons = (root = document) => {
    queryWithin(root,
      "[data-app-action-sidebar-project-row][data-app-action-sidebar-project-id]",
    ).forEach((project) => {
      if (!(project instanceof HTMLElement) || project.querySelector(`[${projectImportAttribute}]`)) return;
      const projectPath = projectPathFromRow(project);
      if (!projectPath) return;
      project.dataset.codeyProjectPath = projectPath;
      const button = document.createElement("button");
      button.type = "button";
      button.setAttribute(projectImportAttribute, "true");
      button.setAttribute("aria-label", "导入会话数据到此项目");
      inheritNativeButtonClass(button, findProjectActionControl(project));
      button.innerHTML = projectImportIcon;
      wrapNativeButtonIcon(button, findProjectActionControl(project));
      attachSidebarActionTooltip(button, "导入会话数据到此项目");
      const refreshPosition = () => positionProjectImportButton(project, button);
      project.addEventListener("mouseenter", refreshPosition);
      project.addEventListener("focusin", refreshPosition);
      refreshPosition();
      ["pointerdown", "mousedown", "mouseup", "touchstart"].forEach((eventName) => {
        button.addEventListener(eventName, stopSidebarActionEvent, true);
      });
      button.addEventListener("click", (event) => {
        stopSidebarActionEvent(event);
        chooseSessionImportFile(projectPath, button);
      }, true);
      project.appendChild(button);
    });
  };

  // Codex owns permanent deletion: the row menu knows the conversation and the
  // host, so the injected icon reuses that action instead of deleting through
  // the backend on its own.
  const sessionDeleteMenuItemId = "delete-thread";

  const sidebarRowMenuItems = async (row) => {
    const fiberKey = Object.keys(row).find((key) => key.startsWith("__reactFiber$"));
    for (let fiber = fiberKey ? row[fiberKey] : null; fiber; fiber = fiber.return) {
      const getItems = fiber.memoizedProps?.getItems;
      if (typeof getItems !== "function") continue;
      try {
        const items = await getItems();
        if (Array.isArray(items)) return items;
      } catch {
        return null;
      }
    }
    return null;
  };

  const findMenuItemById = (items, id) => {
    for (const item of items || []) {
      if (!item || item.type === "separator") continue;
      if (item.id === id) return item;
      const nested = Array.isArray(item.submenu) ? findMenuItemById(item.submenu, id) : null;
      if (nested) return nested;
    }
    return null;
  };

  const openOfficialSessionDelete = async (row) => {
    if (disposed) return false;
    try {
      const menuItem = findMenuItemById(await sidebarRowMenuItems(row), sessionDeleteMenuItemId);
      if (disposed) return false;
      if (typeof menuItem?.onSelect === "function" && !menuItem.disabled) {
        await menuItem.onSelect();
        return true;
      }
    } catch {
      if (!disposed) showRuntimeToast("无法打开 Codex 永久删除确认，请重试", "error");
      return false;
    }
    showRuntimeToast("当前 Codex 版本未提供永久删除入口", "error");
    return false;
  };

  const findArchiveControl = (thread) => [...thread.querySelectorAll("button, [role=button]")]
    .find((control) => {
      if (
        !(control instanceof HTMLElement)
        || control.hasAttribute(sessionExportAttribute)
        || control.hasAttribute(sessionDeleteAttribute)
      ) return false;
      const descriptor = [
        control.getAttribute("aria-label"),
        control.getAttribute("title"),
        control.getAttribute("data-testid"),
        control.getAttribute("data-app-action"),
        control.textContent,
      ].filter(Boolean).join(" ");
      return /归档|取消归档|\barchive\b|\bunarchive\b/i.test(descriptor);
    });

  const projectActionControls = (project) => [...project.querySelectorAll("button, [role=button]")]
    .filter((control) => {
      if (!(control instanceof HTMLElement) || control.hasAttribute(projectImportAttribute)) return false;
      if (control.hasAttribute("data-app-action-sidebar-select-project")) return false;
      const className = String(control.getAttribute("class") || "").trim();
      const classes = className.split(/\s+/);
      return Boolean(className) && !classes.includes("sr-only") && control.getClientRects().length > 0;
    });

  const findProjectActionControl = (project) => projectActionControls(project)[0];

  const positionProjectImportButton = (project, button) => {
    const projectRect = project.getBoundingClientRect();
    const actionRects = projectActionControls(project)
      .map((control) => control.getBoundingClientRect())
      .filter((rect) => rect.width > 0 && rect.height > 0);
    if (projectRect.width <= 0 || actionRects.length === 0) return;
    const leftmostAction = Math.min(...actionRects.map((rect) => rect.left));
    const right = Math.ceil(projectRect.right - leftmostAction + 4);
    if (Number.isFinite(right) && right > 0) button.style.right = `${right}px`;
  };

  const archivePlacementTarget = (thread, archiveControl) => {
    const wrapper = archiveControl.parentElement;
    // Only skip the tooltip span; newer Codex puts the button directly in the action bar.
    return wrapper instanceof HTMLElement && wrapper !== thread && wrapper.tagName === "SPAN"
      ? wrapper
      : archiveControl;
  };

  const installSessionDeleteButtons = (root = document) => {
    queryWithin(root,
      "[data-app-action-sidebar-thread-id][data-app-action-sidebar-thread-title]",
    ).forEach((thread) => {
      if (
        !(thread instanceof HTMLElement)
        || thread.querySelector(`[${sessionDeleteAttribute}]`)
      ) return;
      const archiveControl = findArchiveControl(thread);
      if (!(archiveControl instanceof HTMLElement)) return;
      const placementTarget = archivePlacementTarget(thread, archiveControl);
      if (placementTarget.parentElement instanceof HTMLElement && placementTarget.parentElement !== thread) {
        placementTarget.parentElement.setAttribute("data-codey-session-action-row", "true");
      }
      const button = document.createElement("button");
      button.type = "button";
      button.setAttribute(sessionDeleteAttribute, "true");
      button.setAttribute("aria-label", "永久删除");
      inheritNativeButtonClass(button, archiveControl);
      button.innerHTML = sessionDeleteIcon;
      wrapNativeButtonIcon(button, archiveControl);
      attachSidebarActionTooltip(button, "永久删除");
      ["pointerdown", "mousedown", "mouseup", "touchstart"].forEach((eventName) => {
        button.addEventListener(eventName, stopSidebarActionEvent, true);
      });
      button.addEventListener("click", async (event) => {
        stopSidebarActionEvent(event);
        if (button.disabled) return;
        button.disabled = true;
        try {
          await window.__codeySessionToolsInstall?.openOfficialSessionDelete?.(thread);
        } finally {
          button.disabled = false;
        }
      }, true);
      placementTarget.insertAdjacentElement("afterend", button);
    });
  };

  const scan = (root = document, syncTitles = true) => {
    installSessionExportButtons(root);
    installTasksImportButton(root);
    installSessionDeleteButtons(root);
    installProjectImportButtons(root);
    installThreadUpdatedTimes(root);
    recoverHiddenRunningThreads(root);
    if (syncTitles) syncSidebarTitles(root);
  };

  window.__codeyBridge = callBridge;
  window.__codeyGetSessionId = getSessionId;
  window.__codeyGetSessionTitle = getSessionTitle;
  window.__codeySyncSidebarTitles = syncSidebarTitles;
  window.__codeyReconcileStaleCompletedTask = reconcileStaleCompletedTask;
  window.__codeyProjectPathFromRow = projectPathFromRow;
  window.__codeyFormatRelativeThreadTime = formatRelativeThreadTime;
  window.__codeyThreadTimestampMsFromPayload = threadTimestampMsFromPayload;
  window.__codeyUpdateThreadUpdatedAt = updateThreadUpdatedAt;
  window.__codeyInstallThreadUpdatedTimes = installThreadUpdatedTimes;
  window.__codeyHasNativeThreadStatus = hasNativeThreadStatus;
  window.__codeyUpdateThreadRunningPriority = updateThreadRunningPriority;
  window.__codeyRecoverHiddenRunningThreads = recoverHiddenRunningThreads;
  window.__codeyRefreshRecentLocalSessions = refreshRecentLocalSessions;
  window.__codeyExportSession = exportSession;
  window.__codeyImportSessionFile = importSessionFile;
  window.__codeyInstallSessionDeleteButtons = installSessionDeleteButtons;

  const codeyOwnedSelector = [
    rendererSettingsButtonSelector,
    `#${toastId}`,
    `#${sidebarActionTooltipId}`,
    `[${sessionExportAttribute}]`,
    `[${tasksImportAttribute}]`,
    `[${projectImportAttribute}]`,
    `[${sessionDeleteAttribute}]`,
    `[${threadUpdatedAtAttribute}]`,
    "[data-codey-prompt-optimize]",
  ].join(", ");
  const scanBoundarySelector = sidebarScanRootSelector;
  const interactiveControlSelector = [
    "button",
    "[role=button]",
    "[role=menuitem]",
    "[role=option]",
    "[role=switch]",
    "input",
    "label",
  ].join(", ");
  const relevantAddedSelector = [
    scanBoundarySelector,
    interactiveControlSelector,
  ].join(", ");
  const pendingScanRoots = new Set();

  const isCodeyOwned = (element) => (
    element instanceof HTMLElement
    && (
      element.matches?.(codeyOwnedSelector)
      || element.closest?.(codeyOwnedSelector)
    )
  );
  const containsRelevantElement = (element) => (
    element instanceof HTMLElement
    && (
      element.matches?.(relevantAddedSelector)
      || element.querySelector?.(relevantAddedSelector)
    )
  );
  const nearestScanRoot = (element) => {
    if (!(element instanceof HTMLElement)) return null;
    return element.closest?.(scanBoundarySelector)
      || element.querySelector?.(scanBoundarySelector)
      || null;
  };
  const addedSubtreeScanRoot = (element) => {
    if (!(element instanceof HTMLElement)) return null;
    const enclosingBoundary = element.closest?.(scanBoundarySelector);
    if (enclosingBoundary) return enclosingBoundary;
    // Keep the whole newly-added wrapper when it contains several sibling
    // boundaries. nearestScanRoot() intentionally returns only one node and is
    // still appropriate for attribute/removal mutations.
    return element.querySelector?.(scanBoundarySelector) ? element : null;
  };
  const threadClassMutationMayAffectStatus = (target, threadRow, oldClassName) => (
    target === threadRow
    || nativeThreadStatusClassPattern.test(String(oldClassName || ""))
    || nativeThreadStatusClassPattern.test(String(target?.className || ""))
  );
  const addPendingScanRoot = (root) => {
    if (!(root instanceof HTMLElement)) return;
    // Header mounts must stay fresh even while the root budget is saturated,
    // otherwise the settings button can go stale for a whole mutation storm.
    if (root.matches?.("header, nav")) {
      window.__codeyRendererInvalidateHeaderMount?.(root);
    }
    // Unknown/new Codex DOM shapes must degrade by skipping optional controls,
    // not by turning a burst of virtualized rows into a synchronous full-page
    // scan on the renderer thread.
    if (pendingScanRoots.size >= maxPendingScanRoots) return;
    for (const pendingRoot of pendingScanRoots) {
      if (pendingRoot === root || pendingRoot.contains?.(root)) return;
      if (root.contains?.(pendingRoot)) pendingScanRoots.delete(pendingRoot);
    }
    pendingScanRoots.add(root);
  };
  const flushIncrementalScans = () => {
    if (disposed) return;
    scanTimer = 0;
    scanDeadline = 0;
    const roots = [...pendingScanRoots]
      .filter((root) => root.isConnected !== false)
      .filter((root, index, candidates) => !candidates.some((
        candidate,
        candidateIndex,
      ) => candidateIndex !== index && candidate.contains?.(root)));
    pendingScanRoots.clear();
    roots.forEach((root) => scan(root, true));
  };
  const scheduleIncrementalScan = (root) => {
    if (disposed) return;
    addPendingScanRoot(root);
    const now = Date.now();
    if (!scanDeadline) scanDeadline = now + maxScanLatencyMs;
    // The debounce restarts on every batch, so a sustained mutation stream
    // could otherwise defer the flush indefinitely while roots pile up.
    const delay = Math.max(0, Math.min(scanDebounceMs, scanDeadline - now));
    window.clearTimeout(scanTimer);
    scanTimer = window.setTimeout(flushIncrementalScans, delay);
  };
  const scheduleInitialScan = () => {
    const run = () => {
      initialScanHandle = 0;
      if (disposed) return;
      try {
        scan();
      } catch (error) {
        window.__codeySessionToolsError = error instanceof Error
          ? `${error.name}: ${error.message}`
          : String(error);
        console.error("[CodeyX] deferred session tools scan failed", error);
      }
    };
    if (typeof window.requestIdleCallback === "function") {
      // Do not force this optional full-page discovery through a timeout: on a
      // continuously scrolling/animating renderer that would move the same
      // synchronous work back onto a latency-sensitive frame.
      initialScanUsesIdleCallback = true;
      initialScanHandle = window.requestIdleCallback(run);
    } else {
      initialScanHandle = window.setTimeout(run, 0);
    }
  };

  // Lightweight observer telemetry: per-handler call count, mutation count and
  // wall time, exposed on window.__codeyObserverStats for performance triage.
  // No behavior change; timing falls back to Date.now() where performance is
  // unavailable (test sandboxes).
  const codeyTimed = (name, count, run) => {
    const now = () =>
      typeof performance === "object" && typeof performance.now === "function"
        ? performance.now()
        : Date.now();
    const stats = (window.__codeyObserverStats ||= {});
    const entry = (stats[name] ||= { calls: 0, items: 0, totalMs: 0, maxMs: 0 });
    const startedAt = now();
    try {
      return run();
    } finally {
      const elapsed = now() - startedAt;
      entry.calls += 1;
      entry.items += count;
      entry.totalMs += elapsed;
      if (elapsed > entry.maxMs) entry.maxMs = elapsed;
    }
  };
  const handleSessionToolMutations = (mutations) =>
    codeyTimed("codey-inject.sessionToolMutations", mutations?.length ?? 0, () => handleSessionToolMutationsImpl(mutations));
  const handleSessionToolMutationsImpl = (mutations) => {
    if (disposed) return;
    for (const mutation of mutations) {
      const target = mutation.target instanceof HTMLElement
        ? mutation.target
        : mutation.target?.parentElement;
      if (mutation.type === "attributes") {
        if (target && !isCodeyOwned(target)) {
          const threadRow = target.closest?.(sidebarThreadRowSelector) || null;
          const relevantThreadClassChange = threadRow
            && mutation.attributeName === "class"
            && threadClassMutationMayAffectStatus(target, threadRow, mutation.oldValue);
          if (relevantThreadClassChange || mutation.attributeName !== "class") {
            addPendingScanRoot(threadRow || nearestScanRoot(target));
          }
        }
        continue;
      }
      // Depends only on mutation.target, so it is identical for every node in
      // this record; streaming appends many text nodes per record.
      let interactiveRoot;
      const interactiveRootFor = () => {
        if (interactiveRoot === undefined) {
          interactiveRoot = target?.closest?.(interactiveControlSelector) || null;
        }
        return interactiveRoot;
      };
      for (const node of mutation.addedNodes || []) {
        const element = node instanceof HTMLElement ? node : null;
        if (!element) {
          if (node?.nodeType !== Node.TEXT_NODE) continue;
          const root = interactiveRootFor();
          if (root && !isCodeyOwned(root)) {
            addPendingScanRoot(root);
          }
          continue;
        }
        if (isCodeyOwned(element)) continue;
        const threadRow = element.closest?.(sidebarThreadRowSelector)
          || target?.closest?.(sidebarThreadRowSelector)
          || null;
        if (threadRow) {
          addPendingScanRoot(threadRow);
          continue;
        }
        if (!containsRelevantElement(element)) continue;
        addPendingScanRoot(addedSubtreeScanRoot(element));
      }
      for (const node of mutation.removedNodes || []) {
        const element = node instanceof HTMLElement ? node : null;
        if (!element) continue;
        const threadRow = target?.closest?.(sidebarThreadRowSelector) || null;
        if (threadRow && !isCodeyOwned(target)) {
          addPendingScanRoot(threadRow);
          continue;
        }
        if (!containsRelevantElement(element)) continue;
        if (target && !isCodeyOwned(target)) {
          addPendingScanRoot(addedSubtreeScanRoot(target) || nearestScanRoot(target));
        }
      }
    }
    if (pendingScanRoots.size) {
      scheduleIncrementalScan(null);
    }
    if (document.visibilityState === "hidden") return;
    const sessionId = getSessionId();
    if (
      sessionId
      && !completionReconcileInFlight
      && (
        sessionId !== completionReconcileSessionId
        || Date.now() >= completionNextReconcileAt
      )
    ) {
      void reconcileStaleCompletedTask();
    }
  };
  const sessionToolMutationOptions = {
    attributes: true,
    attributeOldValue: true,
    attributeFilter: [
      "aria-label",
      "aria-expanded",
      "aria-hidden",
      "data-request-user-input-auto-resolution-conversation-id",
      "data-app-action-sidebar-thread-host-id",
      "data-app-action-sidebar-thread-id",
      "data-app-action-sidebar-thread-kind",
      "data-app-action-sidebar-thread-title",
      "data-app-action-sidebar-project-id",
      "data-app-action-sidebar-project-list-id",
      "data-app-action-sidebar-project-row",
      sidebarProjectShowAllAttribute,
      "data-testid",
      "disabled",
      "hidden",
      "class",
    ],
    childList: true,
    subtree: true,
  };
  const mutationDispatcher = window.__codeyMutationDispatcher;
  let sessionToolObserver = null;
  const installedIntervals = [];
  const installedListeners = [];
  disposeInstall = () => {
    if (disposed) return;
    disposed = true;
    try { sessionToolObserver?.disconnect?.(); } catch {}
    for (const [target, type, handler, options] of installedListeners) {
      try { target.removeEventListener?.(type, handler, options); } catch {}
    }
    for (const id of installedIntervals) window.clearInterval?.(id);
    for (const id of [scanTimer, watcherWakeTimer, threadUpdatedAtFetchTimer]) {
      window.clearTimeout(id);
    }
    if (initialScanUsesIdleCallback) window.cancelIdleCallback?.(initialScanHandle);
    else window.clearTimeout(initialScanHandle);
    hideSidebarActionTooltip();
    for (const id of threadRunningRecheckTimers.values()) window.clearTimeout(id);
    threadRunningRecheckTimers.clear();
    pendingScanRoots.clear();
    pendingThreadUpdatedAtRefs.clear();
    threadUpdatedAtRows.clear();
    // Native-operation timeout promises must still settle after disposal.
    // Resource cleanup timers (toast, file input, object URL) also finish.
    if (window.__codeyShowRuntimeToast === showRuntimeToast) delete window.__codeyShowRuntimeToast;
    window.__codeySessionToolsInjectLoaded = false;
  };
  window.__codeySessionToolsInstall = {
    dispose: disposeInstall,
    openOfficialSessionDelete,
    tooltip: {
      show: scheduleSidebarActionTooltip,
      hide(button) {
        if (!button || sidebarActionTooltipAnchor === button) hideSidebarActionTooltip();
      },
    },
  };
  addStyle();
  if (typeof mutationDispatcher?.subscribe === "function") {
    const unsubscribe = mutationDispatcher.subscribe(
      handleSessionToolMutations,
      sessionToolMutationOptions,
    );
    sessionToolObserver = { disconnect: unsubscribe };
    if (!mutationDispatcher.snapshot?.().observerInstalled) {
      unsubscribe?.();
      sessionToolObserver = null;
    }
  }
  if (!sessionToolObserver) {
    sessionToolObserver = new MutationObserver(handleSessionToolMutations);
    sessionToolObserver.observe(document.documentElement, sessionToolMutationOptions);
  }
  // forceRefresh bypasses the per-session throttle and re-fetches official
  // thread metadata for every sidebar row, so alt-tabbing must stay debounced.
  let lastForcedThreadTimeRefresh = 0;
  const forcedThreadTimeRefreshIntervalMs = 10_000;
  const refreshThreadUpdatedTimesOnReturn = () => {
    const now = Date.now();
    if (now - lastForcedThreadTimeRefresh < forcedThreadTimeRefreshIntervalMs) return;
    lastForcedThreadTimeRefresh = now;
    refreshTrackedThreadUpdatedTimes(true);
  };
  const reconcileOnVisible = () => {
    if (document.visibilityState !== "hidden") {
      refreshThreadUpdatedTimesOnReturn();
      void reconcileStaleCompletedTask();
    }
  };
  if (typeof document.addEventListener === "function") {
    const pointerdownOptions = { capture: true, passive: true };
    installedListeners.push(
      [document, "visibilitychange", wakeSessionWatcher, undefined],
      [document, "visibilitychange", reconcileOnVisible, undefined],
      [document, "pointerdown", wakeSessionWatcher, pointerdownOptions],
      [document, "keydown", wakeSessionWatcherFromKey, true],
    );
    document.addEventListener("visibilitychange", wakeSessionWatcher);
    document.addEventListener("visibilitychange", reconcileOnVisible);
    document.addEventListener("pointerdown", wakeSessionWatcher, pointerdownOptions);
    document.addEventListener("keydown", wakeSessionWatcherFromKey, true);
  }
  if (typeof window.addEventListener === "function") {
    for (const type of ["focus", "pageshow"]) {
      for (const handler of [wakeSessionWatcher, refreshThreadUpdatedTimesOnReturn, reconcileStaleCompletedTask]) {
        installedListeners.push([window, type, handler, undefined]);
      }
    }
    window.addEventListener("focus", wakeSessionWatcher);
    window.addEventListener("focus", refreshThreadUpdatedTimesOnReturn);
    window.addEventListener("focus", reconcileStaleCompletedTask);
    window.addEventListener("pageshow", wakeSessionWatcher);
    window.addEventListener("pageshow", refreshThreadUpdatedTimesOnReturn);
    window.addEventListener("pageshow", reconcileStaleCompletedTask);
  }
  if (typeof window.setInterval === "function") {
    installedIntervals.push(window.setInterval(() => {
      void reconcileStaleCompletedTask();
    }, completedTaskReconcileIntervalMs));
    installedIntervals.push(window.setInterval(() => {
      if (document.visibilityState === "hidden") return;
      refreshTrackedThreadUpdatedTimes(false);
    }, threadTimestampRefreshIntervalMs));
  }
  window.__codeyRendererInjectLoaded = true;
  window.__codeySessionToolsInjectLoaded = true;
  window.__codeySessionToolsInjectLoading = false;
  void reconcileStaleCompletedTask();
  scheduleInitialScan();
  } catch (error) {
    window.__codeySessionToolsInjectLoading = false;
    disposeInstall?.();
    // 已销毁或尚未完成的安装都不该继续对外可见。
    delete window.__codeySessionToolsInstall;
    throw error;
  }
})();

// Lightweight renderer bootstrap injected by the CodeyX CDP launcher.
// The heavier session/sidebar tools live in codey-inject.js and are loaded
// after sidebar interaction or once the renderer has idle time.
(() => {
  const rendererCoreAlreadyLoaded = window.__codeyRendererCoreLoaded === true;
  window.__codeyRendererModuleReady = true;

  const sessionToolsLoadPath = "/internal/codey/session-tools/load";
  const updateCheckPath = "/api/check_for_updates";
  const backendStatusPath = "/backend/status";
  const backendHealthPath = "/backend/health";
  const accountUsagePath = "/account/usage";
  const buttonId = "codey-settings-button";
  const buttonMeasureId = "codey-settings-button-measure";
  const accountUsageId = "codey-account-usage";
  const accountUsageDetailsId = "codey-account-usage-details";
  const styleId = "codey-core-injected-style";
  const updateAvailableEvent = "codey-update-availability-changed";
  const runtimeHealthEvent = "codey-runtime-health-changed";
  const configChangedEvent = "codey:config-changed";
  const updateCheckIntervalMs = 30 * 60 * 1000;
  const updateCheckTimeoutMs = 10_000;
  const runtimeHealthCheckIntervalMs = 30_000;
  const runtimeHealthCheckTimeoutMs = 3_000;
  const runtimeHealthFailureRetryMs = 1_000;
  const runtimeHealthUnavailableRetryMs = 5_000;
  const runtimeHealthFailureThreshold = 2;
  const runtimeHealthStallToleranceMs = 1_500;
  // 系统睡眠会同时冻结页面和后端，唤醒瞬间所有进程一起恢复，
  // 3 秒的往返预算不足以判断 CodeyX 是否真的退出。排程间隔远超定时器
  // 周期即视为刚从睡眠恢复，在这段宽限期内放宽超时与失败阈值。
  const runtimeHealthResumeGapMs = 90_000;
  const runtimeHealthResumeGraceMs = 120_000;
  const runtimeHealthResumeTimeoutMs = 8_000;
  const runtimeHealthResumeFailureThreshold = 4;
  const accountUsageRefreshIntervalMs = 60_000;
  const accountUsageTimeoutMs = 8_000;
  const accountUsageWarningPercent = 30;
  const accountUsageCriticalPercent = 10;
  const sessionToolsIdleLoadTimeoutMs = 5_000;
  const sidebarSelector = [
    "[data-app-action-sidebar-scroll]",
    "[data-app-action-sidebar-section]",
    "[data-app-action-sidebar-thread-row]",
    "[data-app-action-sidebar-project-row]",
    "[data-app-action-sidebar-thread-id][data-app-action-sidebar-thread-title]",
  ].join(", ");
  const headerSelector = "header, nav";
  // Codex 把左侧图标栏收进 nav[data-app-navigation-rail]，图标栏底部的贴底
  // 堆栈里放着帮助与个人资料按钮，CodeyX 入口跟随它们落在这里。
  const navigationRailSelector = '[data-app-navigation-rail="true"]';
  const railHelpLabelPattern = /帮助|help/i;
  const railProfileLabelPattern = /个人资料|账户|账号|profile|account/i;
  const bootstrapProbeSelector = `${headerSelector}, ${sidebarSelector}, ${navigationRailSelector}`;
  // 与 generate-app-icons.py 的 C / 提示符轮廓一致，入口保留宿主的单色主题。
  const settingsIcon = `
    <svg viewBox="174 176 672 672" aria-hidden="true" focusable="false">
      <polygon points="584,252 370,252 214,408 214,616 370,772 584,772 664,692 584,612 536,660 416,660 326,570 326,454 416,364 536,364 584,412 664,332"></polygon>
      <polygon points="680,386 806,512 680,638 616,574 678,512 616,450"></polygon>
    </svg>
  `;
  let sessionToolsLoadPromise = null;
  let scanTimer = 0;
  let updateCheckTimer = 0;
  let updateCheckInFlight = false;
  let codeyUpdatePolicy = null;
  let updateCheckGeneration = 0;
  let runtimeHealthTimer = 0;
  let runtimeHealthCheckPromise = null;
  let settingsHealthCheckPending = false;
  let runtimeHealthFailures = 0;
  let runtimeHealthState = "checking";
  let runtimeHealthMessage = "";
  let runtimeHealthObservedAt = 0;
  let runtimeHealthLastCheckAt = 0;
  let runtimeHealthResumeGraceUntil = 0;
  let accountUsageTimer = 0;
  let accountUsageCheckInFlight = false;
  let accountUsagePollingEnabled = true;
  let accountUsageLastResult = null;
  let accountUsageStale = false;
  let sessionToolsInteractionArmed = false;
  let sessionToolsIdleLoadScheduled = false;
  let bootstrapObserver = null;
  let headerMountDirty = true;
  let navigationRailSeen = false;

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
    return Promise.resolve({
      status: "failed",
      code: "bridge_unavailable",
      message: "CodeyX bridge 不可用",
    });
  };

  const addStyle = () => {
    if (document.getElementById(styleId)) return;
    const style = document.createElement("style");
    style.id = styleId;
    style.textContent = `
      /* Codex 原生小按钮：28×28、圆角 12.5px、图标继承按钮前景色，
         CodeyX 入口按同一套数值对齐，保证与相邻原生按钮同色同尺寸。 */
      #${buttonId} { --codey-icon-size: 16px; --codey-icon-color: currentColor; -webkit-app-region: no-drag !important; pointer-events: auto !important; position: relative; z-index: 2147483641; display: inline-grid; place-items: center; flex: 0 0 auto; width: 32px; height: 32px; border: 0; border-radius: 12.5px; padding: 0; margin-inline-start: 8px; margin-inline-end: 18px; background: transparent; color: inherit; cursor: pointer; opacity: .86; user-select: none; transition: background .15s ease, opacity .15s ease, transform .15s ease; }
      #${buttonId}[data-codey-header-actions="true"] { width: 28px; height: 28px; margin-inline-start: 0; margin-inline-end: 6px; }
      #${buttonId}[data-codey-native-slot="true"], #${buttonMeasureId} { box-sizing: border-box; flex: 0 0 auto; width: 28px; height: 28px; margin: 0; color: inherit; }
      #${buttonId}[data-codey-native-slot="true"] svg { width: 16px; height: 16px; }
      #${buttonId}[data-codey-rail-slot="true"] { --codey-icon-size: 20px; box-sizing: border-box; flex: 0 0 auto; width: 36px; height: 36px; margin: 0; border-radius: 12.5px; color: color-mix(in srgb, CanvasText 52%, transparent); }
      #${buttonId}[data-codey-rail-slot="true"] svg { width: 20px; height: 20px; }
      #${buttonId}[data-codey-rail-slot="true"]:hover { color: CanvasText; }
      #${buttonId}[data-codey-rail-slot="true"]::after { top: 4px; right: 4px; }
      #${buttonMeasureId} { display: inline-block; pointer-events: none; }
      #${buttonId}:hover { background: rgba(127, 127, 127, .14); opacity: 1; }
      #${buttonId}:active { transform: translateY(1px); }
      #${buttonId}:focus-visible { outline: 2px solid rgba(139, 151, 255, .72); outline-offset: 2px; }
      #${buttonId} svg { display: block; flex: 0 0 auto; width: var(--codey-icon-size); height: var(--codey-icon-size); fill: var(--codey-icon-color); stroke: none; }
      #${buttonId} .codey-settings-label { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
      #${buttonId} .codey-runtime-badge { position: absolute; top: -2px; right: -2px; display: grid; width: 13px; height: 13px; place-items: center; border: 2px solid Canvas; border-radius: 999px; background: #ff453a; color: #fff; font: 800 9px/1 -apple-system, BlinkMacSystemFont, sans-serif; opacity: 0; transform: scale(.65); transition: opacity .15s ease, transform .15s ease; pointer-events: none; }
      #${buttonId}[data-codey-runtime-state="unavailable"] { background: rgba(255, 69, 58, .12); color: #ff453a; opacity: 1; }
      #${buttonId}[data-codey-runtime-state="unavailable"]:hover { background: rgba(255, 69, 58, .2); }
      #${buttonId}[data-codey-runtime-state="unavailable"] .codey-runtime-badge { opacity: 1; transform: scale(1); }
      #${buttonId}::after { content: ""; position: absolute; top: 5px; right: 5px; width: 7px; height: 7px; border-radius: 999px; background: #ff3b30; box-shadow: 0 0 0 2px Canvas; opacity: 0; transform: scale(.7); transition: opacity .15s ease, transform .15s ease; pointer-events: none; }
      #${buttonId}[data-codey-update-available="true"]::after { opacity: 1; transform: scale(1); }
      #${buttonId}[data-codey-header-actions="true"]::after { top: 4px; right: 4px; }
      #${buttonId}[data-codey-runtime-state="unavailable"][data-codey-update-available="true"]::after { top: auto; right: 3px; bottom: 3px; width: 5px; height: 5px; }
      /* 额度块直接取 Codex 的语义色板，宿主切换明暗主题时同步变化；变量缺失时退回系统色。
         侧边栏本身半透明，额度块铺一层随主题变化的半透明磨砂浮层与之融合，悬停时略微提亮。 */
      #${accountUsageId} { --codey-usage-ink: var(--color-text, CanvasText); --codey-usage-ink-2: color-mix(in srgb, var(--codey-usage-ink) 72%, transparent); --codey-usage-ink-3: color-mix(in srgb, var(--codey-usage-ink) 60%, transparent); --codey-usage-line: var(--color-token-border, color-mix(in srgb, CanvasText 8%, transparent)); --codey-usage-track: color-mix(in srgb, var(--codey-usage-ink) 9%, transparent); --codey-usage-fill: color-mix(in srgb, var(--codey-usage-ink) 62%, transparent); --codey-usage-warning: var(--color-text-warning, #e25507); --codey-usage-danger: var(--color-text-danger, #e02e2a); --codey-usage-success: var(--color-text-success, #00a240); --codey-usage-surface: var(--color-token-dropdown-background, var(--color-surface-elevated, Canvas)); --codey-usage-ease: cubic-bezier(.22, 1, .36, 1); -webkit-app-region: no-drag !important; position: relative; isolation: isolate; display: block; box-sizing: border-box; width: 100%; min-width: 0; padding: 0; transition: box-shadow .15s ease; color: var(--codey-usage-ink); font-family: var(--font-sans, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", sans-serif); font-size: 12px; line-height: 16px; outline: none; pointer-events: auto !important; user-select: none; }
      #${accountUsageId}::before { content: ""; position: absolute; z-index: -1; inset: -20px 0 0; background: color-mix(in srgb, var(--codey-usage-surface) 58%, transparent); -webkit-backdrop-filter: blur(16px) saturate(1.4); backdrop-filter: blur(16px) saturate(1.4); -webkit-mask-image: linear-gradient(to bottom, transparent, #000 20px); mask-image: linear-gradient(to bottom, transparent, #000 20px); transition: background-color .15s ease; pointer-events: none; }
      /* 摘要不再使用卡片外框，整块以半透明浮层铺满侧边栏底部：顶部给出整体结论与套餐，下面每个额度窗口一行进度、一行重置倒计时。 */
      #${accountUsageId} .codey-usage-summary { display: grid; min-width: 0; grid-template-columns: max-content minmax(0, 1fr) max-content; align-items: center; column-gap: 10px; row-gap: 8px; padding: 10px 18px 12px; }
      #${accountUsageId}:hover::before, #${accountUsageId}:focus-visible::before { background: color-mix(in srgb, var(--codey-usage-surface) 74%, transparent); }
      #${accountUsageId}:focus-visible { box-shadow: inset 0 0 0 1.5px var(--color-token-focus-border, #3a83f7); }
      #${accountUsageId} .codey-usage-overview { display: flex; grid-column: 1 / -1; min-width: 0; align-items: center; gap: 7px; }
      #${accountUsageId} .codey-usage-overview::before { content: ""; flex: 0 0 auto; width: 7px; height: 7px; border-radius: 999px; background: var(--codey-usage-success); box-shadow: 0 0 0 3px color-mix(in srgb, var(--codey-usage-success) 16%, transparent); }
      #${accountUsageId} .codey-usage-overview[data-tone="warning"]::before { background: var(--codey-usage-warning); box-shadow: 0 0 0 3px color-mix(in srgb, var(--codey-usage-warning) 16%, transparent); }
      #${accountUsageId} .codey-usage-overview[data-tone="critical"]::before { background: var(--codey-usage-danger); box-shadow: 0 0 0 3px color-mix(in srgb, var(--codey-usage-danger) 16%, transparent); }
      #${accountUsageId} .codey-usage-status { overflow: hidden; min-width: 0; font-size: 12px; font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
      #${accountUsageId} .codey-usage-overview[data-tone="critical"] .codey-usage-status { color: var(--codey-usage-danger); }
      #${accountUsageId} .codey-usage-overview .codey-usage-plan { flex: 0 0 auto; padding: 0 7px; font-size: 10.5px; line-height: 17px; }
      #${accountUsageId} .codey-usage-segment { display: grid; grid-column: 1 / -1; grid-template-columns: subgrid; align-items: center; row-gap: 1px; min-width: 0; transition: opacity .2s ease; }
      #${accountUsageId}[data-state="stale"] .codey-usage-segment { opacity: .62; }
      #${accountUsageId} .codey-usage-label { color: var(--codey-usage-ink-2); font-size: 11.5px; white-space: nowrap; }
      #${accountUsageId} .codey-usage-reset { grid-column: 2 / -1; overflow: hidden; min-width: 0; color: var(--codey-usage-ink-3); font-size: 11px; font-variant-numeric: tabular-nums; line-height: 14px; text-overflow: ellipsis; white-space: nowrap; }
      #${accountUsageId} [data-pace="empty"] .codey-usage-reset { color: var(--codey-usage-danger); }
      #${accountUsageId} .codey-usage-announcer { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
      #${accountUsageId} .codey-usage-value { justify-self: end; font-size: 12px; font-variant-numeric: tabular-nums; font-weight: 600; letter-spacing: -.01em; white-space: nowrap; }
      #${accountUsageId} [data-tone="warning"] .codey-usage-value, #${accountUsageId} [data-tone="warning"] .codey-usage-figure-value { color: var(--codey-usage-warning); }
      #${accountUsageId} [data-tone="critical"] .codey-usage-value, #${accountUsageId} [data-tone="critical"] .codey-usage-figure-value { color: var(--codey-usage-danger); }
      #${accountUsageId} .codey-usage-meter { position: relative; display: block; box-sizing: border-box; min-width: 24px; height: 4px; border-radius: 999px; background: var(--codey-usage-track); }
      #${accountUsageId} .codey-usage-fill { position: absolute; inset: 0 auto 0 0; width: calc(var(--codey-usage-remaining) * 100%); border-radius: inherit; background: var(--codey-usage-fill); }
      #${accountUsageId} [data-tone="warning"] .codey-usage-fill { background: var(--codey-usage-warning); }
      #${accountUsageId} [data-tone="critical"] .codey-usage-fill { background: var(--codey-usage-danger); }
      #${accountUsageId} .codey-usage-error { display: flex; grid-column: 1 / -1; align-items: center; gap: 7px; min-width: 0; color: var(--codey-usage-ink-2); font-size: 11.5px; }
      #${accountUsageId} .codey-usage-error svg { flex: 0 0 auto; width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-linecap: round; stroke-width: 1.6; }
      #${accountUsageId} .codey-usage-details { position: absolute; z-index: 2; right: 8px; bottom: calc(100% - 2px); left: 8px; box-sizing: border-box; min-width: 0; padding: 12px 14px 11px; border-radius: 12px; background: var(--codey-usage-surface); box-shadow: var(--shadow-dropdown-overlay, 0 0 0 .5px rgb(0 0 0 / .08), 0 8px 16px -4px rgb(0 0 0 / .12)); color: var(--codey-usage-ink); opacity: 0; pointer-events: none; transform: translateY(4px) scale(.985); transform-origin: 50% 100%; transition: opacity .12s ease, transform .12s ease, visibility 0s linear .12s; visibility: hidden; }
      #${accountUsageId}:hover .codey-usage-details, #${accountUsageId}:focus-visible .codey-usage-details { opacity: 1; transform: none; transition: opacity .18s var(--codey-usage-ease) .12s, transform .22s var(--codey-usage-ease) .12s, visibility 0s linear .12s; visibility: visible; }
      #${accountUsageId}[data-dismissed="true"] .codey-usage-details { opacity: 0; transition: none; visibility: hidden; }
      #${accountUsageId} .codey-usage-pop-head { display: flex; min-width: 0; align-items: center; gap: 8px; margin-bottom: 12px; }
      #${accountUsageId} .codey-usage-pop-title { font-size: 13px; font-weight: 600; white-space: nowrap; }
      #${accountUsageId} .codey-usage-plan { overflow: hidden; max-width: 60%; margin-inline-start: auto; border-radius: 999px; padding: 1px 8px; background: var(--codey-usage-track); color: var(--codey-usage-ink-2); font-size: 11px; font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
      #${accountUsageId} .codey-usage-window + .codey-usage-window { margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--codey-usage-line); }
      #${accountUsageId} .codey-usage-window-head { display: flex; min-width: 0; align-items: baseline; justify-content: space-between; gap: 8px; margin-bottom: 8px; }
      #${accountUsageId} .codey-usage-window-name { overflow: hidden; color: var(--codey-usage-ink-2); text-overflow: ellipsis; white-space: nowrap; }
      #${accountUsageId} .codey-usage-figure { display: inline-flex; flex: 0 0 auto; align-items: baseline; gap: 4px; }
      #${accountUsageId} .codey-usage-figure-label { color: var(--codey-usage-ink-3); font-size: 11px; }
      #${accountUsageId} .codey-usage-figure-value { font-size: 18px; font-variant-numeric: tabular-nums; font-weight: 600; letter-spacing: -.02em; line-height: 20px; }
      #${accountUsageId} .codey-usage-window .codey-usage-meter { height: 6px; }
      #${accountUsageId} .codey-usage-window-meta { display: flex; min-width: 0; flex-wrap: wrap; justify-content: space-between; gap: 2px 8px; margin-top: 8px; color: var(--codey-usage-ink-3); font-size: 11px; font-variant-numeric: tabular-nums; line-height: 15px; white-space: nowrap; }
      #${accountUsageId} .codey-usage-pace-note { display: flex; min-width: 0; align-items: flex-start; gap: 6px; margin-top: 4px; color: var(--codey-usage-ink-2); font-size: 11px; line-height: 15px; }
      #${accountUsageId} .codey-usage-pace-note::before { content: ""; flex: 0 0 auto; width: 6px; height: 6px; margin-top: 4.5px; border-radius: 999px; background: var(--codey-usage-ink-3); }
      #${accountUsageId} [data-pace="steady"] .codey-usage-pace-note::before { background: var(--codey-usage-success); }
      #${accountUsageId} [data-pace="fast"] .codey-usage-pace-note::before { background: var(--codey-usage-warning); }
      #${accountUsageId} [data-pace="empty"] .codey-usage-pace-note { color: var(--codey-usage-danger); }
      #${accountUsageId} [data-pace="empty"] .codey-usage-pace-note::before { background: var(--codey-usage-danger); }
      #${accountUsageId} .codey-usage-credits { display: flex; min-width: 0; align-items: baseline; justify-content: space-between; gap: 8px; margin-top: 12px; padding-top: 10px; border-top: 1px solid var(--codey-usage-line); color: var(--codey-usage-ink-2); }
      #${accountUsageId} .codey-usage-credits-value { color: var(--codey-usage-ink); font-variant-numeric: tabular-nums; font-weight: 600; white-space: nowrap; }
      #${accountUsageId} .codey-usage-reset-credits { flex-wrap: wrap; }
      #${accountUsageId} .codey-usage-credit-expiry { flex-basis: 100%; font-size: 11px; }
      #${accountUsageId} [data-expiring="true"] .codey-usage-credit-expiry { color: var(--codey-usage-danger); }
      #${accountUsageId} .codey-usage-pop-foot { display: flex; min-width: 0; flex-wrap: wrap; align-items: center; gap: 2px 8px; margin-top: 12px; color: var(--codey-usage-ink-3); font-size: 11px; line-height: 15px; }
      #${accountUsageId} .codey-usage-updated, #${accountUsageId} .codey-usage-stale-note { overflow: hidden; margin-inline-start: auto; font-variant-numeric: tabular-nums; text-overflow: ellipsis; white-space: nowrap; }
      #${accountUsageId} .codey-usage-stale-note { display: none; color: var(--codey-usage-warning); }
      #${accountUsageId}[data-state="stale"] .codey-usage-updated { display: none; }
      #${accountUsageId}[data-state="stale"] .codey-usage-stale-note { display: block; }
      #${accountUsageId} .codey-usage-error-message { display: -webkit-box; overflow: hidden; margin: 0; color: var(--codey-usage-ink-2); font-size: 12px; line-height: 17px; overflow-wrap: anywhere; -webkit-box-orient: vertical; -webkit-line-clamp: 4; }
      @media (prefers-reduced-motion: reduce) {
        #${buttonId}, #${buttonId} *, #${accountUsageId}, #${accountUsageId}::before, #${accountUsageId} * { animation: none !important; transition: none !important; }
        #${accountUsageId} .codey-usage-details { transform: none; }
      }
    `;
    document.documentElement.appendChild(style);
  };

  const hasDetectedUpdate = () =>
    window.__codeyUpdateAvailability?.updateAvailable === true;

  const hasInstallableUpdate = () =>
    hasDetectedUpdate() && Boolean(window.__codeyUpdateAvailability?.selectedAsset);

  const dispatchUpdateAvailability = () => {
    if (
      typeof window.dispatchEvent !== "function"
      || typeof CustomEvent !== "function"
    ) return;
    window.dispatchEvent(new CustomEvent(updateAvailableEvent, {
      detail: hasDetectedUpdate() ? window.__codeyUpdateAvailability : null,
    }));
  };

  const applyUpdateBadge = (button = document.getElementById(buttonId)) => {
    if (!(button instanceof HTMLElement)) return;
    button.setAttribute("data-codey-runtime-state", runtimeHealthState);
    if (hasDetectedUpdate()) {
      button.setAttribute("data-codey-update-available", "true");
    } else {
      button.removeAttribute?.("data-codey-update-available");
    }
    if (runtimeHealthState === "unavailable") {
      const detail = runtimeHealthMessage || "CodeyX 后端未响应";
      const updateLabel = hasDetectedUpdate() ? "，另有可用更新" : "";
      button.setAttribute(
        "aria-label",
        `CodeyX 连接中断，点击查看处理提示${updateLabel}`,
      );
      button.title = `CodeyX 连接中断：${detail}（点击查看处理提示）${updateLabel}`;
      return;
    }
    if (hasDetectedUpdate()) {
      button.setAttribute("aria-label", "打开 CodeyX 配置，有可用更新");
      button.title = "打开 CodeyX 配置（发现新版本）";
    } else {
      button.setAttribute("aria-label", "打开 CodeyX 配置");
      button.title = "打开 CodeyX 配置";
    }
  };

  const runtimeHealthSnapshot = () => ({
    state: runtimeHealthState,
    message: runtimeHealthMessage,
    observedAt: runtimeHealthObservedAt,
    consecutiveFailures: runtimeHealthFailures,
  });

  const setRuntimeHealthState = (state, message = "") => {
    const nextState = state === "healthy" || state === "unavailable"
      ? state
      : "checking";
    const nextMessage = String(message || "").slice(0, 160);
    const changed = runtimeHealthState !== nextState || runtimeHealthMessage !== nextMessage;
    runtimeHealthState = nextState;
    runtimeHealthMessage = nextMessage;
    runtimeHealthObservedAt = Date.now();
    window.__codeyRuntimeHealth = runtimeHealthSnapshot();
    if (changed) applyUpdateBadge();
    if (
      changed
      && typeof window.dispatchEvent === "function"
      && typeof CustomEvent === "function"
    ) {
      window.dispatchEvent(new CustomEvent(runtimeHealthEvent, {
        detail: window.__codeyRuntimeHealth,
      }));
    }
    return window.__codeyRuntimeHealth;
  };

  const setUpdateAvailability = (result, { dispatch = true } = {}) => {
    window.__codeyUpdateAvailability = codeyUpdatePolicy !== "off"
      && !result?.prerelease && !result?.latestVersion?.split("+")[0].includes("-")
      && result?.updateAvailable === true
      ? result
      : null;
    applyUpdateBadge();
    if (hasInstallableUpdate()) {
      window.clearTimeout(updateCheckTimer);
      updateCheckTimer = 0;
    }
    if (dispatch) dispatchUpdateAvailability();
  };

  const withTimeout = (
    promise,
    timeoutMs,
    message = "检查更新超时",
  ) => new Promise((resolve, reject) => {
    const timer = window.setTimeout(
      () => reject(new Error(message)),
      timeoutMs,
    );
    Promise.resolve(promise).then(
      (value) => {
        window.clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        window.clearTimeout(timer);
        reject(error);
      },
    );
  });

  const scheduleRuntimeHealthCheck = (delayMs = runtimeHealthCheckIntervalMs) => {
    window.clearTimeout(runtimeHealthTimer);
    runtimeHealthTimer = 0;
    if (document.visibilityState === "hidden") return;
    runtimeHealthTimer = window.setTimeout(() => {
      runtimeHealthTimer = 0;
      void checkRuntimeHealth();
    }, delayMs);
  };

  const checkRuntimeHealth = async () => {
    if (document.visibilityState === "hidden") {
      scheduleRuntimeHealthCheck();
      return runtimeHealthSnapshot();
    }
    runtimeHealthCheckPromise ||= runRuntimeHealthCheck().finally(() => {
      runtimeHealthCheckPromise = null;
    });
    return runtimeHealthCheckPromise;
  };

  const runRuntimeHealthCheck = async () => {
    let inconclusive = false;
    const observedAt = Date.now();
    const observedGap = runtimeHealthLastCheckAt > 0
      ? observedAt - runtimeHealthLastCheckAt
      : 0;
    runtimeHealthLastCheckAt = observedAt;
    if (observedGap >= runtimeHealthResumeGapMs) {
      // 页面和后端被系统一起冻结，唤醒后 CodeyX 需要时间重新建立与
      // Codex 的连接。恢复前记录的失败不代表当前状态，直接丢弃。
      runtimeHealthResumeGraceUntil = observedAt + runtimeHealthResumeGraceMs;
      runtimeHealthFailures = 0;
    }
    const resuming = observedAt < runtimeHealthResumeGraceUntil;
    const checkTimeoutMs = resuming
      ? runtimeHealthResumeTimeoutMs
      : runtimeHealthCheckTimeoutMs;
    const failureThreshold = resuming
      ? runtimeHealthResumeFailureThreshold
      : runtimeHealthFailureThreshold;
    try {
      if (typeof window.__codexSessionDeleteBridge !== "function") {
        runtimeHealthFailures = failureThreshold;
        return setRuntimeHealthState("unavailable", "CodeyX bridge 不可用");
      }
      const result = await withTimeout(
        callBridge(backendHealthPath, {}, { timeoutMs: checkTimeoutMs }),
        checkTimeoutMs + 250,
        "CodeyX 后端健康检查超时",
      );
      if (result?.status === "ok") {
        runtimeHealthFailures = 0;
        return setRuntimeHealthState("healthy");
      }
      const error = new Error(result?.message || "CodeyX 后端未响应");
      error.code = result?.code || "backend_unavailable";
      throw error;
    } catch (error) {
      const immediate = error?.code === "bridge_unavailable";
      // 桥接重装或页面卡顿后的超时不能证明后端已断线。
      inconclusive = !immediate && (
        error?.code === "bridge_reinstalled"
        || Date.now() - observedAt > checkTimeoutMs + runtimeHealthStallToleranceMs
      );
      if (inconclusive) return runtimeHealthSnapshot();
      runtimeHealthFailures += 1;
      if (immediate) runtimeHealthFailures = failureThreshold;
      if (runtimeHealthFailures >= failureThreshold) {
        return setRuntimeHealthState("unavailable", "CodeyX 后端未响应");
      }
      return setRuntimeHealthState("checking", "正在确认 CodeyX 进程状态");
    } finally {
      let nextDelay = runtimeHealthState === "unavailable"
        ? runtimeHealthUnavailableRetryMs
        : runtimeHealthCheckIntervalMs;
      if (inconclusive || (runtimeHealthFailures > 0 && runtimeHealthFailures < failureThreshold)) {
        nextDelay = runtimeHealthFailureRetryMs;
      }
      scheduleRuntimeHealthCheck(nextDelay);
    }
  };

  const setAutomaticUpdateChecks = (policy) => {
    policy = policy === "off" ? "off" : "stable";
    if (codeyUpdatePolicy === policy) return;
    const previous = codeyUpdatePolicy;
    codeyUpdatePolicy = policy;
    if (previous !== null) setUpdateAvailability(null);
    updateCheckGeneration += 1;
    window.clearTimeout(updateCheckTimer);
    updateCheckTimer = 0;
  };

  const scheduleUpdateCheck = (delayMs = updateCheckIntervalMs) => {
    window.clearTimeout(updateCheckTimer);
    updateCheckTimer = 0;
    if (codeyUpdatePolicy === "off" || hasInstallableUpdate()) return;
    updateCheckTimer = window.setTimeout(() => {
      updateCheckTimer = 0;
      // 尚未读取到设置时先重试状态查询，避免关闭后仍发起更新请求。
      if (codeyUpdatePolicy === null) void hydrateUpdateAvailability();
      else void checkForUpdatesSilently();
    }, delayMs);
  };

  const checkForUpdatesSilently = async () => {
    if (codeyUpdatePolicy !== "stable" || updateCheckInFlight || hasInstallableUpdate()) return;
    updateCheckInFlight = true;
    const generation = updateCheckGeneration;
    try {
      const result = await withTimeout(
        callBridge(updateCheckPath, {}, { timeoutMs: updateCheckTimeoutMs }),
        updateCheckTimeoutMs,
      );
      if (codeyUpdatePolicy !== "stable" || generation !== updateCheckGeneration) return;
      if (result?.status !== "failed" && result?.updateAvailable === true) {
        setUpdateAvailability(result);
        return;
      }
    } catch {
      // 更新地址不可达或检查超时时直接跳过，不阻塞 Codex 页面。
    } finally {
      updateCheckInFlight = false;
      if (!hasInstallableUpdate()) scheduleUpdateCheck();
    }
  };

  const hydrateUpdateAvailability = async () => {
    const generation = updateCheckGeneration;
    try {
      const status = await withTimeout(
        callBridge(backendStatusPath, {}, { timeoutMs: updateCheckTimeoutMs }),
        updateCheckTimeoutMs,
        "读取更新状态超时",
      );
      if (generation !== updateCheckGeneration || !status || status.status === "failed") return;
      setAutomaticUpdateChecks(status.codeyUpdatePolicy ?? (status.autoCheckCodeyUpdates === false ? "off" : "stable"));
      setUpdateAvailability(status?.availableUpdate || null);
    } catch {
      if (generation === updateCheckGeneration) setUpdateAvailability(null);
    } finally {
      if (!hasInstallableUpdate()) scheduleUpdateCheck();
    }
  };

  const accountUsageWindowKind = (window) => {
    const minutes = Number(window?.windowMinutes);
    if (!Number.isFinite(minutes) || !Number.isFinite(Number(window?.usedPercent))) {
      return null;
    }
    if (minutes >= 6 * 24 * 60 && minutes <= 8 * 24 * 60) return "weekly";
    if (minutes >= 270 && minutes <= 330) return "five-hour";
    return null;
  };

  const normalizeAppServerUsageWindow = (window) => {
    if (typeof window?.usedPercent !== "number" || typeof window?.windowDurationMins !== "number") return null;
    const usedPercent = Number(window?.usedPercent);
    const windowMinutes = Number(window?.windowDurationMins);
    if (!Number.isFinite(usedPercent) || !Number.isFinite(windowMinutes) || windowMinutes <= 0) {
      return null;
    }
    const resetsAtValue = Number(window?.resetsAt);
    const resetsAt = Number.isFinite(resetsAtValue) && resetsAtValue > 0
      ? Math.round(resetsAtValue > 10_000_000_000 ? resetsAtValue / 1000 : resetsAtValue)
      : undefined;
    return {
      usedPercent: Math.max(0, Math.min(100, usedPercent)),
      windowMinutes: Math.max(1, Math.round(windowMinutes)),
      ...(resetsAt ? { resetsAt } : {}),
    };
  };

  const normalizeResetCreditsSummary = (summary) => {
    if (!summary || typeof summary !== "object") return null;
    const count = Number(summary.availableCount ?? summary.available_count);
    if (!Number.isSafeInteger(count) || count < 0) return null;
    let nextExpiresAt;
    for (const row of Array.isArray(summary.credits) ? summary.credits : []) {
      if (row?.status === "redeemed" || row?.status === "unknown") continue;
      const value = row?.expiresAt ?? row?.expires_at;
      const raw = Number(value);
      const seconds = Number.isFinite(raw) ? (raw > 10_000_000_000 ? raw / 1000 : raw)
        : typeof value === "string" ? Date.parse(value) / 1000 : NaN;
      if (!Number.isFinite(seconds) || seconds * 1000 <= Date.now()) continue;
      const expires = Math.round(seconds);
      nextExpiresAt = nextExpiresAt === undefined ? expires : Math.min(nextExpiresAt, expires);
    }
    return { availableCount: count, ...(nextExpiresAt ? { nextExpiresAt } : {}) };
  };

  const normalizeAppServerAccountUsage = (response) => {
    const unavailable = { status: "unavailable", code: "codex_usage_incompatible", message: "当前 Codex 暂时无法提供额度信息" };
    const payload = response?.result && typeof response.result === "object"
      ? response.result
      : response;
    if (!payload || typeof payload !== "object") {
      return unavailable;
    }
    // 账号摘要只读取通用额度，不能合并模型专属的 rateLimitsByLimitId。
    const buckets = [];
    if (payload.rateLimits && typeof payload.rateLimits === "object") {
      buckets.push(payload.rateLimits);
    }
    const windowsByKind = new Map();
    for (const bucket of buckets) {
      for (const rawWindow of [bucket.primary, bucket.secondary]) {
        const window = normalizeAppServerUsageWindow(rawWindow);
        const kind = accountUsageWindowKind(window);
        if (kind && !windowsByKind.has(kind)) windowsByKind.set(kind, window);
      }
    }
    const primary = windowsByKind.get("weekly") || windowsByKind.get("five-hour") || null;
    const secondary = primary === windowsByKind.get("weekly")
      ? windowsByKind.get("five-hour") || null
      : windowsByKind.get("weekly") || null;
    const rawCredits = buckets.find((bucket) => bucket.credits)?.credits || payload.credits || null;
    const credits = rawCredits && typeof rawCredits === "object"
      && (rawCredits.unlimited === true || (rawCredits.hasCredits === true
        && (typeof rawCredits.balance === "number"
          || (typeof rawCredits.balance === "string" && rawCredits.balance.trim() !== ""))
        && Number.isFinite(Number(rawCredits.balance))))
      ? rawCredits : null;
    if (!primary && !secondary && !credits) {
      return unavailable;
    }
    const planType = buckets
      .map((bucket) => bucket.planType)
      .find((value) => typeof value === "string" && value.trim())
      || (typeof payload.planType === "string" ? payload.planType : undefined);
    const resetCredits = normalizeResetCreditsSummary(
      payload.rateLimitResetCredits ?? payload.rate_limit_reset_credits
        ?? payload.rateLimits?.rateLimitResetCredits ?? payload.rateLimits?.rate_limit_reset_credits,
    );
    return {
      status: "ok",
      ...(planType ? { planType } : {}),
      ...(primary ? { primary } : {}),
      ...(secondary ? { secondary } : {}),
      ...(credits ? { credits } : {}),
      ...(resetCredits ? { resetCredits } : {}),
      fetchedAt: Math.floor(Date.now() / 1000),
    };
  };

  const escapeAccountUsageText = (value) => String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");

  const accountUsageWindowLabel = (window) => {
    const kind = accountUsageWindowKind(window);
    if (kind === "weekly") return "每周额度";
    if (kind === "five-hour") return "5 小时额度";
    const minutes = Math.max(1, Math.round(Number(window?.windowMinutes) || 0));
    if (minutes % (24 * 60) === 0) return `${minutes / (24 * 60)} 天额度`;
    if (minutes % 60 === 0) return `${minutes / 60} 小时额度`;
    return `${minutes} 分钟额度`;
  };

  const accountUsagePlanLabel = (planType) => {
    const raw = String(planType || "").trim();
    if (!raw) return "";
    const compact = raw.toLowerCase().replace(/[\s_$-]+/g, "");
    if (compact === "5x" || compact.includes("pro5x") || compact.includes("pro100")) {
      return "Pro 5x";
    }
    if (compact === "pro" || compact.includes("pro20x") || compact.includes("pro200")) {
      return "Pro 20x";
    }
    if (compact.includes("prolite")) return "Pro Lite";
    if (compact.includes("plus")) return "Plus";
    if (compact.includes("free")) return "Free";
    return raw
      .replace(/[_-]+/g, " ")
      .replace(/\b\w/g, (character) => character.toUpperCase());
  };

  const accountUsageDurationLabel = (minutes) => {
    const total = Math.max(1, Math.ceil(minutes));
    if (total < 60) return `${total} 分钟`;
    if (total < 24 * 60) {
      const hours = Math.floor(total / 60);
      const rest = total % 60;
      return rest ? `${hours} 小时 ${rest} 分钟` : `${hours} 小时`;
    }
    const days = Math.floor(total / (24 * 60));
    const hours = Math.floor((total % (24 * 60)) / 60);
    return hours ? `${days} 天 ${hours} 小时` : `${days} 天`;
  };

  const accountUsageResetLabel = (resetsAt) => {
    const timestamp = Number(resetsAt);
    if (!Number.isFinite(timestamp) || timestamp <= 0) return "";
    const remainingMinutes = (timestamp * 1000 - Date.now()) / 60_000;
    return remainingMinutes > 0 ? `${accountUsageDurationLabel(remainingMinutes)}后重置` : "即将重置";
  };

  const accountUsageResetTimeLabel = (resetsAt, suffix = "重置") => {
    const timestamp = Number(resetsAt);
    if (!Number.isFinite(timestamp) || timestamp <= 0) return "";
    const resetAt = new Date(timestamp * 1000);
    if (Number.isNaN(resetAt.getTime())) return "";
    const now = new Date();
    const startOfToday = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
    ).getTime();
    const startOfResetDay = new Date(
      resetAt.getFullYear(),
      resetAt.getMonth(),
      resetAt.getDate(),
    ).getTime();
    const dayOffset = Math.round(
      (startOfResetDay - startOfToday) / (24 * 60 * 60 * 1000),
    );
    const time = resetAt.toLocaleTimeString("zh-CN", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    if (dayOffset === 0) return `今天 ${time} ${suffix}`;
    if (dayOffset === 1) return `明天 ${time} ${suffix}`;
    return `${resetAt.getMonth() + 1}月${resetAt.getDate()}日 ${time} ${suffix}`;
  };

  // Codex 把侧边栏底部内容收进贴底的绝对定位 footer 容器后，容器内容由 Codex
  // 自己渲染，可能暂时为空，所以不能再要求它一定含控件。
  const sidebarFooterSlot = (element) => {
    const style = window.getComputedStyle(element);
    if (!style || style.display === "none" || style.visibility === "hidden") return false;
    return style.position === "absolute"
      && style.bottom === "0px"
      && element.getBoundingClientRect().width > 0;
  };

  const findAccountUsageMount = () => {
    const seenNavigations = new Set();
    for (const anchor of queryWithin(document, sidebarSelector)) {
      const navigation = anchor.matches?.("nav") ? anchor : anchor.closest?.("nav");
      if (!(navigation instanceof HTMLElement) || seenNavigations.has(navigation)) continue;
      seenNavigations.add(navigation);
      if (!visibleMountRect(navigation)) continue;
      const sidebarRoot = navigation.parentElement;
      if (!(sidebarRoot instanceof HTMLElement)) continue;
      const siblings = Array.from(sidebarRoot.children || []);
      const navigationIndex = siblings.indexOf(navigation);
      const trailing = siblings
        .slice(navigationIndex + 1)
        .filter((target) => target instanceof HTMLElement && target.id !== accountUsageId);
      // 老布局的 footer 自带账号控件，新布局只剩 Codex 的贴底容器；两者都接受，
      // 一律插到容器内最后一个子元素之前，让 Codex 的测量继续覆盖额度块。
      const target = trailing.find((candidate) => (candidate.querySelectorAll?.("button, [role=button], a[href]")?.length || 0) > 0)
        || trailing.find(sidebarFooterSlot);
      if (!target) continue;
      const before = Array.from(target.children || [])
        .reverse()
        .find((child) => child instanceof HTMLElement && child.id !== accountUsageId) || null;
      return { target, before };
    }
    return null;
  };

  const mountedAccountUsageIsUsable = (usage) => {
    if (!(usage instanceof HTMLElement) || usage.isConnected !== true) return false;
    const host = usage.parentElement;
    return host instanceof HTMLElement
      && host.getAttribute("data-codey-usage-host") === "true"
      && usage.nextElementSibling === usage.__codeyUsageAnchor;
  };

  // 按已经过去的窗口时间估算消耗速度：用量快于时间时预测用尽时刻，样本太少时不下结论。
  const accountUsagePace = (window, remaining, now) => {
    const windowMinutes = Number(window.windowMinutes);
    const resetsAt = Number(window.resetsAt);
    const state = remaining < 0.5 ? "empty" : Number(window.usedPercent) <= 0 ? "idle" : "";
    if (!Number.isFinite(resetsAt) || resetsAt <= 0 || !(windowMinutes > 0)) return { state };
    const minutesLeft = Math.max(0, Math.min(windowMinutes, (resetsAt * 1000 - now) / 60_000));
    const pace = { state, minutesLeft };
    const elapsedMinutes = windowMinutes - minutesLeft;
    if (state || elapsedMinutes < Math.max(10, windowMinutes * 0.02)) return pace;
    const minutesToEmpty = remaining / ((100 - remaining) / elapsedMinutes);
    return minutesToEmpty < minutesLeft
      ? { ...pace, state: "fast", minutesToEmpty }
      : { ...pace, state: "steady" };
  };

  const accountUsagePaceNote = (pace) => {
    if (pace.state === "empty") {
      return pace.minutesLeft > 0 ? `已用完，${accountUsageDurationLabel(pace.minutesLeft)}后恢复` : "额度已用完";
    }
    if (pace.state === "idle") return "本周期尚未使用";
    if (pace.state === "fast") return `按当前速度约 ${accountUsageDurationLabel(pace.minutesToEmpty)}后用完`;
    if (pace.state === "steady") return "按当前速度可用到重置";
    return "";
  };

  const accountUsageWindowModel = (window, kind, key, now) => {
    const remaining = Math.max(0, Math.min(100, 100 - Number(window.usedPercent)));
    const rounded = Math.round(remaining);
    const pace = accountUsagePace(window, remaining, now);
    const name = accountUsageWindowLabel(window);
    const reset = accountUsageResetLabel(window.resetsAt);
    const percent = remaining > 0 && rounded === 0 ? "<1%" : `${rounded}%`;
    return {
      kind,
      key,
      name,
      pace,
      percent,
      minutes: Number(window.windowMinutes),
      shortLabel: kind === "weekly" ? "每周" : kind === "five-hour" ? "5 小时" : name.replace(/额度$/, ""),
      tone: rounded <= accountUsageCriticalPercent
        ? "critical"
        : rounded <= accountUsageWarningPercent ? "warning" : "ok",
      reset,
      resetTime: accountUsageResetTimeLabel(window.resetsAt),
      announcement: `${name}剩余 ${percent}`,
      aria: `${name}剩余 ${percent}${reset ? `，${reset}` : ""}`,
      remainingRatio: Number((remaining / 100).toFixed(4)),
    };
  };

  const accountUsageWindowModels = (result, now = Date.now()) => {
    const seen = new Set();
    const models = [];
    for (const window of [result?.primary, result?.secondary]) {
      const windowMinutes = Number(window?.windowMinutes);
      if (!Number.isFinite(Number(window?.usedPercent)) || !Number.isFinite(windowMinutes) || windowMinutes <= 0) continue;
      const kind = accountUsageWindowKind(window);
      const key = kind || `w${Math.round(windowMinutes)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      models.push(accountUsageWindowModel(window, kind, key, now));
    }
    return models.sort((left, right) => left.minutes - right.minutes);
  };

  // 摘要顶部的一句话结论取最需要关注的窗口：已用完 > 余量紧张 > 消耗偏快 > 余量偏低。
  const accountUsageOverview = (models, stale, fetchedAt) => {
    if (stale) {
      const fetched = accountUsageClockLabel(fetchedAt);
      return { tone: "warning", text: fetched ? `未能刷新 · 截至 ${fetched}` : "未能刷新" };
    }
    const empty = models.find((model) => model.pace.state === "empty");
    if (empty) return { tone: "critical", text: `${empty.name}已用完` };
    if (models.some((model) => model.tone === "critical")) return { tone: "critical", text: "额度紧张" };
    if (models.some((model) => model.pace.state === "fast")) return { tone: "warning", text: "消耗偏快" };
    if (models.some((model) => model.tone === "warning")) return { tone: "warning", text: "额度偏低" };
    return { tone: "ok", text: "额度充足" };
  };

  const accountUsageSummaryMarkup = (models, overview, plan) => `
      <div class="codey-usage-overview" data-tone="${overview.tone}">
        <span class="codey-usage-status">${escapeAccountUsageText(overview.text)}</span>
        ${plan ? `<span class="codey-usage-plan">${escapeAccountUsageText(plan)}</span>` : ""}
      </div>
      ${models.map((model) => {
        const { state, minutesLeft } = model.pace;
        const meta = state === "empty"
          ? minutesLeft > 0 ? `${accountUsageDurationLabel(minutesLeft)}后恢复` : "已用完"
          : model.reset;
        return `
      <span class="codey-usage-segment" data-window="${model.kind}" data-tone="${model.tone}" data-pace="${state || "unknown"}" style="--codey-usage-remaining:${model.remainingRatio}">
        <span class="codey-usage-label">${escapeAccountUsageText(model.shortLabel)}</span>
        <span class="codey-usage-meter" aria-hidden="true"><span class="codey-usage-fill"></span></span>
        <span class="codey-usage-value">${escapeAccountUsageText(model.percent)}</span>
        ${meta ? `<span class="codey-usage-reset">${escapeAccountUsageText(meta)}</span>` : ""}
      </span>`;
      }).join("")}`;

  const accountUsageDetailWindow = (model) => {
    const note = accountUsagePaceNote(model.pace);
    const { minutesLeft } = model.pace;
    const countdown = minutesLeft === undefined
      ? ""
      : minutesLeft > 0 ? `${accountUsageDurationLabel(minutesLeft)}后` : "即将重置";
    return `
      <section class="codey-usage-window" data-tone="${model.tone}" data-pace="${model.pace.state || "unknown"}" style="--codey-usage-remaining:${model.remainingRatio}">
        <div class="codey-usage-window-head">
          <span class="codey-usage-window-name">${escapeAccountUsageText(model.name)}</span>
          <span class="codey-usage-figure"><span class="codey-usage-figure-label">剩余</span><span class="codey-usage-figure-value">${escapeAccountUsageText(model.percent)}</span></span>
        </div>
        <span class="codey-usage-meter" aria-hidden="true"><span class="codey-usage-fill"></span></span>
        ${model.resetTime ? `<div class="codey-usage-window-meta"><span>${escapeAccountUsageText(model.resetTime)}</span>${countdown ? `<span>${countdown}</span>` : ""}</div>` : ""}
        ${note ? `<div class="codey-usage-pace-note">${escapeAccountUsageText(note)}</div>` : ""}
      </section>`;
  };

  const accountUsageCreditsLabel = (credits) => {
    if (!credits || typeof credits !== "object") return "";
    if (credits.unlimited) return "不限";
    const raw = credits.balance;
    const blank = raw === undefined || raw === null || String(raw).trim() === "";
    const balance = blank ? 0 : Number(raw);
    // 账号未开通 Credits 时接口也会回传 0，这种情况不占用详情空间。
    if (credits.hasCredits === false && balance === 0) return "";
    if (blank) return credits.hasCredits ? "可用" : "0";
    return Number.isFinite(balance) ? balance.toLocaleString("zh-CN", { maximumFractionDigits: 2 }) : String(raw);
  };

  const accountUsageClockLabel = (seconds) => {
    const timestamp = Number(seconds);
    if (!Number.isFinite(timestamp) || timestamp <= 0) return "";
    const date = new Date(timestamp * 1000);
    if (Number.isNaN(date.getTime())) return "";
    return date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
  };

  const accountUsageResetExpiring = (credits) => {
    const remaining = Number(credits?.nextExpiresAt) * 1000 - Date.now();
    return Number(credits?.availableCount) > 0 && remaining > 0 && remaining <= 12 * 60 * 60 * 1000;
  };

  const accountUsageResetCreditsMarkup = (credits) => {
    const count = Number(credits?.availableCount);
    if (!Number.isSafeInteger(count) || count <= 0) return "";
    const expiry = accountUsageResetTimeLabel(credits.nextExpiresAt, "过期");
    return `<div class="codey-usage-credits codey-usage-reset-credits"${accountUsageResetExpiring(credits) ? ' data-expiring="true"' : ""}>
      <span>剩余重置次数</span><span class="codey-usage-credits-value">${count} 次</span>
      ${expiry ? `<span class="codey-usage-credit-expiry">最近 ${escapeAccountUsageText(expiry)}</span>` : ""}
    </div>`;
  };

  const accountUsageDetailsMarkup = (result, models) => {
    const plan = accountUsagePlanLabel(result?.planType);
    const credits = accountUsageCreditsLabel(result?.credits);
    const fetched = accountUsageClockLabel(result?.fetchedAt);
    return `
      <div class="codey-usage-pop-head">
        <span class="codey-usage-pop-title">账号额度</span>
        ${plan ? `<span class="codey-usage-plan">${escapeAccountUsageText(plan)}</span>` : ""}
      </div>
      ${models.map(accountUsageDetailWindow).join("")}
      ${credits ? `<div class="codey-usage-credits"><span>Credits 余额</span><span class="codey-usage-credits-value">${escapeAccountUsageText(credits)}</span></div>` : ""}
      ${accountUsageResetCreditsMarkup(result?.resetCredits)}
      <div class="codey-usage-pop-foot">
        ${fetched ? `<span class="codey-usage-updated">更新于 ${fetched}</span>` : ""}
        <span class="codey-usage-stale-note">${fetched ? `未能刷新 · 截至 ${fetched}` : "未能刷新，显示上次结果"}</span>
      </div>`;
  };

  const accountUsageErrorSummary = `
      <span class="codey-usage-error">
        <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><circle cx="8" cy="8" r="6.2"></circle><path d="M8 4.9v3.6M8 11v.1"></path></svg>
        <span>额度暂不可用</span>
      </span>`;

  const accountUsageErrorDetails = (message) => `
      <div class="codey-usage-pop-head"><span class="codey-usage-pop-title">账号额度</span></div>
      <p class="codey-usage-error-message">${escapeAccountUsageText(message || "官方账号额度暂不可用")}</p>
      <div class="codey-usage-pop-foot"><span>稍后会自动重试</span></div>`;

  const accountUsagePart = (usage, key, create) => {
    let part = usage[key];
    if (!(part instanceof HTMLElement) || part.parentElement !== usage) {
      part = create();
      usage[key] = part;
      usage.appendChild(part);
    }
    return part;
  };

  // 摘要、详情各自比对后再写入，避免轮询和侧边栏重扫造成多余重排。摘要含按分钟变化的
  // 倒计时，所以读屏播报交给独立的隐藏节点，只在结论或剩余比例变化时更新。
  const writeAccountUsage = (usage, summaryHtml, detailsHtml, announcement) => {
    const summary = accountUsagePart(usage, "__codeyUsageSummary", () => {
      const element = document.createElement("div");
      element.className = "codey-usage-summary";
      return element;
    });
    const details = accountUsagePart(usage, "__codeyUsageDetails", () => {
      const element = document.createElement("div");
      element.id = accountUsageDetailsId;
      element.className = "codey-usage-details";
      element.setAttribute("role", "tooltip");
      return element;
    });
    const announcer = accountUsagePart(usage, "__codeyUsageAnnouncer", () => {
      const element = document.createElement("span");
      element.className = "codey-usage-announcer";
      element.setAttribute("role", "status");
      element.setAttribute("aria-live", "polite");
      element.setAttribute("aria-atomic", "true");
      return element;
    });
    if (summary.__codeyUsageHtml !== summaryHtml) {
      summary.__codeyUsageHtml = summaryHtml;
      summary.innerHTML = summaryHtml;
    }
    if (details.__codeyUsageHtml !== detailsHtml) {
      details.__codeyUsageHtml = detailsHtml;
      details.innerHTML = detailsHtml;
    }
    if (announcer.textContent !== announcement) announcer.textContent = announcement;
  };

  const removeAccountUsage = () => {
    const usage = document.getElementById(accountUsageId);
    if (usage) usage.__codeyUsageAnchor = null;
    usage?.remove?.();
    document.querySelectorAll?.("[data-codey-usage-host]")?.forEach?.((host) => {
      host.removeAttribute?.("data-codey-usage-host");
    });
  };

  const accountUsageMount = () => {
    addStyle();
    let usage = document.getElementById(accountUsageId);
    if (mountedAccountUsageIsUsable(usage)) return usage;
    const mount = findAccountUsageMount();
    if (!mount) {
      usage?.remove?.();
      return null;
    }
    if (!(usage instanceof HTMLElement)) {
      usage = document.createElement("div");
      usage.id = accountUsageId;
      usage.setAttribute("role", "group");
      usage.setAttribute("tabindex", "0");
      // Esc 收起详情浮层，移开指针或焦点后恢复，满足悬浮提示可关闭的要求。
      const restoreDetails = () => { delete usage.dataset.dismissed; };
      usage.addEventListener("keydown", (event) => {
        if (event.key === "Escape") usage.dataset.dismissed = "true";
      });
      usage.addEventListener("blur", restoreDetails);
      usage.addEventListener("pointerleave", restoreDetails);
    }
    document.querySelectorAll?.("[data-codey-usage-host]")?.forEach?.((host) => {
      if (host !== mount.target) host.removeAttribute?.("data-codey-usage-host");
    });
    mount.target.setAttribute("data-codey-usage-host", "true");
    if (usage.parentElement !== mount.target || usage.nextElementSibling !== mount.before) {
      mount.target.insertBefore(usage, mount.before);
    }
    usage.__codeyUsageAnchor = mount.before;
    return usage;
  };

  const renderAccountUsage = (result) => {
    if (!result || result.status === "disabled" || result.status === "unavailable") {
      accountUsagePollingEnabled = false;
      window.clearTimeout(accountUsageTimer);
      accountUsageTimer = 0;
      accountUsageLastResult = null;
      removeAccountUsage();
      return;
    }
    accountUsagePollingEnabled = true;
    if (result.status === "error") {
      // 已有成功结果时继续展示上次数据，只标记为未能刷新。
      if (accountUsageLastResult?.status === "ok") {
        accountUsageStale = true;
        renderAccountUsage(accountUsageLastResult);
        return;
      }
      const usage = accountUsageMount();
      if (!usage) return;
      usage.dataset.state = "error";
      delete usage.dataset.windowCount;
      usage.setAttribute("aria-label", "官方账号额度暂不可用");
      usage.setAttribute("aria-describedby", accountUsageDetailsId);
      writeAccountUsage(
        usage,
        accountUsageErrorSummary,
        accountUsageErrorDetails(String(result.message || "")),
        "官方账号额度暂不可用",
      );
      return;
    }
    if (result.status !== "ok") return;

    if (result !== accountUsageLastResult) accountUsageStale = false;
    const models = accountUsageWindowModels(result);
    const summaryModels = models.filter((model) => model.kind);
    accountUsageLastResult = result;
    if (!summaryModels.length) {
      removeAccountUsage();
      return;
    }
    const usage = accountUsageMount();
    if (!usage) return;
    usage.dataset.state = accountUsageStale ? "stale" : "ready";
    usage.dataset.windowCount = String(summaryModels.length);
    const overview = accountUsageOverview(summaryModels, accountUsageStale, result.fetchedAt);
    if (accountUsageResetExpiring(result.resetCredits)) overview.text += " · 重置次数即将过期";
    const aria = summaryModels.map((model) => model.aria).join("；")
      + (accountUsageStale && accountUsageResetExpiring(result.resetCredits) ? "；重置次数即将过期" : "");
    usage.setAttribute("aria-label", accountUsageStale ? `${aria}；暂未能刷新，显示上次结果` : `${overview.text}；${aria}`);
    usage.setAttribute("aria-describedby", accountUsageDetailsId);
    writeAccountUsage(
      usage,
      accountUsageSummaryMarkup(summaryModels, overview, accountUsagePlanLabel(result.planType)),
      accountUsageDetailsMarkup(result, models),
      [overview.text, ...summaryModels.map((model) => model.announcement)].join("；"),
    );
  };

  const scheduleAccountUsageCheck = (delayMs = accountUsageRefreshIntervalMs) => {
    window.clearTimeout(accountUsageTimer);
    accountUsageTimer = 0;
    if (!accountUsagePollingEnabled || document.visibilityState === "hidden") return;
    accountUsageTimer = window.setTimeout(() => {
      accountUsageTimer = 0;
      void checkAccountUsage();
    }, delayMs);
  };

  const readAccountUsageFromAppServer = async (backendResult) => {
    if (typeof window.__codeyReadAccountRateLimits !== "function") {
      return { status: "unavailable", code: "codex_usage_incompatible", message: "当前 Codex 暂时无法提供额度信息" };
    }
    const response = await window.__codeyReadAccountRateLimits();
    const snapshot = normalizeAppServerAccountUsage(response);
    if (snapshot.status !== "ok") return snapshot;
    // 同步 Codex 管理的账号额度，让官方账号面板可以复用当前快照。
    if (Number.isSafeInteger(backendResult?.authGeneration)) {
      const stored = await callBridge("/api/store_official_account_usage", {
        authGeneration: backendResult.authGeneration, snapshot,
      }, { timeoutMs: accountUsageTimeoutMs });
      if (stored?.status !== "ok") throw new Error(stored?.message || "同步官方额度失败");
      snapshot.authGeneration = backendResult.authGeneration;
    }
    return snapshot;
  };

  const checkAccountUsage = async () => {
    if (accountUsageCheckInFlight || document.visibilityState === "hidden") return null;
    accountUsageCheckInFlight = true;
    try {
      let result = await withTimeout(
        callBridge(accountUsagePath, {}, { timeoutMs: accountUsageTimeoutMs }),
        accountUsageTimeoutMs,
        "读取官方账号额度超时",
      );
      if (result?.status === "error" || result?.stale) {
        try {
          const fallback = await withTimeout(
            readAccountUsageFromAppServer(result),
            accountUsageTimeoutMs,
            "读取 Codex 官方额度超时",
          );
          if (fallback?.status === "ok") result = fallback;
        } catch {
          // Preserve the original backend error. It is normally more actionable
          // when the current Codex asset does not expose AppServerManager yet.
        }
      }
      renderAccountUsage(result);
      return result;
    } catch (error) {
      renderAccountUsage({
        status: "error",
        message: error instanceof Error ? error.message : String(error),
      });
      return null;
    } finally {
      accountUsageCheckInFlight = false;
      if (accountUsagePollingEnabled) scheduleAccountUsageCheck();
    }
  };

  const syncAccountUsageMount = () => {
    if (accountUsageLastResult?.status === "ok") {
      renderAccountUsage(accountUsageLastResult);
    }
  };

  const preloadSettings = async () => {
    const overlay = window.__codeySettingsOverlay;
    if (runtimeHealthState === "unavailable"
      || !overlay?.__codeyLazyLoader
      || typeof overlay.load !== "function") return;
    try {
      await overlay.load();
    } catch {
      // Passive loading must leave error reporting and retry to the real click.
    }
  };

  const openSettings = async () => {
    if (runtimeHealthState === "unavailable") {
      if (settingsHealthCheckPending) return;
      settingsHealthCheckPending = true;
      try {
        await checkRuntimeHealth();
      } finally {
        settingsHealthCheckPending = false;
      }
      if (runtimeHealthState === "unavailable") {
        window.alert(
          "CodeyX 与 Codex 的连接已中断，当前配置面板无法连接。"
          + "CodeyX 会继续尝试自动恢复；若长时间仍未恢复，请退出 Codex 后重新启动 CodeyX。",
        );
        return;
      }
    }
    if (window.__codeySettingsOverlay?.toggle) {
      window.__codeySettingsOverlay.toggle();
      return;
    }
    const detail = String(window.__codeyOverlayError || "").split("\n")[0];
    window.alert(detail
      ? `CodeyX 内嵌配置面板加载失败：${detail}`
      : "CodeyX 内嵌配置面板尚未加载，请退出 Codex 后重新启动 CodeyX");
  };

  const mountableRect = (element) => {
    if (!(element instanceof HTMLElement)) return null;
    const style = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== "none"
      && style.visibility !== "hidden"
      && rect.width > 0
      && rect.height > 0
      ? rect
      : null;
  };

  const visibleMountRect = (element) =>
    element instanceof HTMLElement && element.closest("[hidden], [aria-hidden=true]")
      ? null
      : mountableRect(element);

  // Codex 打开模态对话框时只给图标栏等背景内容补 aria-hidden，布局不变；
  // 把它当成隐藏会让对话框弹出期间的扫描把入口当成失效挂载卸载。
  const railMountRect = (element) =>
    element instanceof HTMLElement && element.closest("[hidden]")
      ? null
      : mountableRect(element);

  const isTopChromeMountTarget = (element) => {
    const rect = visibleMountRect(element);
    if (!rect) return false;
    const viewportWidth = Math.max(
      window.innerWidth || 0,
      document.documentElement?.clientWidth || 0,
      document.documentElement?.getBoundingClientRect?.().width || 0,
      rect.right,
    );
    return rect.top <= 96
      && rect.height <= 120
      && rect.width >= 48
      && rect.right >= viewportWidth - 48;
  };

  const findHeaderMount = () => {
    const header = [...document.querySelectorAll("header")].find(isTopChromeMountTarget)
      || [...document.querySelectorAll("nav")].find(isTopChromeMountTarget);
    if (!header) return null;

    const rightmostControl = [...header.querySelectorAll("button, [role=button], a[href]")]
      .reduce((rightmost, control) => {
        if (control.id === buttonId) return rightmost;
        const rect = visibleMountRect(control);
        if (!rect || (rightmost && rect.right <= rightmost.right)) return rightmost;
        return { control, right: rect.right };
      }, null)?.control || null;
    if (!rightmostControl) return { header, target: header };

    // Newer shells measure an invisible copy of each action row. Participate
    // in that measurement so panel headers reserve the complete action width.
    const slot = rightmostControl.closest('[data-test-id="header-shell-slot"]');
    if (slot?.parentElement === header) {
      const measureHost = [...slot.children].find((child) => child.getAttribute("aria-hidden") === "true");
      const visibleHost = [...slot.children].find((child) => child !== measureHost && child.contains(rightmostControl));
      const measureRow = measureHost?.firstElementChild;
      const actionRow = visibleHost?.firstElementChild;
      if (measureRow && actionRow && visibleMountRect(actionRow)) {
        return { header, target: actionRow, measureRow, nativeSlot: true };
      }
      // Some shells measure the live content directly, without a hidden copy.
      // There the slot holds one measured host, and the action row sits inside it.
      const liveHost = slot.children.length === 1 ? slot.firstElementChild : null;
      const liveRowCandidate = liveHost?.firstElementChild;
      const liveRow = liveRowCandidate
        && liveRowCandidate !== rightmostControl
        && liveRowCandidate.contains(rightmostControl)
        ? liveRowCandidate
        : liveHost;
      if (!measureHost && liveRow?.contains(rightmostControl) && visibleMountRect(liveRow)) {
        return { header, target: liveRow, nativeSlot: true };
      }
    }

    let headerChild = rightmostControl;
    while (headerChild.parentElement && headerChild.parentElement !== header) {
      headerChild = headerChild.parentElement;
    }
    const headerRect = header.getBoundingClientRect();
    const childRect = headerChild.getBoundingClientRect();
    const hasTrailingActionRegion = headerChild !== rightmostControl
      && childRect.width <= 240
      && childRect.right >= headerRect.right - 24;
    return {
      header,
      target: header,
      before: hasTrailingActionRegion ? headerChild : null,
    };
  };

  // 图标栏底部的贴底堆栈：nav 的最后一个可见子容器 → 它的 flex 列容器，
  // 帮助菜单可能不再显示，此时将 CodeyX 入口放在个人资料菜单之前。
  const findRailFooterMount = () => {
    const rail = document.querySelector(navigationRailSelector);
    if (!(rail instanceof HTMLElement)) return null;
    navigationRailSeen = true;
    if (!railMountRect(rail)) return null;
    const cluster = [...rail.children]
      .filter((child) => railMountRect(child))
      .at(-1);
    const stack = cluster?.firstElementChild;
    if (!(stack instanceof HTMLElement)) return null;
    const controls = [...stack.querySelectorAll("button")]
      .filter((candidate) => candidate.id !== buttonId && railMountRect(candidate));
    const anchor = controls.find((candidate) => railHelpLabelPattern.test(candidate.getAttribute("aria-label") || ""))
      || controls.find((candidate) => railProfileLabelPattern.test(candidate.getAttribute("aria-label") || ""));
    if (!(anchor instanceof HTMLElement)) return null;
    // 菜单按钮外面可能还包着 radix 的触发层，只取 stack 的直接子容器作锚点。
    const before = [...stack.children]
      .find((child) => child instanceof HTMLElement && child.contains(anchor));
    if (!(before instanceof HTMLElement)) return null;
    return { target: stack, before };
  };

  const mountedButtonIsUsable = (button) => {
    if (headerMountDirty || !(button instanceof HTMLElement) || button.isConnected !== true) {
      return false;
    }
    const parent = button.parentElement;
    if (!(parent instanceof HTMLElement)) {
      return false;
    }
    if (button.dataset.codeyRailSlot === "true") {
      // 模态对话框给背景补的 aria-hidden 不算真实隐藏，与 railMountRect 一致。
      if (button.closest("[hidden]")) return false;
      const rail = button.closest?.(navigationRailSelector);
      return !!rail
        && rail.isConnected !== false
        && parent === button.__codeyRailStack
        && button.nextElementSibling === button.__codeyRailAnchor;
    }
    if (button.closest("[hidden], [aria-hidden=true]")) {
      return false;
    }
    // 页面先渲染顶部、后渲染侧栏时，已挂载的顶部入口也需要迁移。
    if (document.querySelector(navigationRailSelector)) return false;
    if (button.dataset.codeyNativeSlot === "true") {
      const measure = document.getElementById(buttonMeasureId);
      return parent === button.__codeyActionRow
        && button.nextElementSibling === null
        && !!parent.closest('[data-test-id="header-shell-slot"]')
        && (!button.__codeyMeasureRow || (
          measure?.parentElement === button.__codeyMeasureRow
          && measure?.isConnected === true
        ));
    }
    const validParent = parent.matches?.(headerSelector);
    const anchored = button.dataset.codeyHeaderActions !== "true"
      || (
        !!button.nextElementSibling
        && button.nextElementSibling === button.__codeyHeaderAnchor
      );
    return !!validParent && anchored;
  };

  const mountButton = () => {
    addStyle();
    const existingButton = document.getElementById(buttonId);
    if (mountedButtonIsUsable(existingButton)) return;
    const railMount = findRailFooterMount();
    // 仅无图标栏的旧版布局使用顶部入口，侧栏重建期间等待它恢复。
    const mount = railMount || (!navigationRailSeen ? findHeaderMount() : null);
    if (!mount) {
      existingButton?.remove?.();
      document.getElementById(buttonMeasureId)?.remove();
      return;
    }
    let button = existingButton;
    if (!button) {
      button = document.createElement("button");
      button.id = buttonId;
      button.type = "button";
      button.setAttribute("aria-label", "打开 CodeyX 配置");
      button.innerHTML = `${settingsIcon}<span class="codey-runtime-badge" aria-hidden="true">!</span><span class="codey-settings-label">CodeyX</span>`;
      button.title = "打开 CodeyX 配置";
      button.addEventListener("pointerenter", preloadSettings, { passive: true });
      button.addEventListener("focus", preloadSettings);
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        void openSettings();
      }, true);
    }
    if (railMount) {
      button.dataset.codeyRailSlot = "true";
      delete button.dataset.codeyHeaderActions;
      delete button.dataset.codeyNativeSlot;
      document.getElementById(buttonMeasureId)?.remove();
      button.__codeyActionRow = null;
      button.__codeyMeasureRow = null;
      button.__codeyHeaderAnchor = null;
      button.__codeyRailStack = mount.target;
      button.__codeyRailAnchor = mount.before;
      if (button.parentElement !== mount.target || button.nextElementSibling !== mount.before) {
        mount.target.insertBefore(button, mount.before);
      }
      applyUpdateBadge(button);
      headerMountDirty = false;
      return;
    }
    delete button.dataset.codeyRailSlot;
    button.__codeyRailStack = null;
    button.__codeyRailAnchor = null;
    if (mount.before) {
      button.dataset.codeyHeaderActions = "true";
    } else {
      delete button.dataset.codeyHeaderActions;
    }
    if (mount.nativeSlot) {
      button.dataset.codeyNativeSlot = "true";
      let measure = document.getElementById(buttonMeasureId);
      if (mount.measureRow && !measure) {
        measure = document.createElement("span");
        measure.id = buttonMeasureId;
        measure.setAttribute("aria-hidden", "true");
      }
      if (mount.measureRow) {
        if (measure.parentElement !== mount.measureRow) mount.measureRow.appendChild(measure);
      } else {
        measure?.remove();
      }
      button.__codeyActionRow = mount.target;
      button.__codeyMeasureRow = mount.measureRow || null;
    } else {
      delete button.dataset.codeyNativeSlot;
      document.getElementById(buttonMeasureId)?.remove();
      button.__codeyActionRow = null;
      button.__codeyMeasureRow = null;
    }
    if (mount.before) {
      if (button.parentElement !== mount.target || button.nextElementSibling !== mount.before) {
        mount.target.insertBefore(button, mount.before);
      }
    } else if (
      button.parentElement !== mount.target
      || (mount.nativeSlot && button.nextElementSibling !== null)
    ) {
      mount.target.appendChild(button);
    }
    button.__codeyHeaderAnchor = mount.before || null;
    applyUpdateBadge(button);
    headerMountDirty = false;
  };

  const finishSessionToolsLoad = () => {
    if (window.__codeySessionToolsInjectLoaded !== true) return false;
    disarmSessionToolsInteraction();
    bootstrapObserver?.disconnect();
    bootstrapObserver = null;
    return true;
  };

  const loadSessionTools = () => {
    if (finishSessionToolsLoad()) return Promise.resolve(true);
    if (sessionToolsLoadPromise) return sessionToolsLoadPromise;
    sessionToolsLoadPromise = Promise.resolve(callBridge(
      sessionToolsLoadPath,
      {},
      { timeoutMs: updateCheckTimeoutMs },
    ))
      .then((result) => {
        if (!result || result.status !== "ok") {
          throw new Error(result?.message || "会话工具加载请求失败");
        }
        if (window.__codeySessionToolsInjectLoaded !== true) {
          throw new Error(window.__codeySessionToolsError || "会话工具未完成初始化");
        }
        return finishSessionToolsLoad();
      })
      .catch((error) => {
        // Runtime.evaluate can time out while the renderer keeps executing the
        // already-started script. If initialization completed before the bridge
        // rejection reached this page, treat it as success and always release
        // the bootstrap observer/listeners.
        if (finishSessionToolsLoad()) return true;
        sessionToolsLoadPromise = null;
        console.warn("[CodeyX] session tools lazy load failed", error);
        return false;
      });
    return sessionToolsLoadPromise;
  };

  const loadSessionToolsFromInteraction = (event) => {
    const target = event?.target instanceof Element
      ? event.target
      : event?.target?.parentElement;
    if (!target?.closest?.(sidebarSelector)) return;
    void loadSessionTools();
  };

  const armSessionToolsInteraction = () => {
    if (
      typeof document.addEventListener !== "function"
      || sessionToolsInteractionArmed
      || sessionToolsLoadPromise
      || window.__codeySessionToolsInjectLoaded === true
    ) return;
    sessionToolsInteractionArmed = true;
    document.addEventListener("pointerover", loadSessionToolsFromInteraction, {
      capture: true,
      passive: true,
    });
    document.addEventListener("pointerdown", loadSessionToolsFromInteraction, {
      capture: true,
      passive: true,
    });
    document.addEventListener("focusin", loadSessionToolsFromInteraction, true);
  };

  const disarmSessionToolsInteraction = () => {
    if (!sessionToolsInteractionArmed) return;
    sessionToolsInteractionArmed = false;
    document.removeEventListener("pointerover", loadSessionToolsFromInteraction, true);
    document.removeEventListener("pointerdown", loadSessionToolsFromInteraction, true);
    document.removeEventListener("focusin", loadSessionToolsFromInteraction, true);
  };

  const scheduleSessionToolsIdleLoad = () => {
    if (
      sessionToolsIdleLoadScheduled
      || sessionToolsLoadPromise
      || window.__codeySessionToolsInjectLoaded === true
    ) return;
    sessionToolsIdleLoadScheduled = true;
    const run = () => {
      sessionToolsIdleLoadScheduled = false;
      void loadSessionTools();
    };
    if (typeof window.requestIdleCallback === "function") {
      window.requestIdleCallback(run, { timeout: sessionToolsIdleLoadTimeoutMs });
      return;
    }
    window.setTimeout(run, 1_000);
  };

  const scan = (root = document) => {
    mountButton();
    syncAccountUsageMount();
  };

  const scheduleScan = (root = document) => {
    window.clearTimeout(scanTimer);
    scanTimer = window.setTimeout(() => {
      scanTimer = 0;
      scan(root);
    }, 60);
  };

  const invalidateHeaderMount = (root = document) => {
    headerMountDirty = true;
    scheduleScan(root || document);
  };

  if (rendererCoreAlreadyLoaded) return;
  window.addEventListener?.(updateAvailableEvent, (event) => {
    const result = "detail" in event
      ? event.detail
      : window.__codeyUpdateAvailability;
    setUpdateAvailability(result, { dispatch: false });
    if (!hasInstallableUpdate()) scheduleUpdateCheck();
  });
  window.addEventListener?.(configChangedEvent, (event) => {
    const policy = event.detail?.config?.codeyUpdatePolicy;
    if (["off", "stable"].includes(policy) && codeyUpdatePolicy !== policy) {
      setAutomaticUpdateChecks(policy);
      if (policy !== "off") scheduleUpdateCheck(0);
    }
    accountUsageLastResult = null;
    accountUsagePollingEnabled = true;
    scheduleAccountUsageCheck(0);
  });
  // Arm before React mounts the sidebar. The handler itself filters to sidebar
  // targets, so this closes the observer/debounce race without moving the heavy
  // session-tools evaluation into startup.
  armSessionToolsInteraction();
  scheduleSessionToolsIdleLoad();
  scan();
  void hydrateUpdateAvailability();
  void checkRuntimeHealth();
  scheduleAccountUsageCheck(250);

  const headerNodesChanged = (nodes) => {
    for (const node of nodes || []) {
      if (
        node instanceof HTMLElement
        && node.id !== buttonId
        && node.id !== buttonMeasureId
        && node.id !== accountUsageId
      ) {
        return true;
      }
    }
    return false;
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
  const handleBootstrapMutations = (mutations) =>
    codeyTimed("renderer-inject.bootstrapMutations", mutations?.length ?? 0, () => handleBootstrapMutationsImpl(mutations));
  const handleBootstrapMutationsImpl = (mutations) => {
    for (const mutation of mutations) {
      const target = mutation.target instanceof HTMLElement
        ? mutation.target
        : mutation.target?.parentElement;
      const conversationTurn = target?.closest?.("[data-turn-key]");
      if (
        mutation.type === "childList"
        && conversationTurn
        && conversationTurn.isConnected !== false
      ) {
        continue;
      }
      if (
        target?.id === accountUsageId
        || target?.closest?.(`#${accountUsageId}`)
      ) {
        continue;
      }
      const usageTreeChanged = accountUsageLastResult?.status === "ok"
        && [...(mutation.addedNodes || []), ...(mutation.removedNodes || [])].some((node) => {
          const element = node instanceof HTMLElement ? node : null;
          return element?.id === accountUsageId
            || !!element?.querySelector?.(`#${accountUsageId}`);
        });
      if (
        accountUsageLastResult?.status === "ok"
        && (
          usageTreeChanged
          || target?.getAttribute?.("data-codey-usage-host") === "true"
          || target?.closest?.("[data-codey-usage-host]")
        )
      ) {
        scheduleScan(target || document);
        return;
      }
      if (mutation.type === "attributes") {
        if (target?.matches?.(headerSelector) || target?.matches?.(sidebarSelector)) {
          if (target.matches?.(headerSelector)) headerMountDirty = true;
          scheduleScan(target);
          return;
        }
        continue;
      }
      const targetHeader = target?.matches?.(headerSelector)
        ? target
        : target?.closest?.(headerSelector);
      const headerChildrenChanged = targetHeader && (
        headerNodesChanged(mutation.addedNodes)
        || headerNodesChanged(mutation.removedNodes)
      );
      if (headerChildrenChanged) {
        headerMountDirty = true;
        scheduleScan(targetHeader);
        return;
      }
      for (const node of mutation.addedNodes || []) {
        const element = node instanceof HTMLElement ? node : null;
        if (!element) continue;
        // One combined probe rejects the overwhelmingly common streaming case
        // in two subtree walks instead of four.
        const matched = element.matches?.(bootstrapProbeSelector)
          ? element
          : element.querySelector?.(bootstrapProbeSelector);
        if (!matched) continue;
        if (element.matches?.(headerSelector) || element.querySelector?.(headerSelector)) {
          headerMountDirty = true;
        }
        scheduleScan(element);
        return;
      }
    }
  };
  const bootstrapMutationOptions = {
    attributes: true,
    attributeFilter: [
      "data-app-action-sidebar-scroll",
      "data-app-action-sidebar-section",
      "data-app-action-sidebar-thread-id",
      "data-app-action-sidebar-thread-title",
      "data-app-action-sidebar-project-id",
      "data-app-action-sidebar-project-row",
      "hidden",
      "aria-hidden",
    ],
    childList: true,
    subtree: true,
  };
  const mutationDispatcher = window.__codeyMutationDispatcher;
  if (typeof mutationDispatcher?.subscribe === "function") {
    const unsubscribe = mutationDispatcher.subscribe(
      handleBootstrapMutations,
      bootstrapMutationOptions,
    );
    if (mutationDispatcher.snapshot?.().observerInstalled) {
      bootstrapObserver = { disconnect: unsubscribe };
    } else {
      unsubscribe?.();
    }
  }
  if (!bootstrapObserver) {
    bootstrapObserver = new MutationObserver(handleBootstrapMutations);
    bootstrapObserver.observe(document.documentElement, bootstrapMutationOptions);
  }

  window.__codeyLoadSessionTools = loadSessionTools;
  window.__codeyRendererScan = scan;
  window.__codeyRendererInvalidateHeaderMount = invalidateHeaderMount;
  window.__codeyRefreshAccountUsage = checkAccountUsage;
  window.__codeyRefreshRuntimeHealth = checkRuntimeHealth;

  window.addEventListener?.("focus", () => {
    void loadSessionTools();
    scan();
    scheduleRuntimeHealthCheck(0);
    scheduleAccountUsageCheck(0);
  });
  document.addEventListener?.("visibilitychange", () => {
    if (document.visibilityState !== "hidden") void loadSessionTools();
    scheduleRuntimeHealthCheck(0);
    scheduleAccountUsageCheck(0);
  });
  window.addEventListener?.("pageshow", () => {
    void loadSessionTools();
    scan();
    scheduleRuntimeHealthCheck(0);
  });
  // Commit the idempotency marker only after every synchronous bootstrap step
  // succeeded. If an earlier step throws, CDP can inject this module again.
  window.__codeyRendererCoreLoaded = true;
})();

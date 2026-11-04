// ============================================================
// Codey 用户脚本:额度用尽仍可发送(Quota Unlock)
// ------------------------------------------------------------
// Codey 在本地路由启用时经 CDP 以 document-start 注入 Codex
// 桌面端渲染进程主世界,先于页面全部业务脚本执行。
//
// 原理:官方额度用尽后,Codex 前端把 UI(发送按钮、编辑旧消息、
// composer 输入区)整体锁死——判定数据来自 /wham/usage 轮询响应
// 与 SSE / WebSocket 的 usage.snapshot 推送
// (React Query ['rate-limit-status'] 缓存)。在 JSON.parse 层清除
// 发送阻塞标记,让第三方线路继续发请求。保留真实用量、重置时间
// 和余额,供官方套餐页面展示;服务端仍按实际额度校验官方请求。
//
// 关闭:在 Codex 页面 DevTools 执行
//   localStorage.setItem("codeyQuotaUnlock","off") 后刷新;
//   或 window.__codeyQuotaUnlock.disable()
// 状态:window.__codeyQuotaUnlock.status()
// ============================================================
(() => {
  "use strict";
  if (window.__codeyQuotaUnlock) return;

  let enabled = true;
  try {
    enabled = localStorage.getItem("codeyQuotaUnlock") !== "off";
  } catch {}

  const STATE = {
    version: "1.0.2",
    enabled,
    installedAt: new Date().toISOString(),
    parsePatched: false,
    wsPatched: false,
    sanitized: 0,
    lastSanitizedAt: null,
  };
  if (!enabled) {
    window.__codeyQuotaUnlock = {
      version: STATE.version,
      status() { return { ...STATE, note: "已停用(off),刷新/重启后不拦截" }; },
      enable() { try { localStorage.removeItem("codeyQuotaUnlock"); } catch {} return "已移除 off 标记,刷新或重启生效"; },
      disable() { try { localStorage.setItem("codeyQuotaUnlock", "off"); } catch {} return "已写入 off 标记,刷新或重启生效"; },
    };
    return;
  }

  const nativeParse = JSON.parse;

  // 只改发送阻塞状态。额度窗口和 credits 同时供计费页面使用,必须原样保留。
  function sanitize(node, depth) {
    if (!node || typeof node !== "object" || depth > 12) return;
    if (Array.isArray(node)) {
      for (const x of node) sanitize(x, depth + 1);
      return;
    }
    // 1) 限流布尔判定
    const rl = node.rate_limit;
    if (rl && typeof rl === "object") {
      if ("allowed" in rl) rl.allowed = true;
      if ("limit_reached" in rl) rl.limit_reached = false;
    }
    if ("rate_limit_reached_type" in node) node.rate_limit_reached_type = null;
    if ("rateLimitReachedType" in node) node.rateLimitReachedType = null;
    if (("primary_window" in node || "secondary_window" in node) && ("allowed" in node || "limit_reached" in node)) {
      node.allowed = true;
      node.limit_reached = false;
    }
    // 2) 花费阻塞状态
    const sc = node.spend_control;
    if (sc && typeof sc === "object" && "reached" in sc) sc.reached = false;
    // 3) 横幅 / 侧边栏警告数据源
    if ("rate_limit_upsell" in node) node.rate_limit_upsell = null;
    if ("rate_limit_warning" in node) node.rate_limit_warning = null;
    if ("sidebar_usage_warnings" in node) node.sidebar_usage_warnings = [];
    // 4) /conversation/init 的发送闸门
    if (Array.isArray(node.blocked_features)) {
      node.blocked_features = node.blocked_features.filter(
        (f) => !(f && typeof f === "object" && (f.name === "send" || f.name === "tpp_send"))
      );
    }
    if (Array.isArray(node.limits_progress)) {
      node.limits_progress = node.limits_progress.filter(
        (f) => !(f && typeof f === "object" && typeof f.remaining === "number" && f.remaining <= 0)
      );
    }
    // 5) 继续走子节点(覆盖 additional_rate_limits / code_review_rate_limit 等)
    for (const k in node) {
      const v = node[k];
      if (v && typeof v === "object") sanitize(v, depth + 1);
    }
  }

  // 浅层标记:只有命中 OpenAI 限流语义键才处理发送状态,避免误伤普通解析
  const MARKERS = [
    "rate_limit",
    "rateLimits",
    "rateLimitsByLimitId",
    "rate_limit_upsell",
    "rate_limit_warning",
    "sidebar_usage_warnings",
    "blocked_features",
    "limits_progress",
    "spend_control",
    "code_review_rate_limit",
  ];
  function looksRelevant(root) {
    if (!root || typeof root !== "object" || Array.isArray(root)) return false;
    for (const m of MARKERS) if (m in root) return true;
    return false;
  }

  function sanitizeUsage(root) {
    if (root?.type === "usage.snapshot" && root.payload != null) {
      if (root.payload.version !== 1) return false;
      root = root.payload.usage_by_client?.electron;
    }
    if (!looksRelevant(root) && !looksRelevant(root?.usage)) return false;
    sanitize(root, 0);
    return true;
  }

  function sanitizeParsed(root) {
    if (!Array.isArray(root)) return sanitizeUsage(root);
    let touched = false;
    // 新版 pubsub 批量传输消息，重连补发则放在订阅回复的 catchups 中。
    for (const frame of root) {
      const reply = frame?.reply;
      const messages = reply?.type === "subscribe" && reply.topic_id === "codex-work-usage-push-v1"
        ? reply.catchups : [frame];
      if (!Array.isArray(messages)) continue;
      for (const message of messages) {
        if (message?.type === "message" && message.topic_id === "codex-work-usage-push-v1"
          && message.payload?.type === "usage.snapshot" && sanitizeUsage(message.payload)) {
          touched = true;
        }
      }
    }
    return touched;
  }

  function markSanitized() {
    STATE.sanitized += 1;
    STATE.lastSanitizedAt = new Date().toISOString();
  }

  // 主拦截:REST / WS / SSE 中的额度 JSON。
  try {
    JSON.parse = function (text, reviver) {
      const v = nativeParse.call(JSON, text, reviver);
      try {
        if (sanitizeParsed(v)) {
          markSanitized();
        }
      } catch {}
      return v;
    };
    STATE.parsePatched = true;
  } catch {}

  // 兜底:WebSocket JSON-RPC 与额度推送帧。
  try {
    const NativeWS = window.WebSocket;
    function PatchedWebSocket(url, protocols) {
      const ws = protocols === undefined ? new NativeWS(url) : new NativeWS(url, protocols);
      const pending = new Map();
      const origSend = ws.send.bind(ws);
      ws.send = function (data) {
        try {
          if (typeof data === "string" && data.includes('"method"')) {
            const m = nativeParse(data);
            if (m && typeof m === "object" && m.method && m.id != null) pending.set(m.id, m.method);
          }
        } catch {}
        return origSend(data);
      };
      ws.addEventListener("message", (ev) => {
        try {
          if (typeof ev.data !== "string" || (!ev.data.includes("rateLimit") && !ev.data.includes('"usage.snapshot"'))) return;
          const m = nativeParse(ev.data);
          if (!m || typeof m !== "object") return;
          let touched = sanitizeParsed(m);
          if (m.id != null && (m.result !== undefined || m.error !== undefined)) {
            const method = pending.get(m.id);
            pending.delete(m.id);
            if (method === "account/rateLimits/read" && m.result) {
              sanitize(m.result, 0);
              touched = true;
            }
          }
          if (m.method === "account/rateLimits/updated" && m.params) {
            sanitize(m.params, 0);
            touched = true;
          }
          if (touched) {
            Object.defineProperty(ev, "data", { value: JSON.stringify(m) });
            markSanitized();
          }
        } catch {}
      });
      return ws;
    }
    PatchedWebSocket.prototype = NativeWS.prototype;
    for (const k of ["CONNECTING", "OPEN", "CLOSING", "CLOSED"]) PatchedWebSocket[k] = NativeWS[k];
    window.WebSocket = PatchedWebSocket;
    STATE.wsPatched = true;
  } catch {}

  window.__codeyQuotaUnlock = {
    version: STATE.version,
    status() { return { ...STATE }; },
    enable() {
      try { localStorage.removeItem("codeyQuotaUnlock"); } catch {}
      return "已移除 off 标记,刷新或重启 Codex 生效";
    },
    disable() {
      try { localStorage.setItem("codeyQuotaUnlock", "off"); } catch {}
      return "已写入 off 标记,刷新或重启 Codex 生效";
    },
  };
})();

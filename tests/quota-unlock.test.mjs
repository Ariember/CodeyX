import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../public/quota-unlock.js", import.meta.url), "utf8");

function createRuntime(initialValue = null) {
  const values = new Map(initialValue === null ? [] : [["codeyQuotaUnlock", initialValue]]);
  const localStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  };
  class MockWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;

    constructor(url, protocols) {
      this.url = url;
      this.protocols = protocols;
      this.sent = [];
      this.listeners = [];
    }

    send(data) { this.sent.push(data); }
    addEventListener(type, listener) {
      if (type === "message") this.listeners.push(listener);
    }
    receive(data) {
      const event = { data };
      this.listeners.forEach((listener) => listener(event));
      return event.data;
    }
  }
  const window = { localStorage, WebSocket: MockWebSocket };
  window.window = window;
  const context = { window, localStorage, console };
  vm.runInNewContext(source, context);
  return { context, window, localStorage };
}

function parsePayload(context, payload) {
  const value = vm.runInNewContext(`JSON.parse(${JSON.stringify(JSON.stringify(payload))})`, context);
  return JSON.parse(JSON.stringify(value));
}

function usagePush() {
  const usage = {
    user_id: "fixture-user",
    account_id: "fixture-account",
    plan_type: "plus",
    rate_limit: {
      allowed: false,
      limit_reached: true,
      primary_window: { used_percent: 100, reset_at: 1800000000, limit_window_seconds: 18000 },
      secondary_window: { used_percent: 100, reset_at: 1800100000, limit_window_seconds: 604800 },
    },
    credits: { has_credits: false, unlimited: false, balance: "0" },
    spend_control: { reached: true, individual_limit: { used_percent: 100 } },
    rate_limit_reached_type: { type: "rate_limit_reached" },
    additional_rate_limits: [{ limit_name: "fixture-model", rate_limit: { allowed: false, limit_reached: true } }],
  };
  return {
    type: "usage.snapshot",
    payload: {
      version: 1,
      stream_id: "fixture-stream",
      sequence: 1,
      generated_at_ms: 1800000000000,
      usage_by_client: { electron: usage, browser: structuredClone(usage) },
    },
  };
}

test("quota unlock clears send blockers without changing official usage or credits", () => {
  const { context, window } = createRuntime();
  const payload = {
    rate_limit: { allowed: false, limit_reached: true },
    primary_window: { used_percent: 100, reset_at: 1 },
    spend_control: { reached: true },
    credits: { has_credits: false, unlimited: false, balance: 0 },
    blocked_features: [{ name: "send" }, { name: "tpp_send" }, { name: "other" }],
    rate_limit_reached_type: "weekly",
  };
  const value = parsePayload(context, payload);

  assert.equal(value.rate_limit.allowed, true);
  assert.equal(value.rate_limit.limit_reached, false);
  assert.deepEqual(value.primary_window, payload.primary_window);
  assert.equal(value.spend_control.reached, false);
  assert.deepEqual(value.credits, payload.credits);
  assert.deepEqual(value.blocked_features, [{ name: "other" }]);
  assert.equal(value.rate_limit_reached_type, null);
  assert.equal(window.__codeyQuotaUnlock.status().sanitized, 1);
});

test("quota unlock preserves changing REST and SSE usage snapshots, including exhausted windows", () => {
  for (const wrap of [(usage) => usage, (usage) => ({ type: "usage.snapshot", usage })]) {
    const { context } = createRuntime();
    for (const usedPercent of [0, 2.5, 3, 38.75, 97, 100, 125]) {
      const usage = {
        plan_type: "pro",
        rate_limit: {
          allowed: usedPercent < 100,
          limit_reached: usedPercent >= 100,
          primary_window: { used_percent: usedPercent, reset_at: 1, limit_window_seconds: 18000 },
          secondary_window: { used_percent: usedPercent, reset_at: 1800000000, limit_window_seconds: 604800 },
        },
        additional_rate_limits: [{ rate_limit: {
          primary_window: { used_percent: usedPercent, reset_at: null },
          secondary_window: null,
        } }],
        code_review_rate_limit: { primary_window: { used_percent: usedPercent, reset_at: "unknown" } },
        credits: { has_credits: false, unlimited: false, balance: "0" },
      };
      const payload = wrap(usage);
      const value = parsePayload(context, payload);
      const expected = structuredClone(payload);
      const expectedUsage = expected.usage ?? expected;
      expectedUsage.rate_limit.allowed = true;
      expectedUsage.rate_limit.limit_reached = false;
      assert.deepEqual(value, expected);
    }
  }
});

test("quota unlock preserves app-server rate limits and billing across all limit buckets", () => {
  const { context } = createRuntime();
  const snapshot = {
    primary: { usedPercent: 45.5, resetAt: 1, windowDurationMins: 300 },
    secondary: { usedPercent: 100, resetsAt: 1800000000, windowDurationMins: 10080 },
    credits: { hasCredits: false, unlimited: false, balance: "12.50" },
    planType: "pro",
  };
  const payload = {
    rateLimits: snapshot,
    rateLimitsByLimitId: { codex: snapshot, reviews: { ...snapshot, primary: null } },
  };
  assert.deepEqual(parsePayload(context, payload), payload);
});

test("quota unlock clears desktop push blockers while preserving usage, billing and other clients", () => {
  const { context, window } = createRuntime();
  const payload = usagePush();
  const expected = structuredClone(payload);
  const usage = expected.payload.usage_by_client.electron;
  usage.rate_limit.allowed = true;
  usage.rate_limit.limit_reached = false;
  usage.rate_limit_reached_type = null;
  usage.spend_control.reached = false;
  usage.additional_rate_limits[0].rate_limit.allowed = true;
  usage.additional_rate_limits[0].rate_limit.limit_reached = false;

  assert.deepEqual(parsePayload(context, payload), expected);
  assert.equal(window.__codeyQuotaUnlock.status().sanitized, 1);
});

test("quota unlock handles batched pubsub pushes and subscription catchups without touching other topics", () => {
  for (const catchup of [false, true]) {
    for (const transport of ["parse", "websocket"]) {
      const { context, window } = createRuntime();
      const snapshot = usagePush();
      const message = { type: "message", topic_id: "codex-work-usage-push-v1", offset: "fixture-offset", payload: snapshot };
      const unrelated = { ...structuredClone(message), topic_id: "conversations" };
      const payload = catchup
        ? [{ id: 1, reply: { type: "subscribe", topic_id: message.topic_id, recovered: true, catchups: [unrelated, message] } }]
        : [unrelated, message, { id: 2, reply: { type: "presence" } }];
      const expected = structuredClone(payload);
      const expectedMessage = catchup ? expected[0].reply.catchups[1] : expected[1];
      expectedMessage.payload = parsePayload(context, snapshot);
      const before = window.__codeyQuotaUnlock.status().sanitized;
      const value = transport === "parse"
        ? parsePayload(context, payload)
        : JSON.parse(new window.WebSocket("ws://127.0.0.1/test").receive(JSON.stringify(payload)));

      assert.deepEqual(value, expected, `${transport}, catchup=${catchup}`);
      assert.equal(window.__codeyQuotaUnlock.status().sanitized, before + 1);
    }
  }
});

test("quota unlock ignores unsupported or malformed push envelopes", () => {
  const { context, window } = createRuntime();
  const snapshot = usagePush();
  const message = { type: "message", topic_id: "codex-work-usage-push-v1", payload: snapshot };
  const frames = [
    { ...snapshot, type: "conversation-update" },
    { ...snapshot, payload: { ...snapshot.payload, version: 2 } },
    { ...snapshot, payload: null },
    { ...snapshot, payload: { version: 1, usage_by_client: { browser: snapshot.payload.usage_by_client.browser } } },
    { ...snapshot, payload: { version: 1, usage_by_client: { electron: [] } } },
    [null, "not a message", { reply: null }],
    [{ ...message, topic_id: "conversations" }],
    [{ ...message, type: "other" }],
    [{ id: 1, reply: { type: "subscribe", topic_id: message.topic_id, catchups: {} } }],
    [{ id: 1, reply: { type: "subscribe", topic_id: "conversations", catchups: [message] } }],
  ];
  const socket = new window.WebSocket("ws://127.0.0.1/test");
  for (const payload of frames) {
    assert.deepEqual(parsePayload(context, payload), payload);
    assert.equal(socket.receive(JSON.stringify(payload)), JSON.stringify(payload));
  }
  assert.equal(window.__codeyQuotaUnlock.status().sanitized, 0);
});

test("quota unlock preserves WebSocket read and update measurements while clearing send blockers", () => {
  const { window } = createRuntime();
  const socket = new window.WebSocket("ws://127.0.0.1/test", ["jsonrpc"]);
  const payload = {
    rateLimits: {
      primary: { usedPercent: 68, resetAt: 1 },
      secondary: { usedPercent: 100, resetsAt: 1800000000 },
      credits: { has_credits: false, unlimited: false, balance: 0 },
      rateLimitReachedType: "weekly",
    },
    rateLimitsByLimitId: { codex: { secondary: { usedPercent: 100, resetsAt: 1800000000 } } },
  };
  const expected = structuredClone(payload);
  expected.rateLimits.rateLimitReachedType = null;
  const request = JSON.stringify({ id: 0, method: "account/rateLimits/read" });
  socket.send(request);
  const read = { id: 0, result: payload };
  const update = { method: "account/rateLimits/updated", params: payload };
  assert.deepEqual(JSON.parse(socket.receive(JSON.stringify(read))), { id: 0, result: expected });
  assert.deepEqual(JSON.parse(socket.receive(JSON.stringify(update))), {
    method: "account/rateLimits/updated", params: expected,
  });
  assert.deepEqual(socket.sent, [request]);
  assert.deepEqual(socket.protocols, ["jsonrpc"]);
  assert.equal(window.WebSocket.OPEN, 1);
  assert.equal(window.__codeyQuotaUnlock.status().sanitized, 2);
});

test("quota unlock leaves unrelated payloads and malformed WebSocket frames intact", () => {
  const { context, window } = createRuntime();
  const payload = { primary: { usedPercent: 95 }, credits: { balance: 0 }, allowed: false };
  assert.deepEqual(parsePayload(context, payload), payload);
  const socket = new window.WebSocket("ws://127.0.0.1/test");
  for (const frame of ["not JSON rateLimits", JSON.stringify({ id: 1, error: { message: "rateLimits unavailable" } })]) {
    assert.equal(socket.receive(frame), frame);
  }
  assert.throws(() => vm.runInNewContext('JSON.parse("invalid")', context), { name: "SyntaxError" });
  assert.equal(window.__codeyQuotaUnlock.status().sanitized, 0);
});

test("quota unlock can be disabled before the document is loaded", () => {
  const { context, window } = createRuntime("off");
  const payload = {
    rate_limit: { allowed: false, limit_reached: true },
    primary_window: { used_percent: 100, reset_at: 1 },
    credits: { has_credits: false, unlimited: false, balance: 0 },
  };
  const value = parsePayload(context, payload);

  assert.deepEqual(value, payload);
  assert.deepEqual(parsePayload(context, usagePush()), usagePush());
  assert.equal(window.__codeyQuotaUnlock.status().enabled, false);
});

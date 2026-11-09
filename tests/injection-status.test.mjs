import assert from "node:assert/strict";
import test from "node:test";

import { flushMicrotasks } from "./helpers/flush.mjs";

import { loadTypeScriptModule } from "./helpers/load-typescript-module.mjs";
import { createModuleGraph } from "./helpers/jsx-tree.mjs";
import { featurePolicyRuntimeFixture } from "./helpers/feature-policy.mjs";

const root = new URL("../", import.meta.url);
const { createStatusPollScheduler } = createModuleGraph(new URL("src/features/runtime-status/useStatusPollingController.ts", root)).exports;
const { createStatusPollTask, STATUS_POLL_MAX_CONSECUTIVE_ERRORS } = await loadTypeScriptModule(new URL("src/features/runtime-status/state.ts", root));

function createFakeClock() {
  let currentTime = 0;
  let nextTimerId = 1;
  const timers = new Map();
  const clock = {
    now: () => currentTime,
    setTimeout(callback, delay) {
      const id = nextTimerId;
      nextTimerId += 1;
      timers.set(id, {
        at: currentTime + Math.max(0, delay),
        callback,
      });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
  };

  return {
    clock,
    async runNext() {
      const next = [...timers.entries()].sort(
        ([leftId, left], [rightId, right]) =>
          left.at - right.at || leftId - rightId,
      )[0];
      if (!next) return false;
      const [id, timer] = next;
      timers.delete(id);
      currentTime = timer.at;
      timer.callback();
      await flushMicrotasks();
      return true;
    },
  };
}

test("runtime feature presentation exposes only confirmed user-facing behavior", async () => {
  const { buildEnabledOptimizationFeatures } = createModuleGraph(
    new URL("src/runtimeStatusPresentation.ts", root),
  ).exports;
  const features = buildEnabledOptimizationFeatures(
    {
      running: true,
      injectionScripts: [
        {
          id: "internal-ready",
          name: "内部控制",
          source: "builtin",
          visibility: "internal",
          status: "effective",
        },
        {
          id: "builtin-ready",
          name: "内置功能",
          source: "builtin",
          visibility: "feature",
          status: "effective",
          detail: "已确认",
        },
        {
          id: "user-ready",
          name: "用户功能",
          source: "user",
          visibility: "feature",
          status: "effective",
        },
        {
          id: "not-confirmed",
          name: "等待确认",
          source: "builtin",
          visibility: "feature",
          status: "executed",
        },
      ],
      subagentOptimizationActive: true,
      notificationChannelsActive: true,
      activeNotificationChannelCount: 2,
      traceLogWriteProtectionActive: true,
      crashpadDiskProtectionActive: true,
      featurePolicy: featurePolicyRuntimeFixture().featurePolicy,
    },
    {
      userConfigured: true,
      detectionFailed: false,
      serverId: "fastctx-local",
    },
  );

  assert.deepEqual(
    features.map(({ id, icon, sourceLabel }) => ({ id, icon, sourceLabel })),
    [
      {
        id: "fastctx-context-tools",
        icon: "fastctx",
        sourceLabel: "外部配置",
      },
      { id: "builtin-ready", icon: "code", sourceLabel: "内置" },
      { id: "user-ready", icon: "code", sourceLabel: "用户脚本" },
      {
        id: "subagent-optimization",
        icon: "subagent",
        sourceLabel: "CodeyX",
      },
      {
        id: "notification-channels",
        icon: "notifications",
        sourceLabel: "CodeyX",
      },
      {
        id: "disk-write-protection",
        icon: "database",
        sourceLabel: "CodeyX",
      },
    ],
  );
  assert.equal(features[0].detail, "Codex 已配置 FastCtx（fastctx-local）");
  assert.equal(features.at(-1).detail, "Codex Trace 日志与 Crashpad 磁盘保护均已生效");
  assert.equal(features.some((feature) => feature.id === "internal-ready"), false);
  assert.equal(features.some((feature) => feature.id === "not-confirmed"), false);
});

test("injection status summary separates internal failures from feature verification", async () => {
  const { summarizeInjectionScripts } = createModuleGraph(
    new URL("src/runtimeStatusPresentation.ts", root),
  ).exports;
  const summary = summarizeInjectionScripts([
    {
      id: "internal-pending",
      name: "内部等待",
      source: "builtin",
      visibility: "internal",
      status: "executed",
    },
    {
      id: "internal-failed",
      name: "内部失败",
      source: "builtin",
      visibility: "internal",
      status: "unknown",
    },
    {
      id: "feature-pending",
      name: "功能等待",
      source: "builtin",
      visibility: "feature",
      status: "executed",
    },
    {
      id: "feature-failed",
      name: "功能失败",
      source: "builtin",
      visibility: "feature",
      status: "failed",
    },
    {
      id: "feature-unknown",
      name: "功能未知",
      source: "user",
      visibility: "feature",
      status: "unknown",
    },
    {
      id: "feature-ready",
      name: "功能可用",
      source: "builtin",
      visibility: "feature",
      status: "effective",
    },
  ]);

  assert.deepEqual(summary, {
    attentionInjectionScripts: [
      { id: "internal-pending", name: "内部等待", source: "builtin", visibility: "internal", status: "executed" },
      { id: "internal-failed", name: "内部失败", source: "builtin", visibility: "internal", status: "unknown" },
      { id: "feature-pending", name: "功能等待", source: "builtin", visibility: "feature", status: "executed" },
      { id: "feature-failed", name: "功能失败", source: "builtin", visibility: "feature", status: "failed" },
      { id: "feature-unknown", name: "功能未知", source: "user", visibility: "feature", status: "unknown" },
    ],
    failedInjectionScriptCount: 2,
    internalInjectionError: true,
    internalInjectionPending: true,
    unverifiedInjectionScriptCount: 1,
  });
});

test("status poll scheduler coalesces due work and stops after bounded failures", async () => {
  {
    const fake = createFakeClock();
    const requests = [];
    const scheduler = createStatusPollScheduler(async (refreshesInjectionStatus) => {
      requests.push(refreshesInjectionStatus);
      return { running: true };
    }, fake.clock);
    scheduler.add(createStatusPollTask({
      kind: "injection",
      delays: [10],
      pending: () => false,
      refreshesInjectionStatus: true,
    }, 1_000, fake.clock.now()));
    scheduler.add(createStatusPollTask({
      kind: "restart",
      delays: [10],
      pending: () => false,
      refreshesInjectionStatus: false,
    }, 1_000, fake.clock.now()));

    assert.equal(await fake.runNext(), true);
    assert.deepEqual(requests, [true]);
    assert.equal(await fake.runNext(), false);
  }

  {
    const fake = createFakeClock();
    let requests = 0;
    const scheduler = createStatusPollScheduler(async () => {
      requests += 1;
      throw new Error("runtime unavailable");
    }, fake.clock);
    scheduler.add(createStatusPollTask({
      kind: "injection",
      delays: [1],
      pending: () => true,
      refreshesInjectionStatus: true,
    }, 10_000, fake.clock.now()));

    for (let index = 0; index < 10 && await fake.runNext(); index += 1) {
      // Drain scheduled retries.
    }
    assert.equal(requests, STATUS_POLL_MAX_CONSECUTIVE_ERRORS);
    assert.equal(await fake.runNext(), false);
  }
});

test("status poll scheduler never overlaps requests and clear cancels queued work", async () => {
  const fake = createFakeClock();
  let requests = 0;
  let releaseRequest;
  const scheduler = createStatusPollScheduler(
    () => {
      requests += 1;
      return new Promise((resolve) => {
        releaseRequest = resolve;
      });
    },
    fake.clock,
  );
  scheduler.add(createStatusPollTask({
    kind: "restart",
    delays: [1],
    pending: () => true,
    refreshesInjectionStatus: false,
  }, 10_000, fake.clock.now()));

  assert.equal(await fake.runNext(), true);
  assert.equal(requests, 1);
  assert.equal(await fake.runNext(), false);

  scheduler.clear();
  releaseRequest({ running: true });
  await flushMicrotasks();
  assert.equal(await fake.runNext(), false);
  assert.equal(requests, 1);
});

test("active policy snapshots refresh at low frequency and stop on hide, stop, or repeated errors", async (t) => {
  for (const outcome of ["healthy", "hidden", "stopped", "legacy", "runtime-stopped", "errors"]) {
    const fake = createFakeClock();
    t.mock.method(Date, "now", fake.clock.now);
    const previousWindow = globalThis.window;
    globalThis.window = fake.clock;
    const cleanups = [];
    const requests = [];
    const errors = [];
    const ref = { current: null };
    const { useStatusPollingController } = createModuleGraph(
      new URL("src/features/runtime-status/useStatusPollingController.ts", root),
      { stubs: { react: {
        useRef: () => ref,
        useEffect: effect => {
          const cleanup = effect();
          if (cleanup) cleanups.push(cleanup);
        },
      } } },
    ).exports;
    const status = featurePolicyRuntimeFixture();
    if (outcome === "legacy") delete status.featurePolicy;
    if (outcome === "stopped") status.running = false;
    try {
      useStatusPollingController({
        active: outcome !== "hidden", revision: 0, status, restartStatusError: null,
        setRestartStatusError: error => errors.push(error),
        requestRuntimeStatus: async refresh => {
          requests.push({ refresh, at: fake.clock.now() });
          if (outcome === "errors") throw new Error("disconnected");
          return { ...status, running: outcome !== "runtime-stopped" };
        },
      });
      const expected = outcome === "healthy" ? 12 : outcome === "errors" ? STATUS_POLL_MAX_CONSECUTIVE_ERRORS : outcome === "runtime-stopped" ? 1 : 0;
      for (let index = 0; index < expected; index++) assert.equal(await fake.runNext(), true, outcome);
      assert.deepEqual(requests, Array.from({ length: expected }, (_, index) => ({ refresh: false, at: (index + 1) * 30_000 })), outcome);
      assert.equal(errors.length, outcome === "errors" ? 1 : 0, outcome);
      if (outcome !== "healthy") assert.equal(await fake.runNext(), false, outcome);
    } finally {
      for (const cleanup of cleanups.reverse()) cleanup();
      assert.equal(await fake.runNext(), false, "unmount must cancel the next policy refresh");
      if (previousWindow === undefined) delete globalThis.window;
      else globalThis.window = previousWindow;
      t.mock.restoreAll();
    }
  }
});

test("restart polling reports exhaustion and can resume after a manual status query", async () => {
  for (const outcome of ["errors", "deadline", "completed"]) {
    const fake = createFakeClock();
    let exhausted = 0;
    let completed = outcome === "completed";
    const scheduler = createStatusPollScheduler(async () => {
      if (outcome === "errors" && !completed) throw new Error("disconnected");
      return { running: true, restartInProgress: !completed };
    }, fake.clock);
    const addRestart = () => scheduler.add(createStatusPollTask({
      kind: "restart",
      delays: [500],
      pending: (next) => next.restartInProgress,
      refreshesInjectionStatus: false,
      onExhausted: () => { exhausted += 1; },
    }, outcome === "errors" ? 300_000 : 1_000, fake.clock.now()));
    addRestart();
    for (let index = 0; index < 10 && await fake.runNext(); index += 1) {}
    assert.equal(exhausted, outcome === "completed" ? 0 : 1, outcome);
    assert.equal(await fake.runNext(), false);

    completed = true;
    addRestart();
    assert.equal(await fake.runNext(), true);
    assert.equal(await fake.runNext(), false);
    assert.equal(exhausted, outcome === "completed" ? 0 : 1);
  }
});

for (const outcome of ["success", "error"]) {
  test(`cleared poll ${outcome} cannot release the lock of a newer polling request`, async () => {
    const fake = createFakeClock();
    const requests = [];
    const scheduler = createStatusPollScheduler(() => new Promise((resolve, reject) => requests.push({ resolve, reject })), fake.clock);
    const addTask = (kind) => scheduler.add(createStatusPollTask({
      kind, delays: [1], pending: () => false, refreshesInjectionStatus: kind === "injection",
    }, 1000, fake.clock.now()));
    addTask("restart");
    await fake.runNext();
    scheduler.clear();
    addTask("restart");
    await fake.runNext();
    assert.equal(requests.length, 2);
    if (outcome === "success") requests[0].resolve({ running: false });
    else requests[0].reject(new Error("stale"));
    await flushMicrotasks();
    addTask("injection");
    assert.equal(await fake.runNext(), false, "new poll still owns the request lock");
    requests[1].resolve({ running: true });
    await flushMicrotasks();
    assert.equal(await fake.runNext(), true);
    assert.equal(requests.length, 3);
    requests[2].resolve({ running: true });
    await flushMicrotasks();
    assert.equal(await fake.runNext(), false);
  });
}

test("a timed-out status request cannot commit a late response", async () => {
  const { withTimeout } = await loadTypeScriptModule(new URL("src/appUtils.ts", root));
  const fake = createFakeClock();
  const previousWindow = globalThis.window;
  globalThis.window = fake.clock;
  try {
    let resolveRequest;
    let committed = false;
    const request = withTimeout(new Promise((resolve) => {
      resolveRequest = resolve;
    }), 10_000, "status timeout").then(() => { committed = true; });
    const rejection = assert.rejects(request, /status timeout/);
    await fake.runNext();
    await rejection;
    resolveRequest({ restartInProgress: true });
    await flushMicrotasks();
    assert.equal(committed, false);
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../public/codex-runtime-adapter.js", import.meta.url), "utf8");
const names = ["inspect_local_file", "grep", "glob", "replace", "delete", "move", "create_file"];
const definitions = names.map((name) => ({ name, description: name, inputSchema: { type: "object" } }));
const plain = (value) => JSON.parse(JSON.stringify(value));
const settle = () => new Promise((resolve) => setImmediate(resolve));

function fixture(invoke = async () => ({ available: true, tools: definitions })) {
  const timers = new Map();
  let sequence = 0;
  const window = {
    __codeyInvokeApi: invoke,
    setTimeout(callback) { const id = ++sequence; timers.set(id, callback); return id; },
    clearTimeout(id) { timers.delete(id); },
  };
  const context = vm.createContext({ window, document: {}, AbortController });
  vm.runInContext(source, context);
  return { window, timers, api: window.__codeyFastCtxNative };
}

function execution(overrides = {}) {
  let turnCompleted;
  let disposals = 0;
  const controller = new AbortController();
  return {
    hostId: "local",
    request: {
      namespace: "codey_fastctx", tool: "grep", arguments: { pattern: "needle" },
      threadId: "thread-1", turnId: "turn-1", callId: "call-1",
    },
    cwd: "E:/项目",
    signal: controller.signal,
    getCurrentPermissions: () => ({ sandboxPolicy: { type: "dangerFullAccess" } }),
    getThreadExecutionState: () => ({ activeTurnId: "turn-1" }),
    subscribeTurnCompleted(listener) {
      turnCompleted = listener;
      return () => { disposals += 1; };
    },
    complete: () => turnCompleted({ conversationId: "thread-1", turnId: "turn-1" }),
    abort: () => controller.abort(),
    disposals: () => disposals,
    ...overrides,
  };
}

test("native tools are published only after execution is patched and the backend is available", async () => {
  const calls = [];
  const { window, api } = fixture(async (...args) => { calls.push(args); return { available: true, tools: definitions }; });
  const original = [{ namespace: "codex_app", name: "get_usage_limits" }];
  assert.equal(await api.appendTools(original, { hostId: "remote" }), original);
  assert.equal(await api.appendTools(original, { hostId: "local" }), original);
  assert.equal(calls.length, 0);
  const tools = await api.appendTools(original, { hostId: "local" }, () => { window.__codeyFastCtxNativeExecutionInstalled = true; });
  assert.deepEqual(plain(tools[0]), original[0]);
  assert.equal(tools[1].type, "namespace");
  assert.equal(tools[1].name, "codey_fastctx");
  assert.deepEqual(plain(tools[1].tools).map(({ type, name }) => ({ type, name })), names.map((name) => ({ type: "function", name })));
  assert.deepEqual(plain(calls), [["get_fastctx_native_tools", {}]]);
  assert.equal((await api.appendTools(tools, { hostId: "local" })).length, 2);
  assert.equal(tools[1].tools.at(-1).deferLoading, false);
});

test("missing, disabled, failed, and timed out metadata keep the original tool list", async () => {
  for (const response of [{ available: false }, { available: true, tools: definitions.slice(1) }, { available: true, tools: [...definitions, definitions[0]] }]) {
    const { window, api } = fixture(async () => response);
    window.__codeyFastCtxNativeExecutionInstalled = true;
    const original = [];
    assert.equal(await api.appendTools(original, { hostId: "local" }), original);
  }
  const { window, api, timers } = fixture(async () => new Promise(() => {}));
  window.__codeyFastCtxNativeExecutionInstalled = true;
  const original = [];
  const pending = api.appendTools(original, { hostId: "local" });
  await settle();
  for (const callback of timers.values()) callback();
  assert.equal(await pending, original);
  assert.equal(await api.appendTools(original, { hostId: "local" }, () => { throw new Error("unsupported module"); }), original);
});

test("native results preserve continuation text and map image content", async () => {
  const calls = [];
  const { api } = fixture(async (method, args) => {
    calls.push({ method, args });
    return { content: [{ type: "text", text: "needle\n(Partial: continue offset=2)" }, { type: "image", data: "AQID", mimeType: "image/png", _meta: { detail: "original" } }], isError: false };
  });
  const context = execution();
  context.request.arguments.cwd = "C:/untrusted";
  context.request.arguments.permissions = { sandboxPolicy: { type: "readOnly" } };
  const result = await api.execute(context);
  assert.deepEqual(plain(result), { success: true, contentItems: [
    { type: "inputText", text: "needle\n(Partial: continue offset=2)" },
    { type: "inputImage", imageUrl: "data:image/png;base64,AQID" },
  ] });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "call_fastctx_native_tool");
  assert.equal(calls[0].args.cwd, "E:/项目");
  assert.deepEqual(plain(calls[0].args.permissions), { sandboxPolicy: { type: "dangerFullAccess" } });
  assert.equal(calls[0].args.arguments.cwd, "C:/untrusted");
  assert.equal(context.disposals(), 1);
});

test("filesystem mutations reach the native backend with their arguments intact", async () => {
  for (const [tool, arguments_] of [
    ["create_file", { path: "E:/项目/new.txt", content: "中文\r\n" }],
    ["move", { source: "E:/项目/new.txt", destination: "E:/项目/moved.txt" }],
    ["delete", { paths: ["E:/项目/moved.txt"], dry_run: false }],
  ]) {
    const calls = [];
    const { api } = fixture(async (method, args) => { calls.push({ method, args }); return { content: [], isError: false }; });
    const context = execution();
    context.request.tool = tool;
    context.request.arguments = arguments_;
    assert.equal((await api.execute(context)).success, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, "call_fastctx_native_tool");
    assert.equal(calls[0].args.tool, tool);
    assert.deepEqual(plain(calls[0].args.arguments), arguments_);
  }
});

test("invalid host and restricted or unknown permission profiles do not invoke the backend", async () => {
  let calls = 0;
  const { api } = fixture(async () => { calls += 1; throw new Error("must not execute"); });
  for (const context of [
    execution({ hostId: "remote" }),
    execution({ getCurrentPermissions: () => null }),
    execution({ getCurrentPermissions: () => ({ sandboxPolicy: { type: "externalSandbox" } }) }),
    execution({ getCurrentPermissions: () => ({ sandboxPolicy: { type: "readOnly" } }) }),
    execution({ getCurrentPermissions: () => ({ sandboxPolicy: { type: "workspaceWrite" } }) }),
    execution({ getCurrentPermissions: () => ({ sandboxPolicy: { type: "dangerFullAccess" }, activePermissionProfile: "custom" }) }),
    execution({ getCurrentPermissions: () => ({ sandboxPolicy: { type: "dangerFullAccess" }, activePermissionProfile: {} }) }),
    execution({ request: { ...execution().request, tool: "replace", arguments: { dry_run: false } }, getCurrentPermissions: () => ({ sandboxPolicy: { type: "readOnly" } }) }),
  ]) {
    const result = await api.execute(context);
    assert.equal(result.success, false);
    assert.doesNotMatch(result.contentItems[0].text, /MCP|CODEY_FASTCTX_NATIVE_TOOLS/);
  }
  await assert.rejects(api.execute(execution({ getThreadExecutionState: () => ({ activeTurnId: "different-turn" }) })), { name: "AbortError" });
  assert.equal(calls, 0);
});

test("incompatible execution contexts report native availability without a removed MCP fallback", async () => {
  const { api } = fixture(() => { throw new Error("must not execute"); });
  const result = await api.execute(execution({ subscribeTurnCompleted: null }));
  assert.equal(result.success, false);
  assert.match(result.contentItems[0].text, /当前客户端不支持 FastCtx 原生执行上下文/);
  assert.doesNotMatch(result.contentItems[0].text, /MCP|CODEY_FASTCTX_NATIVE_TOOLS/);
});

test("standard full access permission profiles reach the native backend", async () => {
  for (const activePermissionProfile of [null, ":danger-full-access", { id: ":danger-full-access" }]) {
    let calls = 0;
    const { api } = fixture(async () => { calls += 1; return { content: [] }; });
    const result = await api.execute(execution({ getCurrentPermissions: () => ({
      sandboxPolicy: { type: "dangerFullAccess" }, activePermissionProfile,
    }) }));
    assert.equal(result.success, true);
    assert.equal(calls, 1);
  }
});

test("backend policy errors and malformed results fail without retrying a write", async () => {
  for (const response of [new Error("unsupported sandbox policy"), { content: [{ type: "resource", uri: "file:///secret" }] }, { content: [{ type: "image", data: "AQID", mimeType: "text/html" }] }]) {
    let calls = 0;
    const { api } = fixture(async () => { calls += 1; if (response instanceof Error) throw response; return response; });
    const context = execution({ request: { ...execution().request, tool: "replace", arguments: { dry_run: false } } });
    const result = await api.execute(context);
    assert.equal(result.success, false);
    assert.equal(calls, 1);
    assert.equal(context.disposals(), 1);
  }
});

test("abort and completed turns cancel once and discard a late result", async () => {
  for (const end of ["abort", "complete"]) {
    const calls = [];
    let finish;
    const { api } = fixture((method, args) => {
      calls.push({ method, args });
      return method === "call_fastctx_native_tool" ? new Promise((resolve) => { finish = resolve; }) : Promise.resolve({ cancelled: true });
    });
    const context = execution();
    const pending = api.execute(context);
    const rejected = assert.rejects(pending, { name: "AbortError" });
    await settle();
    context[end]();
    context[end]();
    finish({ content: [{ type: "text", text: "late result" }] });
    await rejected;
    await settle();
    assert.deepEqual(calls.map(({ method }) => method), ["call_fastctx_native_tool", "cancel_fastctx_native_tool"]);
    assert.deepEqual(plain(calls[1].args), { requestId: "call-1", threadId: "thread-1" });
    assert.equal(context.disposals(), 1);
  }
});

test("concurrent duplicate callbacks execute once and disposal cancels active calls", async () => {
  let finish;
  const calls = [];
  const { window, api } = fixture((method) => {
    calls.push(method);
    return method === "call_fastctx_native_tool" ? new Promise((resolve) => { finish = resolve; }) : Promise.resolve({ cancelled: true });
  });
  const context = execution();
  const first = api.execute(context);
  const second = api.execute(context);
  const rejectedFirst = assert.rejects(first, { name: "AbortError" });
  const rejectedSecond = assert.rejects(second, { name: "AbortError" });
  await settle();
  window.__codeyNativeRuntime.dispose();
  finish({ content: [{ type: "text", text: "late result" }] });
  await Promise.all([rejectedFirst, rejectedSecond]);
  await settle();
  assert.deepEqual(calls, ["call_fastctx_native_tool", "cancel_fastctx_native_tool"]);
  assert.equal(window.__codeyFastCtxNative, undefined);
  assert.equal(context.disposals(), 1);
});

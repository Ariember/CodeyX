import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

const sources = [
  "codey-bridge.js", "codex-runtime-adapter.js", "model-request-gate.js", "model-whitelist-inject.js",
].map(name => readFileSync(new URL(`../../public/${name}`, import.meta.url), "utf8"));

async function install(page, { route = "route-a", failPresentation = false, moduleOnly = false } = {}) {
  await page.setContent('<main id="root"></main>');
  await page.evaluate(({ route, failPresentation, moduleOnly }) => {
    const model = `${route}/shared`;
    window.fixture = { calls: [] };
    class Client {
      constructor(hostId = "local") { this.hostId = hostId; }
      enqueueRequest(method, params) {
        window.fixture.calls.push({ hostId: this.hostId, method, params });
        return { method, params };
      }
      createRequest() {}
      onResult() {}
      async sendRequest(method, params) { return this.enqueueRequest(method, params); }
    }
    window.fixture.local = new Client();
    window.fixture.remote = new Client("ssh-host");
    if (moduleOnly) {
      const script = document.createElement("script");
      script.type = "application/json";
      script.src = "app://-/assets/app-initial-startup.js";
      document.head.append(script);
      const scope = {
        get(_key, hostId) { return hostId === "local" ? { requestClient: window.fixture.local } : null; },
        query: null, set() {}, watch() {}, when() {},
      };
      window.__codeyImportCodexAsset = async () => ({
        container: { scope },
        Registry: class {
          getAll() { return this.scope.get("managers"); }
          getForHostId(hostId) { return this.scope.get("manager", hostId); }
        },
      });
    } else {
      window.__codeyAppServerRequestClients = new Map([["local", window.fixture.local]]);
    }
    window.__codexSessionDeleteBridge = async () => ({
      status: "ok", models: [model], default_model: model,
      model_metadata: [{ model, source_model: "shared", route_provider_id: route, provider_id: "codey_router" }],
    });
    if (failPresentation) {
      const add = document.addEventListener.bind(document);
      document.addEventListener = (name, ...args) => {
        if (name === "click") throw new Error("incompatible picker");
        return add(name, ...args);
      };
    }
  }, { route, failPresentation, moduleOnly });
  for (const content of sources) await page.addScriptTag({ content });
  await expect.poll(() => page.evaluate(() => window.__codeyModelWhitelistPatch.snapshot().loaded)).toBe(true);
  expect(await page.evaluate(() => window.__codeyModelWhitelistPatch.ensureRequestGate())).toBe(true);
}

test("页面尚未挂载时从本地模块安装请求校验，不依赖外网", async ({ page }) => {
  await page.route("**/*", route => route.abort());
  await install(page, { moduleOnly: true });
  const result = await page.evaluate(() => ({
    callsBeforeRequest: window.fixture.calls.length,
    local: window.fixture.local.enqueueRequest("thread/start", { model: "route-a/shared" }).params,
    remote: window.fixture.remote.enqueueRequest("thread/start", { model: "route-a/shared" }).params,
    mounted: Object.keys(document.querySelector("#root")).some(key => key.startsWith("__react")),
  }));
  expect(result.callsBeforeRequest).toBe(0);
  expect(result.mounted).toBe(false);
  expect(result.local.modelProvider).toBe("codey_router");
  expect(result.remote.modelProvider).toBeUndefined();
});

test("模型菜单初始化失败仍保留目录、原生路由校验及 MCP 刷新", async ({ page }) => {
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await install(page, { failPresentation: true });
  const result = await page.evaluate(async () => ({
    presentation: window.__codeyModelWhitelistPatch.presentation().status,
    local: window.fixture.local.enqueueRequest("thread/start", { model: "route-a/shared" }).params,
    remote: window.fixture.remote.enqueueRequest("thread/start", { model: "route-a/shared" }).params,
    reload: await window.__codeyReloadMcpServers(),
    reloadCalls: window.fixture.calls.filter(call => call.method === "config/mcpServer/reload"),
  }));
  expect(result.presentation).toBe("unavailable");
  expect(result.local.modelProvider).toBe("codey_router");
  expect(result.remote.modelProvider).toBeUndefined();
  expect(result.reload.ok).toBe(true);
  expect(result.reloadCalls.map(call => call.hostId)).toEqual(["local"]);
  expect(errors).toEqual([]);
});

test("多窗口保持各自目录和本机连接，页面重建后重新安装", async ({ page, context }) => {
  const second = await context.newPage();
  try {
    await install(page);
    await install(second, { route: "route-b" });
    await page.evaluate(() => window.__codeyReloadMcpServers());
    expect(await second.evaluate(() => window.fixture.calls)).toEqual([]);
    await page.reload();
    expect(await page.evaluate(() => typeof window.__codeyNativeRuntime)).toBe("undefined");
    await install(page, { route: "route-c" });
    await page.evaluate(() => window.__codeyReloadMcpServers());
    expect(await page.evaluate(() => window.__codeyModelWhitelistPatch.snapshot().models)).toEqual(["route-c/shared"]);
    expect(await second.evaluate(() => window.__codeyModelWhitelistPatch.snapshot().models)).toEqual(["route-b/shared"]);
    expect(await second.evaluate(() => window.__codeyNativeRuntime.isActive())).toBe(true);
    expect(await second.evaluate(() => window.fixture.calls)).toEqual([]);
  } finally { await second.close(); }
});

test("原生入口能力缺失时阻止校验成功，不向远程连接提交", async ({ page }) => {
  await page.setContent('<main id="root"></main>');
  await page.addScriptTag({ content: sources[2] });
  const result = await page.evaluate(async () => {
    let calls = 0;
    window.__codeyAppServerRequestClients = new Map([["ssh-host", { sendRequest() { calls += 1; } }]]);
    const gate = window.__codeyCreateModelRequestGate({});
    try { await gate.ensure(); return { verified: true, calls }; }
    catch (error) { return { verified: false, calls, message: error.message }; }
    finally { gate.dispose(); }
  });
  expect(result).toEqual({ verified: false, calls: 0, message: "模型请求校验尚未就绪" });
});

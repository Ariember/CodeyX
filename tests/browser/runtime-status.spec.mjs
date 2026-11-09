import { expect, test as base } from "@playwright/test";

const test = base.extend({
  page: async ({ page }, use) => {
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await use(page);
    expect(errors, "运行状态刷新不应出现未捕获异常").toEqual([]);
  },
});

for (const outcome of ["success", "error"]) {
  test(`设置隐藏时暂停读取，重开刷新后丢弃旧 ${outcome}`, async ({ page }) => {
    await page.goto("/codey/tests/ui-browser.html?platform=windows");
    const close = page.getByRole("button", { name: "关闭配置", exact: true });
    await expect(close).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole("button", { name: "重启 Codex", exact: true })).toBeEnabled();
    await page.evaluate(() => {
      const bridge = window.__codexSessionDeleteBridge;
      const state = window.runtimeStatusBehavior = { requests: [] };
      window.__codexSessionDeleteBridge = async (path, args) => {
        const result = await bridge(path, args);
        if (!path.endsWith("/runtime_status")) return result;
        return new Promise((resolve, reject) => state.requests.push({
          args, complete: (overrides) => resolve({ ...result, ...overrides }), fail: reject,
        }));
      };
      window.dispatchEvent(new Event("codey-injection-status-changed"));
    });
    await expect.poll(() => page.evaluate(() => window.runtimeStatusBehavior.requests.length)).toBe(1);
    await close.click();
    await expect(close).not.toBeVisible();
    await page.evaluate(() => {
      window.dispatchEvent(new Event("codey-injection-status-changed"));
      window.dispatchEvent(new Event("codey-settings-opened"));
    });
    expect(await page.evaluate(() => window.runtimeStatusBehavior.requests.length)).toBe(1);

    await page.getByRole("button", { name: "打开内嵌设置", exact: true }).click();
    await expect(close).toBeVisible();
    await expect.poll(() => page.evaluate(() => window.runtimeStatusBehavior.requests.length)).toBe(2);
    expect(await page.evaluate(() => window.runtimeStatusBehavior.requests[1].args)).toEqual({ refreshInjectionStatus: true });
    await page.evaluate(() => window.runtimeStatusBehavior.requests[1].complete({ running: true, appVersion: "9.0.2" }));
    await expect(page.getByText("v9.0.2", { exact: true })).toBeVisible();

    await page.evaluate(outcome => {
      const old = window.runtimeStatusBehavior.requests[0];
      if (outcome === "success") old.complete({ running: false, appVersion: "0.0.1" });
      else old.fail(new Error("测试：过期状态读取失败"));
    }, outcome);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await expect(page.getByText("v9.0.2", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "重启 Codex", exact: true })).toBeEnabled();
    expect(await page.evaluate(() => window.runtimeStatusBehavior.requests.length)).toBe(2);
  });
}

for (const [theme, width] of [["light", 1280], ["dark", 360]]) {
  test(`系统优化诊断列出待确认、异常和基础组件：${theme} / ${width}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto(`/codey/tests/ui-browser.html?platform=windows&theme=${theme}`);
    await expect(page.getByRole("button", { name: "已保存", exact: true })).toBeVisible({ timeout: 60_000 });
    await page.evaluate(() => {
      const bridge = window.__codexSessionDeleteBridge;
      window.__codexSessionDeleteBridge = async (path, args) => {
        const result = await bridge(path, args);
        return path.endsWith("/runtime_status") ? {
          ...result,
          injectionScripts: [
            { id: "runtime-optimizations", name: "运行时资源优化", source: "builtin", visibility: "feature", status: "executed", detail: "脚本已执行，但生效探针尚未通过" },
            { id: "user-failed", name: "自定义功能", source: "user", visibility: "feature", status: "failed", error: "测试：脚本执行失败" },
            { id: "internal-unknown", name: "基础组件探测", source: "builtin", visibility: "internal", status: "unknown" },
            { id: "pet-control-shield", name: "宠物控制精简", source: "builtin", visibility: "feature", status: "effective" },
            { id: "inactive", name: "已关闭功能", source: "builtin", visibility: "feature", status: "inactive" },
          ],
        } : result;
      };
      window.dispatchEvent(new Event("codey-injection-status-changed"));
    });
    const card = page.getByRole("button", { name: /^系统优化（基础异常/ });
    await expect(card).toBeVisible();
    await card.click();
    const attention = page.getByRole("region", { name: "待确认与异常", exact: true });
    await expect(attention.getByRole("listitem")).toHaveCount(3);
    await expect(attention).toContainText("运行时资源优化");
    await expect(attention).toContainText("待确认");
    await expect(attention).toContainText("脚本已执行，但生效探针尚未通过");
    await expect(attention).toContainText("测试：脚本执行失败");
    await expect(attention).toContainText("基础组件探测");
    await expect(attention).toContainText("未知");
    await expect(attention).not.toContainText("宠物控制精简");
    await expect(attention).not.toContainText("已关闭功能");
    await expect(page.getByRole("region", { name: /^已生效.*功能/ })).toContainText("宠物控制精简");
    await attention.screenshot({ path: testInfo.outputPath("injection-attention.png") });
    expect(await attention.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  });
}

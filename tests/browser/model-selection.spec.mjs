import { expect, test as base } from "@playwright/test";

const test = base.extend({
  page: async ({ page }, use) => {
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await use(page);
    expect(errors, "浏览器不应出现未捕获异常").toEqual([]);
  },
});

async function openModels(page, mode) {
  await page.goto("/codey/tests/ui-browser.html?platform=windows");
  await expect(page.getByRole("button", { name: "已保存", exact: true })).toBeVisible({ timeout: 60_000 });
  const route = await page.evaluate(async mode => {
    const bridge = window.__codexSessionDeleteBridge;
    const { config } = await bridge("/api/load_codey_config", {});
    const route = config.profiles.find(profile => profile.authMode !== "officialAccount" && profile.enabled !== false && !profile.pluginOwnerId);
    const state = window.modelSelectionBehavior = { saves: [], reads: 0, mode };
    window.__codexSessionDeleteBridge = async (path, args) => {
      if (path.endsWith("/fetch_route_models")) {
        state.reads++;
        if (state.mode === "pending-read" && state.reads === 1) {
          const result = await bridge(path, args);
          await new Promise(resolve => { state.release = resolve; });
          return result;
        }
      }
      if (path.endsWith("/save_selected_models")) {
        state.saves.push(structuredClone(args));
        if (state.mode === "fail-first" && state.saves.length === 1) {
          await new Promise(resolve => { state.release = resolve; });
          return { status: "failed", message: "测试：模型保存失败" };
        }
      }
      return bridge(path, args);
    };
    return { id: route.id, name: route.name, providerId: route.sourceProviderId || route.id };
  }, mode);
  await page.getByRole("button", { name: "线路与模型", exact: true }).click();
  return route;
}

test("官方模型支持搜索和清空，空结果不误报目录缺失或添加自定义模型", async ({ page }) => {
  await openModels(page, "normal");
  const route = await page.evaluate(async () => {
    const { config } = await window.__codexSessionDeleteBridge("/api/load_codey_config", {});
    return config.profiles.find(profile => profile.authMode === "officialAccount" && profile.enabled !== false);
  });
  await page.getByLabel(`同步 ${route.name} 模型`, { exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "配置当前线路支持的模型", exact: true });
  const search = dialog.getByRole("textbox", { name: "搜索模型", exact: true });
  await expect(search).toBeEnabled();
  const models = dialog.getByRole("checkbox", { name: /^当前线路支持 / });
  const initialCount = await models.count();
  expect(initialCount).toBeGreaterThan(0);
  await search.fill("no-such-official-model");
  await search.press("Enter");
  await expect(models).toHaveCount(0);
  await expect(dialog.getByText("未找到匹配的官方模型", { exact: true })).toBeVisible();
  await expect(dialog.getByText("暂未读取到当前账号可用模型", { exact: true })).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "添加", exact: true })).toHaveCount(0);
  await dialog.getByRole("button", { name: "清空搜索", exact: true }).click();
  await expect(models).toHaveCount(initialCount);
});

test("手动模型保存防重，失败保留选择，重试后线路展示已保存模型", async ({ page }) => {
  const route = await openModels(page, "fail-first");
  await page.getByLabel(`同步 ${route.name} 模型`, { exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "配置当前线路支持的模型", exact: true });
  const save = dialog.getByRole("button", { name: "保存模型声明", exact: true });
  await expect(save).toBeEnabled();
  const input = dialog.getByRole("textbox", { name: "搜索或添加模型", exact: true });
  await input.fill("codex-auto-review");
  await dialog.getByRole("button", { name: "添加", exact: true }).click();
  await expect(dialog.getByText("codex-auto-review 是线路能力，请使用上方 Auto Review 开关", { exact: true })).toBeVisible();
  await input.fill("test-manual-model");
  await input.press("Enter");
  const selected = dialog.getByRole("checkbox", { name: "当前线路支持 test-manual-model", exact: true });
  await expect(selected).toBeChecked();
  await save.click();
  await expect(save).toBeDisabled();
  await expect(dialog.getByRole("button", { name: "取消", exact: true })).toBeDisabled();
  await expect.poll(() => page.evaluate(() => window.modelSelectionBehavior.saves.length)).toBe(1);
  await page.evaluate(() => window.modelSelectionBehavior.release());
  await expect(dialog.getByText("测试：模型保存失败", { exact: true })).toBeVisible();
  await expect(selected).toBeChecked();
  await save.click();
  await expect(dialog).not.toBeVisible();
  const stored = await page.evaluate(async route => {
    const { config } = await window.__codexSessionDeleteBridge("/api/load_codey_config", {});
    return { selected: config.selectedModelsByProvider[route.providerId],
      manual: config.manualThirdPartyModelsByProvider[route.providerId], calls: window.modelSelectionBehavior.saves };
  }, route);
  expect(stored.selected).toContain("test-manual-model");
  expect(stored.manual).toContain("test-manual-model");
  expect(stored.calls).toHaveLength(2);
  expect(stored.calls[0]).toEqual(stored.calls[1]);
  expect(stored.calls[1].routeId).toBe(route.id);
  await expect(page.getByRole("button", { name: "设 test-manual-model 为默认模型", exact: true })).toBeVisible();
});

test("设置隐藏后迟到的模型目录不能重新打开弹窗，重开可重新同步", async ({ page }) => {
  const route = await openModels(page, "pending-read");
  await page.getByLabel(`同步 ${route.name} 模型`, { exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "配置当前线路支持的模型", exact: true });
  await expect(dialog.getByText("正在获取当前账号可用的模型", { exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => typeof window.modelSelectionBehavior.release)).toBe("function");
  await page.evaluate(() => window.__codeySettingsOverlay.close());
  await expect(dialog).not.toBeVisible();
  await page.evaluate(() => window.modelSelectionBehavior.release());
  await page.getByRole("button", { name: "打开内嵌设置", exact: true }).click();
  await expect(page.getByRole("button", { name: "已保存", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "线路与模型", exact: true }).click();
  const sync = page.getByLabel(`同步 ${route.name} 模型`, { exact: true });
  await expect(sync).toBeEnabled();
  await expect(dialog).not.toBeVisible();
  await sync.click();
  await expect(dialog.getByRole("button", { name: "保存模型声明", exact: true })).toBeEnabled();
  expect(await page.evaluate(() => window.modelSelectionBehavior.reads)).toBe(2);
});

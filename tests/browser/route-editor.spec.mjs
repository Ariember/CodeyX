import { expect, test as base } from "@playwright/test";

const test = base.extend({
  page: async ({ page }, use) => {
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await use(page);
    expect(errors).toEqual([]);
  },
});

async function openRoutes(page, failFirst = false) {
  await page.goto("/codey/tests/ui-browser.html?platform=windows");
  await expect(page.getByRole("button", { name: "已保存", exact: true })).toBeVisible({ timeout: 60_000 });
  const route = await page.evaluate(async failFirst => {
    const bridge = window.__codexSessionDeleteBridge;
    const { config } = await bridge("/api/load_codey_config", {});
    const route = config.profiles.find(profile => profile.authMode !== "officialAccount" && profile.enabled !== false && !profile.pluginOwnerId);
    const state = window.routeEditorBehavior = { saves: 0 };
    window.__codexSessionDeleteBridge = async (path, args) => {
      if (path.endsWith("/save_codey_config")) {
        state.saves++;
        if (failFirst && state.saves === 1) {
          await new Promise(resolve => { state.release = resolve; });
          return { status: "failed", message: "测试：线路保存失败" };
        }
      }
      return bridge(path, args);
    };
    return { id: route.id, name: route.name };
  }, failFirst);
  await page.getByRole("button", { name: "线路与模型", exact: true }).click();
  return route;
}

test("线路编辑校验聚焦、保存防重和失败保留草稿，成功关闭后密钥恢复隐藏", async ({ page }) => {
  const route = await openRoutes(page, true);
  await page.getByLabel(`编辑线路 ${route.name}`, { exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "编辑线路", exact: true });
  await expect(dialog.getByRole("textbox", { name: "上游代理（可选）", exact: true })).toHaveCount(0);
  const shortName = dialog.getByRole("textbox", { name: "短名称", exact: true });
  const save = dialog.getByRole("button", { name: "保存线路", exact: true });
  await shortName.fill("");
  await save.click();
  await expect(shortName).toBeFocused();
  await expect(dialog.getByText("请输入短名称", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.routeEditorBehavior.saves)).toBe(0);
  await shortName.fill("验");
  await dialog.getByRole("textbox", { name: "线路名", exact: true }).fill("重构验证");
  await dialog.locator("#route-key-input").fill("fixture-key");
  await save.click();
  await expect(save).toBeDisabled();
  await expect(dialog.getByRole("button", { name: "取消", exact: true })).toBeDisabled();
  await dialog.press("Escape"); await expect(dialog).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.routeEditorBehavior.saves)).toBe(1);
  await page.evaluate(() => window.routeEditorBehavior.release());
  await expect(page.getByText("测试：线路保存失败", { exact: true })).toBeVisible();
  await expect(shortName).toHaveValue("验");
  await expect(dialog.locator("#route-key-input")).toHaveValue("fixture-key");
  await save.click();
  await expect(dialog).not.toBeVisible();
  expect(await page.evaluate(() => window.routeEditorBehavior.saves)).toBe(2);
  await page.getByLabel("编辑线路 重构验证", { exact: true }).click();
  await expect(dialog.locator("#route-key-input")).toHaveAttribute("type", "password");
  await expect(shortName).toHaveValue("验");
});

test("New API 导入仅填充新增线路草稿，保留手填名称并经正常保存", async ({ page }) => {
  await openRoutes(page);
  await page.getByRole("button", { name: "新增线路", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "新增线路", exact: true });
  await dialog.getByRole("textbox", { name: "线路名", exact: true }).fill("导入验证");
  await dialog.getByRole("button", { name: "New API 快速导入", exact: true }).click();
  const input = dialog.getByRole("textbox", { name: "New API 连接串", exact: true });
  await input.fill("invalid");
  await dialog.getByRole("button", { name: "填入线路", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("无法识别连接串");
  await input.fill(JSON.stringify({ _type: "newapi_channel_conn", url: "https://api.example.com/v1", key: "fixture-import-key" }));
  await dialog.getByRole("button", { name: "填入线路", exact: true }).click();
  await expect(input).not.toBeVisible();
  await expect(dialog.getByRole("textbox", { name: "线路名", exact: true })).toHaveValue("导入验证");
  await expect(dialog.getByRole("textbox", { name: "URL", exact: true })).toHaveValue("https://api.example.com/v1");
  await expect(dialog.locator("#route-key-input")).toHaveAttribute("type", "password");
  await expect(dialog.locator("#route-key-input")).toHaveValue("fixture-import-key");
  expect(await page.evaluate(() => window.routeEditorBehavior.saves)).toBe(0);
  await dialog.getByRole("button", { name: "保存线路", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  expect(await page.evaluate(() => window.routeEditorBehavior.saves)).toBe(1);
  await page.getByLabel("编辑线路 导入验证", { exact: true }).click();
  await expect(page.getByRole("button", { name: "New API 快速导入", exact: true })).toHaveCount(0);
});

test("请求头编辑拒绝非法 JSON，保存空值删除标记并可重新读取", async ({ page }) => {
  const route = await openRoutes(page);
  await page.getByLabel(`编辑线路 ${route.name} 的请求头`, { exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "编辑上游请求头", exact: true });
  const input = dialog.getByRole("textbox", { name: "请求头（JSON）", exact: true });
  const save = dialog.getByRole("button", { name: "保存请求头", exact: true });
  await input.fill("invalid"); await save.click();
  await expect(input).toHaveAttribute("aria-invalid", "true");
  expect(await page.evaluate(() => window.routeEditorBehavior.saves)).toBe(0);
  await input.fill('{"X-Test":"value","X-Remove":null}'); await save.click();
  await expect(dialog).not.toBeVisible();
  await page.getByLabel(`编辑线路 ${route.name} 的请求头`, { exact: true }).click();
  const headers = JSON.parse(await input.inputValue());
  expect(headers).toEqual({ "x-test": "value", "x-remove": null });
  const stored = await page.evaluate(async id => {
    const { config } = await window.__codexSessionDeleteBridge("/api/load_codey_config", {});
    return config.profiles.find(profile => profile.id === id).modelRequestHeaders;
  }, route.id);
  expect(stored).toEqual({ "x-test": "value", "x-remove": "" });
  expect(await page.evaluate(() => window.routeEditorBehavior.saves)).toBe(1);
});

import { expect, test } from "@playwright/test";

async function open(page, theme = "light") {
  await page.goto(`/codey/tests/ui-browser.html?platform=windows&theme=${theme}`);
  await expect(page.getByRole("button", { name: "已保存", exact: true })).toBeVisible({ timeout: 60_000 });
  await page.getByRole("button", { name: "会话管理", exact: true }).click();
  await expect(page.getByRole("checkbox").first()).toBeVisible();
}

test("管理面板会话选择、归档筛选、永久清理确认和重启提示", async ({ page }) => {
  const errors = []; page.on("pageerror", error => errors.push(error.message));
  await open(page);
  const sessions = page.getByLabel("本机会话列表", { exact: true });
  await expect(sessions.getByText("E:\\code\\CodeyX", { exact: true }).first()).toBeVisible();
  await expect(sessions.getByText("\\\\Server\\Share\\example", { exact: true }).first()).toBeVisible();
  await expect(sessions).not.toContainText("\\\\?\\");
  await page.screenshot({ path: "output/playwright/session-management.png" });
  await page.getByRole("combobox", { name: "会话范围" }).selectOption("archived");
  await page.getByRole("searchbox", { name: "搜索会话" }).fill("已归档的界面方案");
  await expect(page.getByRole("checkbox")).toHaveCount(1);
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "清理所选", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "永久清理所选会话？" });
  await expect(dialog).toContainText("其中归档 1 个");
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  await expect(page.getByRole("checkbox")).toBeChecked();
  await page.getByRole("button", { name: "清理所选", exact: true }).click();
  await dialog.getByRole("button", { name: "确认永久清理", exact: true }).click();
  await expect(page.getByText("没有符合条件的会话。", { exact: true })).toBeVisible();
  await expect(page.getByText(/请通过 CodeyX 重启 Codex，完成剩余缓存清理/)).toBeVisible();
  await expect(page.getByRole("button", { name: "重启 Codex", exact: true }).last()).toBeEnabled();
  expect(errors).toEqual([]);
});

for (const [theme, width] of [["light", 1280], ["dark", 620]]) {
  test(`自定义天数筛选与自动清理确认保存：${theme} / ${width}`, async ({ page }) => {
    const errors = []; page.on("pageerror", error => errors.push(error.message));
    await page.setViewportSize({ width, height: 900 });
    await open(page, theme);
    const toggle = page.getByRole("switch", { name: "启用自动清理", exact: true });
    const days = page.getByRole("spinbutton", { name: "保留天数", exact: true });
    const save = page.getByRole("button", { name: "保存清理设置", exact: true });
    await expect(toggle).not.toBeChecked(); await expect(days).toHaveValue("30"); await expect(save).toBeDisabled();
    await days.fill(""); await expect(page.getByText("保留天数须为 1 至 36500 的整数。", { exact: true })).toBeVisible();
    await expect(save).toBeDisabled();
    await days.fill("30");
    await page.getByRole("combobox", { name: "时间范围" }).selectOption("expired");
    await expect(page.getByRole("checkbox", { name: "选择会话 管理面板功能开发", exact: true })).toHaveCount(0);
    await expect(page.getByRole("checkbox", { name: "选择会话 项目会话 3", exact: true })).toBeVisible();
    await toggle.press("Space");
    const panel = page.getByRole("region", { name: "自动清理", exact: true });
    await panel.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `output/playwright/session-retention-${theme}.png` });
    expect(await panel.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    await save.click();
    const dialog = page.getByRole("dialog", { name: "启用此自动清理规则？", exact: true });
    await expect(dialog).toContainText("超过 30 天"); await expect(dialog).toContainText("无法撤销");
    await dialog.getByRole("button", { name: "取消", exact: true }).click();
    await expect(page.getByText("共 25 个 · 已选 0 个", { exact: true })).toBeVisible();
    await save.click(); await dialog.getByRole("button", { name: "确认启用自动清理", exact: true }).click();
    await expect(page.getByText(/自动清理设置已保存/)).toBeVisible();
    await expect(page.getByText("共 2 个 · 已选 0 个", { exact: true })).toBeVisible();
    await expect(page.getByText("没有符合条件的会话。", { exact: true })).toBeVisible();
    await expect(toggle).toBeChecked(); await expect(save).toBeDisabled();
    await page.getByRole("combobox", { name: "时间范围" }).selectOption("all");
    await expect(page.getByRole("checkbox", { name: "选择会话 管理面板功能开发", exact: true })).toBeVisible();
    await expect(page.getByRole("checkbox", { name: "选择会话 已归档的界面方案", exact: true })).toBeVisible();
    await toggle.press("Space"); await save.click();
    await expect(page.getByText("自动清理已关闭。", { exact: true })).toBeVisible();
    await expect(page.getByRole("dialog", { name: "启用此自动清理规则？", exact: true })).toHaveCount(0);
    expect(errors).toEqual([]);
  });
}

test("Shadow DOM 中逐项、整行与键盘选择同步，清理保留未选会话", async ({ page }) => {
  await open(page);
  const selected = page.getByRole("checkbox", { name: "选择会话 管理面板功能开发", exact: true });
  const unselected = page.getByRole("checkbox", { name: "选择会话 已归档的界面方案", exact: true });
  expect(await selected.evaluate(input => input.getRootNode() instanceof ShadowRoot)).toBe(true);
  const remove = page.getByRole("button", { name: "清理所选", exact: true });
  await expect(remove).toBeDisabled();

  await selected.click();
  await expect(selected).toBeChecked();
  await expect(page.getByText("共 25 个 · 已选 1 个", { exact: true })).toBeVisible();
  await expect(remove).toBeEnabled();
  await selected.press("Space");
  await expect(selected).not.toBeChecked();
  await expect(remove).toBeDisabled();
  await page.getByText("管理面板功能开发", { exact: true }).click();
  await expect(selected).toBeChecked();
  await expect(page.getByText("共 25 个 · 已选 1 个", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "选择本页", exact: true }).click();
  await expect(page.getByText("共 25 个 · 已选 20 个", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "取消本页选择", exact: true }).click();
  await expect(remove).toBeDisabled();
  await selected.check();
  await remove.click();
  const dialog = page.getByRole("dialog", { name: "永久清理所选会话？" });
  await expect(dialog).toContainText("1 个本机会话，其中归档 0 个");
  await dialog.getByRole("button", { name: "确认永久清理", exact: true }).click();
  await expect(selected).toHaveCount(0);
  await expect(unselected).toBeVisible();
  await expect(page.getByText("共 24 个 · 已选 0 个", { exact: true })).toBeVisible();
});

test("全部清理明确包含筛选外归档，窄屏可选择并显示空状态", async ({ page }) => {
  await page.setViewportSize({ width: 620, height: 820 });
  await open(page);
  await page.getByRole("combobox", { name: "会话范围" }).selectOption("active");
  await page.getByRole("button", { name: "清空全部（含归档）", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "清空全部本机会话？" });
  await expect(dialog).toContainText("25 个本机会话，其中归档 12 个");
  await expect(dialog).toContainText("包含当前筛选条件以外的全部会话");
  await dialog.getByRole("button", { name: "确认永久清理", exact: true }).click();
  await expect(page.getByText("暂无本机会话。", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "清空全部（含归档）", exact: true })).toBeDisabled();
  await page.screenshot({ path: "output/playwright/session-management-narrow.png" });
});

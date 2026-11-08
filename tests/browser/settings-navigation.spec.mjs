import { expect, test } from "@playwright/test";

const groups = [
  ["核心配置", ["基础功能", "线路与模型", "提示词优化", "子代理优化"]],
  ["运行管理", ["远程控制", "会话管理", "备份与恢复"]],
  ["扩展生态", ["内置工具", "CodeyX 插件", "MCP 管理", "Skill 管理"]],
];

for (const theme of ["light", "dark"]) {
  for (const width of [1280, 360]) {
    test(`侧边栏三个分区及页面切换：${theme} / ${width}`, async ({ page }, testInfo) => {
      const errors = [];
      page.on("pageerror", error => errors.push(error.message));
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`/codey/tests/remote-control-browser.html?platform=windows&state=stopped&theme=${theme}`);
      const menu = page.getByRole("navigation", { name: "配置功能菜单" });
      await expect(menu).toBeVisible({ timeout: 60_000 });
      await expect(menu.locator(".settings-nav-group-title")).toHaveText(groups.map(([title]) => title));
      await expect(menu.locator(".settings-nav-item")).toHaveCount(11);
      await expect(menu.getByRole("button", { name: "网络代理", exact: true })).toHaveCount(0);
      await page.screenshot({ path: testInfo.outputPath("sidebar.png") });

      for (const [index, [, titles]] of groups.entries()) {
        const group = menu.locator(".settings-nav-group").nth(index);
        await expect(group.getByRole("button")).toHaveText(titles);
        for (const title of titles) {
          const button = group.getByRole("button", { name: title, exact: true });
          await button.click({ timeout: 10_000 });
          await expect(button).toHaveAttribute("aria-current", "page");
          await expect(menu.locator('[aria-current="page"]')).toHaveCount(1);
          const panel = page.locator(".settings-page").and(page.getByRole("region", { name: title, exact: true }));
          await expect(panel).toBeVisible();
          expect(await panel.getAttribute("id")).toBe(await button.getAttribute("aria-controls"));
          await expect(page.locator(".settings-page:visible")).toHaveCount(1);
        }
      }

      const backup = menu.getByRole("button", { name: "备份与恢复", exact: true });
      await backup.focus();
      await page.keyboard.press("Enter");
      await expect(backup).toBeFocused();
      await expect(page.locator(".settings-page").and(page.getByRole("region", { name: "备份与恢复", exact: true }))).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      expect(errors).toEqual([]);
    });
  }
}

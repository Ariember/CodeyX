import { expect, test } from "@playwright/test";
import { fileURLToPath } from "node:url";

const script = name => fileURLToPath(new URL(`../../public/${name}.js`, import.meta.url));

for (const theme of ["light", "dark"]) {
  for (const width of [360, 1280]) {
    test(`重置次数和过期提示：${theme} / ${width}`, async ({ page }, testInfo) => {
      const errors = [];
      page.on("pageerror", error => errors.push(error.message));
      await page.setViewportSize({ width, height: 720 });
      await page.setContent(`<html style="color-scheme:${theme}"><body style="margin:0;font-family:system-ui">
        <header style="height:40px;display:flex;justify-content:flex-end"><button>分享</button></header>
        <aside style="width:300px;height:640px;position:relative">
          <nav style="height:560px"><div data-app-action-sidebar-scroll>会话列表</div></nav>
          <footer style="position:absolute;bottom:0;width:100%"><button>账号</button></footer>
        </aside>
      </body></html>`);
      await page.evaluate(() => {
        const now = Math.floor(Date.now() / 1000);
        window.usageSnapshot = {
          status: "ok", planType: "plus", fetchedAt: now,
          primary: { usedPercent: 20, windowMinutes: 300, resetsAt: now + 3600 },
          secondary: { usedPercent: 40, windowMinutes: 10080, resetsAt: now + 86400 },
          resetCredits: { availableCount: 2, nextExpiresAt: now + 6 * 3600 },
        };
        window.__codeySessionToolsInjectLoaded = true;
        window.__codexSessionDeleteBridge = async path => {
          if (path === "/account/usage") return window.usageSnapshot;
          return { status: "ok" };
        };
      });
      await page.addScriptTag({ path: script("codey-bridge") });
      await page.addScriptTag({ path: script("renderer-inject") });
      const usage = page.locator("#codey-account-usage");
      await expect(usage).toBeVisible();
      await expect(usage).toHaveAttribute("aria-label", /重置次数即将过期/);
      await usage.focus();
      const details = usage.locator(".codey-usage-details");
      await expect(details).toBeVisible();
      const credits = details.locator(".codey-usage-reset-credits");
      await expect(credits).toContainText("2 次");
      await expect(credits).toContainText("过期");
      await expect(credits).toHaveAttribute("data-expiring", "true");
      const bounds = await details.boundingBox();
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
      expect(await details.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath("reset-credits.png") });
      await page.keyboard.press("Escape");
      await expect(details).toBeHidden();
      await page.evaluate(async () => {
        window.usageSnapshot.resetCredits = { availableCount: 0 };
        await window.__codeyRefreshAccountUsage();
      });
      await expect(credits).toHaveCount(0);
      await expect(usage).not.toHaveAttribute("aria-label", /重置次数即将过期/);
      expect(errors).toEqual([]);
    });
  }
}

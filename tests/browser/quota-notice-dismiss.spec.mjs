import { expect, test } from "@playwright/test";
import { fileURLToPath } from "node:url";

const script = name => fileURLToPath(new URL(`../../public/${name}.js`, import.meta.url));

for (const theme of ["light", "dark"]) {
  test(`额度提示 ${theme} 主题分批扫描并支持键盘关闭`, async ({ page }) => {
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.setViewportSize({ width: 375, height: 667 });
    await page.setContent(`<html style="color-scheme:${theme}"><body style="margin:16px;font-family:system-ui">
      <div id="history">${"<span></span>".repeat(600)}</div>
      <section id="notice" style="padding:48px 16px 16px;border:1px solid gray;border-radius:12px">
        <h2>Codex 和工作使用额度已用完</h2>
        <p>你的速率限制将于 17:31 重置。</p><button id="reset">重置使用量</button>
      </section>
      <section data-turn-key="quoted"><p>Codex 和工作使用额度已用完，你的速率限制将于 17:31 重置。</p></section>
    </body></html>`);
    await page.evaluate(() => {
      window.resetClicks = 0;
      document.querySelector("#reset").addEventListener("click", () => { window.resetClicks += 1; });
    });
    await page.addScriptTag({ path: script("codey-bridge") });
    await page.addScriptTag({ path: script("quota-notice-dismiss") });
    const close = page.getByRole("button", { name: "关闭使用额度提示", exact: true });
    await expect(close).toHaveCount(1);
    await expect(close).toBeVisible();
    await expect(close).toHaveCSS("background-color", theme === "dark" ? "rgb(45, 47, 51)" : "rgb(255, 255, 255)");
    const box = await close.boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(375);
    await close.focus();
    await page.screenshot({ path: `output/playwright/quota-notice-${theme}.png` });
    await page.keyboard.press("Enter");
    await expect(page.locator("#notice")).toBeHidden();
    await expect(page.locator("[data-turn-key]")).toBeVisible();
    expect(await page.evaluate(() => window.resetClicks)).toBe(0);
    await page.evaluate(() => {
      const notice = document.querySelector("#notice");
      notice.remove();
      document.body.insertAdjacentHTML("beforeend", '<section id="replacement"><h2>Codex and Work limits reached</h2><p>Your rate limit resets tomorrow.</p><button>Reset usage</button></section>');
    });
    await expect(close).toBeVisible();
    await close.click();
    await expect(page.locator("#replacement")).toBeHidden();
    expect(errors).toEqual([]);
  });
}

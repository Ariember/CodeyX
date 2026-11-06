import { mkdir, readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { loadStartupSplashMarkup } from "../helpers/startup-splash.mjs";

const markup = loadStartupSplashMarkup();
const script = (await readFile(new URL("../../public/startup-splash.js", import.meta.url), "utf8"))
  .replace("__CODEY_STARTUP_SPLASH__", JSON.stringify(markup));
const loader = '<div class="startup-loader"><span class="startup-loader__logo">Native loading</span></div>';
const ready = '<main><button>New chat</button></main>';

async function open(page, { managed = false, query = "", content = loader } = {}) {
  await page.route("http://startup.test/**", route => route.fulfill({
    contentType: "text/html",
    body: `<!doctype html><html><head><meta charset="utf-8"><style id="host-style">button { font: inherit; }</style></head><body>${managed ? "" : markup}<div id="root">${content}</div></body></html>`,
  }));
  if (managed) {
    await page.addInitScript(() => {
      if (window.startupObserverTracking) return;
      window.startupObserverTracking = true;
      window.activeStartupObservers = 0;
      const NativeObserver = window.MutationObserver;
      window.MutationObserver = class extends NativeObserver {
        active = false;
        constructor(callback) {
          super(callback);
          this.startup = callback.name === "update";
        }
        observe(...args) {
          if (this.startup && !this.active) window.activeStartupObservers += 1;
          this.active = this.startup;
          return super.observe(...args);
        }
        disconnect() {
          if (this.active) window.activeStartupObservers -= 1;
          this.active = false;
          return super.disconnect();
        }
      };
    });
    await page.addInitScript({ content: script });
  }
  await page.goto(`http://startup.test/index.html${query}`);
}

async function render(page, html) {
  await page.locator("#root").evaluate((root, content) => { root.innerHTML = content; }, html);
}

async function expectSplashDisposed(page) {
  await expect(page.locator(".codey-splash")).toHaveCount(0);
  await expect(page.locator("style")).toHaveCount(1);
  await expect(page.locator("#host-style")).toHaveCount(1);
}

test("CSS fallback covers slow startup, empty roots and React loading until a usable screen appears", async ({ page }) => {
  await open(page);
  const splash = page.locator(".codey-splash");
  await page.waitForTimeout(5000);
  await expect(splash).toBeVisible();
  await expect(page.locator(".startup-loader")).toBeHidden();
  await render(page, "");
  await page.waitForTimeout(700);
  await expect(splash).toBeVisible();
  await render(page, '<main><div role="progressbar">Loading</div></main>');
  await page.waitForTimeout(700);
  await expect(splash).toBeVisible();
  await render(page, '<main hidden><button>New chat</button></main>');
  await page.waitForTimeout(700);
  await expect(splash).toBeVisible();
  await render(page, ready);
  await expect(splash).toBeHidden();
  await render(page, loader);
  await expect(splash).toBeVisible();
});

test("managed splash cancels a premature exit, removes itself after ready and never reinstalls", async ({ page }) => {
  await open(page, { managed: true });
  const splash = page.locator(".codey-splash");
  await expect(splash).toHaveAttribute("data-codey-splash-managed", "true");
  await page.waitForTimeout(3500);
  await render(page, "");
  await page.waitForTimeout(700);
  await expect(splash).toBeVisible();
  await render(page, '<main style="display:none"><button>New chat</button></main><div role="progressbar">Loading</div>');
  await page.waitForTimeout(700);
  await expect(splash).not.toHaveAttribute("data-codey-splash-ready");
  await render(page, ready);
  await expect(splash).toHaveAttribute("data-codey-splash-ready", "true");
  await render(page, loader);
  await expect(splash).not.toHaveAttribute("data-codey-splash-ready");
  await expect(splash).toBeVisible();
  await mkdir("output/playwright", { recursive: true });
  await page.screenshot({ path: "output/playwright/startup-lifecycle-loading.png" });
  await render(page, ready);
  await expectSplashDisposed(page);
  expect(await page.evaluate(() => window.activeStartupObservers)).toBe(0);
  await page.addScriptTag({ content: script });
  await expectSplashDisposed(page);
  await expect(page.getByRole("button", { name: "New chat" })).toBeVisible();
  await page.screenshot({ path: "output/playwright/startup-lifecycle-ready.png" });
});

for (const [name, content] of [["login", '<form><input aria-label="Email"><button>Sign in</button></form>'], ["startup error", '<div role="alert">Failed to start. Retry</div>']]) {
  test(`reduced motion still dismisses for ${name}`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await open(page, { managed: true });
    await expect(page.locator(".codey-splash")).toBeVisible();
    await render(page, content);
    await expectSplashDisposed(page);
    expect(await page.evaluate(() => window.activeStartupObservers)).toBe(0);
  });
}

test("secondary windows and already ready primary windows do not install a splash", async ({ page }) => {
  await open(page, { managed: true, query: "?initialRoute=%2Fhotkey-window" });
  await expect(page.locator(".codey-splash")).toHaveCount(0);
  expect(await page.evaluate(() => window.activeStartupObservers)).toBe(0);
  await open(page, { managed: true, content: ready });
  await expect(page.locator(".codey-splash")).toHaveCount(0);
  expect(await page.evaluate(() => window.activeStartupObservers)).toBe(0);
});

for (const reason of ["pagehide", "removed splash", "removed root"]) {
  test(`managed splash removes its own stylesheet on ${reason}`, async ({ page }) => {
    await open(page, { managed: true });
    await expect(page.locator(".codey-splash")).toBeVisible();
    await page.evaluate(reason => {
      if (reason === "pagehide") window.dispatchEvent(new Event("pagehide"));
      else document.querySelector(reason === "removed splash" ? ".codey-splash" : "#root").remove();
    }, reason);
    await expectSplashDisposed(page);
    expect(await page.evaluate(() => window.activeStartupObservers)).toBe(0);
    await page.addScriptTag({ content: script });
    await expectSplashDisposed(page);
  });
}

test("late injection removes the CSS fallback and its stylesheet after startup", async ({ page }) => {
  await open(page, { content: ready });
  await expect(page.locator("style")).toHaveCount(2);
  await expect(page.locator(".codey-splash")).toBeHidden();
  await page.addScriptTag({ content: script });
  await expectSplashDisposed(page);
});

test("host theme markers override system preference and update while loading", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await open(page);
  const splash = page.locator(".codey-splash");
  await expect(splash).toHaveCSS("background-color", "rgb(19, 22, 32)");
  await page.evaluate(() => { document.documentElement.dataset.theme = "light"; });
  await expect(splash).toHaveCSS("background-color", "rgb(248, 247, 245)");
  await page.evaluate(() => {
    delete document.documentElement.dataset.theme;
    document.body.className = "light";
  });
  await expect(splash).toHaveCSS("background-color", "rgb(248, 247, 245)");
  await page.evaluate(() => {
    document.body.className = "";
    document.getElementById("root").className = "dark";
  });
  await page.emulateMedia({ colorScheme: "light" });
  await expect(splash).toHaveCSS("background-color", "rgb(19, 22, 32)");
});

for (const [name, width, height, theme] of [
  ["light", 1280, 800, "light"],
  ["dark", 1000, 700, "dark"],
  ["narrow", 390, 740, "light"],
  ["compact", 600, 600, "dark"],
  ["short", 900, 420, "light"],
]) {
  test(`splash ${name} layout keeps the wordmark and complete artwork apart`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
    await open(page);
    const artwork = page.locator(".codey-splash__art img");
    await expect(artwork).toBeVisible();
    await expect.poll(() => artwork.evaluate(image => image.complete && image.naturalWidth > 0)).toBe(true);
    const mark = page.locator(".codey-splash__mark");
    await expect(mark).toBeVisible();
    await expect(mark).toHaveAttribute("aria-label", "CodeyX");
    expect(await mark.locator("path").evaluateAll(paths => paths.length > 0 && paths.every(path => path.getTotalLength() > 0))).toBe(true);
    const wordmarkBounds = await mark.evaluate(svg => {
      const ink = svg.getBBox();
      const viewport = svg.viewBox.baseVal;
      return { ink: { x: ink.x, y: ink.y, right: ink.x + ink.width, bottom: ink.y + ink.height },
        viewport: { x: viewport.x, y: viewport.y, right: viewport.x + viewport.width, bottom: viewport.y + viewport.height } };
    });
    expect(wordmarkBounds.ink.x).toBeGreaterThanOrEqual(wordmarkBounds.viewport.x);
    expect(wordmarkBounds.ink.y).toBeGreaterThanOrEqual(wordmarkBounds.viewport.y);
    expect(wordmarkBounds.ink.right).toBeLessThanOrEqual(wordmarkBounds.viewport.right);
    expect(wordmarkBounds.ink.bottom).toBeLessThanOrEqual(wordmarkBounds.viewport.bottom);
    await expect(page.locator(".codey-splash__label")).toHaveText("正在启动 Codex");
    const copyBox = await page.locator(".codey-splash__copy").boundingBox();
    const artBox = await artwork.boundingBox();
    for (const box of [copyBox, artBox]) {
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(width);
      expect(box.y + box.height).toBeLessThanOrEqual(height);
    }
    if (width > 760) expect(copyBox.x + copyBox.width).toBeLessThan(artBox.x);
    else expect(copyBox.y + copyBox.height).toBeLessThan(artBox.y);
    await mkdir("output/playwright", { recursive: true });
    await page.screenshot({ path: `output/playwright/startup-splash-${name}.png` });
  });
}

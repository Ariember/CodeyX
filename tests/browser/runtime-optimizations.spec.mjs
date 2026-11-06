import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

const source = readFileSync(new URL("../../public/runtime-optimizations.js", import.meta.url), "utf8")
  .replaceAll("__CODEY_SLIM_PET__", "false");
const controller = '[data-codex-window-type="electron"] :is([data-app-shell-titlebar], [data-app-shell-tabs="true"]:has([data-browser-sidebar-chrome-expanded="true"])) [data-app-shell-tab-strip-controller]';
const nativeCss = `
  ${controller} { -webkit-app-region: no-drag; }
  ${controller} * { -webkit-app-region: initial; }
  [data-codex-window-type="electron"] :is([data-unrelated], [data-other]:has(button)) span { color: red; }
  [data-codex-window-type="electron"] [data-fixture-section] [data-app-shell-tab-strip-controller],
  [data-codex-window-type="electron"] [data-fixture-section] [data-app-shell-tab-strip-controller] * { -webkit-app-region: drag; }
  [data-codex-window-type="electron"] [data-fixture-section] [data-app-shell-tab-strip-controller][data-competing],
  [data-codex-window-type="electron"] [data-fixture-section] [data-app-shell-tab-strip-controller] [data-competing] { -webkit-app-region: drag; }
`;

async function open(page, { layered = false, css = true } = {}) {
  const sections = [
    ["title", "data-app-shell-titlebar"],
    ["tabs", 'data-app-shell-tabs="true"'],
    ["other", ""],
  ].map(([id, attributes]) => `
    <section id="${id}" data-fixture-section ${attributes}>
      <span data-browser-sidebar-chrome-expanded="false"></span>
      <div data-app-shell-tab-strip-controller data-target="${id}-controller"><span data-target="${id}-child">Tab</span></div>
    </section>
  `).join("") + `
    <section data-fixture-section data-app-shell-titlebar>
      <div data-app-shell-tab-strip-controller data-competing data-target="competing-controller"><span data-competing data-target="competing-child">Tab</span></div>
    </section>
  `;
  await page.route("http://runtime.test/index.html", route => route.fulfill({
    contentType: "text/html",
    body: `<!doctype html><html><head>${css ? `<style id="native">${layered ? `@layer native { ${nativeCss} }` : nativeCss}</style>` : ""}</head><body data-codex-window-type="electron">${sections}</body></html>`,
  }));
  await page.goto("http://runtime.test/index.html");
  await page.evaluate(() => {
    window.__codeyNativeRuntime = { discoverAppAssetUrls: async () => [] };
    window.fixtureRules = () => {
      const rules = document.getElementById("native").sheet.cssRules;
      return Array.from(rules[0] instanceof CSSLayerBlockRule ? rules[0].cssRules : rules);
    };
  });
}

async function install(page) {
  await page.addScriptTag({ content: source });
  await page.evaluate(() => window.__codeyRuntimeOptimizations.refresh());
}

const selectors = page => page.evaluate(() => window.fixtureRules().map(rule => rule.selectorText));
const regions = page => page.locator("[data-target]").evaluateAll(elements => (
  elements.map(element => getComputedStyle(element).getPropertyValue("-webkit-app-region"))
));
const setState = (page, state) => page.evaluate(state => {
  document.getElementById("title").toggleAttribute("data-app-shell-titlebar", state < 2);
  document.querySelector("#tabs [data-browser-sidebar-chrome-expanded]")
    .setAttribute("data-browser-sidebar-chrome-expanded", String(state > 0));
}, state);

for (const layered of [false, true]) {
  test(`原生拖动区域保持动态匹配和优先级${layered ? "（嵌套 layer）" : ""}`, async ({ page }) => {
    await open(page, { layered });
    const original = await selectors(page);
    const declarations = await page.evaluate(() => window.fixtureRules().map(rule => rule.style.cssText));
    const expected = [];
    for (let state = 0; state < 3; state += 1) {
      await setState(page, state);
      expected.push(await regions(page));
    }
    expect(expected[0]).toEqual(["no-drag", "none", "drag", "drag", "drag", "drag", "drag", "drag"]);
    expect(expected[1]).toEqual(["no-drag", "none", "no-drag", "none", "drag", "drag", "drag", "drag"]);
    expect(expected[2]).toEqual(["drag", "drag", "no-drag", "none", "drag", "drag", "drag", "drag"]);

    await install(page);
    const patched = await selectors(page);
    expect(patched[0]).not.toBe(original[0]);
    expect(patched[1]).not.toBe(original[1]);
    expect(patched.slice(2)).toEqual(original.slice(2));
    expect(await page.evaluate(() => window.fixtureRules().map(rule => rule.style.cssText))).toEqual(declarations);
    for (let state = 0; state < 3; state += 1) {
      await setState(page, state);
      expect(await regions(page)).toEqual(expected[state]);
    }
    await page.evaluate(() => document.body.setAttribute("data-codex-window-type", "browser"));
    expect(await regions(page)).toEqual(Array(8).fill("none"));
    await page.evaluate(() => document.body.setAttribute("data-codex-window-type", "electron"));
    expect(await regions(page)).toEqual(expected[2]);
    await page.evaluate(() => window.__codeyRuntimeOptimizations.dispose());
    expect(await selectors(page)).toEqual(original);
    await expect(page.locator("[data-codey-sidebar-expanded]")).toHaveCount(0);
  });
}

test("重复安装和版本切换只保留当前补丁，清理不覆盖原生的新选择器", async ({ page }) => {
  await open(page);
  const original = await selectors(page);
  await install(page);
  const patched = await selectors(page);
  await page.evaluate(() => { window.firstRuntime = window.__codeyRuntimeOptimizations; });
  await install(page);
  expect(await page.evaluate(() => window.firstRuntime === window.__codeyRuntimeOptimizations)).toBe(true);
  expect(await selectors(page)).toEqual(patched);

  await page.evaluate(() => {
    const previous = window.__codeyRuntimeOptimizations;
    window.disposals = 0;
    window.__codeyRuntimeOptimizations = {
      ...previous, version: 0,
      dispose() { window.disposals += 1; previous.dispose(); },
    };
  });
  await install(page);
  expect(await page.evaluate(() => window.disposals)).toBe(1);
  expect(await selectors(page)).toEqual(patched);
  const replacement = "[data-app-shell-tab-strip-controller]";
  await page.evaluate(replacement => {
    window.fixtureRules()[0].selectorText = replacement;
    window.__codeyRuntimeOptimizations.dispose();
  }, replacement);
  expect(await selectors(page)).toEqual([replacement, ...original.slice(1)]);
});

test("局部标记跟随新建、移动和移除的展开状态，清理后停止观察", async ({ page }) => {
  await open(page);
  await install(page);
  await page.evaluate(() => {
    const tabs = document.getElementById("tabs");
    const expanded = document.createElement("div");
    expanded.id = "expanded";
    expanded.setAttribute("data-browser-sidebar-chrome-expanded", "true");
    tabs.appendChild(expanded);
    const nested = tabs.cloneNode(true);
    nested.id = "nested-tabs";
    tabs.appendChild(nested);
    window.detachedTabs = nested;
  });
  await expect(page.locator("[data-codey-sidebar-expanded]")).toHaveCount(2);
  await page.evaluate(() => document.body.appendChild(document.getElementById("expanded")));
  await expect(page.locator("#tabs")).toHaveAttribute("data-codey-sidebar-expanded", "true");
  await page.evaluate(() => document.getElementById("nested-tabs").remove());
  await expect(page.locator("[data-codey-sidebar-expanded]")).toHaveCount(0);
  expect(await page.evaluate(() => window.detachedTabs.hasAttribute("data-codey-sidebar-expanded"))).toBe(false);
  await page.evaluate(() => document.getElementById("tabs").appendChild(document.getElementById("expanded")));
  await expect(page.locator("#tabs")).toHaveAttribute("data-codey-sidebar-expanded", "true");
  await page.evaluate(() => document.getElementById("tabs").setAttribute("data-app-shell-tabs", "false"));
  await expect(page.locator("[data-codey-sidebar-expanded]")).toHaveCount(0);
  await page.evaluate(() => document.getElementById("tabs").setAttribute("data-app-shell-tabs", "true"));
  await expect(page.locator("#tabs")).toHaveAttribute("data-codey-sidebar-expanded", "true");
  await page.evaluate(() => {
    window.__codeyRuntimeOptimizations.dispose();
    document.getElementById("tabs").appendChild(document.createElement("span"));
  });
  await expect(page.locator("[data-codey-sidebar-expanded]")).toHaveCount(0);
});

test("延迟加载的样式表可修复，跨域表保持原样且不影响清理", async ({ page }) => {
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await open(page, { css: false });
  await page.route("http://foreign.test/native.css", route => route.fulfill({ contentType: "text/css", body: nativeCss }));
  await page.evaluate(() => new Promise(resolve => {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = "http://foreign.test/native.css";
    link.onload = resolve;
    document.head.appendChild(link);
  }));
  expect(await page.evaluate(() => {
    try { document.styleSheets[0].cssRules; return false; }
    catch (error) { return error.name === "SecurityError"; }
  })).toBe(true);
  await install(page);
  await page.route("http://runtime.test/native.css", route => route.fulfill({ contentType: "text/css", body: nativeCss }));
  await page.evaluate(() => {
    const link = document.createElement("link");
    link.id = "native";
    link.rel = "stylesheet";
    link.href = "http://runtime.test/native.css";
    document.head.appendChild(link);
  });
  await expect.poll(() => page.evaluate(() => document.getElementById("native").sheet !== null)).toBe(true);
  await expect.poll(() => selectors(page)).not.toEqual(await page.evaluate(css => {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(css);
    return Array.from(sheet.cssRules, rule => rule.selectorText);
  }, nativeCss));
  expect(await regions(page)).toEqual(["no-drag", "none", "drag", "drag", "drag", "drag", "drag", "drag"]);
  await page.evaluate(() => window.__codeyRuntimeOptimizations.dispose());
  expect(errors).toEqual([]);
});

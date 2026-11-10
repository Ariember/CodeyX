import { expect, test } from "@playwright/test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../../public/conversation-stats-inject.js", import.meta.url));

test("统计浮层使用原生展开状态并避开宿主通用状态选择器", async ({ page }) => {
  await page.setContent(`<style>
    body:has([aria-expanded="true"]), body:has([data-state="stale"]) { --host-state: changed; }
  </style><main style="position:fixed;bottom:24px;left:24px;right:24px"><div data-above-composer-conversation-id="conversation-1"></div><textarea></textarea></main>`);
  await page.evaluate(() => {
    window.__codexSessionDeleteBridge = async () => ({ status: "ok", stats: { totalTokens: 100 } });
  });
  await page.addScriptTag({ path: script });
  const trigger = page.locator(".codey-cs-activity-summary");
  const panel = page.getByRole("region", { name: "最近一轮统计", exact: true });
  const client = await page.context().newCDPSession(page);
  const expanded = async () => {
    const { nodes } = await client.send("Accessibility.getFullAXTree");
    const button = nodes.find(node => node.role?.value === "button" && node.name?.value.includes("最近一轮统计"));
    return button?.properties.find(property => property.name === "expanded")?.value.value;
  };
  try {
    await expect(trigger).toBeVisible();
    await expect.poll(expanded).toBe(false);
    await trigger.click();
    await expect(panel).toBeVisible();
    await expect.poll(expanded).toBe(true);
    await expect(trigger).not.toHaveAttribute("aria-expanded");
    expect(await page.evaluate(() => getComputedStyle(document.body).getPropertyValue("--host-state"))).toBe("");
    await page.keyboard.press("Escape");
    await expect(panel).toBeHidden();
    await expect.poll(expanded).toBe(false);
    await expect(trigger).toBeFocused();
  } finally {
    await client.detach();
  }
});

test("统计浮层放大窗口后仍贴近入口，滚动缩放合并到一帧并可清理", async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 360 });
  await page.setContent(`<main style="position:fixed;bottom:24px;left:24px;right:24px">
    <div data-above-composer-conversation-id="conversation-1"></div><textarea></textarea>
  </main>`);
  await page.evaluate(() => {
    window.__codexSessionDeleteBridge = async () => ({
      status: "ok", stats: { totalTokens: 100 },
      codegraph: { phase: "watching", projectPath: `E:/${"long-project-directory/".repeat(30)}`, message: "项目索引已接入" },
    });
  });
  await page.addScriptTag({ path: script });
  const trigger = page.locator(".codey-cs-codegraph-summary");
  await trigger.click();
  const panel = page.getByRole("region", { name: "CodeGraph 代码索引", exact: true });
  await expect(panel).toBeVisible();
  await panel.evaluate(element => {
    window.panelGaps = [];
    window.panelPositionObserver = new MutationObserver(() => {
      const anchor = document.querySelector(".codey-cs-codegraph-summary").getBoundingClientRect();
      window.panelGaps.push(Math.round(anchor.top - element.getBoundingClientRect().bottom));
    });
    window.panelPositionObserver.observe(element, { attributes: true, attributeFilter: ["style"] });
  });
  await page.setViewportSize({ width: 800, height: 800 });
  await expect.poll(async () => {
    const [anchor, box] = await Promise.all([trigger.boundingBox(), panel.boundingBox()]);
    return Math.round(anchor.y - box.y - box.height);
  }).toBe(8);
  const gaps = await page.evaluate(() => {
    window.panelPositionObserver.disconnect();
    return window.panelGaps;
  });
  expect(gaps.length).toBeGreaterThan(0);
  expect(gaps.every(gap => gap === 8), `每次定位都应贴近入口，实际间距：${gaps}`).toBe(true);

  const measurements = await page.evaluate(async () => {
    const refs = document.getElementById("codey-conversation-stats").__codeyCs;
    const panel = refs.panels.codegraph;
    const original = panel.getBoundingClientRect;
    let reads = 0;
    panel.getBoundingClientRect = function () { reads += 1; return original.call(this); };
    try {
      // 内部滚动不会改变浮层的锚点；外部事件只需使用本帧最终布局。
      for (let index = 0; index < 20; index += 1) panel.dispatchEvent(new Event("scroll"));
      await new Promise(requestAnimationFrame);
      const internal = reads;
      reads = 0;
      for (let index = 0; index < 20; index += 1) {
        document.dispatchEvent(new Event("scroll"));
        window.dispatchEvent(new Event("resize"));
      }
      const synchronous = reads;
      await new Promise(requestAnimationFrame);
      const frame = reads;
      reads = 0;
      window.dispatchEvent(new Event("resize"));
      window.__codeyConversationStats.dispose();
      await new Promise(requestAnimationFrame);
      return { internal, synchronous, frame, afterDispose: reads };
    } finally {
      panel.getBoundingClientRect = original;
    }
  });
  expect(measurements).toEqual({ internal: 0, synchronous: 0, frame: 1, afterDispose: 0 });
  await expect(panel).toHaveCount(0);
});

test("changing statistics preserves text nodes without structural mutations", async ({ page }) => {
  await page.setContent('<main><div data-above-composer-conversation-id="conversation-1"></div><textarea></textarea></main>');
  await page.evaluate(() => {
    window.statsResponse = { status: "ok", stats: { totalTokens: 100 } };
    window.__codexSessionDeleteBridge = async () => window.statsResponse;
  });
  await page.addScriptTag({ path: script });
  const total = page.locator(".codey-cs-total");
  await expect(total).toHaveText("100 tok");
  await page.evaluate(() => {
    const refs = document.getElementById("codey-conversation-stats").__codeyCs;
    window.totalTextNode = refs.total.firstChild;
    window.statsMutations = [];
    const observer = new MutationObserver(records => window.statsMutations.push(...records.map(record => record.type)));
    for (const root of [refs.total, refs.fields.totalTokens]) {
      observer.observe(root, { childList: true, characterData: true, subtree: true });
    }
    window.statsResponse = { status: "ok", stats: { totalTokens: 200 } };
    window.__codeyConversationStats.refresh();
  });
  await expect(total).toHaveText("200 tok");
  await expect(page.locator('[data-field="totalTokens"]')).toHaveText("200 tok");
  expect(await total.evaluate(element => element.firstChild === window.totalTextNode)).toBe(true);
  expect(await page.evaluate(() => window.statsMutations)).toEqual(["characterData", "characterData"]);

  await page.evaluate(async () => {
    window.statsMutations = [];
    await new Promise(resolve => {
      window.__codexSessionDeleteBridge = async () => { setTimeout(resolve, 0); return window.statsResponse; };
      window.__codeyConversationStats.refresh();
    });
  });
  expect(await page.evaluate(() => window.statsMutations)).toEqual([]);

  for (const content of ["", "<strong>old</strong>", "old<span>content</span>"]) {
    await total.evaluate((element, html) => { element.innerHTML = html; }, content);
    await page.evaluate(() => window.__codeyConversationStats.refresh());
    await expect(total).toHaveText("200 tok");
    expect(await total.evaluate(element => element.childNodes.length === 1 && element.firstChild.nodeType === Node.TEXT_NODE)).toBe(true);
  }
  await page.evaluate(() => window.__codeyConversationStats.dispose());
});

for (const theme of ["light", "dark"]) {
  test(`会话状态条 ${theme} 主题可打开详情、键盘关闭并适应窄屏`, async ({ page }) => {
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.setContent(`<html class="${theme}" style="color-scheme:${theme}"><body style="margin:24px;font-family:system-ui;background:${theme === "dark" ? "#181818" : "#fff"}"><main style="max-width:720px;margin:320px auto 0"><div data-above-composer-conversation-id="11111111-1111-4111-8111-111111111111"></div><textarea aria-label="消息" style="box-sizing:border-box;width:100%;height:100px;border-radius:16px;padding:16px">继续完善当前功能</textarea></main></body></html>`);
    await page.evaluate(() => {
      window.__codexSessionDeleteBridge = async () => ({ status: "ok", stats: {
        usageSource: "rollout", usageScope: "session", turnCount: 8,
        totalTokens: 125000, inputTokens: 100000, outputTokens: 25000, cachedInputTokens: 75000,
        lastTurn: { id: "turn-a", status: "completed", stepCount: 3,
          modelDurationMs: 24500, toolDurationMs: 8000, averageTtftMs: 700,
          averageOutputTokensPerSecond: 85, coverage: "runtime", speedIsEstimate: false },
      }, codegraph: { projectPath: "E:/projects/current-project", phase: "watching", message: "项目索引已接入，代码变化会自动同步。" } });
    });
    await page.addScriptTag({ path: script });
    const bar = page.locator("#codey-conversation-stats");
    await expect(bar).toContainText("8 轮 · 3 步");
    await expect(bar).toContainText("125k tok");
    await expect(bar).toContainText("75%");
    await expect(bar).toContainText("CodeGraph 已接入");
    const activity = bar.locator(".codey-cs-activity-summary");
    await activity.focus();
    await activity.press("Enter");
    const detail = page.getByRole("region", { name: "最近一轮统计", exact: true });
    await expect(detail).toBeVisible();
    await expect(detail).toContainText("24.5秒");
    await page.screenshot({ path: `output/playwright/conversation-stats-${theme}.png` });
    await page.keyboard.press("Escape");
    await expect(detail).not.toBeVisible();
    await expect(activity).toBeFocused();
    await page.setViewportSize({ width: 375, height: 667 });
    await bar.locator(".codey-cs-tokens-summary").click();
    const tokens = page.getByRole("region", { name: "Token 用量", exact: true });
    await expect(tokens).toBeVisible();
    const box = await tokens.boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(375);
    await expect(tokens.locator('[data-field="uncachedInputTokens"]')).toHaveText("25,000 tok");
    await page.screenshot({ path: `output/playwright/conversation-stats-${theme}-narrow.png` });
    const codegraph = bar.locator(".codey-cs-codegraph-summary");
    await codegraph.focus();
    await codegraph.press("Enter");
    const project = page.getByRole("region", { name: "CodeGraph 代码索引", exact: true });
    await expect(project).toBeVisible();
    await expect(project).toContainText("E:/projects/current-project");
    await expect(project).toContainText("代码变化会自动同步");
    const projectBox = await project.boundingBox();
    expect(projectBox.x).toBeGreaterThanOrEqual(0);
    expect(projectBox.x + projectBox.width).toBeLessThanOrEqual(375);
    await page.screenshot({ path: `output/playwright/conversation-codegraph-${theme}-narrow.png` });
    await page.keyboard.press("Escape");
    await expect(project).not.toBeVisible();
    await expect(codegraph).toBeFocused();
    await page.evaluate(() => window.__codeyConversationStats.dispose());
    await expect(bar).toHaveCount(0);
    expect(errors).toEqual([]);
  });
}

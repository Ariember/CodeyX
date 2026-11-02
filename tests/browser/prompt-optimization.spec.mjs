import { expect, test as base } from "@playwright/test";
import { fileURLToPath } from "node:url";

const test = base.extend({
  page: async ({ page }, use) => {
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await use(page);
    expect(errors, "提示词优化不应出现未捕获异常").toEqual([]);
  },
});

async function openSettings(page) {
  await page.goto("/codey/tests/ui-browser.html?platform=windows");
  await expect(page.getByRole("button", { name: "已保存", exact: true })).toBeVisible({ timeout: 60_000 });
  await page.evaluate(() => {
    const bridge = window.__codexSessionDeleteBridge;
    const state = window.promptBehavior = { calls: [], pending: [] };
    window.__codexSessionDeleteBridge = (path, args) => {
      if (!/\/(fetch_prompt_optimization_models|test_prompt_optimization)$/.test(path)) return bridge(path, args);
      state.calls.push({ path, config: structuredClone(args.config) });
      return new Promise(resolve => state.pending.push(resolve));
    };
  });
  await page.getByRole("button", { name: "提示词优化", exact: true }).click();
}

test("共享观察器接收输入框文本变化并更新优化按钮", async ({ page }) => {
  await page.setContent(`<main style="margin:200px 40px 0;width:600px">
    <div data-above-composer-conversation-id="test-session"></div>
    <div id="composer" contenteditable="true" role="textbox" style="min-height:80px">initial</div>
    <div style="display:flex;gap:12px"><button>完全访问</button><button>发送</button></div>
  </main>`);
  await page.evaluate(() => {
    window.__codexSessionDeleteBridge = async () => ({ promptOptimization: { enabled: true, mode: "codeyRoute" } });
  });
  for (const name of ["codey-bridge", "prompt-optimize"]) {
    await page.addScriptTag({ path: fileURLToPath(new URL(`../../public/${name}.js`, import.meta.url)) });
  }
  const button = page.locator("#codey-prompt-optimize-button");
  await expect(button).toBeVisible();
  await expect(button).toBeEnabled();
  await page.locator("#composer").evaluate(element => { element.firstChild.nodeValue = ""; });
  await expect(button).toBeDisabled();
  await page.locator("#composer").evaluate(element => { element.firstChild.nodeValue = "updated"; });
  await expect(button).toBeEnabled();
});

async function complete(page, index, response) {
  await page.evaluate(({ index, response }) => window.promptBehavior.pending[index](response), { index, response });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

test("路由模型点击整行展开且只能从列表选择，支持键盘并保存选择", async ({ page }) => {
  await openSettings(page);
  const label = "提示词优化 CodeyX 路由模型";
  const model = page.getByRole("button", { name: new RegExp(label) });
  await expect(page.getByRole("combobox", { name: label, exact: true })).toHaveCount(0);
  await model.click({ position: { x: 18, y: 16 } });
  const list = page.getByRole("listbox", { name: new RegExp(label) });
  await expect(list).toBeVisible();
  const option = list.locator('[role="option"]:not([aria-selected="true"])').first();
  const selectedLabel = await option.innerText();
  const selectedValue = await option.getAttribute("data-key");
  await page.screenshot({ path: "output/playwright/model-picker-open.png", fullPage: true });
  await option.click();
  await expect(list).not.toBeVisible();
  await expect(model).toContainText(selectedLabel);
  await expect(model).toBeFocused();
  await model.press("Space");
  await expect(list).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(list).not.toBeVisible();
  await expect(model).toBeFocused();
  await model.press("ArrowDown");
  await expect(list).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(list).not.toBeVisible();
  await page.getByRole("button", { name: "保存更改", exact: true }).click();
  await expect(page.getByRole("button", { name: "已保存", exact: true })).toBeDisabled();
  const stored = await page.evaluate(async () => (await window.__codexSessionDeleteBridge("/api/load_codey_config", {})).config);
  expect(stored.promptOptimization.model).toBe(selectedValue);
});

test("手动配置作废旧目录，重新获取采用当前草稿，跨页保留模型和指令", async ({ page }) => {
  await openSettings(page);
  await page.getByRole("tab", { name: "手动配置", exact: true }).click();
  const url = page.getByRole("textbox", { name: "API 地址", exact: true });
  const fetchModels = page.getByRole("button", { name: "获取列表", exact: true });
  await fetchModels.click();
  await expect(fetchModels).toBeDisabled();
  await url.fill("https://new.example.com/v1");
  await complete(page, 0, { models: ["obsolete-model"] });
  await expect(fetchModels).toBeEnabled();
  await expect(page.getByText("已获取 1 个模型", { exact: true })).not.toBeVisible();
  await fetchModels.click();
  expect(await page.evaluate(() => window.promptBehavior.calls[1].config.baseUrl)).toBe("https://new.example.com/v1");
  await complete(page, 1, { models: ["fresh-model"] });
  await expect(page.getByText("已获取 1 个模型", { exact: true })).toBeVisible();
  const model = page.getByRole("combobox", { name: "提示词优化模型", exact: true });
  await model.fill("fresh-model");
  await model.press("Escape");
  const instruction = page.getByRole("textbox", { name: "优化指令", exact: true });
  await instruction.fill("保留这一份未保存的提示词草稿");
  await page.getByRole("button", { name: "基础功能", exact: true }).click();
  await page.getByRole("button", { name: "提示词优化", exact: true }).click();
  await expect(model).toHaveValue("fresh-model");
  await expect(instruction).toHaveValue("保留这一份未保存的提示词草稿");
  await page.getByRole("button", { name: "测试 API 连通性", exact: true }).click();
  expect(await page.evaluate(() => window.promptBehavior.calls[2].config)).toMatchObject({
    baseUrl: "https://new.example.com/v1", model: "fresh-model", instruction: "保留这一份未保存的提示词草稿",
  });
  await complete(page, 2, { result: { httpStatus: 503, responsePreview: "测试服务暂不可用" } });
  await expect(page.getByText("连接失败（HTTP 503）：测试服务暂不可用", { exact: true })).toBeVisible();
  await expect(instruction).toHaveValue("保留这一份未保存的提示词草稿");
});

test("切页重开保留在途测试锁，旧成功不弹提示，显式重试展示当前结果", async ({ page }) => {
  await openSettings(page);
  const testConnection = page.getByRole("button", { name: "测试路由连通性", exact: true });
  await testConnection.click();
  await page.getByRole("button", { name: "基础功能", exact: true }).click();
  await page.getByRole("button", { name: "提示词优化", exact: true }).click();
  await expect(testConnection).toBeDisabled();
  expect(await page.evaluate(() => window.promptBehavior.calls.length)).toBe(1);
  await complete(page, 0, { result: { httpStatus: 200 } });
  await expect(testConnection).toBeEnabled();
  await expect(page.getByText("连接成功（HTTP 200）", { exact: true })).not.toBeVisible();
  await testConnection.click();
  await complete(page, 1, { result: { httpStatus: 200 } });
  await expect(page.getByText("连接成功（HTTP 200）", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.promptBehavior.calls.length)).toBe(2);
});

test("关闭设置后迟到的测试错误保持静默，重新打开不自动重放", async ({ page }) => {
  await openSettings(page);
  await page.getByRole("button", { name: "测试路由连通性", exact: true }).click();
  await page.getByRole("button", { name: "关闭配置", exact: true }).click();
  await complete(page, 0, { status: "failed", message: "测试：过期连接错误" });
  await expect(page.getByText("测试：过期连接错误", { exact: true })).not.toBeVisible();
  await page.getByRole("button", { name: "打开内嵌设置", exact: true }).click();
  await page.getByRole("button", { name: "提示词优化", exact: true }).click();
  await expect(page.getByRole("button", { name: "测试路由连通性", exact: true })).toBeEnabled();
  expect(await page.evaluate(() => window.promptBehavior.calls.length)).toBe(1);
  await expect(page.getByText("测试：过期连接错误", { exact: true })).not.toBeVisible();
});

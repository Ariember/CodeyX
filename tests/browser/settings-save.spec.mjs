import { expect, test as base } from "@playwright/test";

const test = base.extend({
  page: async ({ page }, use) => {
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await use(page);
    expect(errors, "浏览器不应出现未捕获异常").toEqual([]);
  },
});

async function openSettings(page, mode = "normal") {
  await page.goto("/codey/tests/ui-browser.html?platform=windows");
  // Cold Vite starts also compile the dynamically imported overlay and its styles.
  await expect(page.getByRole("button", { name: "已保存", exact: true })).toBeVisible({ timeout: 60_000 });
  // Replace only the mocked backend boundary; the React tree and bridge stay real.
  await page.evaluate(mode => {
    const bridge = window.__codexSessionDeleteBridge;
    const state = window.settingsBehavior = { saves: [], changes: [], mode };
    window.addEventListener("codey:config-changed", event => {
      state.changes.push(structuredClone(event.detail.config));
    });
    window.__codexSessionDeleteBridge = async (path, args) => {
      if (path.endsWith("/runtime_status") && state.application) {
        return { ...await bridge(path, args), configApply: state.application,
          restartRequired: state.application.phase === "restart_required" };
      }
      if (path.endsWith("/load_codey_config") && state.deferNextRead) {
        state.deferNextRead = false;
        const result = await bridge(path, args);
        await new Promise(resolve => { state.releaseRead = resolve; });
        return result;
      }
      if (!path.endsWith("/save_codey_config")) return bridge(path, args);
      state.saves.push(structuredClone(args.config));
      if (state.mode === "pending") {
        await new Promise(resolve => { state.release = resolve; });
      }
      if (state.mode === "conflict") {
        state.mode = "normal";
        const { config } = await bridge("/api/load_codey_config", {});
        const external = await bridge(path, { config: { ...config, streamMaxRetries: config.streamMaxRetries + 1 } });
        state.externalRevision = external.config.settingsRevision;
        return { status: "failed", message: "Codey 设置已被其他操作更新，请关闭后重新打开设置页面再保存" };
      }
      const result = await bridge(path, args);
      if (state.mode === "background") {
        state.application = { settingsRevision: result.config.settingsRevision, phase: "pending" };
        return { config: result.config, fastContextToolsStatus: result.fastContextToolsStatus, configApply: state.application };
      }
      if (state.mode === "apply-failed") {
        return { ...result, routeRequestLogHealth: "failed", routeRequestLogHotReloadError: "测试：日志写入器暂时不可用" };
      }
      return result;
    };
  }, mode);
  await page.getByRole("button", { name: "线路与模型", exact: true }).click();
  const toggle = page.getByRole("switch", { name: "开启请求日志记录", exact: true });
  await expect(toggle).toBeChecked();
  return toggle;
}

async function storedConfig(page) {
  return page.evaluate(async () => {
    const { config } = await window.__codexSessionDeleteBridge("/api/load_codey_config", {});
    return { revision: config.settingsRevision, logging: config.routeRequestLog.enabled, retries: config.streamMaxRetries };
  });
}

async function reopenSettings(page) {
  await page.getByRole("button", { name: "打开内嵌设置", exact: true }).click();
  await expect(page.getByRole("button", { name: "已保存", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "线路与模型", exact: true }).click();
}

test("关闭设置移除宿主，重开复用内容且不会被旧关闭回调隐藏", async ({ page }) => {
  await openSettings(page);
  await page.evaluate(() => {
    window.savedOverlayHost = document.getElementById("codey-settings-overlay-host");
    window.__codeySettingsOverlay.close();
  });
  await expect(page.locator("#codey-settings-overlay-host")).toHaveCount(0);
  await reopenSettings(page);
  expect(await page.evaluate(() => document.getElementById("codey-settings-overlay-host") === window.savedOverlayHost)).toBe(true);
  await page.evaluate(async () => {
    window.__codeySettingsOverlay.close();
    window.__codeySettingsOverlay.open();
    await new Promise(resolve => setTimeout(resolve, 500));
  });
  await expect(page.locator("#codey-settings-overlay-host")).toBeVisible();
  await expect(page.getByRole("button", { name: "关闭配置", exact: true })).toBeVisible();
});

test("草稿跨页面保留，保存等待期间禁止重复操作，完成后重新打开仍为已保存值", async ({ page }) => {
  const toggle = await openSettings(page, "pending");
  const before = await storedConfig(page);
  await toggle.focus();
  await toggle.press("Space");
  await expect(toggle).not.toBeChecked();
  expect(await storedConfig(page)).toEqual(before);

  await page.getByRole("button", { name: "基础功能", exact: true }).click();
  await page.getByRole("button", { name: "线路与模型", exact: true }).click();
  await expect(toggle).not.toBeChecked();
  const save = page.getByRole("button", { name: "保存更改", exact: true });
  await save.click();
  await expect(save).toBeDisabled();
  await expect(page.getByRole("button", { name: "关闭配置", exact: true })).toBeDisabled();
  await expect.poll(() => page.evaluate(() => window.settingsBehavior.saves.length)).toBe(1);
  expect(await storedConfig(page)).toEqual(before);
  await page.evaluate(() => window.settingsBehavior.release());

  await expect(page.getByRole("button", { name: "已保存", exact: true })).toBeDisabled();
  expect(await storedConfig(page)).toEqual({ ...before, revision: before.revision + 1, logging: false });
  expect(await page.evaluate(() => window.settingsBehavior.changes.length)).toBe(1);
  await page.getByRole("button", { name: "关闭配置", exact: true }).click();
  await reopenSettings(page);
  await expect(toggle).not.toBeChecked();
  expect(await page.evaluate(() => window.settingsBehavior.saves.length)).toBe(1);
});

test("版本冲突保留草稿，取消关闭可继续编辑，放弃并重开后使用最新版本保存", async ({ page }) => {
  const toggle = await openSettings(page, "conflict");
  const before = await storedConfig(page);
  await toggle.focus();
  await toggle.press("Space");
  await page.getByRole("button", { name: "保存更改", exact: true }).click();
  await expect(page.getByText("Codey 设置已被其他操作更新，请关闭后重新打开设置页面再保存", { exact: true })).toBeVisible();
  await expect(toggle).not.toBeChecked();
  await expect(page.getByRole("button", { name: "保存更改", exact: true })).toBeEnabled();
  expect(await storedConfig(page)).toEqual({ ...before, revision: before.revision + 1, retries: before.retries + 1 });
  expect(await page.evaluate(() => window.settingsBehavior.changes.length)).toBe(0);

  await page.getByRole("button", { name: "关闭配置", exact: true }).click();
  const confirmation = page.getByRole("dialog", { name: "放弃未保存的更改？" });
  await confirmation.getByRole("button", { name: "取消", exact: true }).click();
  await expect(confirmation).not.toBeVisible();
  await expect(toggle).not.toBeChecked();
  await page.getByRole("button", { name: "关闭配置", exact: true }).click();
  await confirmation.getByRole("button", { name: "放弃更改并关闭", exact: true }).click();
  await reopenSettings(page);
  await expect(toggle).toBeChecked();
  await toggle.focus();
  await toggle.press("Space");
  await page.getByRole("button", { name: "保存更改", exact: true }).click();
  await expect(page.getByRole("button", { name: "已保存", exact: true })).toBeDisabled();
  expect(await page.evaluate(() => window.settingsBehavior.saves.map(config => config.settingsRevision))).toEqual([before.revision, before.revision + 1]);
  expect(await storedConfig(page)).toEqual({ revision: before.revision + 2, logging: false, retries: before.retries + 1 });
});

test("配置已保存但热更新失败时保留已保存状态并显示生效失败原因", async ({ page }) => {
  const toggle = await openSettings(page, "apply-failed");
  const before = await storedConfig(page);
  await toggle.focus();
  await toggle.press("Space");
  await page.getByRole("button", { name: "保存更改", exact: true }).click();
  await expect(page.getByText("CodeyX 设置已保存；测试：日志写入器暂时不可用", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "已保存", exact: true })).toBeDisabled();
  expect(await storedConfig(page)).toEqual({ ...before, revision: before.revision + 1, logging: false });
  expect(await page.evaluate(() => window.settingsBehavior.changes.length)).toBe(1);
  await page.getByRole("button", { name: "关闭配置", exact: true }).click();
  await reopenSettings(page);
  await expect(toggle).not.toBeChecked();
  expect(await page.evaluate(() => window.settingsBehavior.saves.length)).toBe(1);
});

test("重新打开时迟到的配置刷新合并新草稿，不覆盖用户刚修改的字段", async ({ page }) => {
  const toggle = await openSettings(page);
  const before = await storedConfig(page);
  await page.getByRole("button", { name: "关闭配置", exact: true }).click();
  await page.evaluate(async () => {
    const bridge = window.__codexSessionDeleteBridge;
    const { config } = await bridge("/api/load_codey_config", {});
    await bridge("/api/save_codey_config", { config: { ...config, streamMaxRetries: config.streamMaxRetries + 1 } });
    window.settingsBehavior.deferNextRead = true;
  });
  await reopenSettings(page);
  await expect.poll(() => page.evaluate(() => typeof window.settingsBehavior.releaseRead)).toBe("function");
  await toggle.focus();
  await toggle.press("Space");
  await expect(toggle).not.toBeChecked();
  await page.evaluate(() => window.settingsBehavior.releaseRead());
  // Wait for the Promise chain and React commit, without an arbitrary wall-clock sleep.
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await expect(toggle).not.toBeChecked();
  await page.getByRole("button", { name: "保存更改", exact: true }).click();
  await expect(page.getByRole("button", { name: "已保存", exact: true })).toBeDisabled();
  expect(await page.evaluate(() => window.settingsBehavior.saves.at(-1).settingsRevision)).toBe(before.revision + 1);
  expect(await storedConfig(page)).toEqual({ revision: before.revision + 2, logging: false, retries: before.retries + 1 });
});

test("后台应用期间可以连续保存和关闭，重开后显示应用失败且不丢失草稿", async ({ page }) => {
  const toggle = await openSettings(page, "background");
  const before = await storedConfig(page);
  await toggle.press("Space");
  await page.getByRole("button", { name: "保存更改", exact: true }).click();
  await expect(page.getByText("CodeyX 设置已保存，正在后台应用，可继续修改", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "关闭配置", exact: true })).toBeEnabled();
  await toggle.press("Space");
  await page.getByRole("button", { name: "保存更改", exact: true }).click();
  await expect(page.getByRole("button", { name: "已保存", exact: true })).toBeDisabled();
  expect(await storedConfig(page)).toEqual({ ...before, revision: before.revision + 2 });
  await page.getByRole("button", { name: "关闭配置", exact: true }).click();
  await page.evaluate(() => {
    window.settingsBehavior.application = { ...window.settingsBehavior.application,
      phase: "failed", applyError: "测试：后台应用失败，配置仍已保存" };
  });
  await reopenSettings(page);
  await expect(page.getByText("CodeyX 设置已保存；测试：后台应用失败，配置仍已保存", { exact: true })).toBeVisible();
  await expect(toggle).toBeChecked();
  await toggle.press("Space");
  await expect(page.getByRole("button", { name: "保存更改", exact: true })).toBeEnabled();
  expect(await storedConfig(page)).toEqual({ ...before, revision: before.revision + 2 });
  expect(await page.evaluate(() => window.settingsBehavior.saves.length)).toBe(2);
});

test("后台应用完成后更新需重启提示", async ({ page }) => {
  const toggle = await openSettings(page, "background");
  await toggle.press("Space");
  await page.getByRole("button", { name: "保存更改", exact: true }).click();
  await expect(page.getByText("CodeyX 设置已保存，正在后台应用，可继续修改", { exact: true })).toBeVisible();
  await page.evaluate(() => {
    window.settingsBehavior.application = { ...window.settingsBehavior.application, phase: "restart_required", restartRequired: true };
  });
  await expect(page.getByText("CodeyX 设置已保存，启动参数将在重启 Codex 后生效", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "已保存", exact: true })).toBeDisabled();
});

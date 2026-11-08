import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

const sources = ["codey-bridge.js", "codex-runtime-adapter.js", "codey-inject.js"].map(name => (
  readFileSync(new URL(`../../public/${name}`, import.meta.url), "utf8")
));

test("菜单和侧栏变化不触发 Git 状态查询，导航和工具栏重挂仍生效", async ({ page }) => {
  await page.setContent('<aside data-app-action-sidebar-section></aside><main><div id="toolbar"><button id="anchor">发送</button></div></main>');
  await page.evaluate(() => {
    const fixture = window.fixture = { sessionId: "session-a", contextReads: 0, statusCalls: [] };
    window.__codeyPromptOptimize = { composerContext: () => {
      fixture.contextReads += 1;
      return { sessionId: fixture.sessionId, target: {
        host: document.getElementById("toolbar"), anchor: document.getElementById("anchor"),
      } };
    } };
    window.__codexSessionDeleteBridge = async path => {
      if (path === "/settings/get") return { conversationGit: { enabled: true } };
      fixture.statusCalls.push(fixture.sessionId);
      return { visible: true };
    };
  });
  for (const name of ["codey-bridge", "conversation-git"]) {
    await page.addScriptTag({ content: readFileSync(new URL(`../../public/${name}.js`, import.meta.url), "utf8") });
  }
  const button = page.locator("#codey-conversation-git");
  await expect(button).toBeVisible();
  // Let the initial mounting frame and its own mutation records finish.
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const result = await page.evaluate(async () => {
    const fixture = window.fixture;
    fixture.contextReads = 0;
    const before = fixture.statusCalls.length;
    const menu = document.createElement("div"); menu.setAttribute("role", "menu"); document.body.append(menu);
    for (let index = 0; index < 40; index += 1) {
      menu.replaceChildren(document.createElement("button"));
      document.querySelector("aside").replaceChildren(document.createElement("span"));
      await new Promise(requestAnimationFrame);
    }
    return { contextReads: fixture.contextReads, statusCalls: fixture.statusCalls.length - before };
  });
  expect(result).toEqual({ contextReads: 0, statusCalls: 0 });
  await page.evaluate(() => {
    window.fixture.sessionId = "session-b";
    document.getElementById("toolbar").setAttribute("data-above-composer-conversation-id", "session-b");
  });
  await expect.poll(() => page.evaluate(() => window.fixture.statusCalls.at(-1))).toBe("session-b");
  await button.evaluate(element => element.remove());
  await expect(button).toBeVisible();
});

test("共享观察器调整订阅时保留待派发变更，最后退订后停止观察", async ({ page }) => {
  await page.setContent('<main><div id="composer"></div></main>');
  await page.addScriptTag({ content: sources[0] });
  const result = await page.evaluate(async () => {
    const dispatcher = window.__codeyMutationDispatcher;
    const changes = [];
    const stop = dispatcher.subscribe(records => {
      changes.push(...records.map(record => record.attributeName));
    }, { attributes: true, attributeFilter: ["data-session", "data-state"] });
    const composer = document.getElementById("composer");
    composer.setAttribute("data-session", "first");
    const stopTemporary = dispatcher.subscribe(() => {}, { childList: true });
    await Promise.resolve();
    composer.setAttribute("data-state", "ready");
    stopTemporary();
    await Promise.resolve();
    stop();
    composer.setAttribute("data-session", "second");
    await Promise.resolve();
    return { changes, installed: dispatcher.snapshot().observerInstalled };
  });
  expect(result).toEqual({ changes: ["data-session", "data-state"], installed: false });
});

test("侧栏悬浮与会话切换合并布局读取，不阻塞 DOM 观察器", async ({ page }) => {
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.setContent(`
    <aside data-app-action-sidebar-section>
      <div data-app-action-sidebar-thread-row data-app-action-sidebar-thread-id="local:session-a"
           data-app-action-sidebar-thread-title="测试会话">
        测试会话<button aria-label="Archive">归档</button>
      </div>
    </aside>
    <main><div data-above-composer-conversation-id="session-a" style="height:24px"></div></main>
  `);
  await page.evaluate(() => {
    const fixture = window.fixture = {
      reconciled: [], observerDeliveries: 0, observerLayoutReads: 0, layoutReads: 0,
    };
    let inObserver = false;
    const Observer = window.MutationObserver;
    window.MutationObserver = class extends Observer {
      constructor(callback) {
        super((records, observer) => {
          fixture.observerDeliveries += 1;
          inObserver = true;
          try { callback(records, observer); }
          finally { inObserver = false; }
        });
      }
    };
    const getClientRects = Element.prototype.getClientRects;
    Element.prototype.getClientRects = function () {
      if (this.hasAttribute("data-above-composer-conversation-id")) {
        fixture.layoutReads += 1;
        if (inObserver) fixture.observerLayoutReads += 1;
      }
      return getClientRects.call(this);
    };
    window.__codexSessionDeleteBridge = async () => ({ status: "ok", timestamps: {} });
    window.__codeyCodexSessionController = {
      kind: "manager",
      async reconcileCompletedConversation({ conversationId }) {
        fixture.reconciled.push(conversationId);
        return true;
      },
    };
  });
  for (const content of sources) await page.addScriptTag({ content });
  await expect.poll(() => page.evaluate(() => window.fixture.reconciled)).toEqual(["session-a"]);

  const burst = await page.evaluate(async () => {
    const fixture = window.fixture;
    fixture.layoutReads = 0;
    const before = fixture.observerDeliveries;
    const row = document.querySelector("[data-app-action-sidebar-thread-row]");
    // Separate microtasks exercise actual Chromium observer delivery before timers run.
    for (let index = 0; index < 40; index += 1) {
      row.classList.toggle("hovered", index % 2 === 0);
      await Promise.resolve();
    }
    for (const sessionId of ["session-b", "session-c"]) {
      const composer = document.querySelector("[data-above-composer-conversation-id]");
      const replacement = composer.cloneNode();
      replacement.setAttribute("data-above-composer-conversation-id", sessionId);
      composer.replaceWith(replacement);
      await Promise.resolve();
    }
    return { deliveries: fixture.observerDeliveries - before, layoutReads: fixture.layoutReads };
  });
  expect(burst.deliveries).toBeGreaterThanOrEqual(40);
  expect(burst.layoutReads).toBe(0);
  await expect.poll(() => page.evaluate(() => window.fixture.reconciled)).toEqual(["session-a", "session-c"]);
  expect(await page.evaluate(() => window.fixture.observerLayoutReads)).toBe(0);
  expect(await page.evaluate(() => window.fixture.layoutReads)).toBeGreaterThan(0);
  expect(errors).toEqual([]);
});

test("模型菜单重复刷新不重写未变化的属性，原生重绘后仍可修复", async ({ page }) => {
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.setContent('<div role="menu"><div role="menuitemradio">relay/model</div></div>');
  await page.evaluate(() => {
    window.__codexSessionDeleteBridge = async () => ({
      status: "ok", models: ["relay/model"], default_model: "relay/model",
      model_metadata: [{
        model: "relay/model", display_name: "[中转] model", route_name: "中转线路",
        route_prefix: "中转", provider_id: "relay", source_model: "model",
      }],
    });
  });
  for (const name of ["codey-bridge", "model-request-gate", "model-whitelist-inject"]) {
    await page.addScriptTag({ content: readFileSync(new URL(`../../public/${name}.js`, import.meta.url), "utf8") });
  }
  await page.evaluate(async () => {
    await window.__codeyModelWhitelistPatch.refresh();
    window.__codeyModelWhitelistPatch.enhanceModelMenus();
  });
  const item = page.getByRole("menuitemradio");
  await expect(item).toHaveText("model");
  await expect(item).toHaveAttribute("aria-label", "中转线路 / model");
  const writes = await page.evaluate(() => {
    const observer = new MutationObserver(() => {});
    observer.observe(document.querySelector('[role="menu"]'), {
      attributes: true, childList: true, characterData: true, subtree: true,
    });
    for (let index = 0; index < 20; index += 1) window.__codeyModelWhitelistPatch.enhanceModelMenus();
    const count = observer.takeRecords().length;
    observer.disconnect();
    return count;
  });
  expect(writes).toBe(0);
  await item.evaluate(element => {
    element.removeAttribute("class");
    element.removeAttribute("aria-label");
    delete element.dataset.codeyRouteName;
    window.__codeyModelWhitelistPatch.enhanceModelMenus();
  });
  await expect(item).toHaveClass("codey-model-route-item");
  await expect(item).toHaveAttribute("aria-label", "中转线路 / model");
  await expect(item).toHaveAttribute("data-codey-route-name", "中转线路");
  await page.evaluate(() => window.__codeyModelWhitelistPatch.dispose());
  expect(errors).toEqual([]);
});

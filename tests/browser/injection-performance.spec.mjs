import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

const sources = ["codey-bridge.js", "codex-runtime-adapter.js", "codey-inject.js"].map(name => (
  readFileSync(new URL(`../../public/${name}`, import.meta.url), "utf8")
));

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

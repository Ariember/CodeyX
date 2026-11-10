import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

const sources = ["codex-runtime-adapter.js", "codey-inject.js"].map(name => (
  readFileSync(new URL(`../../public/${name}`, import.meta.url), "utf8")
));

test("批量项目导入按钮先统一测量再挂载，悬浮后按新位置更新", async ({ page }) => {
  await page.setContent(`<style>
    .project { position: relative; width: 248px; height: 32px; }
    .actions { position: absolute; right: 4px; top: 4px; display: flex; }
    .native-action { width: 24px; height: 24px; }
  </style><aside data-app-action-sidebar-section>
    ${Array.from({ length: 12 }, (_, index) => `
      <div class="project" data-app-action-sidebar-project-row data-app-action-sidebar-project-id="E:/workspace/project-${index}">
        项目 ${index}<div class="actions"><button class="native-action" aria-label="项目操作">+</button></div>
      </div>
    `).join("")}
  </aside>`);
  await page.evaluate(() => {
    window.__codexSessionDeleteBridge = async () => ({ status: "ok" });
    window.projectWork = [];
    const getClientRects = Element.prototype.getClientRects;
    Element.prototype.getClientRects = function () {
      if (this.getAttribute("aria-label") === "项目操作") window.projectWork.push("read");
      return getClientRects.call(this);
    };
    const appendChild = Node.prototype.appendChild;
    Node.prototype.appendChild = function (child) {
      if (child.hasAttribute?.("data-codey-project-import")) window.projectWork.push("write");
      return appendChild.call(this, child);
    };
  });
  for (const content of sources) await page.addScriptTag({ content });
  const buttons = page.locator("[data-codey-project-import]");
  await expect(buttons).toHaveCount(12);
  expect(await page.evaluate(() => window.projectWork)).toEqual([
    ...Array(12).fill("read"), ...Array(12).fill("write"),
  ]);
  await expect(buttons.first()).toHaveCSS("right", "32px");
  const project = page.locator(".project").first();
  await project.locator(".actions").evaluate(element => { element.style.right = "28px"; });
  await project.hover();
  await expect(buttons.first()).toHaveCSS("right", "56px");
});

test("侧边栏增强按钮在新旧原生操作容器内保持同行", async ({ page }, testInfo) => {
  await page.setContent(`
    <style>
      aside { width: 248px; }
      .thread { position: relative; height: 32px; }
      .thread-content { display: flex; height: 100%; width: 100%; align-items: center; }
      .thread-title { flex: 1; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
      .native-actions { position: absolute; right: 4px; top: 4px; display: flex; opacity: 0; }
      .thread:hover .native-actions, .thread:focus-within .native-actions { opacity: 1; }
      .native-action { display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 24px; padding: 4px; border: 0; }
      .native-action span { display: flex; }
    </style>
    <aside data-app-action-sidebar-section>
      ${["wrapped", "direct"].map(layout => `
        <div class="thread" data-layout="${layout}" data-app-action-sidebar-thread-row
             data-app-action-sidebar-thread-id="local:${layout}"
             data-app-action-sidebar-thread-title="侧边栏里的长会话标题">
          <div class="thread-content">
            <span class="thread-title">侧边栏里的长会话标题</span>
            <div class="native-actions">
              ${layout === "wrapped" ? "<span data-state='closed'>" : ""}
                <button class="native-action" aria-label="Archive"><span>□</span></button>
              ${layout === "wrapped" ? "</span>" : ""}
            </div>
          </div>
        </div>
      `).join("")}
    </aside>
  `);
  await page.evaluate(() => {
    window.__codexSessionDeleteBridge = async () => ({ status: "ok", timestamps: {} });
  });
  for (const content of sources) await page.addScriptTag({ content });

  for (const width of [248, 160]) {
    await page.locator("aside").evaluate((element, value) => { element.style.width = `${value}px`; }, width);
    for (const layout of ["wrapped", "direct"]) {
      const row = page.locator(`[data-layout="${layout}"]`);
      const actions = row.locator(".native-actions");
      await expect(actions.locator(":scope > [data-codey-session-export]")).toHaveCount(1);
      await expect(actions.locator(":scope > [data-codey-session-delete]")).toHaveCount(1);
      await row.hover();
      await expect(actions).toHaveCSS("opacity", "1");
      const boxes = await row.locator("button").evaluateAll(buttons => buttons.map(button => {
        const { x, y, width, height } = button.getBoundingClientRect();
        return { x, y, width, height };
      }));
      const bounds = await row.boundingBox();
      expect(boxes).toHaveLength(3);
      for (const box of boxes) {
        expect(box.y).toBe(bounds.y + 4);
        expect(box.height).toBe(24);
        expect(box.x).toBeGreaterThanOrEqual(bounds.x);
        expect(box.x + box.width).toBeLessThanOrEqual(bounds.x + bounds.width);
      }
      expect(boxes[0].x + boxes[0].width).toBeLessThanOrEqual(boxes[1].x);
      expect(boxes[1].x + boxes[1].width).toBeLessThanOrEqual(boxes[2].x);
      await expect(row.locator(".thread-content")).not.toHaveAttribute("data-codey-session-action-row");
    }
  }
  await page.evaluate(() => window.__codeySessionToolsInstall.dispose());
  for (const content of sources) await page.addScriptTag({ content });
  await expect(page.locator("[data-codey-session-export]")).toHaveCount(2);
  await expect(page.locator("[data-codey-session-delete]")).toHaveCount(2);
  await page.screenshot({ path: testInfo.outputPath("sidebar-actions.png") });
});

test("会话工具保留整段会话操作，不再为对话轮次添加选择和删除控件", async ({ page }) => {
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.setContent(`
    <aside data-app-action-sidebar-section>
      <div data-app-action-sidebar-thread-row data-app-action-sidebar-thread-id="local:fixture"
           data-app-action-sidebar-thread-title="会话测试">
        会话测试<button aria-label="Archive">归档</button>
      </div>
    </aside>
    <main id="conversation" data-session-id="fixture">
      <section data-turn-key="turn-1">第一轮</section>
      <section data-turn-key="turn-2" hidden>第二轮</section>
    </main>
  `);
  await page.evaluate(() => {
    window.fixture = { calls: [], deletes: 0 };
    window.__codexSessionDeleteBridge = async (path, payload) => {
      window.fixture.calls.push({ path, payload });
      return { status: "ok", timestamps: {} };
    };
    window.__codeyCodexSessionController = {
      kind: "manager",
      async reconcileCompletedConversation() { return false; },
    };
    document.querySelector("[data-app-action-sidebar-thread-row]").__reactFiber$fixture = {
      memoizedProps: {
        getItems: () => [{ id: "delete-thread", onSelect: () => { window.fixture.deletes += 1; } }],
      },
    };
  });
  for (const content of sources) await page.addScriptTag({ content });
  await expect(page.getByRole("button", { name: "导出会话数据", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "永久删除", exact: true })).toBeVisible();
  const removedControls = page.locator("#codey-message-toolbar, [data-codey-message-select], [data-codey-message-id]");
  await expect(removedControls).toHaveCount(0);

  await page.evaluate(() => {
    document.querySelector('[data-turn-key="turn-2"]').hidden = false;
    const turn = document.createElement("section");
    turn.dataset.turnKey = "turn-3";
    turn.textContent = "第三轮";
    document.querySelector("#conversation").appendChild(turn);
    document.querySelector("[data-app-action-sidebar-thread-row]")
      .setAttribute("data-app-action-sidebar-thread-title", "会话更新");
  });
  await expect.poll(() => page.evaluate(() => window.fixture.calls.some(call => (
    call.path === "/session/titles" && call.payload.titles.some(title => title.title === "会话更新")
  )))).toBe(true);
  await expect(removedControls).toHaveCount(0);
  await expect(page.locator("#conversation section")).toHaveText(["第一轮", "第二轮", "第三轮"]);
  await page.getByRole("button", { name: "永久删除", exact: true }).click();
  expect(await page.evaluate(() => window.fixture.deletes)).toBe(1);
  expect(await page.evaluate(() => window.fixture.calls.some(call => call.path === "/session/delete-messages"))).toBe(false);
  expect(errors).toEqual([]);
});

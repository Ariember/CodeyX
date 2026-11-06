import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const source = readFileSync(new URL("../src/components/ReleaseNotes.tsx", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
}).outputText.replace(/from "([^".][^"]*)"/g, (_match, specifier) => `from "${import.meta.resolve(specifier)}"`);
const { ReleaseNotes, releaseContentUrl, githubReleaseUrl } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
const releaseUrl = "https://github.com/Ariember/CodeyX/releases/tag/v1.0.1";
const render = (markdown, props = {}) => renderToStaticMarkup(React.createElement(ReleaseNotes, { markdown, releaseUrl, ...props }));

test("客户端完整渲染 Release 标题、GFM 列表、表格、代码和图片", () => {
  const html = render("## 本次亮点\n\n支持 **完整公告** 与 ~~旧文案~~。\n\n1. 第一项\n2. 第二项\n\n- [x] 已完成\n\n| 平台 | 状态 |\n| --- | --- |\n| Windows | 支持 |\n\n```js\nconst value = 1;\n```\n\n![功能截图](https://github.com/user-attachments/assets/example.png)\n\n[完整变更](https://github.com/Ariember/CodeyX/compare/v1.0.0...v1.0.1)", { title: "CodeyX v1.0.1 · 更新公告" });
  for (const pattern of [/CodeyX v1\.0\.1 · 更新公告/, /<h2[^>]*>本次亮点<\/h2>/, /<strong>完整公告<\/strong>/, /<del>旧文案<\/del>/, /<ol>/, /type="checkbox"/, /<table>/, /hljs-keyword/, /alt="功能截图"/, /loading="lazy"/, /referrerPolicy="no-referrer"/, /rel="noopener noreferrer"/]) assert.match(html, pattern);
});

test("未知代码语言安全回退为代码文本，不阻断整份公告", () => {
  for (const language of ["unknown-language", "text", "mermaid"]) {
    const html = render(`\`\`\`${language}\n原始代码内容\n\`\`\`\n\n后续公告仍可阅读。`);
    assert.match(html, /<pre><code[^>]*>原始代码内容\n<\/code><\/pre>/);
    assert.match(html, /后续公告仍可阅读/);
  }
});

test("GitHub 折叠块和提示块保留正文及语义", () => {
  const html = render("<details>\n<summary>详细变更</summary>\n\n- **完整内容**不会被摘要替换。\n\n</details>\n\n> [!IMPORTANT]\n> 升级前备份数据。\n\n> 普通引用");
  for (const pattern of [/<details>/, /<summary>详细变更<\/summary>/, /<strong>完整内容<\/strong>/, /data-release-alert="important"/, /升级前备份数据/, /普通引用/]) assert.match(html, pattern);
  assert.doesNotMatch(html, /\[!IMPORTANT\]/);
});

test("Markdown 标题锚点经过隔离并在公告内跳转", () => {
  const html = render("[查看亮点](#本次亮点)\n\n## 本次亮点\n\n## 本次亮点\n\n<a id=\"custom\"></a>\n\n[自定义锚点](#custom)");
  assert.match(html, /id="release-note-本次亮点"/);
  assert.match(html, /id="release-note-本次亮点-1"/);
  assert.match(html, /href="#release-note-本次亮点"/);
  assert.match(html, /id="release-note-custom"/);
  assert.match(html, /href="#release-note-custom"/);
});

test("公告只允许安全标记，不执行 HTML、脚本、样式或本地协议", () => {
  const html = render('<script>alert("secret")</script>\n\n<style>body{display:none}</style>\n\n<iframe src="https://example.test"></iframe><form><input name="password"></form>\n\n<svg onload="alert(1)"></svg>\n\n<img src="https://example.test/image.png" onerror="alert(1)" style="position:fixed" />\n\n<a href="javascript:alert(1)" onclick="alert(1)">不安全链接</a>\n\n[文件](file:///C:/secret.txt) [执行](javascript:alert) ![无效图片](data:image/svg+xml;base64,YQ==)');
  for (const pattern of [/<script/, /<style/, /<iframe/, /<form/, /<svg/, /onerror=/, /onclick=/, /style=/, /href="(?:javascript|file|data):/, /src="data:/, /alert\(/, /body\{display/]) assert.doesNotMatch(html, pattern);
  assert.match(html, /不安全链接/);
  assert.match(html, /无效图片/);
});

test("相对链接按对应发布标签解析，不访问宿主页面或本地桥接", () => {
  assert.equal(releaseContentUrl("docs/guide.md", "href", releaseUrl), "https://github.com/Ariember/CodeyX/blob/v1.0.1/docs/guide.md");
  assert.equal(releaseContentUrl("images/preview.png", "src", releaseUrl), "https://raw.githubusercontent.com/Ariember/CodeyX/v1.0.1/images/preview.png");
  assert.equal(releaseContentUrl("https://example.test/docs", "href"), "https://example.test/docs");
  assert.equal(releaseContentUrl("mailto:hello@example.test", "href"), "mailto:hello@example.test");
  for (const url of ["javascript:alert(1)", "file:///C:/secret", "C:\\secret", "//example.test/image", "https://user:password@example.test/image", "https://example.test/\u0000image"]) {
    assert.equal(releaseContentUrl(url, "href", releaseUrl), "");
    assert.equal(releaseContentUrl(url, "src", releaseUrl), "");
  }
  assert.equal(releaseContentUrl("http://example.test/image.png", "src", releaseUrl), "");
  assert.equal(releaseContentUrl("/codey/api/load_codey_config", "href"), "");
  for (const url of ["https://github.com.evil.test/x/y/releases/tag/v1", "http://github.com/x/y/releases/tag/v1", "https://evil.test/x/y/releases/tag/v1", "https://user:pass@github.com/x/y/releases/tag/v1"]) {
    assert.equal(githubReleaseUrl(url), "");
    assert.equal(releaseContentUrl("docs/guide.md", "href", url), "");
  }
});

test("长公告不会截断、重分组或丢失原始段落", () => {
  const html = render(`${"完整的说明段落。\n\n".repeat(100)}最后一段仍然可见。`);
  assert.equal((html.match(/完整的说明段落/g) || []).length, 100);
  assert.match(html, /最后一段仍然可见/);
  const dialogs = readFileSync(new URL("../src/AppDialogs.tsx", import.meta.url), "utf8");
  assert.match(dialogs, /<ReleaseNotes/);
  assert.doesNotMatch(dialogs, /noteGroups|releaseNotes\?\.split/);
});

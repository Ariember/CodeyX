import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const root = new URL("../", import.meta.url);

test("automatic update checks start after Codex launches and share runtime shutdown", async () => {
  const library = await readFile(
    new URL("backend/src/lib.rs", root),
    "utf8",
  );
  const update = library.indexOf("startup_update::run(&state, &ui)");
  const launch = library.indexOf(
    "commands::launch_codey_runtime(&state).await",
  );

  assert.notEqual(launch, -1);
  assert.ok(launch < update);
  assert.match(
    library.slice(launch, update),
    /Ok\(_\) => \{\s*break wait_for_runtime_shutdown\(/,
  );
  assert.match(
    library,
    /StartupUpdateOutcome::InstallScheduled \{[\s\S]*?return ShutdownReason::InstallUpdate;/,
  );
});

test("background updates hand the exact Release to the rendered client dialog without starting installation", async () => {
  const source = await readFile(new URL("backend/src/cdp.rs", root), "utf8");
  const match = source.match(/fn update_prompt_script\(check: &serde_json::Value\) -> String \{\s*format!\(\s*r#"(.*?)"#/s);
  assert.ok(match, "the update prompt script must be independently testable");
  const update = { latestVersion: "1.0.1", releaseNotes: "## 完整公告\n\n</script><script>throw new Error('unsafe')</script>\n\n最后一段", releaseUrl: "https://github.com/Ariember/CodeyX/releases/tag/v1.0.1" };
  const script = match[1].replaceAll("{{", "{").replaceAll("}}", "}").replace("{check}", JSON.stringify(update));
  let opened = 0;
  const events = [];
  const currentUpdate = { latestVersion: "1.0.2" };
  const window = { __codeyUpdateAvailability: currentUpdate, __codeySettingsOverlay: { open() { opened++; } }, dispatchEvent(event) { events.push(event.type); } };
  assert.equal(vm.runInNewContext(script, { window, CustomEvent }), true);
  assert.equal(opened, 1);
  assert.equal(window.__codeyUpdateAvailability, currentUpdate, "the client must accept the pending update before replacing a newer manual result");
  assert.equal(JSON.stringify(window.__codeyPendingUpdatePrompt), JSON.stringify(update));
  assert.ok(events.includes("codey-update-prompt"));
  assert.doesNotMatch(script, /download_update|install_downloaded_update/);
  assert.equal(vm.runInNewContext(script, { window: {}, CustomEvent }), false);
});

test("Windows startup update UI uses a dedicated message loop and custom task-dialog buttons", async () => {
  const [ui, manifest, cargo] = await Promise.all([
    readFile(new URL("backend/src/native_update_ui.rs", root), "utf8"),
    readFile(new URL("backend/build.rs", root), "utf8"),
    readFile(new URL("backend/Cargo.toml", root), "utf8"),
  ]);

  assert.match(ui, /name\("codey-native-update-ui"\.to_string\(\)\)/);
  assert.match(ui, /GetMessageW\(&mut message, None, 0, 0\)/);
  assert.match(ui, /PostThreadMessageW\(self\.thread\.thread_id, WM_APP/);
  assert.match(
    ui,
    /rfd::MessageButtons::OkCancelCustom\(primary_label, secondary_label\)/,
  );
  assert.match(ui, /if rollback[\s\S]*?"回退并重启"[\s\S]*?"更新并重启"/);
  assert.match(ui, /Some\("稍后"\.to_string\(\)\)/);
  assert.match(manifest, /Microsoft\.Windows\.Common-Controls/);
  assert.match(manifest, /version="6\.0\.0\.0"/);
  assert.match(cargo, /features = \["common-controls-v6"\]/);
});

test("context recovery prompt is shared by startup, restart and model saves", async () => {
  const [library, runtime, catalogRefresh] = await Promise.all([
    readFile(new URL("backend/src/lib.rs", root), "utf8"),
    readFile(new URL("backend/src/commands/runtime.rs", root), "utf8"),
    readFile(new URL("backend/src/commands/models/catalog_refresh.rs", root), "utf8"),
  ]);

  assert.match(
    library,
    /commands::recover_default_context_budgets_for_launch\(\s*&state,\s*&error\s*\)/,
  );
  assert.match(library, /error\.is::<model_catalog::ContextBudgetCatalogError>\(\)/);
  assert.match(runtime, /error\.is::<crate::model_catalog::ContextBudgetCatalogError>\(\)/);
  assert.match(
    runtime,
    /super::recover_default_context_budgets_for_launch\(\s*&restart_state,\s*&reason\s*\)/,
  );
  assert.match(
    catalogRefresh,
    /confirm\(crate::native_update_ui::ContextRecoveryPurpose::ModelSync\)/,
  );
});

test("macOS keeps AppKit on the main thread without a Dock icon", async () => {
  const [ui, build] = await Promise.all([
    readFile(new URL("backend/src/native_update_ui.rs", root), "utf8"),
    readFile(new URL("scripts/build.mjs", root), "utf8"),
  ]);

  assert.match(ui, /MainThreadMarker::new\(\)/);
  assert.match(ui, /NSApplicationActivationPolicy::Accessory/);
  assert.match(ui, /NSPanel::initWithContentRect_styleMask_backing_defer/);
  assert.match(ui, /name\("codey-runtime"\.to_string\(\)\)/);
  assert.match(ui, /app\.run\(\)/);
  assert.match(build, /<key>LSUIElement<\/key><true\/>/);
});

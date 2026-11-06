import assert from "node:assert/strict";
import fs from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { releaseIdentity } from "../scripts/release-policy.mjs";
import { parseReleaseNotes } from "../scripts/release-notes.mjs";

const workflow = fs.readFileSync(
  new URL("../.github/workflows/build-desktop.yml", import.meta.url),
  "utf8",
);
const ciWorkflow = fs.readFileSync(
  new URL("../.github/workflows/ci.yml", import.meta.url),
  "utf8",
);
const macBuildScript = fs.readFileSync(
  new URL("../scripts/build.mjs", import.meta.url),
  "utf8",
);
const updateSource = fs.readFileSync(
  new URL("../backend/src/commands/updates.rs", import.meta.url),
  "utf8",
);
const windowsInstallerScript = fs.readFileSync(
  new URL("../scripts/installer/windows/Codey.nsi", import.meta.url),
  "utf8",
);

function assertRustQualityGates(job) {
  assert.match(job, /components: rustfmt, clippy/);
  assert.match(job, /cargo fmt --all -- --check/);
  assert.match(job, /cargo test --workspace --locked/);
  assert.match(job, /cargo clippy --workspace --all-targets --locked -- -D warnings/);
}

function workflowStep(from, to) {
  const fromIndex = workflow.indexOf(from);
  assert.notEqual(fromIndex, -1);
  const toIndex = workflow.indexOf(to, fromIndex);
  assert.notEqual(toIndex, -1);
  return workflow.slice(fromIndex, toIndex);
}

test("pull requests enforce the unified Rust quality gate", () => {
  assert.match(ciWorkflow, /^\s*RUSTFLAGS: -D warnings$/m);
  assertRustQualityGates(ciWorkflow);
  const windowsJob = ciWorkflow.slice(ciWorkflow.indexOf("\n  windows-rust:"));
  assert.match(windowsJob, /runs-on: windows-latest/);
  assert.match(windowsJob, /components: clippy/);
  assert.match(windowsJob, /cargo test --workspace --locked/);
  assert.match(
    windowsJob,
    /cargo clippy --workspace --all-targets --locked -- -D warnings/,
  );
});

function workflowJob(name, until) {
  return workflow.slice(
    workflow.indexOf(`\n  ${name}:`),
    workflow.indexOf(`\n  ${until}:`),
  );
}

test("tag-triggered desktop releases independently enforce Rust quality gates", () => {
  assert.match(workflow, /^\s*RUSTFLAGS: -D warnings$/m);
  const macosCheck = workflowJob("macos-check", "windows");
  const windowsCheck = workflowJob("windows-check", "publish");
  const publish = workflow.slice(workflow.indexOf("\n  publish:"));
  assertRustQualityGates(macosCheck);
  assert.match(macosCheck, /pnpm run check/);
  assert.match(macosCheck, /pnpm run test:js/);
  assert.match(windowsCheck, /components: clippy/);
  assert.match(windowsCheck, /cargo test --workspace --locked/);
  assert.match(
    windowsCheck,
    /cargo clippy --workspace --all-targets --locked -- -D warnings/,
  );
  assert.match(publish, /- macos-check/);
  assert.match(publish, /- windows-check/);
  assert.doesNotMatch(workflowJob("windows", "windows-check"), /cargo test --workspace/);
});

test("desktop release jobs reuse the prebuilt frontend overlay", () => {
  for (const job of [
    workflowJob("macos", "macos-check"),
    workflowJob("macos-check", "windows"),
    workflowJob("windows", "windows-check"),
    workflowJob("windows-check", "publish"),
  ]) {
    assert.match(job, /- name: Build embedded frontend assets\s+run: pnpm run vite:build/);
    assert.match(job, /CODEY_SKIP_OVERLAY_BUILD: "1"/);
  }
  for (const job of [
    workflowJob("macos-check", "windows"),
    workflowJob("windows-check", "publish"),
  ]) {
    assert.match(job, /cargo test --workspace --locked\s+env:\s+CODEY_SKIP_OVERLAY_BUILD: "1"/);
    assert.match(job, /cargo clippy --workspace --all-targets --locked -- -D warnings\s+env:\s+CODEY_SKIP_OVERLAY_BUILD: "1"/);
  }
  assert.match(macBuildScript, /CODEY_SKIP_OVERLAY_BUILD/);
});

test("normal Releases builds do not require the upstream broadcast service", () => {
  for (const job of [workflowJob("macos", "macos-check"), workflowJob("windows", "windows-check")]) {
    assert.doesNotMatch(job, /CODEY_RELEASE_ADMIN_URL|CODEY_UPDATE_BASE_URL/);
    assert.match(job, /CODEYX_GITHUB_REPOSITORY: \$\{\{ github\.repository \}\}/);
  }
  const publish = workflowJob("publish", "managed-publish");
  assert.doesNotMatch(publish, /CLOUDFLARE|release-admin|R2/);
  assert.match(publish, /softprops\/action-gh-release@v2/);
  assert.match(publish, /fail_on_unmatched_files: true/);
});

test("tag releases validate curated announcements before building and only publish drafts", () => {
  const prepare = workflowJob("prepare", "notes");
  const publish = workflowJob("publish", "managed-publish");
  assert.match(prepare, /node scripts\/release-notes\.mjs/);
  assert.match(publish, /readReleaseNotes\(identity\.version\)/);
  assert.match(publish, /body_path: \$\{\{ steps\.release-metadata\.outputs\.notes_path \}\}/);
  assert.match(publish, /draft: true/);
  assert.match(publish, /generate_release_notes: false/);
  assert.match(publish, /release\.draft/);
});

for (const scenario of [
  { status: 404, draft: false, allowed: true },
  { status: 200, draft: true, allowed: true },
  { status: 200, draft: false, allowed: false },
  { status: 401, draft: false, allowed: false },
  { status: 500, draft: false, allowed: false },
]) {
  test(`release metadata never rewrites public releases or hides API failures: ${JSON.stringify(scenario)}`, async () => {
    const publish = workflowJob("publish", "managed-publish");
    const script = publish.match(/node --input-type=module <<'NODE'\r?\n([\s\S]+?)^\s+NODE$/m)?.[1]
      .replace(/^          /gm, "").replace(/^import .+\r?\n/gm, "");
    assert.ok(script);
    const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
    const execute = new AsyncFunction("appendFileSync", "writeFileSync", "join", "releaseIdentity", "readReleaseNotes", "fetch", "process", script);
    const notes = parseReleaseNotes("# CodeyX v1.0.1-beta.1 · 公告排版\n\n## 本次亮点\n\n完整正文。\n", "1.0.1-beta.1");
    const writes = [];
    const record = (path, content) => writes.push({ path, content });
    const run = execute(record, record, join, releaseIdentity, version => {
      assert.equal(version, "1.0.1-beta.1");
      return notes;
    }, async (url, options) => {
      assert.equal(url, "https://api.github.com/repos/Ariember/CodeyX/releases/tags/v1.0.1-beta.1");
      assert.equal(options.headers.Authorization, "Bearer unit-test-token");
      return { status: scenario.status, ok: scenario.status === 200, json: async () => ({ draft: scenario.draft }) };
    }, { env: { GITHUB_REF_NAME: "v1.0.1-beta.1", GITHUB_REPOSITORY: "Ariember/CodeyX", GH_TOKEN: "unit-test-token", RUNNER_TEMP: "release-test", GITHUB_OUTPUT: "release-output" } });
    if (!scenario.allowed) {
      await assert.rejects(run, /already public|HTTP/);
      assert.deepEqual(writes, []);
      return;
    }
    await run;
    assert.deepEqual(writes[0], { path: join("release-test", "codeyx-release-notes.md"), content: notes.body });
    assert.equal(writes[1].path, "release-output");
    assert.match(writes[1].content, /^name=CodeyX v1\.0\.1-beta\.1 · 公告排版\n/);
    assert.match(writes[1].content, /\nprerelease=true\ntag=v1\.0\.1-beta\.1\n$/);
  });
}

test("local releases require an announcement before changing versions even when checks are skipped", () => {
  const source = fs.readFileSync(new URL("../scripts/release.mjs", import.meta.url), "utf8");
  const main = source.slice(source.indexOf("function main()"));
  const notes = main.indexOf("readReleaseNotes(options.version)");
  assert.ok(notes >= 0 && notes < main.indexOf("updatePackageJson(options.version)"));
  assert.ok(notes < main.indexOf("if (!options.skipChecks)"));
});

test("local releases run the same locked Rust checks", () => {
  const releaseScript = fs.readFileSync(new URL("../scripts/release.mjs", import.meta.url), "utf8");
  assert.match(releaseScript, /\["fmt", "--all", "--", "--check"\]/);
  assert.match(releaseScript, /\["test", "--workspace", "--locked"\]/);
  assert.match(releaseScript, /\["clippy", "--workspace", "--all-targets", "--locked", "--", "-D", "warnings"\]/);
});

test("desktop builds generate embedded overlay assets before Cargo compiles", () => {
  const overlayBuild = macBuildScript.indexOf("build-overlay.mjs");
  const cargoBuild = macBuildScript.indexOf('"cargo"');
  assert.notEqual(overlayBuild, -1);
  assert.notEqual(cargoBuild, -1);
  assert.ok(
    overlayBuild < cargoBuild,
    "the ignored dist-overlay directory must be generated before include_str! is compiled",
  );
});

test("macOS updates retain a rollback bundle until the replacement launches", () => {
  const backup = updateSource.indexOf('/bin/mv "$app_bundle" "$backup_bundle"');
  const install = updateSource.indexOf('/bin/mv "$tmp_dir/$app_name" "$app_bundle"');
  const launch = updateSource.indexOf('/usr/bin/open "$app_bundle"');
  const commit = updateSource.indexOf("replacement_committed=1");
  assert.ok(backup >= 0 && backup < install);
  assert.ok(install < launch && launch < commit);
  assert.match(
    updateSource,
    /if \[ "\$replacement_committed" -ne 1 \][\s\S]*?\/bin\/mv "\$backup_bundle" "\$app_bundle" \|\| true/,
  );
  assert.doesNotMatch(updateSource, /rm -rf "\$app_bundle"\s*\nmv "\$tmp_dir/);
});

test("desktop packages include FastCtx license and notice files", () => {
  for (const expected of [
    "README.md",
    "LICENSE",
    "THIRD_PARTY_NOTICES.md",
    "licenses/FastCtx/LICENSE-APACHE",
    "licenses/FastCtx/NOTICE",
  ]) {
    assert.match(macBuildScript, new RegExp(expected.replaceAll("/", "\\/")));
  }

  assert.match(workflow, /Contents\/Resources\/licenses\/FastCtx\/LICENSE-APACHE/);
  assert.match(workflow, /Contents\/Resources\/licenses\/FastCtx\/NOTICE/);
  assert.match(windowsInstallerScript, /licenses\\FastCtx\\LICENSE-APACHE/);
  assert.match(windowsInstallerScript, /licenses\\FastCtx\\NOTICE/);
});

test("README keeps required attribution without advertising unbundled plugin notices", () => {
  const readme = fs.readFileSync(new URL("../README.md", import.meta.url), "utf8");
  const notices = fs.readFileSync(new URL("../THIRD_PARTY_NOTICES.md", import.meta.url), "utf8");
  const fastctx = fs.readFileSync(new URL("../licenses/FastCtx/NOTICE", import.meta.url), "utf8").replaceAll("\r\n", "\n");
  const attribution = fastctx.slice(fastctx.indexOf("    This product includes FastCtx"), fastctx.indexOf("\nSection 4(b)")).trimEnd();
  assert.ok(attribution.startsWith("    This product includes FastCtx"));
  for (const document of [readme, notices]) assert.ok(document.replaceAll("\r\n", "\n").includes(attribution));
  const mobileLicense = fs.readFileSync(new URL("../third_party/codex-mobile-bridge.LICENSE", import.meta.url), "utf8")
    .trim().split(/\r?\n/).map(line => line ? `    ${line}` : "").join("\n");
  assert.ok(notices.replaceAll("\r\n", "\n").includes(mobileLicense));
  assert.match(readme, /github\.com\/Ariember\/CodeyX\/releases/);
  assert.match(readme, /AGPL-3\.0-only/);
  assert.doesNotMatch(readme, /PPT Bridge|Excel Shield|SUCK_MY_ASTRA|发布管理|定向推送/);
});

test("Windows release publishes the installer without a portable zip", () => {
  const nsisInstallStep = workflowStep(
    "- name: Install NSIS",
    "- name: Install frontend dependencies",
  );
  const windowsPackageStep = workflowStep(
    "- name: Build Windows packages",
    "- name: Upload Windows installer",
  );

  assert.match(workflow, /name: codey-windows-x64-installer/);
  assert.match(workflow, /windows-x64-setup\.exe/);
  assert.match(nsisInstallStep, /nsis-\$version\.zip/);
  assert.match(nsisInstallStep, /nsis-\$version\/nsis-\$version\.zip/);
  assert.match(
    nsisInstallStep,
    /c7d27f780ddb6cffb4730138cd1591e841f4b7edb155856901cdf5f214394fa1/,
  );
  assert.match(nsisInstallStep, /curl\.exe -fL --retry 3 --retry-all-errors/);
  assert.match(nsisInstallStep, /NSIS archive hash mismatch/);
  assert.match(nsisInstallStep, /Join-Path \$nsisHome "Bin" "makensis\.exe"/);
  assert.match(nsisInstallStep, /MAKENSIS=/);
  assert.doesNotMatch(nsisInstallStep, /choco install nsis/);
  assert.match(
    windowsPackageStep,
    /New-Item -ItemType Directory -Force "dist\\windows" \| Out-Null/,
  );
  assert.ok(
    windowsPackageStep.indexOf('New-Item -ItemType Directory -Force "dist\\windows"') <
      windowsPackageStep.indexOf("& $makensis"),
  );
  assert.match(windowsPackageStep, /\$makensis = \$env:MAKENSIS/);
  assert.match(
    windowsPackageStep,
    /Get-Command makensis -ErrorAction SilentlyContinue/,
  );
  assert.doesNotMatch(windowsPackageStep, /\$makensis = "makensis"/);
  assert.ok(windowsPackageStep.includes('dist\\windows\\CodeyX-$version-windows-x64-setup.exe'));
  assert.ok(windowsInstallerScript.includes('Name "CodeyX"'));
  assert.ok(windowsInstallerScript.includes('BrandingText "CodeyX"'));
  assert.ok(windowsInstallerScript.includes('CodeyX-${VERSION}-windows-x64-setup.exe'));
  assert.ok(windowsInstallerScript.includes('InstallDir "$LOCALAPPDATA\\Programs\\CodeyX"'));
  assert.ok(windowsInstallerScript.includes('InstallDirRegKey HKCU "${UNINSTALL_KEY}" "InstallLocation"'));
  assert.ok(windowsInstallerScript.includes('Uninstall\\Codey"'));
  assert.ok(windowsInstallerScript.includes('"DisplayName" "CodeyX"'));
  const uninstall = windowsInstallerScript.slice(windowsInstallerScript.indexOf('Section "Uninstall"'));
  for (const shortcut of [
    '$DESKTOP\\CodeyX.lnk',
    '$SMPROGRAMS\\CodeyX\\CodeyX.lnk',
    '$SMPROGRAMS\\CodeyX\\Uninstall CodeyX.lnk',
  ]) {
    assert.ok(windowsInstallerScript.includes(`CreateShortcut "${shortcut}"`));
    assert.ok(uninstall.includes(`Delete "${shortcut}"`));
  }
  assert.ok(windowsInstallerScript.includes('IfFileExists "$DESKTOP\\Codey.lnk" 0 legacy_desktop_shortcut_done'));
  assert.ok(uninstall.includes('Delete "$DESKTOP\\Codey.lnk"'));
  assert.doesNotMatch(windowsInstallerScript, /RMDir\s+\/r/i);
});

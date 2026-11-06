import assert from "node:assert/strict";
import test from "node:test";
import { loadTypeScriptModule } from "./helpers/load-typescript-module.mjs";

const { configsHaveSameDraftValues, reconcileConfigDraft } = await loadTypeScriptModule(new URL("../src/configDraft.ts", import.meta.url));

const baseline = () => ({
  settingsRevision: 1,
  streamMaxRetries: 2,
  routeRequestLog: { enabled: false, batchSize: 20 },
  activeProfileId: "official",
  profiles: [{ id: "official", officialAccount: true }, { id: "custom", name: "old" }],
});

test("account refresh preserves the current draft and updates its saved baseline revision", () => {
  const base = baseline();
  const draft = structuredClone(base);
  draft.streamMaxRetries = 9;
  draft.routeRequestLog.enabled = true;
  draft.profiles[1].name = "edited";
  const incoming = baseline();
  incoming.settingsRevision = 2;
  incoming.routeRequestLog.batchSize = 40;
  incoming.profiles = incoming.profiles.slice(1);
  incoming.activeProfileId = "custom";
  const result = reconcileConfigDraft(base, draft, incoming);
  assert.equal(result.config.streamMaxRetries, 9);
  assert.deepEqual(result.config.routeRequestLog, { enabled: true, batchSize: 40 });
  assert.deepEqual(result.config.profiles, [{ id: "custom", name: "edited" }]);
  assert.equal(result.config.settingsRevision, 2);
  assert.equal(result.config.activeProfileId, "custom");
  assert.equal(result.dirty, true);
  assert.equal(incoming.profiles[0].name, "old");
});

test("unchanged drafts accept refreshes without becoming dirty and stale revisions are ignored", () => {
  const base = baseline();
  const incoming = { ...baseline(), settingsRevision: 2, streamMaxRetries: 4 };
  assert.deepEqual(reconcileConfigDraft(base, structuredClone(base), incoming), { config: incoming, dirty: false });
  assert.equal(reconcileConfigDraft(incoming, incoming, base), null);
});

test("locally added and removed custom routes survive account updates", () => {
  const base = baseline();
  const draft = { ...base, profiles: [base.profiles[0], { id: "new", name: "draft" }] };
  const incoming = { ...baseline(), settingsRevision: 2 };
  const result = reconcileConfigDraft(base, draft, incoming);
  assert.deepEqual(result.config.profiles.map((profile) => profile.id), ["official", "new"]);
  assert.equal(result.dirty, true);
});

test("draft equality ignores revisions and key order but preserves arrays, missing values and edits", () => {
  const base = baseline();
  const reordered = { ...Object.fromEntries(Object.entries(base).reverse()), settingsRevision: 8,
    routeRequestLog: { batchSize: 20, enabled: false } };
  assert.equal(configsHaveSameDraftValues(base, reordered), true);
  assert.equal(configsHaveSameDraftValues(null, null), true);
  assert.equal(configsHaveSameDraftValues(base, null), false);
  for (const changed of [
    { ...base, profiles: [...base.profiles].reverse() },
    { ...base, streamMaxRetries: null },
    { ...base, streamMaxRetries: undefined },
    { ...base, routeRequestLog: { batchSize: 21, enabled: false } },
    { ...base, extra: undefined },
  ]) assert.equal(configsHaveSameDraftValues(base, changed), false);
  assert.deepEqual(reconcileConfigDraft(base, reordered, base), { config: base, dirty: false });
});

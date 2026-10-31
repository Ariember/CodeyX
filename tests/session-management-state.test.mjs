import assert from "node:assert/strict";
import test from "node:test";

import { loadTypeScriptModule } from "./helpers/load-typescript-module.mjs";

const { sessionPath, parseRetentionDays, isSessionExpired, filterSessions } = await loadTypeScriptModule(new URL("../src/features/session-management/state.ts", import.meta.url));

test("session paths hide Windows extended prefixes without changing the path text", () => {
  assert.equal(sessionPath("\\\\?\\E:\\code\\MyProject"), "E:\\code\\MyProject");
  assert.equal(sessionPath("\\\\?\\UNC\\Server\\Share\\MyProject"), "\\\\Server\\Share\\MyProject");
  assert.equal(sessionPath("\\\\?\\unc\\Server\\Share"), "\\\\Server\\Share");
  for (const path of ["E:\\code\\MyProject", "e:/code/MyProject", "\\\\Server\\Share", "/work/MyProject", "", "folder\\\\?\\name"]) {
    assert.equal(sessionPath(path), path);
  }
});

test("retention days accept only positive integers within the supported range", () => {
  for (const [input, expected] of [["1", 1], ["30", 30], ["36500", 36500]]) assert.equal(parseRetentionDays(input), expected);
  for (const input of ["", " ", "0", "-1", "1.5", "NaN", "Infinity", "36501", "1e2", "30days"]) assert.equal(parseRetentionDays(input), null, input);
});

test("custom time filtering keeps the exact cutoff, unknown and future timestamps", () => {
  const now = Date.UTC(2026, 9, 31), cutoff = now - 30 * 86_400_000;
  assert.equal(isSessionExpired(cutoff - 1, 30, now), true);
  for (const timestamp of [cutoff, cutoff + 1, 0, -1, now + 1, NaN, Infinity]) assert.equal(isSessionExpired(timestamp, 30, now), false);
  const sessions = [
    { id: "old-active", title: "旧会话", cwd: "/alpha", archived: false, updatedAt: cutoff - 1 },
    { id: "old-archived", title: "旧归档", cwd: "/alpha", archived: true, updatedAt: cutoff - 1 },
    { id: "boundary", title: "边界", cwd: "/beta", archived: false, updatedAt: cutoff },
    { id: "unknown", title: "未知", cwd: "", archived: false, updatedAt: 0 },
  ];
  assert.deepEqual(filterSessions(sessions, "", "all", 30, now).map(value => value.id), ["old-active", "old-archived"]);
  assert.deepEqual(filterSessions(sessions, "alpha", "archived", 30, now).map(value => value.id), ["old-archived"]);
  assert.equal(filterSessions(sessions, "", "all").length, 4);
});

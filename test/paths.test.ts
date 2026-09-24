import assert from "node:assert/strict";
import test from "node:test";
import { isGoogleWorkspaceMimeType, isSyncExcludedPath, isUserExcludedPath } from "../src/paths/index.ts";

test("isSyncExcludedPath excludes system file names", () => {
  assert.equal(isSyncExcludedPath("_sync-meta.json"), true);
  assert.equal(isSyncExcludedPath("settings.json"), true);
});

test("isSyncExcludedPath excludes special folders", () => {
  assert.equal(isSyncExcludedPath("history/run.log"), true);
  assert.equal(isSyncExcludedPath("trash/note.md"), true);
  assert.equal(isSyncExcludedPath("sync_conflicts/backup.md"), true);
  assert.equal(isSyncExcludedPath("__TEMP__/draft.md"), true);
  assert.equal(isSyncExcludedPath("plugins/tool.js"), true);
});

test("isSyncExcludedPath still syncs dashboard files themselves", () => {
  assert.equal(isSyncExcludedPath("Dashboards/home.dashboard"), false);
  assert.equal(isSyncExcludedPath("home.dashboard"), false);
});

test("dashboard workflow cache is a normal synced file", () => {
  // Stored at Dashboards/Data/<id>.json — synced and visible like any file.
  assert.equal(isSyncExcludedPath("Dashboards/Data/abc123.json"), false);
});

test("timeline notes and attachments are normal synced files", () => {
  assert.equal(isSyncExcludedPath("Dashboards/Timeline/Daily/2026-06-27.md"), false);
  assert.equal(isSyncExcludedPath("Dashboards/Timeline/Daily/attachments/2026-06-27/post_01.png"), false);
});

test("isSyncExcludedPath handles leading slash", () => {
  assert.equal(isSyncExcludedPath("/history/run.log"), true);
});

test("isSyncExcludedPath allows normal files", () => {
  assert.equal(isSyncExcludedPath("notes/daily.md"), false);
  assert.equal(isSyncExcludedPath("history_notes.md"), false);
});

test("isGoogleWorkspaceMimeType distinguishes native files from exported files", () => {
  assert.equal(isGoogleWorkspaceMimeType("application/vnd.google-apps.document"), true);
  assert.equal(isGoogleWorkspaceMimeType("application/vnd.google-apps.spreadsheet"), true);
  assert.equal(isGoogleWorkspaceMimeType("application/vnd.openxmlformats-officedocument.wordprocessingml.document"), false);
  assert.equal(isGoogleWorkspaceMimeType("application/pdf"), false);
});

test("isSyncExcludedPath excludes GemiHub/Obsidian conflict backups and tooling folders", () => {
  assert.equal(isSyncExcludedPath("GemiHub/conflict-backups/a_20260101_000000_000.md"), true);
  assert.equal(isSyncExcludedPath("project/node_modules/pkg/index.js"), true);
  assert.equal(isSyncExcludedPath(".git/config"), true);
  assert.equal(isSyncExcludedPath("docs/node_modules.md"), false);
});

test("isSyncExcludedPath matches a system folder itself", () => {
  assert.equal(isSyncExcludedPath("trash"), true);
  assert.equal(isSyncExcludedPath("trashcan.md"), false);
});

test("isSyncExcludedPath strips managed roots only when asked", () => {
  assert.equal(isSyncExcludedPath("gemihub/history/run.log"), false);
  assert.equal(isSyncExcludedPath("gemihub/history/run.log", { managedRootPrefixes: ["gemihub/"] }), true);
});

test("isSyncExcludedPath applies client prefixes, segments and user patterns", () => {
  const options = {
    extraPrefixes: [".obsidian/", "GemiHub/"],
    extraSegments: [".llm-hub"],
    excludePatterns: ["private/", "*.tmp"],
  };
  assert.equal(isSyncExcludedPath(".obsidian/app.json", options), true);
  assert.equal(isSyncExcludedPath("GemiHub", options), true);
  assert.equal(isSyncExcludedPath("work/.llm-hub/state.json", options), true);
  assert.equal(isSyncExcludedPath("private/diary.md", options), true);
  assert.equal(isSyncExcludedPath("notes/scratch.tmp", options), true);
  assert.equal(isSyncExcludedPath("notes/plan.md", options), false);
});

test("isUserExcludedPath matches folder patterns and basename globs", () => {
  assert.equal(isUserExcludedPath("drafts", ["drafts/"]), true);
  assert.equal(isUserExcludedPath("drafts/a.md", ["drafts/"]), true);
  assert.equal(isUserExcludedPath("a/b/draft-1.md", ["draft-?.md"]), true);
  assert.equal(isUserExcludedPath("a/b/final.md", ["draft-*"]), false);
});

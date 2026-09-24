import assert from "node:assert/strict";
import test from "node:test";
import {
  duplicateRemotePaths,
  reconcileSyncMetaWithListing,
  syncMetaFromDriveFiles,
  syncMetaSnapshotChanged,
} from "../src/protocol/snapshot.ts";
import type { SyncMeta } from "../src/protocol/sync-meta.ts";

const entry = (name: string, md5 = "h", modifiedTime = "t") => ({ name, mimeType: "text/markdown", md5Checksum: md5, modifiedTime });

test("syncMetaFromDriveFiles skips system, Workspace-native and excluded files", () => {
  const meta = syncMetaFromDriveFiles([
    { id: "1", name: "a.md", mimeType: "text/markdown", md5Checksum: "h1" },
    { id: "2", name: "_sync-meta.json", mimeType: "application/json" },
    { id: "3", name: "Doc", mimeType: "application/vnd.google-apps.document" },
    { id: "4", name: "trash/old.md", mimeType: "text/markdown" },
  ]);
  assert.deepEqual(Object.keys(meta.files), ["1"]);
});

test("reconcileSyncMetaWithListing trusts the listing but keeps registry-only fields", () => {
  const meta: SyncMeta = {
    lastUpdatedAt: "2026-01-01T00:00:00.000Z",
    files: {
      "1": { ...entry("a.md", "old"), shared: true, publicPath: "/public/file/1/a.md" },
      "gone": entry("deleted.md"),
    },
  };
  const live = reconcileSyncMetaWithListing(meta, [
    { id: "1", name: "a.md", mimeType: "text/markdown", md5Checksum: "new" },
    { id: "2", name: "b.md", mimeType: "text/markdown", md5Checksum: "h2" },
  ]);
  assert.deepEqual(Object.keys(live.files).sort(), ["1", "2"]);
  assert.equal(live.files["1"].md5Checksum, "new");
  assert.equal(live.files["1"].publicPath, "/public/file/1/a.md");
  assert.equal(live.lastUpdatedAt, "2026-01-01T00:00:00.000Z");
});

test("syncMetaSnapshotChanged detects added, removed, renamed and edited files", () => {
  const base = { "1": entry("a.md"), "2": entry("b.md") };
  assert.equal(syncMetaSnapshotChanged(base, { ...base }), false);
  assert.equal(syncMetaSnapshotChanged(base, { "1": entry("a.md") }), true);
  assert.equal(syncMetaSnapshotChanged(base, { ...base, "3": entry("c.md") }), true);
  assert.equal(syncMetaSnapshotChanged(base, { ...base, "2": entry("B.md") }), true);
  assert.equal(syncMetaSnapshotChanged(base, { ...base, "2": entry("b.md", "h2") }), true);
});

test("syncMetaSnapshotChanged falls back to modifiedTime without checksums", () => {
  const before = { "1": entry("a.md", "", "t1") };
  assert.equal(syncMetaSnapshotChanged(before, { "1": entry("a.md", "", "t1") }), false);
  assert.equal(syncMetaSnapshotChanged(before, { "1": entry("a.md", "", "t2") }), true);
});

test("duplicateRemotePaths reports names claimed by several files", () => {
  const files = { "1": entry("a.md"), "2": entry("a.md"), "3": entry("A.md"), "4": entry("b.md") };
  assert.deepEqual(duplicateRemotePaths(files), ["a.md"]);
  assert.deepEqual(duplicateRemotePaths(files, true), ["a.md"]);
  assert.deepEqual(duplicateRemotePaths([entry("x.md"), entry("X.md")], true), ["x.md"]);
});

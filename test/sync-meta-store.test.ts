import assert from "node:assert/strict";
import test from "node:test";
import { DriveApiError, type DriveFile } from "../src/drive/index.ts";
import {
  createSyncMetaStore,
  removeFilesFromMeta,
  syncMetaFromListing,
  upsertDriveFileInMeta,
  type SyncMetaDrive,
} from "../src/sync-meta/index.ts";
import type { SyncMeta } from "../src/protocol/sync-meta.ts";

/** In-memory Drive: files keyed by id, all in folder "root" unless moved/trashed. */
function fakeDrive(initial: Array<DriveFile & { content?: string }>) {
  const files = new Map(initial.map((f) => [f.id, { parents: ["root"], ...f }]));
  let nextId = 1;
  const calls: string[] = [];
  const drive: SyncMetaDrive = {
    async findFilesByExactName(_t, name) {
      calls.push(`find:${name}`);
      return [...files.values()].filter((f) => f.name === name && !f.trashed);
    },
    async readFile(_t, id) {
      calls.push(`read:${id}`);
      const file = files.get(id);
      if (!file) throw new DriveApiError(404, "not found");
      return file.content ?? "";
    },
    async updateFile(_t, id, content) {
      calls.push(`update:${id}`);
      const file = files.get(id)!;
      file.content = content;
      return file;
    },
    async createFile(_t, name, content, parentId, mimeType) {
      const id = `new${nextId++}`;
      calls.push(`create:${name}`);
      const file = { id, name, content, mimeType: mimeType ?? "text/plain", parents: [parentId] };
      files.set(id, file);
      return file;
    },
    async deleteFile(_t, id) {
      calls.push(`delete:${id}`);
      files.delete(id);
    },
    async listUserFiles() {
      return [...files.values()].filter((f) => !f.trashed && f.parents?.includes("root") && f.name !== "_sync-meta.json");
    },
    async getFileMetadata(_t, id) {
      calls.push(`meta:${id}`);
      const file = files.get(id);
      if (!file) throw new DriveApiError(404, "not found");
      return file;
    },
  };
  return { drive, files, calls };
}

const entry = (name: string, md5: string, extra: object = {}) => ({ name, mimeType: "text/markdown", md5Checksum: md5, modifiedTime: "t", ...extra });
const metaFile = (id: string, meta: SyncMeta, modifiedTime: string) =>
  ({ id, name: "_sync-meta.json", mimeType: "application/json", modifiedTime, content: JSON.stringify(meta) });

test("read consolidates duplicate _sync-meta.json files into the newest", async () => {
  const older: SyncMeta = { lastUpdatedAt: "1", files: { a: entry("a.md", "h1") } };
  const newer: SyncMeta = { lastUpdatedAt: "2", files: { b: entry("b.md", "h2") } };
  const { drive, files } = fakeDrive([metaFile("m1", older, "2026-01-01"), metaFile("m2", newer, "2026-02-01")]);
  const store = createSyncMetaStore(drive);
  const { meta, fileId } = await store.readWithFile("tok", "root");
  assert.equal(fileId, "m2");
  assert.deepEqual(Object.keys(meta!.files).sort(), ["a", "b"]);
  assert.equal(files.has("m1"), false);
  assert.deepEqual(Object.keys(JSON.parse(files.get("m2")!.content!).files).sort(), ["a", "b"]);
});

test("read failure leaves duplicate registries untouched", async () => {
  const newer: SyncMeta = { lastUpdatedAt: "2", files: { b: entry("b.md", "h2") } };
  const older: SyncMeta = { lastUpdatedAt: "1", files: { a: entry("a.md", "h1") } };
  const { drive, files, calls } = fakeDrive([metaFile("m1", older, "2026-01-01"), metaFile("m2", newer, "2026-02-01")]);
  const originalRead = drive.readFile;
  drive.readFile = async (token, id, options) => {
    if (id === "m1") throw new DriveApiError(503, "temporarily unavailable");
    return originalRead(token, id, options);
  };
  await assert.rejects(createSyncMetaStore(drive).read("tok", "root"),
    (error: unknown) => error instanceof DriveApiError && error.status === 503);
  assert.equal(files.has("m1"), true);
  assert.equal(files.has("m2"), true);
  assert.equal(calls.some((call) => call.startsWith("delete:") || call.startsWith("update:")), false);
});

test("read failure does not rebuild over the only registry", async () => {
  const meta: SyncMeta = { lastUpdatedAt: "1", files: { a: entry("a.md", "h1") } };
  const { drive, files, calls } = fakeDrive([metaFile("m", meta, "2026-01-01")]);
  drive.readFile = async () => { throw new DriveApiError(503, "temporarily unavailable"); };
  await assert.rejects(createSyncMetaStore(drive).readReconciled("tok", "root"),
    (error: unknown) => error instanceof DriveApiError && error.status === 503);
  assert.deepEqual(JSON.parse(files.get("m")!.content!), meta);
  assert.equal(calls.some((call) => call.startsWith("update:") || call.startsWith("create:")), false);
});

test("readReconciled leaves previously tracked excluded paths alone", async () => {
  // Removing the entry would make every client treat the (still existing) file
  // as deleted remotely; the listing already keeps excluded files from being adopted.
  const meta: SyncMeta = { lastUpdatedAt: "1", files: { hidden: entry("history/a.md", "h") } };
  const { drive, calls } = fakeDrive([
    metaFile("m", meta, "2026-01-01"),
    { id: "hidden", name: "history/a.md", mimeType: "text/markdown", md5Checksum: "changed" },
    { id: "internal", name: "project/node_modules/x.js", mimeType: "text/javascript" },
  ]);
  drive.listUserFiles = async () => [];
  const result = await createSyncMetaStore(drive).readReconciled("tok", "root");
  assert.deepEqual([result.removedIds, result.refreshedIds, result.addedIds], [[], [], []]);
  assert.deepEqual(result.meta!.files, meta.files);
  assert.equal(calls.some((call) => call.startsWith("update:")), false);
});

test("a malformed duplicate is dropped instead of blocking every read and write", async () => {
  const good: SyncMeta = { lastUpdatedAt: "2", files: { a: entry("a.md", "h1") } };
  const { drive, files } = fakeDrive([
    metaFile("good", good, "2026-02-01"),
    { id: "broken", name: "_sync-meta.json", mimeType: "application/json", modifiedTime: "2026-01-01", content: "{ truncated" },
    { id: "wrongShape", name: "_sync-meta.json", mimeType: "application/json", modifiedTime: "2026-01-02", content: "null" },
    { id: "brokenEntry", name: "_sync-meta.json", mimeType: "application/json", modifiedTime: "2026-01-03", content: '{"lastUpdatedAt":"3","files":{"a":null}}' },
  ]);
  const store = createSyncMetaStore(drive);
  const { meta, fileId } = await store.readWithFile("tok", "root");
  assert.equal(fileId, "good");
  assert.deepEqual(Object.keys(meta!.files), ["a"]);
  assert.equal(files.has("broken"), false);
  assert.equal(files.has("wrongShape"), false);
  assert.equal(files.has("brokenEntry"), false);
  assert.equal(await store.write("tok", "root", { lastUpdatedAt: "3", files: {} }), "good");
});

test("when every duplicate is malformed the newest is kept and the registry rebuilt", async () => {
  const { drive, files } = fakeDrive([
    { id: "old", name: "_sync-meta.json", mimeType: "application/json", modifiedTime: "2026-01-01", content: "{" },
    { id: "new", name: "_sync-meta.json", mimeType: "application/json", modifiedTime: "2026-02-01", content: "[" },
    { id: "a", name: "a.md", mimeType: "text/markdown", md5Checksum: "h" },
  ]);
  const store = createSyncMetaStore(drive);
  assert.deepEqual(await store.readWithFile("tok", "root"), { meta: null, fileId: "new" });
  assert.equal(files.has("old"), false);
  const rebuilt = await store.readReconciled("tok", "root");
  assert.equal(rebuilt.fileId, "new");
  assert.deepEqual(Object.keys(rebuilt.meta!.files), ["a"]);
});

test("write reuses a known file id and creates the file when missing", async () => {
  const { drive, calls } = fakeDrive([]);
  const store = createSyncMetaStore(drive);
  const id = await store.write("tok", "root", { lastUpdatedAt: "x", files: {} });
  assert.equal(id, "new1");
  calls.length = 0;
  await store.write("tok", "root", { lastUpdatedAt: "y", files: {} }, { knownFileId: id });
  assert.deepEqual(calls, ["update:new1"]);
});

test("readReconciled removes verified deletions, refreshes drift and adopts untracked files", async () => {
  const meta: SyncMeta = { lastUpdatedAt: "1", files: {
    kept: entry("kept.md", "old", { shared: true, publicPath: "/public/file/kept/kept.md" }),
    trashed: entry("trashed.md", "h"),
    gone: entry("gone.md", "h"),
    moved: entry("moved.md", "h"),
  } };
  const { drive, files } = fakeDrive([
    metaFile("m", meta, "t"),
    { id: "kept", name: "kept.md", mimeType: "text/markdown", md5Checksum: "new", modifiedTime: "t2" },
    { id: "trashed", name: "trashed.md", mimeType: "text/markdown", trashed: true },
    { id: "moved", name: "moved.md", mimeType: "text/markdown", parents: ["elsewhere"] },
    { id: "fresh", name: "fresh.md", mimeType: "text/markdown", md5Checksum: "f" },
  ]);
  const result = await createSyncMetaStore(drive).readReconciled("tok", "root");
  assert.deepEqual(result.removedIds.sort(), ["gone", "moved", "trashed"]);
  assert.deepEqual(result.refreshedIds, ["kept"]);
  assert.deepEqual(result.addedIds, ["fresh"]);
  assert.equal(result.meta!.files.kept.md5Checksum, "new");
  assert.equal(result.meta!.files.kept.publicPath, "/public/file/kept/kept.md");
  assert.deepEqual(Object.keys(JSON.parse(files.get("m")!.content!).files).sort(), ["fresh", "kept"]);
});

test("readReconciled keeps entries it cannot verify and does not write when nothing changed", async () => {
  const meta: SyncMeta = { lastUpdatedAt: "1", files: { a: entry("a.md", "h") } };
  const { drive, calls } = fakeDrive([metaFile("m", meta, "t"), { id: "a", name: "a.md", mimeType: "text/markdown", md5Checksum: "h" }]);
  const result = await createSyncMetaStore(drive).readReconciled("tok", "root");
  assert.deepEqual([result.removedIds, result.refreshedIds, result.addedIds], [[], [], []]);
  assert.equal(calls.some((c) => c.startsWith("update:")), false);

  const failing = fakeDrive([metaFile("m", { lastUpdatedAt: "1", files: { x: entry("x.md", "h") } }, "t")]);
  failing.drive.getFileMetadata = async () => { throw new DriveApiError(500, "boom"); };
  await assert.rejects(createSyncMetaStore(failing.drive).readReconciled("tok", "root"), /500/);
});

test("readReconciled honours isAdoptable, onListing and rebuildIfMissing", async () => {
  const { drive, calls } = fakeDrive([
    { id: "a", name: "a.md", mimeType: "text/markdown" },
    { id: "cfg", name: ".obsidian/app.json", mimeType: "application/json" },
  ]);
  const store = createSyncMetaStore(drive);
  assert.equal((await store.readReconciled("tok", "root", { rebuildIfMissing: false })).meta, null);
  assert.equal(calls.some((c) => c.startsWith("create:")), false);

  await assert.rejects(store.readReconciled("tok", "root", { onListing: () => { throw new Error("duplicates"); } }), /duplicates/);
  assert.equal(calls.some((c) => c.startsWith("create:")), false);

  const rebuilt = await store.readReconciled("tok", "root", { isAdoptable: (f) => !f.name.startsWith(".obsidian/") });
  assert.deepEqual(Object.keys(rebuilt.meta!.files), ["a"]);
  assert.equal(rebuilt.fileId, "new1");
});

test("rebuild keeps client-stored fields from the previous registry", async () => {
  const meta: SyncMeta = { lastUpdatedAt: "1", files: { a: { ...entry("a.md", "old"), shared: true, path: "a.md" } as SyncMeta["files"][string] } };
  const { drive } = fakeDrive([metaFile("m", meta, "t"), { id: "a", name: "a.md", mimeType: "text/markdown", md5Checksum: "new" }]);
  const rebuilt = await createSyncMetaStore(drive).rebuild("tok", "root");
  assert.equal(rebuilt.files.a.md5Checksum, "new");
  assert.equal(rebuilt.files.a.shared, true);
  assert.equal((rebuilt.files.a as { path?: string }).path, "a.md");
});

test("update applies a mutation and can skip the write", async () => {
  const { drive, calls } = fakeDrive([metaFile("m", { lastUpdatedAt: "1", files: {} }, "t")]);
  const store = createSyncMetaStore(drive);
  await store.update("tok", "root", () => false);
  assert.equal(calls.some((c) => c.startsWith("update:")), false);
  const meta = await store.update("tok", "root", (m) => { m.files.a = entry("a.md", "h"); });
  assert.deepEqual(Object.keys(meta.files), ["a"]);
  assert.equal(calls.filter((c) => c.startsWith("update:")).length, 1);
});

test("upsertDriveFileInMeta keeps publish state; removeFilesFromMeta reports changes", () => {
  const meta: SyncMeta = { lastUpdatedAt: "1", files: {
    a: entry("a.md", "h1", { shared: true, webViewLink: "https://w", publicPath: "/p", size: "3", createdTime: "c" }),
  } };
  upsertDriveFileInMeta(meta, { id: "a", name: "a.md", mimeType: "text/markdown", md5Checksum: "h1", modifiedTime: "t" });
  assert.deepEqual(meta.files.a, { ...entry("a.md", "h1"), createdTime: "c", shared: true, webViewLink: "https://w", publicPath: "/p", size: "3" });
  upsertDriveFileInMeta(meta, { id: "a", name: "a.md", mimeType: "text/markdown", md5Checksum: "h2" });
  assert.equal(meta.files.a.size, undefined, "size dropped when content changed without a new size");
  assert.equal(removeFilesFromMeta(meta, ["zzz"]), false);
  assert.equal(removeFilesFromMeta(meta, ["a"]), true);
  assert.deepEqual(syncMetaFromListing([], null).files, {});
});

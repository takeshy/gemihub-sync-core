// Whole-snapshot helpers: build `_sync-meta.json` state from a Drive listing,
// compare two snapshots, and find paths that Drive holds more than once.

import { isGoogleWorkspaceMimeType, isSyncExcludedPath } from "../paths/index.ts";
import type { DriveFileLike } from "./reconcile.ts";
import type { FileSyncMeta, SyncMeta } from "./sync-meta.ts";

/** Default filter: regular (non Workspace-native) files outside the system folders. */
export function isSyncableDriveFile(file: Pick<DriveFileLike, "name" | "mimeType">): boolean {
  return !isGoogleWorkspaceMimeType(file.mimeType) && !isSyncExcludedPath(file.name);
}

/** Build a SyncMeta from a root-folder listing (the listing is the truth). */
export function syncMetaFromDriveFiles(
  files: readonly DriveFileLike[],
  isSyncable: (file: DriveFileLike) => boolean = isSyncableDriveFile,
): SyncMeta {
  return {
    lastUpdatedAt: new Date().toISOString(),
    files: Object.fromEntries(files.filter(isSyncable).map((file) => [file.id, {
      name: file.name,
      mimeType: file.mimeType,
      md5Checksum: file.md5Checksum ?? "",
      modifiedTime: file.modifiedTime ?? "",
      createdTime: file.createdTime,
      size: file.size,
    } satisfies FileSyncMeta])),
  };
}

/**
 * Treat the Drive listing as authoritative while keeping registry-only fields
 * (shared, webViewLink, publicPath, ...) that a listing does not return.
 * Stale or duplicate `_sync-meta.json` files can otherwise hide newly created
 * and deleted files.
 */
export function reconcileSyncMetaWithListing(
  meta: SyncMeta | null,
  files: readonly DriveFileLike[],
  isSyncable: (file: DriveFileLike) => boolean = isSyncableDriveFile,
): SyncMeta {
  const live = syncMetaFromDriveFiles(files, isSyncable);
  if (!meta) return live;
  live.lastUpdatedAt = meta.lastUpdatedAt || live.lastUpdatedAt;
  for (const [id, file] of Object.entries(live.files)) {
    const previous = meta.files?.[id];
    if (previous) {
      live.files[id] = {
        ...previous,
        ...file,
        createdTime: file.createdTime ?? previous.createdTime,
        size: file.size ?? previous.size,
      };
    }
  }
  return live;
}

type SnapshotEntry = Pick<FileSyncMeta, "name" | "md5Checksum" | "modifiedTime">;

/**
 * True when anything changed between two snapshots: a file appeared or
 * disappeared, was renamed (case-sensitively), or its content changed
 * (md5 when both sides have one, otherwise modifiedTime). Used to detect a
 * concurrent writer during a long push/pull.
 */
export function syncMetaSnapshotChanged(
  expected: Record<string, SnapshotEntry> | null | undefined,
  current: Record<string, SnapshotEntry> | null | undefined,
): boolean {
  const before = expected ?? {};
  const after = current ?? {};
  const expectedIds = Object.keys(before).sort();
  const currentIds = Object.keys(after).sort();
  if (expectedIds.length !== currentIds.length || expectedIds.some((id, i) => id !== currentIds[i])) return true;
  return expectedIds.some((id) => {
    const a = before[id];
    const b = after[id];
    if (a.name !== b.name) return true;
    if (a.md5Checksum && b.md5Checksum) return a.md5Checksum !== b.md5Checksum;
    return (a.modifiedTime ?? "") !== (b.modifiedTime ?? "");
  });
}

/**
 * Paths that more than one tracked file claims. Drive allows duplicate names,
 * but the flat layout uses the name as the path, so such files cannot be
 * mapped to a single local file. Returns one representative name per group.
 */
export function duplicateRemotePaths(
  files: Record<string, Pick<FileSyncMeta, "name">> | readonly Pick<FileSyncMeta, "name">[],
  caseInsensitive = false,
): string[] {
  const groups = new Map<string, string[]>();
  for (const file of Array.isArray(files) ? files : Object.values(files)) {
    const key = caseInsensitive ? file.name.toLowerCase() : file.name;
    const names = groups.get(key) ?? [];
    names.push(file.name);
    groups.set(key, names);
  }
  return [...groups.values()]
    .filter((names) => names.length > 1)
    .map((names) => names[0])
    .sort((a, b) => a.localeCompare(b));
}

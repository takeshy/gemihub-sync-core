// Pure reconciliation helpers for the flat Drive layout's `_sync-meta.json`.
// No I/O: callers list/read Drive with their own transport and pass the results in.

import { remoteChangedSincePushSnapshot } from "./push-guard.ts";
import type { SyncMeta } from "./sync-meta.ts";

/** The subset of a Drive `files` resource these helpers read. */
export interface DriveFileLike {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime?: string;
  createdTime?: string;
  parents?: string[];
  trashed?: boolean;
  md5Checksum?: string;
  size?: string;
}

/**
 * Pure helper: given a list of _sync-meta.json matches, pick which to keep
 * (latest modifiedTime) and which to discard. Drive does not enforce unique
 * names, so concurrent writers can create duplicates; callers merge them with
 * mergeSyncMetaSnapshots, write the result to `keep` and delete `discard`.
 */
export function pickSyncMetaToKeep(matches: DriveFileLike[]): {
  keep: DriveFileLike | null;
  discard: DriveFileLike[];
} {
  if (matches.length === 0) return { keep: null, discard: [] };
  if (matches.length === 1) return { keep: matches[0], discard: [] };
  // modifiedTime is ISO 8601 so lexicographic compare is equivalent to chronological
  const sorted = [...matches].sort((a, b) =>
    (b.modifiedTime ?? "").localeCompare(a.modifiedTime ?? "")
  );
  return { keep: sorted[0], discard: sorted.slice(1) };
}

function mergeFileSyncMeta(
  current: SyncMeta["files"][string] | undefined,
  incoming: SyncMeta["files"][string]
): SyncMeta["files"][string] {
  if (!current) return { ...incoming };

  const currentModified = current.modifiedTime ?? "";
  const incomingModified = incoming.modifiedTime ?? "";
  const base =
    incomingModified >= currentModified
      ? { ...current, ...incoming }
      : { ...incoming, ...current };

  const merged: SyncMeta["files"][string] = {
    ...base,
  };

  const shared = incoming.shared ?? current.shared;
  const webViewLink = incoming.webViewLink ?? current.webViewLink;
  const createdTime = incoming.createdTime ?? current.createdTime;
  const size = incoming.size ?? current.size;

  if (shared !== undefined) merged.shared = shared;
  if (webViewLink !== undefined) merged.webViewLink = webViewLink;
  if (createdTime !== undefined) merged.createdTime = createdTime;
  if (size !== undefined) merged.size = size;

  return merged;
}

export function mergeSyncMetaSnapshots(metas: SyncMeta[]): SyncMeta {
  const merged: SyncMeta = {
    lastUpdatedAt: "",
    files: {},
  };

  for (const meta of metas) {
    if (meta.lastUpdatedAt > merged.lastUpdatedAt) {
      merged.lastUpdatedAt = meta.lastUpdatedAt;
    }
    for (const [fileId, fileMeta] of Object.entries(meta.files)) {
      merged.files[fileId] = mergeFileSyncMeta(merged.files[fileId], fileMeta);
    }
  }

  if (!merged.lastUpdatedAt) {
    merged.lastUpdatedAt = new Date().toISOString();
  }

  return merged;
}

/**
 * Whether a Drive file that disappeared from the root listing was actually
 * deleted, trashed, or moved outside the flat sync root.
 */
export function isFileRemovedFromSyncRoot(file: DriveFileLike, rootFolderId: string): boolean {
  return file.trashed === true || !(file.parents ?? []).includes(rootFolderId);
}

/**
 * Register root-folder files that `_sync-meta.json` does not know about.
 *
 * An external client (Desktop/Obsidian plugin) uploads files first and writes
 * the meta once at the end; a crash in between leaves live files that the
 * meta-driven diff never sees. Those clients self-heal on their next run by
 * listing Drive, so GemiHub's reconciliation does the same instead of waiting
 * for the user to run "Detect untracked files". `driveFiles` is a root listing
 * (folders, Workspace-native files and system files already filtered out).
 * Existing entries are never touched. Returns the added file ids.
 */
export function addUntrackedFilesToSyncMeta(meta: SyncMeta, driveFiles: DriveFileLike[]): string[] {
  const added: string[] = [];
  for (const f of driveFiles) {
    if (meta.files[f.id]) continue;
    meta.files[f.id] = {
      name: f.name,
      mimeType: f.mimeType,
      md5Checksum: f.md5Checksum ?? "",
      modifiedTime: f.modifiedTime ?? "",
      createdTime: f.createdTime,
      size: f.size,
    };
    added.push(f.id);
  }
  return added;
}

/**
 * Refresh tracked entries whose Drive file changed without the meta being
 * updated (another client wrote the file, or a meta write was lost).
 *
 * Push revalidates each upload against the live Drive listing using
 * remoteChangedSincePushSnapshot. Without this refresh a drifted entry is
 * invisible to the meta-driven diff (no pull, no conflict) yet makes every
 * Push skip the file forever. Updating it to the Drive state surfaces the
 * remote change as a normal pull/conflict instead. Registry-only fields
 * (shared, publicPath, ...) are preserved. Returns the refreshed file ids.
 */
export function refreshDriftedSyncMetaEntries(meta: SyncMeta, driveFiles: DriveFileLike[]): string[] {
  const refreshed: string[] = [];
  for (const f of driveFiles) {
    const existing = meta.files[f.id];
    if (!existing || !remoteChangedSincePushSnapshot(existing, f)) continue;
    meta.files[f.id] = {
      ...existing,
      name: f.name,
      mimeType: f.mimeType,
      md5Checksum: f.md5Checksum ?? "",
      modifiedTime: f.modifiedTime ?? "",
      size: f.size ?? existing.size,
    };
    refreshed.push(f.id);
  }
  return refreshed;
}

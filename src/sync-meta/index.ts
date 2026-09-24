// `_sync-meta.json` storage on Drive, shared by every GemiHub client.
//
// Drive does not enforce unique names, so concurrent writers can create
// duplicate `_sync-meta.json` files; every read consolidates them into the
// newest one. Reconciliation keeps the registry honest against the actual
// root listing: entries whose file left the sync root are removed (verified
// by ID, so a partial listing cannot fabricate deletions), drifted entries
// adopt the Drive state, and untracked root files are registered.

import type { DriveClient, DriveFile, DriveOperationOptions } from "../drive/index.ts";
import {
  addUntrackedFilesToSyncMeta,
  isFileRemovedFromSyncRoot,
  mergeSyncMetaSnapshots,
  pickSyncMetaToKeep,
  refreshDriftedSyncMetaEntries,
} from "../protocol/reconcile.ts";
import { SYNC_META_FILE_NAME, type FileSyncMeta, type SyncMeta } from "../protocol/sync-meta.ts";

/** The Drive operations the store needs (any DriveClient satisfies it). */
export type SyncMetaDrive = Pick<DriveClient,
  "findFilesByExactName" | "readFile" | "updateFile" | "createFile" | "deleteFile" | "listUserFiles" | "getFileMetadata">;

function emptySyncMeta(): SyncMeta {
  return { lastUpdatedAt: new Date().toISOString(), files: {} };
}

function isNotFound(error: unknown): boolean {
  const status = (error as { status?: unknown } | null)?.status;
  return status === 404 || (error instanceof Error && /\b404\b/.test(error.message));
}

// ---------------------------------------------------------------------------
// Pure entry helpers
// ---------------------------------------------------------------------------

/**
 * Add or update the entry for a Drive file (typically an upload response).
 *
 * GemiHub keeps a file's publish state (`shared`, `webViewLink`, the signed
 * `publicPath`) only inside `_sync-meta.json`; Drive never returns it. The
 * fields are carried over from `previous` (defaults to the entry being
 * replaced), otherwise every push would un-publish the file.
 */
export function upsertDriveFileInMeta(
  meta: SyncMeta,
  file: Pick<DriveFile, "id" | "name" | "mimeType" | "md5Checksum" | "modifiedTime" | "createdTime" | "size">,
  previous: FileSyncMeta | undefined = meta.files[file.id],
): FileSyncMeta {
  const entry: FileSyncMeta = {
    name: file.name,
    mimeType: file.mimeType,
    md5Checksum: file.md5Checksum ?? "",
    modifiedTime: file.modifiedTime ?? "",
  };
  const createdTime = file.createdTime ?? previous?.createdTime;
  if (createdTime !== undefined) entry.createdTime = createdTime;
  if (previous?.shared !== undefined) entry.shared = previous.shared;
  if (previous?.webViewLink !== undefined) entry.webViewLink = previous.webViewLink;
  if (previous?.publicPath !== undefined) entry.publicPath = previous.publicPath;
  // Upload responses carry the new size; otherwise the old size is only still
  // right if the content did not change.
  const size = file.size ?? (previous && previous.md5Checksum === entry.md5Checksum ? previous.size : undefined);
  if (size !== undefined) entry.size = size;
  meta.files[file.id] = entry;
  meta.lastUpdatedAt = new Date().toISOString();
  return entry;
}

/** Remove entries; returns whether anything was removed. */
export function removeFilesFromMeta(meta: SyncMeta, fileIds: Iterable<string>): boolean {
  let changed = false;
  for (const id of fileIds) {
    if (meta.files[id]) {
      delete meta.files[id];
      changed = true;
    }
  }
  if (changed) meta.lastUpdatedAt = new Date().toISOString();
  return changed;
}

/**
 * Registry rebuilt from a root listing. Listing fields win; everything else
 * a client stored on the previous entry (publish state, Obsidian `path`, ...)
 * is kept.
 */
export function syncMetaFromListing(files: readonly DriveFile[], previous: SyncMeta | null): SyncMeta {
  const meta = emptySyncMeta();
  for (const file of files) {
    const prev = previous?.files[file.id];
    meta.files[file.id] = {
      ...prev,
      name: file.name,
      mimeType: file.mimeType,
      md5Checksum: file.md5Checksum ?? "",
      modifiedTime: file.modifiedTime ?? "",
      createdTime: file.createdTime ?? prev?.createdTime,
      size: file.size ?? prev?.size,
    };
  }
  return meta;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export interface ReconcileOptions extends DriveOperationOptions {
  /** Whether an untracked root file is registered (default: every listed file). */
  isAdoptable?: (file: DriveFile) => boolean;
  /**
   * Called with the root listing before anything is written — e.g. to refuse
   * duplicate paths. Throwing aborts reconciliation without side effects.
   */
  onListing?: (files: DriveFile[]) => void | Promise<void>;
  /** Rebuild the registry from the listing when none exists (default true). */
  rebuildIfMissing?: boolean;
}

export interface ReconciledSyncMeta {
  meta: SyncMeta | null;
  fileId: string | null;
  /** The root listing used (syncable user files). */
  driveFiles: DriveFile[];
  removedIds: string[];
  refreshedIds: string[];
  addedIds: string[];
}

export function createSyncMetaStore(drive: SyncMetaDrive) {
  /**
   * Find the single `_sync-meta.json`. Duplicates are merged into the newest
   * file and the extras permanently deleted. `meta` is returned when the
   * consolidation already had to parse it.
   */
  async function findMetaFile(accessToken: string, rootFolderId: string, options: DriveOperationOptions = {}): Promise<{ file: DriveFile | null; meta: SyncMeta | null }> {
    const matches = await drive.findFilesByExactName(accessToken, SYNC_META_FILE_NAME, rootFolderId, options);
    const { keep, discard } = pickSyncMetaToKeep(matches);
    if (!keep) return { file: null, meta: null };
    if (discard.length === 0) return { file: keep as DriveFile, meta: null };

    const parsed = await Promise.all(matches.map(async (match) => {
      try {
        return JSON.parse(await drive.readFile(accessToken, match.id, options)) as SyncMeta;
      } catch {
        return null;
      }
    }));
    const valid = parsed.filter((meta): meta is SyncMeta => meta != null);
    const merged = valid.length > 0 ? mergeSyncMetaSnapshots(valid) : null;
    if (merged) await drive.updateFile(accessToken, keep.id, JSON.stringify(merged, null, 2), "application/json", options);
    await Promise.all(discard.map((file) => drive.deleteFile(accessToken, file.id, options).catch((error: unknown) => {
      if (!isNotFound(error)) throw error;
    })));
    return { file: keep as DriveFile, meta: merged };
  }

  /** Current registry and its file id; `meta` is null when missing or unreadable. */
  async function readWithFile(accessToken: string, rootFolderId: string, options: DriveOperationOptions = {}): Promise<{ meta: SyncMeta | null; fileId: string | null }> {
    const { file, meta } = await findMetaFile(accessToken, rootFolderId, options);
    if (!file) return { meta: null, fileId: null };
    if (meta) return { meta, fileId: file.id };
    try {
      return { meta: JSON.parse(await drive.readFile(accessToken, file.id, options)) as SyncMeta, fileId: file.id };
    } catch {
      return { meta: null, fileId: file.id };
    }
  }

  async function read(accessToken: string, rootFolderId: string, options: DriveOperationOptions = {}): Promise<SyncMeta | null> {
    return (await readWithFile(accessToken, rootFolderId, options)).meta;
  }

  /**
   * Write the registry; returns the Drive file id. Repeated writers (push
   * checkpoints) pass the returned id as `knownFileId` to skip the lookup.
   */
  async function write(
    accessToken: string,
    rootFolderId: string,
    meta: SyncMeta,
    options: DriveOperationOptions & { knownFileId?: string | null } = {},
  ): Promise<string> {
    const fileId = options.knownFileId ?? (await findMetaFile(accessToken, rootFolderId, options)).file?.id ?? null;
    const content = JSON.stringify(meta, null, 2);
    if (fileId) {
      await drive.updateFile(accessToken, fileId, content, "application/json", options);
      return fileId;
    }
    return (await drive.createFile(accessToken, SYNC_META_FILE_NAME, content, rootFolderId, "application/json", options)).id;
  }

  /** Rebuild from a full root listing, keeping client-stored fields. */
  async function rebuild(accessToken: string, rootFolderId: string, options: DriveOperationOptions = {}): Promise<SyncMeta> {
    const { meta: existing, fileId } = await readWithFile(accessToken, rootFolderId, options);
    const files = await drive.listUserFiles(accessToken, rootFolderId, options);
    const meta = syncMetaFromListing(files, existing);
    await write(accessToken, rootFolderId, meta, { ...options, knownFileId: fileId });
    return meta;
  }

  /** Read–modify–write; `mutate` returns false to skip the write. */
  async function update(
    accessToken: string,
    rootFolderId: string,
    mutate: (meta: SyncMeta) => boolean | void,
    options: DriveOperationOptions = {},
  ): Promise<SyncMeta> {
    const { meta: current, fileId } = await readWithFile(accessToken, rootFolderId, options);
    const meta = current ?? emptySyncMeta();
    if (mutate(meta) === false) return meta;
    meta.lastUpdatedAt = new Date().toISOString();
    await write(accessToken, rootFolderId, meta, { ...options, knownFileId: fileId });
    return meta;
  }

  /** Read and reconcile against the root listing, writing back only on change. */
  async function readReconciled(accessToken: string, rootFolderId: string, options: ReconcileOptions = {}): Promise<ReconciledSyncMeta> {
    const { meta, fileId } = await readWithFile(accessToken, rootFolderId, options);
    const driveFiles = await drive.listUserFiles(accessToken, rootFolderId, options);
    await options.onListing?.(driveFiles);
    const result = { fileId, driveFiles, removedIds: [] as string[], refreshedIds: [] as string[], addedIds: [] as string[] };

    if (!meta) {
      if (options.rebuildIfMissing === false) return { ...result, meta: null };
      const adoptable = options.isAdoptable ? driveFiles.filter(options.isAdoptable) : driveFiles;
      const rebuilt = syncMetaFromListing(adoptable, null);
      const writtenId = await write(accessToken, rootFolderId, rebuilt, { ...options, knownFileId: fileId });
      return { ...result, meta: rebuilt, fileId: writtenId, addedIds: Object.keys(rebuilt.files) };
    }

    const listed = new Set(driveFiles.map((file) => file.id));
    for (const id of Object.keys(meta.files).filter((id) => !listed.has(id))) {
      try {
        const file = await drive.getFileMetadata(accessToken, id, options);
        if (isFileRemovedFromSyncRoot(file, rootFolderId)) result.removedIds.push(id);
      } catch (error) {
        if (isNotFound(error)) result.removedIds.push(id);
        else throw error;
      }
    }
    for (const id of result.removedIds) delete meta.files[id];
    result.refreshedIds = refreshDriftedSyncMetaEntries(meta, driveFiles);
    result.addedIds = addUntrackedFilesToSyncMeta(meta, options.isAdoptable ? driveFiles.filter(options.isAdoptable) : driveFiles);

    let writtenId = fileId;
    if (result.removedIds.length > 0 || result.refreshedIds.length > 0 || result.addedIds.length > 0) {
      meta.lastUpdatedAt = new Date().toISOString();
      writtenId = await write(accessToken, rootFolderId, meta, { ...options, knownFileId: fileId });
    }
    return { ...result, meta, fileId: writtenId };
  }

  return { findMetaFile, read, readWithFile, write, rebuild, update, readReconciled };
}

export type SyncMetaStore = ReturnType<typeof createSyncMetaStore>;

// Which paths take part in sync. The system rules are identical for every
// client; clients add their own folders (Obsidian config dir, Desktop
// workspace metadata) through the options.

import { SYNC_META_FILE_NAME, SETTINGS_FILE_NAME, ENCRYPTED_AUTH_FILE_NAME } from "../protocol/sync-meta.ts";

export const SYNC_EXCLUDED_FILE_NAMES = new Set([SYNC_META_FILE_NAME, SETTINGS_FILE_NAME, ENCRYPTED_AUTH_FILE_NAME]);

/** GemiHub system folders at the root of the sync folder. */
export const SYNC_EXCLUDED_PREFIXES = [
  "history/",
  "trash/",
  "sync_conflicts/",
  "__TEMP__/",
  "plugins/",
  "GemiHub/conflict-backups/",
];

/** Folder names excluded at any depth (tooling output, never user content). */
export const SYNC_EXCLUDED_PATH_SEGMENTS = [".git", "node_modules"];

export function isGoogleWorkspaceMimeType(mimeType: string | undefined | null): boolean {
  return Boolean(mimeType?.startsWith("application/vnd.google-apps."));
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\/+/, "");
}

/** A prefix ending in "/" also matches the folder itself ("trash/" ↔ "trash"). */
function matchesPrefix(path: string, prefix: string): boolean {
  if (path.startsWith(prefix)) return true;
  return prefix.endsWith("/") && path === prefix.slice(0, -1);
}

/** GemiHub system files and folders (no client-specific rules). */
export function isProjectInternalPath(fileName: string): boolean {
  const normalized = normalizePath(fileName);
  if (SYNC_EXCLUDED_FILE_NAMES.has(normalized)) return true;
  return SYNC_EXCLUDED_PREFIXES.some((prefix) => matchesPrefix(normalized, prefix));
}

/**
 * A user exclude pattern: a trailing `/` excludes a folder and everything
 * under it; otherwise the pattern is a glob (`*` any characters, `?` one
 * character) matched against the full path or its basename.
 */
export function matchesExcludePattern(path: string, pattern: string): boolean {
  const trimmed = pattern.trim();
  if (!trimmed) return false;
  const normalized = normalizePath(path);
  if (trimmed.endsWith("/")) return matchesPrefix(normalized, trimmed);
  const escaped = trimmed
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  const regex = new RegExp(`^${escaped}$`);
  return regex.test(normalized) || regex.test(normalized.split("/").pop() ?? "");
}

export function isUserExcludedPath(path: string, patterns: readonly string[] = []): boolean {
  return patterns.some((pattern) => matchesExcludePattern(path, pattern));
}

export interface SyncExclusionOptions {
  /** User-defined exclude patterns (see matchesExcludePattern). */
  excludePatterns?: readonly string[];
  /** Additional root-relative folders/prefixes, e.g. Obsidian's config dir + "/". */
  extraPrefixes?: readonly string[];
  /** Additional folder names excluded at any depth. */
  extraSegments?: readonly string[];
  /**
   * Literal roots stripped before matching the system rules. GemiHub's project
   * storage keys carry "gemihub/" in front of history/, trash/, ...; Drive
   * paths never do, so Drive-only clients leave this empty.
   */
  managedRootPrefixes?: readonly string[];
}

/** Whether a path is kept out of sync entirely (never pushed, pulled or listed). */
export function isSyncExcludedPath(fileName: string, options: SyncExclusionOptions = {}): boolean {
  const normalized = normalizePath(fileName);
  if (!normalized) return true;

  const candidates = [normalized];
  for (const root of options.managedRootPrefixes ?? []) {
    if (normalized.startsWith(root)) candidates.push(normalized.slice(root.length));
  }
  if (candidates.some(isProjectInternalPath)) return true;

  const segments = new Set([...SYNC_EXCLUDED_PATH_SEGMENTS, ...(options.extraSegments ?? [])]);
  if (normalized.split("/").slice(0, -1).some((part) => segments.has(part))) return true;
  if ((options.extraPrefixes ?? []).some((prefix) => matchesPrefix(normalized, prefix))) return true;
  return isUserExcludedPath(normalized, options.excludePatterns);
}

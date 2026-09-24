// Conflict backup file names shared by every client, so a backup written by
// one client can be listed and restored to its original path by another.
//
// Format: encodeURIComponent(path) with `_YYYYMMDD_HHMMSS_mmm` (UTC) inserted
// before the extension, e.g. "notes%2Fplan_20260925_064700_123.md".
// The encoded path contains no "/" (backups live in one flat folder) and is
// reversible, unlike the legacy "/" → "_" replacement.

/** `YYYYMMDD_HHMMSS_mmm` in UTC. */
export function conflictBackupTimestamp(now: Date = new Date()): string {
  const iso = now.toISOString(); // 2026-09-25T06:47:00.123Z
  return `${iso.slice(0, 10).replace(/-/g, "")}_${iso.slice(11, 19).replace(/:/g, "")}_${iso.slice(20, 23)}`;
}

function splitExtension(name: string): [base: string, ext: string] {
  const slash = name.lastIndexOf("%2F");
  const segmentStart = slash >= 0 ? slash + 3 : 0;
  const dot = name.lastIndexOf(".");
  // Only a dot inside the last path segment (not leading it) starts an extension.
  return dot > segmentStart ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
}

export function buildConflictBackupName(filePath: string, now: Date = new Date()): string {
  const [base, ext] = splitExtension(encodeURIComponent(filePath.replace(/^\/+/, "")));
  return `${base}_${conflictBackupTimestamp(now)}${ext}`;
}

export interface ParsedConflictBackupName {
  /** Best-effort original path (legacy "/" → "_" names cannot be reversed). */
  originalPath: string;
  /** When the backup was taken, if the name carries a timestamp. */
  createdAt: Date | null;
}

const BACKUP_NAME = /^(.+)_(\d{8})_(\d{6})(?:_(\d{3}))?(\.[^.]+)?$/;

/**
 * Parse a backup name written by any GemiHub client version:
 * current names, legacy second-resolution names (`_YYYYMMDD_HHMMSS`) and
 * legacy millisecond names with "/" replaced by "_".
 */
export function parseConflictBackupName(name: string): ParsedConflictBackupName {
  const match = name.match(BACKUP_NAME);
  if (!match) return { originalPath: safeDecode(name), createdAt: null };
  const [, base, date, time, millis, ext] = match;
  const createdAt = new Date(Date.UTC(
    Number(date.slice(0, 4)), Number(date.slice(4, 6)) - 1, Number(date.slice(6, 8)),
    Number(time.slice(0, 2)), Number(time.slice(2, 4)), Number(time.slice(4, 6)),
    Number(millis ?? 0),
  ));
  return {
    originalPath: safeDecode(base + (ext ?? "")),
    createdAt: Number.isNaN(createdAt.getTime()) ? null : createdAt,
  };
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

// File type classification shared by every GemiHub client: which files are
// synced as text vs. base64 binary, and which MIME type a new Drive file gets.
// One table for all clients, so a file created on one side is typed the same
// way everywhere.

const MIME_BY_EXTENSION: Record<string, string> = {
  // Markdown / plain text
  md: "text/markdown",
  markdown: "text/markdown",
  txt: "text/plain",
  log: "text/plain",
  // GemiHub / Obsidian structured files
  base: "text/yaml",
  kanban: "text/yaml",
  dashboard: "text/yaml",
  workflow: "text/yaml",
  canvas: "application/json",
  desktop: "application/json",
  audioscore: "application/json",
  // Data
  json: "application/json",
  jsonl: "application/jsonl",
  yaml: "text/yaml",
  yml: "text/yaml",
  toml: "application/toml",
  csv: "text/csv",
  xml: "application/xml",
  // Web / code
  html: "text/html",
  htm: "text/html",
  css: "text/css",
  js: "text/javascript",
  mjs: "text/javascript",
  cjs: "text/javascript",
  jsx: "text/javascript",
  ts: "text/typescript",
  tsx: "text/typescript",
  py: "text/x-python",
  sh: "application/x-sh",
  sql: "application/sql",
  // Images
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  bmp: "image/bmp",
  ico: "image/x-icon",
  // Documents
  pdf: "application/pdf",
  epub: "application/epub+zip",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  odt: "application/vnd.oasis.opendocument.text",
  ods: "application/vnd.oasis.opendocument.spreadsheet",
  odp: "application/vnd.oasis.opendocument.presentation",
  // Archives
  zip: "application/zip",
  gz: "application/gzip",
  tar: "application/x-tar",
  bz2: "application/x-bzip2",
  "7z": "application/x-7z-compressed",
  rar: "application/x-rar-compressed",
  wasm: "application/wasm",
  // Audio
  mp3: "audio/mpeg",
  wav: "audio/wav",
  flac: "audio/flac",
  aac: "audio/aac",
  m4a: "audio/mp4",
  opus: "audio/opus",
  mid: "audio/midi",
  midi: "audio/midi",
  // Video (ogg is ambiguous; video covers both in browsers)
  mp4: "video/mp4",
  webm: "video/webm",
  ogg: "video/ogg",
  mov: "video/quicktime",
  avi: "video/x-msvideo",
  mkv: "video/x-matroska",
  // Fonts
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
};

/** Extensions always synced as text, whatever MIME type Drive reports. */
const TEXT_FILE_EXTENSIONS = new Set([
  "md", "markdown", "txt", "log",
  "base", "kanban", "dashboard", "workflow", "canvas", "desktop", "audioscore",
  "json", "jsonl", "yaml", "yml", "toml", "csv", "xml", "ini", "cfg", "conf",
  "html", "htm", "css", "js", "mjs", "cjs", "jsx", "ts", "tsx",
  "py", "rb", "go", "rs", "java", "c", "cc", "cpp", "h", "hpp", "sh", "sql",
]);

/** Extensions always synced as binary (base64). */
const BINARY_FILE_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico",
  "pdf", "epub", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt", "ods", "odp",
  "zip", "gz", "tar", "bz2", "7z", "rar", "wasm",
  "mp3", "wav", "flac", "aac", "m4a", "opus", "mid", "midi",
  "mp4", "webm", "ogg", "mov", "avi", "mkv",
  "woff", "woff2", "ttf", "otf",
  "exe", "dll", "so", "dylib",
]);

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico"]);

const BINARY_APPLICATION_TYPES = new Set([
  "application/pdf",
  "application/epub+zip",
  "application/zip",
  "application/gzip",
  "application/x-tar",
  "application/x-gzip",
  "application/x-bzip2",
  "application/x-7z-compressed",
  "application/x-rar-compressed",
  "application/octet-stream",
  "application/wasm",
]);

const BINARY_APPLICATION_PREFIXES = [
  "application/vnd.openxmlformats-",  // docx, xlsx, pptx
  "application/vnd.ms-",              // doc, xls, ppt
  "application/vnd.oasis.opendocument.", // odt, ods, odp
];

/**
 * Lower-cased extension of the last path segment, or "" when there is none.
 * A leading dot (".gitignore") is a name, not an extension.
 */
export function fileExtension(fileName: string | undefined | null): string {
  const name = (fileName ?? "").split(/[\\/]/).pop()?.toLowerCase() ?? "";
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1) : "";
}

export function isBinaryMimeType(mimeType: string | undefined | null): boolean {
  if (!mimeType) return false;
  if (
    mimeType.startsWith("image/") ||
    mimeType.startsWith("video/") ||
    mimeType.startsWith("audio/") ||
    mimeType.startsWith("font/")
  ) return true;
  if (BINARY_APPLICATION_TYPES.has(mimeType)) return true;
  return BINARY_APPLICATION_PREFIXES.some((p) => mimeType.startsWith(p));
}

function isTextMimeType(mimeType: string): boolean {
  return mimeType.startsWith("text/")
    || /^application\/(json|jsonl|xml|yaml|x-yaml|toml|javascript|typescript|sql|x-sh)(;|$)/.test(mimeType);
}

export function isTextFileName(fileName: string | undefined | null): boolean {
  return TEXT_FILE_EXTENSIONS.has(fileExtension(fileName));
}

export function isBinaryFileName(fileName: string | undefined | null): boolean {
  return BINARY_FILE_EXTENSIONS.has(fileExtension(fileName));
}

/** Check if a file name has an image extension (for thumbnail display). */
export function isImageFileName(name: string): boolean {
  return IMAGE_EXTENSIONS.has(fileExtension(name));
}

/**
 * Whether a file must be synced as base64 binary instead of UTF-8 text.
 *
 * Known text extensions win over the MIME type (Drive often reports
 * application/octet-stream for .base/.dashboard). Without a conclusive
 * extension the Drive MIME type decides; an unknown extension with no usable
 * MIME type is treated as binary, because decoding arbitrary bytes as UTF-8
 * and writing them back corrupts the file. Extensionless files are text.
 */
export function shouldTreatAsBinaryFile(
  fileName: string | undefined | null,
  mimeType?: string | undefined | null,
): boolean {
  if (isTextFileName(fileName)) return false;
  if (isBinaryFileName(fileName)) return true;
  if (mimeType) {
    if (isBinaryMimeType(mimeType)) return true;
    if (isTextMimeType(mimeType)) return false;
  }
  return fileExtension(fileName) !== "";
}

/** MIME type for creating/updating a Drive file from its path. */
export function guessMimeType(fileName: string): string {
  const ext = fileExtension(fileName);
  const known = MIME_BY_EXTENSION[ext];
  if (known) return known;
  if (!ext || isTextFileName(fileName)) return "text/plain";
  return "application/octet-stream";
}

/**
 * Heuristic: check if content looks like binary data.
 * Inspects the first 512 characters for non-printable characters
 * (excluding \t, \n, \r). If >= 10% are control chars, treat as binary.
 */
export function looksLikeBinary(content: string): boolean {
  const sample = content.slice(0, 512);
  if (sample.length === 0) return false;
  let controlCount = 0;
  for (let i = 0; i < sample.length; i++) {
    const code = sample.charCodeAt(i);
    // Allow tab (9), newline (10), carriage return (13)
    if (code < 32 && code !== 9 && code !== 10 && code !== 13) {
      controlCount++;
    }
  }
  return controlCount / sample.length >= 0.1;
}

/** Files larger than this threshold are not cached locally (20 MB). */
export const LARGE_FILE_CACHE_THRESHOLD = 20 * 1024 * 1024;

/** Returns true if the file exceeds the cache size threshold. */
export function isLargeFile(size: string | number | undefined | null): boolean {
  if (size === undefined || size === null || size === "") return false;
  const bytes = Number(size);
  return !Number.isNaN(bytes) && bytes > LARGE_FILE_CACHE_THRESHOLD;
}

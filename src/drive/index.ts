// Google Drive v3 REST client shared by GemiHub web (server + browser),
// Obsidian and Desktop. The HTTP layer is injected (`DriveTransport`): fetch,
// Obsidian `requestUrl` or a desktop plugin network API all fit, so request
// building, pagination, multipart bodies, retries and errors are identical
// everywhere.

import { SYNC_EXCLUDED_FILE_NAMES, isGoogleWorkspaceMimeType } from "../paths/index.ts";

export const DRIVE_API = "https://www.googleapis.com/drive/v3";
export const DRIVE_UPLOAD_API = "https://www.googleapis.com/upload/drive/v3";
export const DRIVE_FOLDER_MIME_TYPE = "application/vnd.google-apps.folder";

const FILE_FIELDS = "id,name,mimeType,modifiedTime,createdTime,webViewLink,md5Checksum,size";
const METADATA_FIELDS = "id,name,mimeType,modifiedTime,createdTime,parents,trashed,webViewLink,md5Checksum,size";

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime?: string;
  createdTime?: string;
  parents?: string[];
  trashed?: boolean;
  webViewLink?: string;
  md5Checksum?: string;
  size?: string;
}

interface DriveListResponse {
  files: DriveFile[];
  nextPageToken?: string;
}

export interface DriveOperationOptions {
  signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

export interface DriveHttpRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string | Uint8Array;
  signal?: AbortSignal;
}

/** The subset of the Fetch `Response` the client reads. */
export interface DriveHttpResponse {
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
  json(): Promise<unknown>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export type DriveTransport<R extends DriveHttpResponse = DriveHttpResponse> = (request: DriveHttpRequest) => Promise<R>;

/**
 * Transport over the Fetch API. `fetch` is looked up per request, so tests
 * that replace `globalThis.fetch` keep working. Requests without a caller
 * signal time out after `timeoutMs`.
 */
export function fetchTransport(options: { fetch?: typeof fetch; timeoutMs?: number } = {}): DriveTransport<Response> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  return (request) => (options.fetch ?? globalThis.fetch)(request.url, {
    method: request.method,
    headers: request.headers,
    body: request.body as BodyInit | undefined,
    signal: request.signal ?? (timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined),
  });
}

/** Adapt a response whose headers are a plain object (Obsidian, desktop plugins). */
export function headersFromRecord(headers: Record<string, string> | undefined): DriveHttpResponse["headers"] {
  const lower = Object.fromEntries(Object.entries(headers ?? {}).map(([key, value]) => [key.toLowerCase(), value]));
  return { get: (name) => lower[name.toLowerCase()] ?? null };
}

export class DriveApiError extends Error {
  readonly status: number;
  readonly responseText: string;

  constructor(status: number, responseText: string) {
    super(`Drive API error ${status}: ${responseText.slice(0, 500)}`);
    this.name = "DriveApiError";
    this.status = status;
    this.responseText = responseText;
  }
}

export function isDriveNotFoundError(error: unknown): boolean {
  return error instanceof DriveApiError ? error.status === 404 : error instanceof Error && /\b404\b/.test(error.message);
}

/** Escape a value for use in Drive API query strings (single-quote contexts). */
export function escapeDriveQuery(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

// ---------------------------------------------------------------------------
// Encoding helpers (no Buffer: must run in browsers and plugin hosts)
// ---------------------------------------------------------------------------

function toBytes(content: Uint8Array | ArrayBuffer): Uint8Array {
  return content instanceof Uint8Array ? content : new Uint8Array(content);
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function multipartBoundary(): string {
  return `-------boundary${Date.now()}${Math.random().toString(16).slice(2)}`;
}

function multipartHead(boundary: string, metadata: object, mimeType: string): string {
  return `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n`
    + `--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export interface DriveClientOptions {
  /** Retries after a retryable status (default 2). */
  retries?: number;
  /** Statuses retried with backoff (default 429, 500, 503). */
  retryStatuses?: readonly number[];
  /** Upper bound for a Retry-After wait (default 10 s). */
  maxRetryDelayMs?: number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export interface DriveRequestInit extends DriveOperationOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Uint8Array;
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new Error("Aborted"));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error("Aborted"));
    }, { once: true });
  });
}

export function createDriveClient<R extends DriveHttpResponse>(transport: DriveTransport<R>, options: DriveClientOptions = {}) {
  const retries = options.retries ?? 2;
  const retryStatuses = new Set(options.retryStatuses ?? [429, 500, 503]);
  const maxRetryDelayMs = options.maxRetryDelayMs ?? 10_000;
  const sleep = options.sleep ?? defaultSleep;
  const subFolderInflight = new Map<string, Promise<string>>();

  /** Authorized request with retry; throws DriveApiError on a non-2xx status. */
  async function request(url: string, accessToken: string, init: DriveRequestInit = {}): Promise<R> {
    for (let attempt = 0; ; attempt++) {
      const response = await transport({
        url,
        method: init.method ?? "GET",
        headers: { Authorization: `Bearer ${accessToken}`, ...init.headers },
        body: init.body,
        signal: init.signal,
      });
      if (retryStatuses.has(response.status) && attempt < retries) {
        const retryAfter = Number.parseInt(response.headers.get("retry-after") ?? "", 10);
        const delay = Math.min(maxRetryDelayMs, (Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 2) * 1000);
        await sleep(delay, init.signal);
        continue;
      }
      if (response.status < 200 || response.status >= 300) {
        let text = "";
        try {
          text = await response.text();
        } catch {
          // body unavailable
        }
        throw new DriveApiError(response.status, text);
      }
      return response;
    }
  }

  async function requestJson<T>(url: string, accessToken: string, init: DriveRequestInit = {}): Promise<T> {
    return (await (await request(url, accessToken, init)).json()) as T;
  }

  async function listQuery(
    accessToken: string,
    query: string,
    fields: string,
    extra: Record<string, string>,
    options: DriveOperationOptions & { limit?: number } = {},
  ): Promise<DriveFile[]> {
    const files: DriveFile[] = [];
    let pageToken: string | undefined;
    do {
      const url = new URL(`${DRIVE_API}/files`);
      url.searchParams.set("q", query);
      url.searchParams.set("fields", `nextPageToken,files(${fields})`);
      for (const [key, value] of Object.entries(extra)) url.searchParams.set(key, value);
      if (pageToken) url.searchParams.set("pageToken", pageToken);
      const data = await requestJson<DriveListResponse>(url.toString(), accessToken, { signal: options.signal });
      files.push(...(data.files ?? []));
      pageToken = data.nextPageToken;
    } while (pageToken && (options.limit === undefined || files.length < options.limit));
    return files;
  }

  async function createFolder(accessToken: string, name: string, parentId?: string, options: DriveOperationOptions = {}): Promise<DriveFile> {
    return requestJson<DriveFile>(`${DRIVE_API}/files`, accessToken, {
      method: "POST",
      signal: options.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, mimeType: DRIVE_FOLDER_MIME_TYPE, ...(parentId ? { parents: [parentId] } : {}) }),
    });
  }

  async function findFolderByName(accessToken: string, name: string, parentId?: string, options: DriveOperationOptions = {}): Promise<DriveFile | null> {
    let query = `name='${escapeDriveQuery(name)}' and mimeType='${DRIVE_FOLDER_MIME_TYPE}' and trashed=false`;
    if (parentId) query += ` and '${parentId}' in parents`;
    const data = await requestJson<DriveListResponse>(
      `${DRIVE_API}/files?q=${encodeURIComponent(query)}&fields=files(id,name,mimeType)&pageSize=1`,
      accessToken,
      { signal: options.signal },
    );
    return data.files?.[0] ?? null;
  }

  /** Find or create a top-level app folder (e.g. "gemihub"). */
  async function ensureRootFolder(accessToken: string, name: string, options: DriveOperationOptions = {}): Promise<string> {
    const existing = await findFolderByName(accessToken, name, undefined, options);
    return existing ? existing.id : (await createFolder(accessToken, name, undefined, options)).id;
  }

  /** Find or create a child folder; concurrent calls for the same folder share one request. */
  function ensureSubFolder(accessToken: string, parentId: string, name: string, options: DriveOperationOptions = {}): Promise<string> {
    const key = `${parentId}:${name}`;
    const inflight = subFolderInflight.get(key);
    if (inflight) return inflight;
    const promise = (async () => {
      const existing = await findFolderByName(accessToken, name, parentId, options);
      return existing ? existing.id : (await createFolder(accessToken, name, parentId, options)).id;
    })().finally(() => subFolderInflight.delete(key));
    subFolderInflight.set(key, promise);
    return promise;
  }

  /** Ensure "a/b/c" exists under `rootFolderId`; returns the deepest folder id. */
  async function ensureFolderPath(accessToken: string, rootFolderId: string, folderPath: string, options: DriveOperationOptions = {}): Promise<string> {
    let parentId = rootFolderId;
    for (const part of folderPath.split("/").filter(Boolean)) {
      parentId = await ensureSubFolder(accessToken, parentId, part, options);
    }
    return parentId;
  }

  /** All non-trashed children of a folder, newest first (paginated). */
  function listFiles(accessToken: string, folderId: string, mimeType?: string, options: DriveOperationOptions = {}): Promise<DriveFile[]> {
    let query = `'${folderId}' in parents and trashed=false`;
    if (mimeType) query += ` and mimeType='${mimeType}'`;
    return listQuery(accessToken, query, FILE_FIELDS, { orderBy: "modifiedTime desc", pageSize: "1000" }, options);
  }

  /**
   * Syncable files in the flat root: no folders, no GemiHub system files and
   * no Workspace-native files (Docs/Sheets/Slides have no alt=media content).
   */
  async function listUserFiles(accessToken: string, rootFolderId: string, options: DriveOperationOptions = {}): Promise<DriveFile[]> {
    return (await listFiles(accessToken, rootFolderId, undefined, options)).filter((file) =>
      file.mimeType !== DRIVE_FOLDER_MIME_TYPE
      && !isGoogleWorkspaceMimeType(file.mimeType)
      && !SYNC_EXCLUDED_FILE_NAMES.has(file.name));
  }

  function listFolders(accessToken: string, parentId: string, options: DriveOperationOptions = {}): Promise<DriveFile[]> {
    const query = `'${parentId}' in parents and mimeType='${DRIVE_FOLDER_MIME_TYPE}' and trashed=false`;
    return listQuery(accessToken, query, "id,name,mimeType", { orderBy: "name" }, options);
  }

  /** Name search (optionally full text) inside a folder, capped at `limit` results. */
  function searchFiles(accessToken: string, folderId: string, text: string, searchContent = false, options: DriveOperationOptions & { limit?: number } = {}): Promise<DriveFile[]> {
    const field = searchContent ? "fullText" : "name";
    const query = `${field} contains '${escapeDriveQuery(text)}' and '${folderId}' in parents and trashed=false`;
    return listQuery(accessToken, query, FILE_FIELDS, { pageSize: "100" }, { signal: options.signal, limit: options.limit ?? 1000 });
  }

  /** All non-folder files with an exact name (duplicates included). */
  async function findFilesByExactName(accessToken: string, name: string, parentId?: string, options: DriveOperationOptions = {}): Promise<DriveFile[]> {
    let query = `name='${escapeDriveQuery(name)}' and mimeType!='${DRIVE_FOLDER_MIME_TYPE}' and trashed=false`;
    if (parentId) query += ` and '${parentId}' in parents`;
    const data = await requestJson<DriveListResponse>(
      `${DRIVE_API}/files?q=${encodeURIComponent(query)}&fields=files(id,name,mimeType,modifiedTime,md5Checksum)&pageSize=100`,
      accessToken,
      { signal: options.signal },
    );
    return data.files ?? [];
  }

  async function findFileByExactName(accessToken: string, name: string, parentId?: string, options: DriveOperationOptions = {}): Promise<DriveFile | null> {
    return (await findFilesByExactName(accessToken, name, parentId, options))[0] ?? null;
  }

  async function readFile(accessToken: string, fileId: string, options: DriveOperationOptions = {}): Promise<string> {
    return (await request(`${DRIVE_API}/files/${fileId}?alt=media`, accessToken, { signal: options.signal })).text();
  }

  /** Raw media response (streaming callers read the body themselves). */
  function readFileResponse(accessToken: string, fileId: string, options: DriveOperationOptions = {}): Promise<R> {
    return request(`${DRIVE_API}/files/${fileId}?alt=media`, accessToken, { signal: options.signal });
  }

  async function readFileBytes(accessToken: string, fileId: string, options: DriveOperationOptions = {}): Promise<Uint8Array> {
    return new Uint8Array(await (await readFileResponse(accessToken, fileId, options)).arrayBuffer());
  }

  async function readFileBase64(accessToken: string, fileId: string, options: DriveOperationOptions = {}): Promise<string> {
    return bytesToBase64(await readFileBytes(accessToken, fileId, options));
  }

  function getFileMetadata(accessToken: string, fileId: string, options: DriveOperationOptions = {}): Promise<DriveFile> {
    return requestJson<DriveFile>(`${DRIVE_API}/files/${fileId}?fields=${METADATA_FIELDS}`, accessToken, { signal: options.signal });
  }

  function uploadMultipart(accessToken: string, metadata: object, body: string | Uint8Array, boundary: string, options: DriveOperationOptions): Promise<DriveFile> {
    return requestJson<DriveFile>(`${DRIVE_UPLOAD_API}/files?uploadType=multipart&fields=${FILE_FIELDS}`, accessToken, {
      method: "POST",
      signal: options.signal,
      headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
      body,
    });
  }

  function createFile(accessToken: string, name: string, content: string, parentId: string, mimeType = "text/plain", options: DriveOperationOptions = {}): Promise<DriveFile> {
    const metadata = { name, parents: [parentId], mimeType };
    const boundary = multipartBoundary();
    const body = `${multipartHead(boundary, metadata, mimeType)}${content}\r\n--${boundary}--`;
    return uploadMultipart(accessToken, metadata, body, boundary, options);
  }

  function createFileBinary(accessToken: string, name: string, content: Uint8Array | ArrayBuffer, parentId: string, mimeType = "application/octet-stream", options: DriveOperationOptions = {}): Promise<DriveFile> {
    const metadata = { name, parents: [parentId], mimeType };
    const boundary = multipartBoundary();
    const encoder = new TextEncoder();
    const body = concatBytes([
      encoder.encode(multipartHead(boundary, metadata, mimeType)),
      toBytes(content),
      encoder.encode(`\r\n--${boundary}--`),
    ]);
    return uploadMultipart(accessToken, metadata, body, boundary, options);
  }

  function updateMedia(accessToken: string, fileId: string, body: string | Uint8Array, mimeType: string, options: DriveOperationOptions): Promise<DriveFile> {
    return requestJson<DriveFile>(`${DRIVE_UPLOAD_API}/files/${fileId}?uploadType=media&fields=${FILE_FIELDS}`, accessToken, {
      method: "PATCH",
      signal: options.signal,
      headers: { "Content-Type": mimeType },
      body,
    });
  }

  function updateFile(accessToken: string, fileId: string, content: string, mimeType = "text/plain", options: DriveOperationOptions = {}): Promise<DriveFile> {
    return updateMedia(accessToken, fileId, content, mimeType, options);
  }

  function updateFileBinary(accessToken: string, fileId: string, content: Uint8Array | ArrayBuffer, mimeType = "application/octet-stream", options: DriveOperationOptions = {}): Promise<DriveFile> {
    return updateMedia(accessToken, fileId, toBytes(content), mimeType, options);
  }

  function renameFile(accessToken: string, fileId: string, newName: string, options: DriveOperationOptions = {}): Promise<DriveFile> {
    return requestJson<DriveFile>(`${DRIVE_API}/files/${fileId}?fields=${FILE_FIELDS}`, accessToken, {
      method: "PATCH",
      signal: options.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: newName }),
    });
  }

  function moveFile(accessToken: string, fileId: string, newParentId: string, oldParentId: string, options: DriveOperationOptions = {}): Promise<DriveFile> {
    const url = `${DRIVE_API}/files/${fileId}?addParents=${encodeURIComponent(newParentId)}&removeParents=${encodeURIComponent(oldParentId)}&fields=id,name,mimeType,parents`;
    return requestJson<DriveFile>(url, accessToken, { method: "PATCH", signal: options.signal });
  }

  /** Permanent delete (temp/system files; user files go to the trash/ folder). */
  async function deleteFile(accessToken: string, fileId: string, options: DriveOperationOptions = {}): Promise<void> {
    await request(`${DRIVE_API}/files/${fileId}`, accessToken, { method: "DELETE", signal: options.signal });
  }

  function copyFile(accessToken: string, fileId: string, name: string, parentId: string, options: DriveOperationOptions = {}): Promise<DriveFile> {
    return requestJson<DriveFile>(`${DRIVE_API}/files/${fileId}/copy?fields=${FILE_FIELDS}`, accessToken, {
      method: "POST",
      signal: options.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, parents: [parentId] }),
    });
  }

  return {
    request,
    requestJson,
    createFolder,
    findFolderByName,
    ensureRootFolder,
    ensureSubFolder,
    ensureFolderPath,
    listFiles,
    listUserFiles,
    listFolders,
    searchFiles,
    findFilesByExactName,
    findFileByExactName,
    readFile,
    readFileResponse,
    readFileBytes,
    readFileBase64,
    getFileMetadata,
    createFile,
    createFileBinary,
    updateFile,
    updateFileBinary,
    renameFile,
    moveFile,
    deleteFile,
    copyFile,
  };
}

export type DriveClient<R extends DriveHttpResponse = DriveHttpResponse> = ReturnType<typeof createDriveClient<R>>;

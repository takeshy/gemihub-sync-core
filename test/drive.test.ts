import assert from "node:assert/strict";
import test from "node:test";
import {
  bytesToBase64,
  createDriveClient,
  DriveApiError,
  fetchTransport,
  headersFromRecord,
  isDriveNotFoundError,
  type DriveHttpRequest,
  type DriveHttpResponse,
} from "../src/drive/index.ts";

type Reply = { status?: number; body?: unknown; headers?: Record<string, string>; bytes?: Uint8Array };

function fakeTransport(replies: Array<Reply | ((request: DriveHttpRequest) => Reply)>) {
  const requests: DriveHttpRequest[] = [];
  const transport = async (request: DriveHttpRequest): Promise<DriveHttpResponse> => {
    requests.push(request);
    const next = replies.shift();
    if (!next) throw new Error(`unexpected request ${request.method} ${request.url}`);
    const reply = typeof next === "function" ? next(request) : next;
    const text = typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body ?? {});
    return {
      status: reply.status ?? 200,
      headers: headersFromRecord(reply.headers),
      text: async () => text,
      json: async () => JSON.parse(text),
      arrayBuffer: async () => (reply.bytes ?? new TextEncoder().encode(text)).slice().buffer,
    };
  };
  return { transport, requests };
}

const noSleep = { sleep: async () => {} };

test("listFiles follows pagination and sends the bearer token", async () => {
  const { transport, requests } = fakeTransport([
    { body: { files: [{ id: "1", name: "a.md", mimeType: "text/markdown" }], nextPageToken: "p2" } },
    { body: { files: [{ id: "2", name: "b.md", mimeType: "text/markdown" }] } },
  ]);
  const drive = createDriveClient(transport, noSleep);
  const files = await drive.listFiles("tok", "root");
  assert.deepEqual(files.map((f) => f.id), ["1", "2"]);
  assert.equal(requests[0].headers.Authorization, "Bearer tok");
  const second = new URL(requests[1].url);
  assert.equal(second.searchParams.get("pageToken"), "p2");
  assert.equal(second.searchParams.get("q"), "'root' in parents and trashed=false");
});

test("listUserFiles drops folders, system files and Workspace-native files", async () => {
  const { transport } = fakeTransport([{ body: { files: [
    { id: "1", name: "a.md", mimeType: "text/markdown" },
    { id: "2", name: "trash", mimeType: "application/vnd.google-apps.folder" },
    { id: "3", name: "_sync-meta.json", mimeType: "application/json" },
    { id: "4", name: "_encrypted-auth.json", mimeType: "application/json" },
    { id: "5", name: "Doc", mimeType: "application/vnd.google-apps.document" },
    { id: "6", name: "history/a.md", mimeType: "text/markdown" },
    { id: "7", name: "nested/node_modules/pkg.js", mimeType: "text/javascript" },
  ] } }]);
  const files = await createDriveClient(transport, noSleep).listUserFiles("tok", "root");
  assert.deepEqual(files.map((f) => f.id), ["1"]);
});

test("does not retry a POST that may already have created a file", async () => {
  const { transport, requests } = fakeTransport([{ status: 503, body: "unavailable" }]);
  const drive = createDriveClient(transport, noSleep);
  await assert.rejects(drive.createFile("tok", "a.md", "content", "root"),
    (error: unknown) => error instanceof DriveApiError && error.status === 503);
  assert.equal(requests.length, 1);
});

test("retries a POST rejected by rate limiting (429 is not processed)", async () => {
  const { transport, requests } = fakeTransport([
    { status: 429, headers: { "Retry-After": "1" } },
    { body: { id: "created", name: "a.md", mimeType: "text/markdown" } },
  ]);
  const file = await createDriveClient(transport, noSleep).createFile("tok", "a.md", "content", "root");
  assert.equal(file.id, "created");
  assert.equal(requests.length, 2);
});

test("a retried DELETE that finds nothing counts as done", async () => {
  const { transport, requests } = fakeTransport([{ status: 503 }, { status: 404, body: "File not found" }]);
  await createDriveClient(transport, noSleep).deleteFile("tok", "f1");
  assert.equal(requests.length, 2);
  const once = fakeTransport([{ status: 404, body: "File not found" }]);
  await assert.rejects(createDriveClient(once.transport, noSleep).deleteFile("tok", "f1"), /404/);
});

test("findFilesByExactName follows every page of duplicate names", async () => {
  const { transport, requests } = fakeTransport([
    { body: { files: [{ id: "first", name: "_sync-meta.json", mimeType: "application/json" }], nextPageToken: "p2" } },
    { body: { files: [{ id: "second", name: "_sync-meta.json", mimeType: "application/json" }] } },
  ]);
  const files = await createDriveClient(transport, noSleep).findFilesByExactName("tok", "_sync-meta.json", "root");
  assert.deepEqual(files.map((file) => file.id), ["first", "second"]);
  assert.equal(new URL(requests[1].url).searchParams.get("pageToken"), "p2");
});

test("retries 429/500/503 with Retry-After, capped, then throws DriveApiError", async () => {
  const waits: number[] = [];
  const { transport, requests } = fakeTransport([
    { status: 429, headers: { "Retry-After": "60" } },
    { status: 500 },
    { status: 503, body: "busy" },
  ]);
  const drive = createDriveClient(transport, { sleep: async (ms) => { waits.push(ms); } });
  await assert.rejects(drive.readFile("tok", "f1"), (error: unknown) =>
    error instanceof DriveApiError && error.status === 503 && error.responseText === "busy");
  assert.equal(requests.length, 3);
  assert.deepEqual(waits, [10_000, 2_000]);
});

test("does not retry client errors; 404 is recognizable", async () => {
  const { transport, requests } = fakeTransport([{ status: 404, body: "File not found" }]);
  const error = await createDriveClient(transport, noSleep).getFileMetadata("tok", "gone").catch((e) => e);
  assert.equal(requests.length, 1);
  assert.equal(isDriveNotFoundError(error), true);
  assert.match(error.message, /Drive API error 404/);
});

test("createFile and createFileBinary send multipart/related bodies", async () => {
  const { transport, requests } = fakeTransport([
    { body: { id: "t", name: "a.md", mimeType: "text/markdown" } },
    { body: { id: "b", name: "x.png", mimeType: "image/png" } },
  ]);
  const drive = createDriveClient(transport, noSleep);
  await drive.createFile("tok", "notes/a.md", "héllo", "root", "text/markdown");
  await drive.createFileBinary("tok", "x.png", new Uint8Array([0, 255, 1]), "root", "image/png");

  const [text, binary] = requests;
  const boundary = text.headers["Content-Type"].split("boundary=")[1];
  assert.match(text.url, /uploadType=multipart/);
  assert.equal(text.body, `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`
    + `{"name":"notes/a.md","parents":["root"],"mimeType":"text/markdown"}\r\n`
    + `--${boundary}\r\nContent-Type: text/markdown\r\n\r\nhéllo\r\n--${boundary}--`);

  assert.ok(binary.body instanceof Uint8Array);
  const binaryBoundary = binary.headers["Content-Type"].split("boundary=")[1];
  const bytes = binary.body as Uint8Array;
  const tail = new TextEncoder().encode(`\r\n--${binaryBoundary}--`);
  const payload = bytes.slice(bytes.length - tail.length - 3, bytes.length - tail.length);
  assert.deepEqual([...payload], [0, 255, 1]);
});

test("ensureSubFolder shares one lookup between concurrent callers and creates when missing", async () => {
  const { transport, requests } = fakeTransport([
    { body: { files: [] } },
    (request) => {
      assert.equal(request.method, "POST");
      assert.deepEqual(JSON.parse(request.body as string), { name: "trash", mimeType: "application/vnd.google-apps.folder", parents: ["root"] });
      return { body: { id: "trash-id", name: "trash", mimeType: "application/vnd.google-apps.folder" } };
    },
  ]);
  const drive = createDriveClient(transport, noSleep);
  const [a, b] = await Promise.all([drive.ensureSubFolder("tok", "root", "trash"), drive.ensureSubFolder("tok", "root", "trash")]);
  assert.equal(a, "trash-id");
  assert.equal(b, "trash-id");
  assert.equal(requests.length, 2);
});

test("readFileBase64 encodes bytes; queries escape quotes", async () => {
  const { transport, requests } = fakeTransport([
    { bytes: new Uint8Array([1, 2, 3, 250]) },
    { body: { files: [{ id: "m", name: "it's.md", mimeType: "text/markdown" }] } },
  ]);
  const drive = createDriveClient(transport, noSleep);
  assert.equal(await drive.readFileBase64("tok", "f"), bytesToBase64(new Uint8Array([1, 2, 3, 250])));
  assert.equal((await drive.findFileByExactName("tok", "it's.md", "root"))?.id, "m");
  assert.match(decodeURIComponent(requests[1].url), /name='it\\'s\.md'/);
});

test("fetchTransport resolves globalThis.fetch per request", async () => {
  const original = globalThis.fetch;
  let seen = "";
  globalThis.fetch = (async (url: string) => { seen = url; return new Response("{}"); }) as typeof fetch;
  try {
    await createDriveClient(fetchTransport(), noSleep).request("https://example.test/x", "tok");
  } finally {
    globalThis.fetch = original;
  }
  assert.equal(seen, "https://example.test/x");
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  buildEncryptedAuthFile,
  buildTokenRefreshRequest,
  decodeMigrationToken,
  decryptEncryptedAuth,
  encodeMigrationToken,
  needsTokenRefresh,
  parseEncryptedAuthFile,
  parseTokenRefreshResponse,
} from "../src/auth/index.ts";
import { encryptPrivateKey, generateKeyPair } from "../src/crypto/index.ts";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/gemihub-crypto.json", import.meta.url), "utf8"));

test("migration tokens round-trip and match GemiHub's Buffer-based encoding", () => {
  const token = { accessToken: "ya29.fixture", rootFolderId: "root-123" };
  const encoded = encodeMigrationToken(token);
  const legacy = Buffer.from(JSON.stringify({ a: token.accessToken, r: token.rootFolderId }));
  for (let i = 0; i < legacy.length; i++) legacy[i] ^= 0x5a;
  assert.equal(encoded, legacy.toString("hex"));
  assert.deepEqual(decodeMigrationToken(` ${encoded.toUpperCase()} `), token);
});

test("decodeMigrationToken rejects malformed tokens", () => {
  assert.throws(() => decodeMigrationToken(""), /Invalid GemiHub sync token/);
  assert.throws(() => decodeMigrationToken("abc"), /Invalid GemiHub sync token/);
  assert.throws(() => decodeMigrationToken("zz"), /Invalid GemiHub sync token/);
  assert.throws(() => decodeMigrationToken(encodeMigrationToken({ accessToken: "", rootFolderId: "r" })), /fields/);
});

test("unlocks _encrypted-auth.json written by GemiHub", async () => {
  const file = parseEncryptedAuthFile(JSON.stringify(fixture.authFile));
  assert.deepEqual(await decryptEncryptedAuth(file, fixture.password), fixture.authPayload);
  await assert.rejects(decryptEncryptedAuth(file, "wrong"), /encryption password/);
});

test("builds _encrypted-auth.json and rejects insecure origins", async () => {
  const { publicKey, privateKey } = await generateKeyPair();
  const { encryptedPrivateKey, salt } = await encryptPrivateKey(privateKey, "pw");
  const keys = { publicKey, encryptedPrivateKey, salt };
  const file = await buildEncryptedAuthFile({ refreshToken: "rt", apiOrigin: "https://a.example/" }, keys);
  assert.deepEqual(await decryptEncryptedAuth(file, "pw"), { refreshToken: "rt", apiOrigin: "https://a.example" });
  const insecure = await buildEncryptedAuthFile({ refreshToken: "rt", apiOrigin: "http://a.example" }, keys);
  await assert.rejects(decryptEncryptedAuth(insecure, "pw"), /HTTPS/);
  assert.throws(() => parseEncryptedAuthFile("{}"), /Invalid _encrypted-auth.json/);
  assert.throws(() => parseEncryptedAuthFile("not json"), /Invalid _encrypted-auth.json/);
});

test("token refresh request and response", () => {
  const request = buildTokenRefreshRequest({ refreshToken: "rt", apiOrigin: "https://a.example" }, "root-1");
  assert.equal(request.url, "https://a.example/api/obsidian/token");
  assert.deepEqual(JSON.parse(request.body), { refreshToken: "rt", rootFolderId: "root-1" });
  assert.throws(() => buildTokenRefreshRequest({ refreshToken: "rt", apiOrigin: "http://a.example" }), /HTTPS/);

  assert.deepEqual(parseTokenRefreshResponse(200, { access_token: "at", expires_in: 60 }, 1000), { accessToken: "at", expiryTime: 61_000 });
  assert.equal(parseTokenRefreshResponse(200, { access_token: "at" }, 0).expiryTime, 3_600_000);
  assert.throws(() => parseTokenRefreshResponse(403, { error: "Premium plan required" }), /Premium plan required/);
  assert.throws(() => parseTokenRefreshResponse(500, null), /HTTP 500/);

  assert.equal(needsTokenRefresh(10 * 60_000, 0), false);
  assert.equal(needsTokenRefresh(4 * 60_000, 0), true);
});

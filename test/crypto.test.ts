import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  decryptData,
  decryptFileContent,
  decryptPrivateKey,
  encryptData,
  encryptFileContent,
  encryptPrivateKey,
  generateKeyPair,
  getEncryptedFileMetadata,
  isEncryptedFile,
  verifyPassword,
} from "../src/crypto/index.ts";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/gemihub-crypto.json", import.meta.url), "utf8"));

test("decrypts files written by GemiHub (format compatibility)", async () => {
  assert.equal(isEncryptedFile(fixture.encryptedFile), true);
  assert.equal(await decryptFileContent(fixture.encryptedFile, fixture.password), fixture.plaintext);
  assert.deepEqual(getEncryptedFileMetadata(fixture.encryptedFile), {
    description: "fixture note",
    publicMetadata: { tag: "demo" },
  });
});

test("decrypts hybrid data written by GemiHub", async () => {
  const privateKey = await decryptPrivateKey(fixture.encryptedPrivateKey, fixture.salt, fixture.password);
  assert.deepEqual(JSON.parse(await decryptData(fixture.authFile.data, privateKey)), fixture.authPayload);
});

test("round-trips key generation, private key protection and hybrid encryption", async () => {
  const { publicKey, privateKey } = await generateKeyPair();
  const { encryptedPrivateKey, salt } = await encryptPrivateKey(privateKey, "pw");
  assert.equal(await verifyPassword(encryptedPrivateKey, salt, "pw"), true);
  assert.equal(await verifyPassword(encryptedPrivateKey, salt, "wrong"), false);
  const unlocked = await decryptPrivateKey(encryptedPrivateKey, salt, "pw");
  assert.equal(await decryptData(await encryptData("héllo", publicKey), unlocked), "héllo");

  const file = await encryptFileContent("body", publicKey, encryptedPrivateKey, salt);
  assert.equal(await encryptFileContent(file, publicKey, encryptedPrivateKey, salt), file, "no double encryption");
  assert.equal(await decryptFileContent(file, "pw"), "body");
});

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { md5Hash, md5HashString } from "../src/hash/index.ts";

test("md5HashString matches RFC 1321 test vectors", () => {
  assert.equal(md5HashString(""), "d41d8cd98f00b204e9800998ecf8427e");
  assert.equal(md5HashString("abc"), "900150983cd24fb0d6963f7d28e17f72");
  assert.equal(md5HashString("message digest"), "f96b697d7cb7938d525a2f31aaf161d0");
});

test("md5Hash matches node:crypto across block boundaries and UTF-8", () => {
  for (const length of [1, 55, 56, 63, 64, 65, 119, 120, 1000, 70_000]) {
    const bytes = new Uint8Array(length).map((_, i) => (i * 31 + 7) & 0xff);
    assert.equal(md5Hash(bytes), createHash("md5").update(bytes).digest("hex"), `length ${length}`);
  }
  assert.equal(md5HashString("日本語"), createHash("md5").update("日本語").digest("hex"));
});

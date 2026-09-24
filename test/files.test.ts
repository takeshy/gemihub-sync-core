import assert from "node:assert/strict";
import test from "node:test";
import { fileExtension, guessMimeType, isLargeFile, shouldTreatAsBinaryFile } from "../src/files/index.ts";

test("shouldTreatAsBinaryFile keeps dashboard-like text files textual despite octet-stream mime", () => {
  assert.equal(shouldTreatAsBinaryFile("Dashboards/home.dashboard", "application/octet-stream"), false);
  assert.equal(shouldTreatAsBinaryFile("Dashboards/Bases/Tips.base", "application/octet-stream"), false);
  assert.equal(shouldTreatAsBinaryFile("workflows/example.yaml", "application/octet-stream"), false);
});

test("shouldTreatAsBinaryFile still treats real binary extensions as binary", () => {
  assert.equal(shouldTreatAsBinaryFile("archive.zip", "application/octet-stream"), true);
  assert.equal(shouldTreatAsBinaryFile("cover.png", ""), true);
});

test("shouldTreatAsBinaryFile without a MIME type: unknown extensions are binary, extensionless files are text", () => {
  assert.equal(shouldTreatAsBinaryFile("notes/plan.md"), false);
  assert.equal(shouldTreatAsBinaryFile("scores/song.audioscore"), false);
  assert.equal(shouldTreatAsBinaryFile("assets/logo.svg"), true);
  assert.equal(shouldTreatAsBinaryFile("data/blob.xyz"), true);
  assert.equal(shouldTreatAsBinaryFile("LICENSE"), false);
  assert.equal(shouldTreatAsBinaryFile(".gitignore"), false);
});

test("shouldTreatAsBinaryFile falls back to the Drive MIME type for unknown extensions", () => {
  assert.equal(shouldTreatAsBinaryFile("data/blob.xyz", "text/plain"), false);
  assert.equal(shouldTreatAsBinaryFile("data/blob.xyz", "application/json"), false);
  assert.equal(shouldTreatAsBinaryFile("data/blob.xyz", "image/heic"), true);
  assert.equal(shouldTreatAsBinaryFile("LICENSE", "application/octet-stream"), true);
});

test("guessMimeType uses one table for every client", () => {
  assert.equal(guessMimeType("a.md"), "text/markdown");
  assert.equal(guessMimeType("Bases/Tips.base"), "text/yaml");
  assert.equal(guessMimeType("board.canvas"), "application/json");
  assert.equal(guessMimeType("photo.JPG"), "image/jpeg");
  assert.equal(guessMimeType("Makefile"), "text/plain");
  assert.equal(guessMimeType("src/main.go"), "text/plain");
  assert.equal(guessMimeType("data/blob.xyz"), "application/octet-stream");
});

test("fileExtension ignores dots in folders and leading dots", () => {
  assert.equal(fileExtension("v1.2/readme"), "");
  assert.equal(fileExtension(".env"), "");
  assert.equal(fileExtension("a/b.TAR.GZ"), "gz");
});

test("isLargeFile accepts string and number sizes", () => {
  assert.equal(isLargeFile("1024"), false);
  assert.equal(isLargeFile(30 * 1024 * 1024), true);
  assert.equal(isLargeFile(undefined), false);
});

import assert from "node:assert/strict";
import test from "node:test";
import { buildConflictBackupName, parseConflictBackupName } from "../src/conflict/index.ts";

const now = new Date(Date.UTC(2026, 8, 25, 6, 47, 0, 123));

test("buildConflictBackupName encodes the path and inserts a millisecond timestamp", () => {
  assert.equal(buildConflictBackupName("notes/plan.md", now), "notes%2Fplan_20260925_064700_123.md");
  assert.equal(buildConflictBackupName("v1.2/README", now), "v1.2%2FREADME_20260925_064700_123");
  assert.equal(buildConflictBackupName(".env", now), ".env_20260925_064700_123");
});

test("parseConflictBackupName round-trips current names", () => {
  const parsed = parseConflictBackupName(buildConflictBackupName("notes/plan.md", now));
  assert.equal(parsed.originalPath, "notes/plan.md");
  assert.equal(parsed.createdAt?.toISOString(), now.toISOString());
});

test("parseConflictBackupName reads legacy GemiHub and Desktop names", () => {
  assert.equal(parseConflictBackupName("notes_plan_20260208_123456.md").originalPath, "notes_plan.md");
  assert.equal(parseConflictBackupName("notes_plan_20260208_123456_789.md").originalPath, "notes_plan.md");
  assert.equal(parseConflictBackupName("README_20260208_123456").originalPath, "README");
});

test("parseConflictBackupName leaves unrelated names untouched", () => {
  const parsed = parseConflictBackupName("manual%20copy.md");
  assert.equal(parsed.originalPath, "manual copy.md");
  assert.equal(parsed.createdAt, null);
});

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { requestIdAfterCreateAttempt } from "@/app/embed/crm/create-request-id";

test("requestIdAfterCreateAttempt: any answer drops the id, refusals included; only a thrown call keeps it", () => {
  assert.equal(requestIdAfterCreateAttempt("abc12345", "answered"), null);
  assert.equal(requestIdAfterCreateAttempt(null, "answered"), null);
  assert.equal(requestIdAfterCreateAttempt("abc12345", "threw"), "abc12345");
});

test("CreateGroupForm: drops the id right after every answer, before branching on ok/mayExist/refusal", () => {
  const src = readFileSync(join(process.cwd(), "src/app/embed/crm/CreateGroupForm.tsx"), "utf8");
  const call = src.indexOf('const json = await callEmbedApi(MANAGE_PATH, "POST", body);');
  assert.ok(call > 0);
  const next = src.slice(call).split("\n")[1].trim();
  assert.equal(next, 'requestId.current = requestIdAfterCreateAttempt(requestId.current, "answered");');
  assert.ok(src.includes('requestId.current = requestIdAfterCreateAttempt(requestId.current, "threw");'));
  assert.equal((src.match(/requestId\.current = null/g) ?? []).length, 0, "no branch-specific reset left over");
});

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import {
  GROUP_RESULT_COPY,
  groupHref,
  parseCandidates,
  parseGroupResult,
  resultForReason,
} from "@/lib/groups/forms";
import { REASON_CONSENT_REQUIRED, REASON_NOT_CONNECTED, reasonMemberCap } from "@/lib/groups/rules";
import { NOINDEX_ROUTES, PUBLIC_ROUTES, SITE_ROUTES } from "@/lib/site/routes";

function form(entries: [string, string][]): FormData {
  const f = new FormData();
  for (const [k, v] of entries) f.append(k, v);
  return f;
}

test("parseCandidates drops contact lines with no usable phone", () => {
  const out = parseCandidates(form([["contact", "c1||Ann"], ["contact", "c2|nonsense|Bob"], ["contact", "c3|+447700900123|Cat"]]));
  assert.deepEqual(out, [{ phone: "+447700900123", ghlContactId: "c3", displayName: "Cat" }]);
});

test("parseCandidates normalises pasted numbers and merges duplicates", () => {
  const out = parseCandidates(form([["pasted", "07700 900123\n+447700900123, 07700 900456"]]));
  assert.deepEqual(out.map((c) => c.phone), ["+447700900123", "+447700900456"]);
  assert.equal(out[0].ghlContactId, null);
});

test("parseCandidates: the contact wins over a pasted number for the same phone", () => {
  const out = parseCandidates(form([["pasted", "07700 900123"], ["contact", "c9|+447700900123|Dee"]]));
  assert.deepEqual(out, [{ phone: "+447700900123", ghlContactId: "c9", displayName: "Dee" }]);
});

test("parseCandidates keeps a name containing a pipe and ignores non-string entries", () => {
  const f = form([["contact", "c1|+447700900123|A|B"]]);
  f.append("contact", new File(["x"], "x.txt"));
  const out = parseCandidates(f);
  assert.equal(out.length, 1);
  assert.equal(out[0].displayName, "A|B");
});

test("parseGroupResult only accepts known codes", () => {
  assert.equal(parseGroupResult("added"), "added");
  assert.equal(parseGroupResult(["posted", "x"]), "posted");
  assert.equal(parseGroupResult("<script>"), null);
  assert.equal(parseGroupResult("toString"), null);
  assert.equal(parseGroupResult(undefined), null);
  for (const k of Object.keys(GROUP_RESULT_COPY)) assert.ok(GROUP_RESULT_COPY[k as keyof typeof GROUP_RESULT_COPY].length > 0);
});

test("resultForReason maps fixed reasons to codes and falls back to refused", () => {
  assert.equal(resultForReason(REASON_CONSENT_REQUIRED, "PingWren"), "consent_required");
  assert.equal(resultForReason(REASON_NOT_CONNECTED, "PingWren"), "not_connected");
  assert.equal(resultForReason(reasonMemberCap("PingWren"), "PingWren"), "member_cap");
  assert.equal(resultForReason("something upstream said this", "PingWren"), "refused");
  assert.equal(GROUP_RESULT_COPY.consent_required, REASON_CONSENT_REQUIRED);
});

test("groupHref builds a deep link with an optional result", () => {
  assert.equal(groupHref("g1"), "/dashboard/groups/g1");
  assert.equal(groupHref("g1", { result: "added" }), "/dashboard/groups/g1?result=added");
  assert.equal(groupHref("a b"), "/dashboard/groups/a%20b");
});

test("groups routes are noindex, not public, and have pages", () => {
  assert.ok(NOINDEX_ROUTES.includes(SITE_ROUTES.groups));
  assert.ok(NOINDEX_ROUTES.includes(SITE_ROUTES.newGroup));
  assert.ok(!PUBLIC_ROUTES.includes(SITE_ROUTES.groups));
  for (const f of [
    "src/app/(app)/dashboard/groups/page.tsx",
    "src/app/(app)/dashboard/groups/new/page.tsx",
    "src/app/(app)/dashboard/groups/[groupId]/page.tsx",
    "src/app/(app)/dashboard/groups/actions.ts",
  ]) assert.ok(existsSync(f), f);
});

/**
 * Multiple numbers per GHL location (Task 3) — `src/lib/sending-number.ts`.
 * `resolveSendingTenant` decides which of a location's numbers an outbound
 * goes out from (the contact's sticky number if it is still one of the
 * location's numbers, else the default); `inboundNumberPrefix` decides the
 * `[label] ` / `[Number N] ` tag on an inbound pushed into GHL. Pure fakes,
 * no Supabase.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { inboundNumberPrefix, resolveSendingTenant, type SendingNumberRepo } from "@/lib/sending-number";
import type { LocationNumber } from "@/lib/types";

const LOC = "loc-1";
const CONTACT = "contact-1";
const T1 = "11111111-1111-4111-8111-111111111111";
const T2 = "22222222-2222-4222-8222-222222222222";
const T3 = "33333333-3333-4333-8333-333333333333";

function fakeRepo(numbers: LocationNumber[], sticky: string | null) {
  const stickyCalls: [string, string][] = [];
  const repo: SendingNumberRepo = {
    async listLocationNumbers(locationId) {
      assert.equal(locationId, LOC);
      return numbers;
    },
    async getStickyTenant(locationId, ghlContactId) {
      stickyCalls.push([locationId, ghlContactId]);
      return sticky;
    },
  };
  return { repo, stickyCalls };
}

const THREE: LocationNumber[] = [
  { tenantId: T1, slot: 1, isDefault: false, label: "Sales" },
  { tenantId: T2, slot: 2, isDefault: true, label: null },
  { tenantId: T3, slot: 3, isDefault: false, label: "Support" },
];

test("resolveSendingTenant: a sticky number beats the default", async () => {
  const { repo, stickyCalls } = fakeRepo(THREE, T3);
  const resolved = await resolveSendingTenant(repo, LOC, CONTACT, T2);
  assert.deepEqual(resolved, { tenantId: T3, slot: 3, label: "Support", multi: true, isDefault: false });
  assert.deepEqual(stickyCalls, [[LOC, CONTACT]]);
});

test("resolveSendingTenant: a sticky tenant that is no longer one of the location's numbers falls back to the default", async () => {
  const { repo } = fakeRepo(THREE, "99999999-9999-4999-8999-999999999999");
  const resolved = await resolveSendingTenant(repo, LOC, CONTACT, T2);
  assert.deepEqual(resolved, { tenantId: T2, slot: 2, label: null, multi: true, isDefault: true });
});

test("resolveSendingTenant: no sticky row -> the default number", async () => {
  const { repo } = fakeRepo(THREE, null);
  const resolved = await resolveSendingTenant(repo, LOC, CONTACT, T2);
  assert.deepEqual(resolved, { tenantId: T2, slot: 2, label: null, multi: true, isDefault: true });
});

test("resolveSendingTenant: multi is true only with more than one number", async () => {
  const one = fakeRepo([{ tenantId: T1, slot: 1, isDefault: true, label: "Main" }], null);
  assert.equal((await resolveSendingTenant(one.repo, LOC, CONTACT, T1)).multi, false);
  const two = fakeRepo(THREE.slice(0, 2), null);
  assert.equal((await resolveSendingTenant(two.repo, LOC, CONTACT, T2)).multi, true);
});

test("resolveSendingTenant: no number rows at all (defensive) -> the account's tenant as the sole default number", async () => {
  const { repo } = fakeRepo([], T3);
  const resolved = await resolveSendingTenant(repo, LOC, CONTACT, T1);
  assert.deepEqual(resolved, { tenantId: T1, slot: 1, label: null, multi: false, isDefault: true });
});

test("inboundNumberPrefix: label when set, else 'Number <slot>'; empty with a single number or an unknown tenant", () => {
  assert.equal(inboundNumberPrefix(THREE, T1), "[Sales] ");
  assert.equal(inboundNumberPrefix(THREE, T2), "[Number 2] ");
  assert.equal(inboundNumberPrefix([{ tenantId: T1, slot: 1, isDefault: true, label: "Main" }], T1), "");
  assert.equal(inboundNumberPrefix(THREE, "99999999-9999-4999-8999-999999999999"), "");
  assert.equal(inboundNumberPrefix([], T1), "");
  assert.equal(inboundNumberPrefix([{ ...THREE[0], label: "  " }, THREE[1]], T1), "[Number 1] ", "a blank label counts as no label");
});

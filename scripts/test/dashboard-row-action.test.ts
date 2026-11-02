import test from "node:test";
import assert from "node:assert/strict";

import { runRowAction, type RowActionDeps, type RowActionRepo } from "@/lib/site/row-action";
import { runOwnedWhatsappAction, NOT_FOUND, type OwnedLocationsRepo } from "@/lib/site/owned-whatsapp";
import { ActivationCapError } from "@/lib/billing/activation";
import type { BillingStatus, GhlAccount } from "@/lib/types";
import { account, fakeStripe, number, numbersRepo } from "./billing-fakes";

function form(fields: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}

function harness(
  opts: {
    status?: BillingStatus;
    stripeFails?: boolean;
    capThrow?: boolean;
    bridgeOk?: boolean;
    activated?: boolean;
    all?: number;
    cap?: number | null;
  } = {},
) {
  const calls: string[] = [];
  const owned = [{ locationId: "loc-1", tenantId: "tenant-1" }];
  const acct = account({ billingStatus: opts.status ?? "active" });
  const nums = numbersRepo([number("tenant-1", opts.activated ? { stripeSubscriptionId: "sub_1", billingStatus: "active" } : {})]);
  const stripe = fakeStripe({ failOn: opts.stripeFails ? ["create", "cancel"] : [] });
  const repo: RowActionRepo = {
    listGhlAccountsForAccount: async () => owned as never,
    getGhlAccountByLocationId: async (id: string) =>
      ({ locationId: id, accountId: id === "loc-1" ? "acc-1" : "acc-2", activatedAt: opts.activated ? "2026-10-01T00:00:00.000Z" : null }) as GhlAccount,
    getAccountById: async () => acct,
    countActivatedAll: async () => opts.all ?? 0,
    setGhlActivated: async (_l, at) => {
      calls.push(`db:${at === null ? "clear" : "set"}`);
      if (opts.capThrow && at !== null) throw new ActivationCapError("platform_cap");
      return 1;
    },
    listNumberBillingForAccount: nums.listNumberBillingForAccount,
    updateNumberBilling: nums.updateNumberBilling,
  };
  const deps: RowActionDeps = {
    activate: {
      ...stripe.deps,
      now: () => new Date("2026-10-16T10:00:00.000Z"),
      platformCap: () => (opts.cap === undefined ? null : opts.cap),
    },
    logout: async (tenantId: string) => {
      calls.push(`bridge:${tenantId}`);
      return opts.bridgeOk === false ? { ok: false, code: "x", message: "x" } : { ok: true };
    },
  };
  return { repo, deps, calls, stripe };
}

const session = { accountId: "acc-1" };

test("a location owned by another account is not_found with no activate or bridge call", async () => {
  const h = harness();
  const href = await runRowAction(h.repo, h.deps, session, form({ intent: "activate", location: "loc-other" }));
  assert.equal(href, "/dashboard?result=not_found");
  const href2 = await runRowAction(h.repo, h.deps, session, form({ intent: "disconnect", location: "loc-other" }));
  assert.equal(href2, "/dashboard?result=not_found");
  assert.deepEqual(h.calls, []);
});

test("an unknown intent is not_found", async () => {
  const h = harness();
  assert.equal(await runRowAction(h.repo, h.deps, session, form({ intent: "delete", location: "loc-1" })), "/dashboard?result=not_found");
  assert.deepEqual(h.calls, []);
});

test("activate: ok, platform_cap, stripe_failed and billing_inactive each give the right result and focus", async () => {
  const f = form({ intent: "activate", location: "loc-1" });
  const ok = harness();
  assert.equal(await runRowAction(ok.repo, ok.deps, session, f), "/dashboard?result=activated&focus=loc-1#row-loc-1");
  assert.deepEqual(ok.stripe.log, ["create:tenant-1:999:trial"]);
  const cap = harness({ cap: 3, all: 3 });
  assert.equal(await runRowAction(cap.repo, cap.deps, session, f), "/dashboard?result=platform_cap&focus=loc-1#row-loc-1");
  const race = harness({ capThrow: true });
  assert.equal(await runRowAction(race.repo, race.deps, session, f), "/dashboard?result=platform_cap&focus=loc-1#row-loc-1");
  const stripe = harness({ stripeFails: true });
  assert.equal(await runRowAction(stripe.repo, stripe.deps, session, f), "/dashboard?result=stripe_failed&focus=loc-1#row-loc-1");
  for (const status of ["pending", "cancelled"] as const) {
    const inactive = harness({ status });
    assert.equal(await runRowAction(inactive.repo, inactive.deps, session, f), "/dashboard?result=billing_inactive&focus=loc-1#row-loc-1");
  }
});

test("deactivate gives deactivated, or deactivated_billing_pending when the Stripe sync failed", async () => {
  const f = form({ intent: "deactivate", location: "loc-1" });
  const ok = harness({ activated: true });
  assert.equal(await runRowAction(ok.repo, ok.deps, session, f), "/dashboard?result=deactivated&focus=loc-1#row-loc-1");
  const pending = harness({ activated: true, stripeFails: true });
  assert.equal(await runRowAction(pending.repo, pending.deps, session, f), "/dashboard?result=deactivated_billing_pending&focus=loc-1#row-loc-1");
  assert.ok(pending.calls.includes("db:clear"));
});

test("disconnect uses the owned tenant id; a bridge failure is bridge_failed", async () => {
  const f = form({ intent: "disconnect", location: "loc-1", tenant: "attacker-tenant" });
  const ok = harness();
  assert.equal(await runRowAction(ok.repo, ok.deps, session, f), "/dashboard?result=disconnected&focus=loc-1#row-loc-1");
  assert.deepEqual(ok.calls, ["bridge:tenant-1"]);
  const bad = harness({ bridgeOk: false });
  assert.equal(await runRowAction(bad.repo, bad.deps, session, f), "/dashboard?result=bridge_failed&focus=loc-1#row-loc-1");
});

test("send-link redirect carries no token", async () => {
  const h = harness();
  const href = await runRowAction(h.repo, h.deps, session, form({ intent: "send-link", location: "loc-1" }));
  assert.equal(href, "/dashboard?result=link&focus=loc-1#row-loc-1");
  assert.doesNotMatch(href, /token|connect/i);
});

test("show-qr goes to ?qr=<id>", async () => {
  const h = harness();
  assert.equal(await runRowAction(h.repo, h.deps, session, form({ intent: "show-qr", location: "loc-1" })), "/dashboard?focus=loc-1&qr=loc-1#row-loc-1");
});

test("the attention filter is preserved", async () => {
  const h = harness();
  assert.equal(
    await runRowAction(h.repo, h.deps, session, form({ intent: "disconnect", location: "loc-1", filter: "attention" })),
    "/dashboard?filter=attention&result=disconnected&focus=loc-1#row-loc-1",
  );
  assert.equal(
    await runRowAction(h.repo, h.deps, session, form({ intent: "nope", location: "loc-1", filter: "attention" })),
    "/dashboard?filter=attention&result=not_found",
  );
});

test("whatsapp actions with a foreign location return NOT_FOUND and never call the bridge", async () => {
  const repo: OwnedLocationsRepo = { listGhlAccountsForAccount: async () => [{ locationId: "loc-1", tenantId: "tenant-1" }] as never };
  const calls: string[] = [];
  const bridge = async (t: string) => {
    calls.push(t);
    return { ok: true as const };
  };
  assert.equal(await runOwnedWhatsappAction(repo, "acc-1", "loc-foreign", bridge), NOT_FOUND);
  assert.deepEqual(calls, []);
  assert.deepEqual(await runOwnedWhatsappAction(repo, "acc-1", "loc-1", bridge), { ok: true });
  assert.deepEqual(calls, ["tenant-1"]);
});

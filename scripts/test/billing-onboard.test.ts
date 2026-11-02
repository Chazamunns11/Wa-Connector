import test from "node:test";
import assert from "node:assert/strict";
import {
  completeSignup,
  createCheckoutForAccount,
  decideCallback,
  pendingFromSignupToken,
  prepareSignup,
  signSignupToken,
  type OnboardRepo,
} from "@/lib/billing/onboard";
process.env.ONBOARD_STATE_SECRET ||= "test-secret-not-used-anywhere-real";
import { signKindedState } from "@/lib/signed-state";
import type { Account } from "@/lib/types";
import { startCheckoutFlow, addCardFlow } from "@/lib/billing/self-serve";

const account = (over: Partial<Account> = {}): Account => ({
  id: "acc-1",
  name: "Acme",
  kind: "business",
  ownerEmail: "a@b.co",
  stripeCustomerId: null,
  stripeSubscriptionId: null,
  billingStatus: "pending",
  trialEndsAt: null,
  cancelledAt: null,
  cleanedUpAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  ...over,
});

function fakeRepo(opts: { profile?: boolean; accounts?: Account[] } = {}) {
  const log: string[] = [];
  const store = new Map<string, Account>((opts.accounts ?? []).map((a) => [a.id, a]));
  const repo: OnboardRepo = {
    async getProfileByEmail() {
      log.push("getProfileByEmail");
      return opts.profile ? { id: "u0", role: "account", accountId: "x" } : null;
    },
    async createAccount(d) {
      log.push(`createAccount:${d.name}:${d.kind}:${d.ownerEmail}`);
      const a = account({ id: "acc-1", name: d.name, kind: d.kind, ownerEmail: d.ownerEmail });
      store.set(a.id, a);
      return a;
    },
    async createProfile(d) {
      log.push(`createProfile:${d.id}:${d.role}:${d.email}:${d.accountId}`);
    },
    async claimGhlAccount(loc, acc) {
      log.push(`claim:${loc}:${acc}`);
      return false;
    },
    async updateAccountBilling(id, patch) {
      log.push(`update:${id}:${JSON.stringify(patch)}`);
      const a = store.get(id);
      if (a) store.set(id, { ...a, ...patch } as Account);
    },
  };
  return { repo, log, store };
}

const verifyClaim = (t: string) => (t === "good-claim" ? { locationId: "loc" } : null);

function deps(log: string[], over: { checkoutOk?: boolean; customerOk?: boolean } = {}) {
  return {
    appUrl: "https://app.test",
    verifyClaim,
    async createCustomer(i: { accountId: string; email: string }) {
      log.push(`customer:${i.accountId}:${i.email}`);
      return over.customerOk === false
        ? ({ ok: false, status: 500, code: null, message: "x" } as const)
        : ({ ok: true, data: { id: "cus_new" } } as const);
    },
    async setup(i: { accountId: string; customerId: string; successUrl: string; cancelUrl: string }) {
      log.push(`setup:${i.accountId}:${i.customerId}:${i.successUrl}:${i.cancelUrl}`);
      return over.checkoutOk === false
        ? ({ ok: false, status: 500, code: null, message: "x" } as const)
        : ({ ok: true, data: { id: "cs_1", url: "https://stripe.test/setup" } } as const);
    },
  };
}

const pending = { accountName: "Acme", kind: "business" as const, claim: null as string | null };
const who = { userId: "u1", email: "A@B.co", pending };

test("prepareSignup creates nothing: it only checks the email and returns the pending signup", async () => {
  const { repo, log } = fakeRepo();
  const out = await prepareSignup(repo, { accountName: "Acme", kind: "business", email: " A@B.co " });
  assert.deepEqual(out, { kind: "send", email: "a@b.co", pending: { accountName: "Acme", kind: "business", claim: null } });
  assert.deepEqual(log, ["getProfileByEmail"]);
});

test("prepareSignup carries the claim token when given", async () => {
  const { repo } = fakeRepo();
  const out = await prepareSignup(repo, { accountName: "Acme", kind: "agency", email: "a@b.co", claim: "tok" });
  assert.deepEqual(out, { kind: "send", email: "a@b.co", pending: { accountName: "Acme", kind: "agency", claim: "tok" } });
});

test("prepareSignup stops at an existing profile", async () => {
  const { repo, log } = fakeRepo({ profile: true });
  assert.deepEqual(await prepareSignup(repo, { accountName: "Acme", kind: "business", email: "a@b.co" }), { kind: "exists" });
  assert.deepEqual(log, ["getProfileByEmail"]);
});

test("a signup token round-trips for the same email, whatever its case", () => {
  const token = signSignupToken("a@b.co", { accountName: " Acme ", kind: "agency", claim: "t" });
  assert.deepEqual(pendingFromSignupToken(token, "A@B.co"), { accountName: "Acme", kind: "agency", claim: "t" });
  const noClaim = signSignupToken("a@b.co", { accountName: "Acme", kind: "business", claim: null });
  assert.deepEqual(pendingFromSignupToken(noClaim, "a@b.co"), { accountName: "Acme", kind: "business", claim: null });
});

test("a signup token is refused for another email, when missing, tampered, expired or of another kind", () => {
  const token = signSignupToken("a@b.co", { accountName: "Acme", kind: "business", claim: null });
  assert.equal(pendingFromSignupToken(token, "victim@b.co"), null);
  assert.equal(pendingFromSignupToken(undefined, "a@b.co"), null);
  assert.equal(pendingFromSignupToken("", "a@b.co"), null);
  assert.equal(pendingFromSignupToken(`${token}x`, "a@b.co"), null);
  assert.equal(pendingFromSignupToken(token, undefined), null);
  const d = { email: "a@b.co", accountName: "Acme", kind: "business", iat: Date.now() };
  assert.ok(pendingFromSignupToken(signKindedState("signup", d, 1000), "a@b.co"));
  assert.equal(pendingFromSignupToken(signKindedState("signup", d, -1), "a@b.co"), null);
  assert.equal(pendingFromSignupToken(signKindedState("ghl-claim", d, 1000), "a@b.co"), null);
  assert.equal(pendingFromSignupToken(signKindedState("signup", { ...d, kind: "owner" }, 1000), "a@b.co"), null);
  assert.equal(pendingFromSignupToken(signKindedState("signup", { ...d, accountName: "A" }, 1000), "a@b.co"), null);
});

test("decideCallback routes by profile first, then by a pending signup, else rejects", () => {
  assert.equal(decideCallback({ role: "owner", accountId: null }, null), "owner");
  assert.equal(decideCallback({ role: "account", accountId: "a" }, null), "dashboard");
  // An existing profile always wins over metadata.
  assert.equal(decideCallback({ role: "account", accountId: "a" }, pending), "dashboard");
  assert.equal(decideCallback(null, pending), "complete_signup");
  assert.equal(decideCallback(null, null), "reject");
  assert.equal(decideCallback({ role: "account", accountId: null }, null), "reject");
  assert.equal(decideCallback({ role: "account", accountId: null }, pending), "reject");
});

test("completeSignup runs account, profile, Stripe customer, then the save-a-card Checkout, bound to the verified email", async () => {
  const { repo, log, store } = fakeRepo();
  const out = await completeSignup(repo, deps(log), who);
  assert.deepEqual(out, { kind: "checkout", url: "https://stripe.test/setup" });
  assert.deepEqual(log, [
    "createAccount:Acme:business:a@b.co",
    "createProfile:u1:account:a@b.co:acc-1",
    "customer:acc-1:a@b.co",
    'update:acc-1:{"stripeCustomerId":"cus_new"}',
    "setup:acc-1:cus_new:https://app.test/signup/complete?session_id={CHECKOUT_SESSION_ID}:https://app.test/login?error=checkout",
  ]);
  assert.equal(store.get("acc-1")!.billingStatus, "pending", "no card until the setup Checkout completes");
});

test("completeSignup claims the verified location after the profile", async () => {
  const { repo, log } = fakeRepo();
  const out = await completeSignup(repo, deps(log), { ...who, pending: { ...pending, claim: "good-claim" } });
  assert.equal(out.kind, "checkout");
  const i = log.indexOf("claim:loc:acc-1");
  assert.ok(i > log.findIndex((l) => l.startsWith("createProfile")) && i >= 0);
});

test("completeSignup ignores a forged or expired claim token", async () => {
  const { repo, log } = fakeRepo();
  const out = await completeSignup(repo, deps(log), { ...who, pending: { ...pending, claim: "forged" } });
  assert.equal(out.kind, "checkout");
  assert.ok(!log.some((l) => l.startsWith("claim:")));
});

test("completeSignup leaves the account behind when the customer or the Checkout fails", async () => {
  for (const over of [{ checkoutOk: false }, { customerOk: false }]) {
    const { repo, log, store } = fakeRepo();
    assert.deepEqual(await completeSignup(repo, deps(log, over), who), { kind: "failed" });
    assert.ok(store.has("acc-1"));
    assert.ok(log.some((l) => l.startsWith("createProfile")));
  }
});

test("createCheckoutForAccount reuses an existing Stripe customer and the account id", async () => {
  const { repo, log } = fakeRepo();
  const out = await createCheckoutForAccount(repo, deps(log), account({ id: "acc-9", ownerEmail: "z@y.co", stripeCustomerId: "cus_9" }));
  assert.equal(out.kind, "checkout");
  assert.equal(log.length, 1);
  assert.match(log[0], /^setup:acc-9:cus_9:/);
});

test("startCheckoutFlow: only an account with no card on file; addCardFlow: only an account with one", async () => {
  for (const status of ["pending", "cancelled", "trialing", "paused"] as const) {
    const { repo, log } = fakeRepo();
    const out = await startCheckoutFlow(repo, account({ billingStatus: status, stripeCustomerId: "cus_1" }), deps(log));
    assert.deepEqual(out, { kind: "redirect", url: "https://stripe.test/setup" }, status);
  }
  for (const status of ["active", "comped"] as const) {
    const { repo, log } = fakeRepo();
    assert.deepEqual(await startCheckoutFlow(repo, account({ billingStatus: status }), deps(log)), { kind: "not_pending" });
    assert.deepEqual(log, []);
  }
  const log: string[] = [];
  const d = deps(log);
  assert.deepEqual(await addCardFlow(account({ billingStatus: "active", stripeCustomerId: "cus_1" }), d), { kind: "redirect", url: "https://stripe.test/setup" });
  assert.match(log[0], /^setup:acc-1:cus_1:https:\/\/app\.test\/dashboard\/billing\?result=card_added:/);
  for (const a of [account({ billingStatus: "pending", stripeCustomerId: "cus_1" }), account({ billingStatus: "active", stripeCustomerId: null }), account({ billingStatus: "comped" })]) {
    assert.deepEqual(await addCardFlow(a, d), { kind: "not_needed" });
  }
});

import test from "node:test";
import assert from "node:assert/strict";
import {
  applyCheckoutSession,
  completeSignup,
  createCheckoutForAccount,
  decideCallback,
  parsePendingSignup,
  prepareSignup,
  type OnboardRepo,
} from "@/lib/billing/onboard";
import type { Account } from "@/lib/types";
import type { StripeCheckoutSession, StripeSubscription } from "@/lib/stripe/billing";

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
    async getAccountById(id) {
      return store.get(id) ?? null;
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

function deps(log: string[], over: { checkoutOk?: boolean } = {}) {
  return {
    appUrl: "https://app.test",
    verifyClaim,
    async checkout(i: { accountId: string; customerEmail: string; successUrl: string; cancelUrl: string }) {
      log.push(`checkout:${i.accountId}:${i.customerEmail}:${i.successUrl}:${i.cancelUrl}`);
      return over.checkoutOk === false
        ? ({ ok: false, status: 500, code: null, message: "x" } as const)
        : ({ ok: true, data: { id: "cs_1", url: "https://stripe.test/pay" } } as const);
    },
  };
}

const pending = { accountName: "Acme", kind: "business" as const, claim: null as string | null };
const who = { userId: "u1", email: "A@B.co", pending };

test("prepareSignup creates nothing: it only checks the email and returns the link metadata", async () => {
  const { repo, log } = fakeRepo();
  const out = await prepareSignup(repo, { accountName: "Acme", kind: "business", email: " A@B.co " });
  assert.deepEqual(out, { kind: "send", email: "a@b.co", data: { accountName: "Acme", kind: "business" } });
  assert.deepEqual(log, ["getProfileByEmail"]);
});

test("prepareSignup carries the claim token in the metadata when given", async () => {
  const { repo } = fakeRepo();
  const out = await prepareSignup(repo, { accountName: "Acme", kind: "agency", email: "a@b.co", claim: "tok" });
  assert.deepEqual(out, { kind: "send", email: "a@b.co", data: { accountName: "Acme", kind: "agency", claim: "tok" } });
});

test("prepareSignup stops at an existing profile", async () => {
  const { repo, log } = fakeRepo({ profile: true });
  assert.deepEqual(await prepareSignup(repo, { accountName: "Acme", kind: "business", email: "a@b.co" }), { kind: "exists" });
  assert.deepEqual(log, ["getProfileByEmail"]);
});

test("parsePendingSignup accepts only well-formed metadata", () => {
  assert.deepEqual(parsePendingSignup({ accountName: " Acme ", kind: "agency", claim: "t" }), { accountName: "Acme", kind: "agency", claim: "t" });
  assert.deepEqual(parsePendingSignup({ accountName: "Acme", kind: "business" }), { accountName: "Acme", kind: "business", claim: null });
  assert.equal(parsePendingSignup(null), null);
  assert.equal(parsePendingSignup("x"), null);
  assert.equal(parsePendingSignup({}), null);
  assert.equal(parsePendingSignup({ accountName: "A", kind: "business" }), null);
  assert.equal(parsePendingSignup({ accountName: "x".repeat(81), kind: "business" }), null);
  assert.equal(parsePendingSignup({ accountName: "Acme", kind: "owner" }), null);
  assert.equal(parsePendingSignup({ accountName: "Acme", kind: "business", claim: 5 })?.claim, null);
  assert.equal(parsePendingSignup({ accountName: "Acme", kind: "business", claim: "y".repeat(201) })?.claim, null);
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

test("completeSignup runs account, profile, Checkout in order, bound to the verified email", async () => {
  const { repo, log } = fakeRepo();
  const out = await completeSignup(repo, deps(log), who);
  assert.deepEqual(out, { kind: "checkout", url: "https://stripe.test/pay" });
  assert.deepEqual(log, [
    "createAccount:Acme:business:a@b.co",
    "createProfile:u1:account:a@b.co:acc-1",
    "checkout:acc-1:a@b.co:https://app.test/signup/complete?session_id={CHECKOUT_SESSION_ID}:https://app.test/login?error=checkout",
  ]);
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

test("completeSignup leaves the account behind when Checkout fails", async () => {
  const { repo, log, store } = fakeRepo();
  assert.deepEqual(await completeSignup(repo, deps(log, { checkoutOk: false }), who), { kind: "failed" });
  assert.ok(store.has("acc-1"));
  assert.ok(log.some((l) => l.startsWith("createProfile")));
});

test("createCheckoutForAccount reuses the account id", async () => {
  const { repo, log } = fakeRepo();
  const d = deps(log);
  const out = await createCheckoutForAccount(repo, d, account({ id: "acc-9", ownerEmail: "z@y.co" }));
  assert.equal(out.kind, "checkout");
  assert.match(log[0], /^checkout:acc-9:z@y\.co:/);
});

const sub = (over: Partial<StripeSubscription> = {}): StripeSubscription => ({
  id: "sub",
  status: "trialing",
  customer: "cus",
  trialEnd: 1_800_000_000,
  canceledAt: null,
  endedAt: null,
  cancelAtPeriodEnd: false,
  currentPeriodEnd: null,
  itemId: "si",
  quantity: 1,
  cardLast4: null,
  metadata: {},
  ...over,
});
const session = (over: Partial<StripeCheckoutSession> = {}): StripeCheckoutSession => ({
  id: "cs_1",
  status: "complete",
  customer: "cus",
  subscription: sub(),
  metadata: { account_id: "acc-1" },
  ...over,
});

test("applyCheckoutSession writes the subscription facts and is idempotent", async () => {
  const { repo, log } = fakeRepo({ accounts: [account()] });
  assert.deepEqual(await applyCheckoutSession(repo, session()), { applied: true, accountId: "acc-1" });
  assert.equal(
    log[0],
    `update:acc-1:${JSON.stringify({
      stripeCustomerId: "cus",
      stripeSubscriptionId: "sub",
      billingStatus: "trialing",
      trialEndsAt: "2027-01-15T08:00:00.000Z",
    })}`,
  );
  assert.deepEqual(await applyCheckoutSession(repo, session()), { applied: true, accountId: "acc-1" });
});

test("applyCheckoutSession ignores incomplete sessions and unknown accounts", async () => {
  const { repo, log } = fakeRepo({ accounts: [account()] });
  assert.equal((await applyCheckoutSession(repo, session({ status: "open" }))).applied, false);
  assert.equal((await applyCheckoutSession(repo, session({ metadata: {} }))).applied, false);
  assert.equal((await applyCheckoutSession(repo, session({ subscription: null }))).applied, false);
  assert.deepEqual(await applyCheckoutSession(repo, session({ metadata: { account_id: "nope" } })), { applied: false, accountId: "nope" });
  assert.equal(log.length, 0);
});

test("applyCheckoutSession keeps the current status for an unmapped subscription status", async () => {
  const { repo, log } = fakeRepo({ accounts: [account({ billingStatus: "pending" })] });
  await applyCheckoutSession(repo, session({ subscription: sub({ status: "incomplete", trialEnd: null }) }));
  assert.match(log[0], /"billingStatus":"pending"/);
  assert.match(log[0], /"trialEndsAt":null/);
});

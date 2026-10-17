import test, { mock } from "node:test";
import assert from "node:assert/strict";
import type { Session } from "@/lib/auth";

let current: Session | null = null;
const redirects: string[] = [];

mock.module("next/navigation", {
  namedExports: {
    redirect: (to: string) => {
      redirects.push(to);
      throw new Error(`NEXT_REDIRECT:${to}`);
    },
  },
});
mock.module("@/lib/auth", { namedExports: { getSession: async () => current } });

async function load() {
  return import("@/lib/account-session");
}

const owner: Session = { profileId: "o", role: "owner", email: "o@x.com", accountId: null };
const noAcc: Session = { profileId: "a", role: "account", email: "a@x.com", accountId: null };
const acc: Session = { profileId: "a", role: "account", email: "a@x.com", accountId: "acc-1" };

test("isAccountSession", async () => {
  const { isAccountSession } = await load();
  assert.equal(isAccountSession(null), false);
  assert.equal(isAccountSession(owner), false);
  assert.equal(isAccountSession(noAcc), false);
  assert.equal(isAccountSession(acc), true);
});

test("requireAccountSession redirects by case and returns an account session", async () => {
  const { requireAccountSession } = await load();
  for (const [s, to] of [
    [null, "/login"],
    [owner, "/admin"],
    [noAcc, "/login?error=no_account"],
  ] as const) {
    current = s;
    redirects.length = 0;
    await assert.rejects(requireAccountSession(), /NEXT_REDIRECT/);
    assert.deepEqual(redirects, [to]);
  }
  current = acc;
  assert.deepEqual(await requireAccountSession(), acc);
});

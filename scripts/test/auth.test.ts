/**
 * `src/lib/auth.ts` — `assertOwner()` is the one gate in front of every /admin
 * server action and the OAuth install routes. It must refuse anything that is
 * not an authenticated `owner` profile: no session at all, and an `account`
 * profile, both throw.
 *
 * Entirely offline: `next/headers`, `@supabase/ssr` (the cookie client that
 * reads the auth user) and `@supabase/supabase-js` (the service-role client
 * that reads the `profiles` row — RLS has no policies on it) are replaced with
 * in-file fakes before `@/lib/auth` is imported.
 */
process.env.NEXT_PUBLIC_SUPABASE_URL ||= "https://test.supabase.example";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= "test-anon-key-not-used-anywhere-real";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "test-service-key-not-used-anywhere-real";

import test, { mock } from "node:test";
import assert from "node:assert/strict";

interface FakeState {
  user: { id: string; email?: string } | null;
  profile: { role: string; email: string } | null;
  profileLookups: string[];
}

const state: FakeState = { user: null, profile: null, profileLookups: [] };

mock.module("next/headers", {
  namedExports: {
    cookies: async () => ({ getAll: () => [], set: () => undefined, get: () => undefined }),
  },
});

mock.module("@supabase/ssr", {
  namedExports: {
    createServerClient: () => ({
      auth: {
        getUser: async () => ({ data: { user: state.user }, error: null }),
      },
    }),
  },
});

mock.module("@supabase/supabase-js", {
  namedExports: {
    createClient: () => ({
      from: (table: string) => ({
        select: () => ({
          eq: (_column: string, id: string) => ({
            maybeSingle: async () => {
              assert.equal(table, "profiles");
              state.profileLookups.push(id);
              return { data: state.profile, error: null };
            },
          }),
        }),
      }),
    }),
  },
});

/** Dynamic (not static) so it resolves AFTER the `mock.module` calls above have registered. */
async function loadAuth() {
  return import("@/lib/auth");
}

function reset(user: FakeState["user"], profile: FakeState["profile"]) {
  state.user = user;
  state.profile = profile;
  state.profileLookups = [];
}

test("assertOwner: no signed-in user -> throws, and no profile lookup is made", async () => {
  const { assertOwner } = await loadAuth();
  reset(null, null);
  await assert.rejects(assertOwner(), /Unauthorized/);
  assert.deepEqual(state.profileLookups, []);
});

test("assertOwner: a signed-in user with no profiles row -> throws", async () => {
  const { assertOwner } = await loadAuth();
  reset({ id: "user-no-profile", email: "nobody@example.com" }, null);
  await assert.rejects(assertOwner(), /Unauthorized/);
  assert.deepEqual(state.profileLookups, ["user-no-profile"]);
});

test("assertOwner: an `account` role -> throws", async () => {
  const { assertOwner } = await loadAuth();
  reset({ id: "user-account", email: "client@example.com" }, { role: "account", email: "client@example.com" });
  await assert.rejects(assertOwner(), /Unauthorized/);
});

test("assertOwner: a profile with an unknown role -> throws", async () => {
  const { assertOwner } = await loadAuth();
  reset({ id: "user-closer", email: "closer@example.com" }, { role: "closer", email: "closer@example.com" });
  await assert.rejects(assertOwner(), /Unauthorized/);
});

test("assertOwner: an `owner` role -> returns the session shape", async () => {
  const { assertOwner } = await loadAuth();
  reset({ id: "user-owner", email: "owner@example.com" }, { role: "owner", email: "owner@example.com" });
  const session = await assertOwner();
  assert.deepEqual(session, { profileId: "user-owner", role: "owner", email: "owner@example.com" });
});

test("getSession: an `account` role is a session, just not an owner one", async () => {
  const { getSession } = await loadAuth();
  reset({ id: "user-account", email: "client@example.com" }, { role: "account", email: "client@example.com" });
  assert.deepEqual(await getSession(), { profileId: "user-account", role: "account", email: "client@example.com" });
});

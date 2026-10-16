#!/usr/bin/env node
/**
 * Operator RLS check (manual, against a live project; not part of `npm test`).
 *
 * Signs in as a real portal user with the ANON key and tries to read every
 * table. Every read must return zero rows or a permission error: the tables
 * have RLS on and no policies, so a signed-in user must see nothing.
 *
 *   SUPABASE_URL=... SUPABASE_ANON_KEY=... SUPABASE_SERVICE_ROLE_KEY=... \
 *   RLS_CHECK_EMAIL=someone@signed-up.example node scripts/rls-check.mjs
 *
 * The service-role key is used only to mint a sign-in token for the email.
 * No secret is ever printed. Exit 0 = pass, 1 = fail.
 */
import { createClient } from "@supabase/supabase-js";

const TABLES = [
  "profiles",
  "accounts",
  "stripe_events",
  "whatsapp_tenants",
  "whatsapp_sessions",
  "whatsapp_session_keys",
  "whatsapp_messages",
  "whatsapp_inbound_messages",
  "ghl_accounts",
  "ghl_outbound_messages",
  "ghl_outbound_attachments",
];

const { SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY, RLS_CHECK_EMAIL } = process.env;
const missing = ["SUPABASE_URL", "SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY", "RLS_CHECK_EMAIL"].filter((k) => !process.env[k]);
if (missing.length) {
  console.error(`Missing environment: ${missing.join(", ")}`);
  process.exit(1);
}

const opts = { auth: { persistSession: false, autoRefreshToken: false } };
const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, opts);
const anon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, opts);

const link = await admin.auth.admin.generateLink({ type: "magiclink", email: RLS_CHECK_EMAIL });
const tokenHash = link.data?.properties?.hashed_token;
if (link.error || !tokenHash) {
  console.error("Could not generate a sign-in token for RLS_CHECK_EMAIL (is that address signed up?).");
  process.exit(1);
}
const verified = await anon.auth.verifyOtp({ token_hash: tokenHash, type: "magiclink" });
if (verified.error || !verified.data?.session) {
  console.error("Could not sign in as RLS_CHECK_EMAIL.");
  process.exit(1);
}

let failed = 0;
for (const table of TABLES) {
  const { data, error } = await anon.from(table).select("*").limit(1);
  if (error) {
    console.log(`PASS  ${table}  (blocked: ${error.code ?? "error"})`);
  } else if (!data || data.length === 0) {
    console.log(`PASS  ${table}  (0 rows)`);
  } else {
    failed += 1;
    console.log(`FAIL  ${table}  (a signed-in user can read rows)`);
  }
}

await anon.auth.signOut();
console.log(failed ? `\n${failed} table(s) readable by a signed-in user.` : "\nAll tables are closed to signed-in users.");
process.exit(failed ? 1 : 0);

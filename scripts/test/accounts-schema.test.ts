import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const sql = readFileSync(join(process.cwd(), "supabase/migrations/0002_accounts.sql"), "utf8");

test("accounts table", () => {
  assert.match(sql, /create table public\.accounts/);
  assert.match(sql, /kind\s+text not null check \(kind in \('agency', 'business'\)\)/);
  assert.match(
    sql,
    /billing_status\s+text not null default 'pending'\s+check \(billing_status in \('pending', 'trialing', 'active', 'past_due', 'paused', 'cancelled', 'comped'\)\)/
  );
  assert.match(sql, /stripe_customer_id\s+text unique/);
  assert.match(sql, /stripe_subscription_id\s+text unique/);
  assert.match(sql, /trial_ends_at\s+timestamptz/);
  assert.match(sql, /cancelled_at\s+timestamptz/);
  assert.match(sql, /cleaned_up_at\s+timestamptz/);
});

test("profiles and ghl_accounts link to accounts", () => {
  assert.match(
    sql,
    /alter table public\.profiles add column account_id uuid references public\.accounts \(id\) on delete restrict/
  );
  assert.match(sql, /update public\.profiles set email = lower\(trim\(email\)\);/);
  assert.match(sql, /create unique index profiles_email_idx on public\.profiles \(email\)/);
  assert.ok(sql.indexOf("set email = lower(trim(email))") < sql.indexOf("create unique index profiles_email_idx"));
  assert.match(
    sql,
    /alter table public\.ghl_accounts add column account_id uuid references public\.accounts \(id\) on delete restrict/
  );
  assert.match(sql, /add column activated_at timestamptz/);
  assert.match(sql, /create index ghl_accounts_account_idx on public\.ghl_accounts \(account_id\)/);
});

test("stripe_events table", () => {
  assert.match(
    sql,
    /create table public\.stripe_events \(\s*id\s+text primary key,\s*type\s+text not null,\s*received_at\s+timestamptz not null default now\(\)/
  );
});

test("RLS on, no policies", () => {
  assert.match(sql, /alter table public\.accounts enable row level security/);
  assert.match(sql, /alter table public\.stripe_events enable row level security/);
  assert.doesNotMatch(sql, /create policy/i);
});

test("updated_at trigger on accounts", () => {
  assert.match(sql, /execute function public\.set_updated_at\(\)/);
});

test("comped convention documented", () => {
  assert.match(sql, /--.*comped/);
  assert.match(sql, /--.*FitClosers/);
});

test("0003: activation function is the DB-side cap, service-role only", () => {
  const cap = readFileSync(join(process.cwd(), "supabase/migrations/0003_activation_cap.sql"), "utf8");
  assert.match(cap, /create function public\.activate_ghl_location/);
  assert.match(cap, /for update/);
  assert.match(cap, /raise exception 'trial_cap'/);
  assert.match(cap, /raise exception 'platform_cap'/);
  assert.match(cap, /activated_at is null/);
  assert.match(cap, /revoke all on function public\.activate_ghl_location\(text, timestamptz, integer\) from public, anon, authenticated/);
  assert.match(cap, />= 3 then/);
});

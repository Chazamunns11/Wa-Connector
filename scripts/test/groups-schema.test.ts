import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const sql = readFileSync(join(process.cwd(), "supabase/migrations/0005_groups.sql"), "utf8");

test("bridge-owned ledgers", () => {
  assert.match(sql, /create table public\.whatsapp_group_jobs/);
  assert.match(sql, /kind\s+text not null check \(kind in \('add', 'create'\)\)/);
  assert.match(sql, /status\s+text not null default 'queued'\s+check \(status in \('queued', 'running', 'done', 'interrupted'\)\)/);
  assert.match(sql, /results\s+jsonb not null default '\[\]'/);
  assert.match(sql, /create table public\.whatsapp_group_posts/);
  assert.match(sql, /constraint whatsapp_group_posts_idempotency unique \(coach_id, idempotency_key\)/);
  assert.match(sql, /check \(status in \('accepted', 'sending', 'sent', 'failed'\)\)/);
});

test("portal-owned groups and members", () => {
  assert.match(sql, /create table public\.whatsapp_groups/);
  assert.match(sql, /wa_group_jid\s+text not null unique/);
  assert.match(sql, /subject\s+text not null check \(char_length\(subject\) between 1 and 100\)/);
  assert.match(sql, /admin_add_only\s+boolean not null default true/);
  assert.match(sql, /create table public\.whatsapp_group_members/);
  assert.match(sql, /phone ~ '\^\\\+\[1-9\]\[0-9\]\{6,14\}\$'/);
  assert.match(sql, /state in \('pending', 'added', 'invite_needed', 'invite_sent', 'recently_left', 'already_member', 'not_on_whatsapp', 'group_full', 'opted_out', 'failed'\)/);
  assert.match(sql, /consent_confirmed_at\s+timestamptz not null/);
  assert.match(sql, /unique \(group_id, phone\)/);
});

test("rls on every table, no policies, no bodies", () => {
  for (const t of ["whatsapp_group_jobs", "whatsapp_group_posts", "whatsapp_groups", "whatsapp_group_members"])
    assert.match(sql, new RegExp(`alter table public\\.${t} enable row level security`));
  assert.doesNotMatch(sql, /create policy/);
  assert.doesNotMatch(sql, /\bbody\s+text/);
});

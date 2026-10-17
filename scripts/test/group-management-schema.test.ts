import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const sql = readFileSync(join(process.cwd(), "supabase/migrations/0009_group_management.sql"), "utf8");

test("whatsapp_groups.created_by_us", () => {
  assert.match(sql, /alter table public\.whatsapp_groups\s+add column created_by_us boolean not null default false/);
});

test("ghl_contact_id lookup index", () => {
  assert.match(
    sql,
    /create index whatsapp_groups_ghl_contact_idx on public\.whatsapp_groups \(ghl_contact_id\)\s+where ghl_contact_id is not null/,
  );
});

test("whatsapp_group_actions", () => {
  assert.match(sql, /create table public\.whatsapp_group_actions/);
  assert.match(sql, /id\s+uuid primary key default gen_random_uuid\(\)/);
  assert.match(sql, /tenant_id\s+uuid not null references public\.whatsapp_tenants \(id\) on delete cascade/);
  assert.match(sql, /group_jid\s+text check \(group_jid is null or group_jid ~ '\^\[0-9\]\+\(-\[0-9\]\+\)\?@g\\\.us\$'\)/);
  assert.match(
    sql,
    /action\s+text not null check \(action in \('create', 'add', 'remove', 'promote', 'demote', 'update', 'invite_reset', 'leave'\)\)/,
  );
  assert.match(sql, /count\s+int not null check \(count between 1 and 50\)/);
  assert.match(sql, /created_at\s+timestamptz not null default now\(\)/);
  assert.match(
    sql,
    /create index whatsapp_group_actions_tenant_created_idx on public\.whatsapp_group_actions \(tenant_id, created_at\)/,
  );
  assert.match(sql, /alter table public\.whatsapp_group_actions enable row level security/);
  assert.doesNotMatch(sql, /create policy/);
});

test("ghl_accounts.group_invite_template is per sub-account", () => {
  assert.match(sql, /alter table public\.ghl_accounts\s+add column group_invite_template text/);
  assert.match(
    sql,
    /check \(\s*group_invite_template is null or \(\s*char_length\(group_invite_template\) between 1 and 500\s+and strpos\(group_invite_template, '\{link\}'\) > 0\s*\)\s*\)/,
  );
  assert.doesNotMatch(sql, /alter table public\.accounts\b/);
});

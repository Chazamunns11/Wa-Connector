import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const sql = readFileSync(join(process.cwd(), "supabase/migrations/0004_reliability.sql"), "utf8");

test("held send_state", () => {
  assert.match(sql, /alter table public\.ghl_outbound_messages drop constraint ghl_outbound_messages_send_state_check/);
  assert.match(sql, /check \(send_state in \('pending_send', 'held', 'accepted', 'refused'\)\)/);
  assert.match(sql, /create index ghl_outbound_held_idx on public\.ghl_outbound_messages \(tenant_id, created_at\)\s+where send_state = 'held'/);
});

test("whatsapp_opt_outs", () => {
  assert.match(sql, /create table public\.whatsapp_opt_outs/);
  assert.match(sql, /tenant_id\s+uuid not null references public\.whatsapp_tenants \(id\) on delete cascade/);
  assert.match(sql, /phone\s+text not null[\s\S]*phone ~ '\^\\\+\[1-9\]\[0-9\]\{6,14\}\$'/);
  assert.match(sql, /keyword\s+text not null check \(char_length\(keyword\) <= 16\)/);
  assert.match(sql, /ghl_contact_id\s+text/);
  assert.match(sql, /primary key \(tenant_id, phone\)/);
  assert.match(sql, /alter table public\.whatsapp_opt_outs enable row level security/);
  assert.doesNotMatch(sql, /create policy/);
});

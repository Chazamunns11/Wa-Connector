import { test } from "node:test";
import assert from "node:assert/strict";
import { contentForQueueItem, participantResultsFromCreate, weAreAdminIn } from "../src/sessions.js";
import type { GroupPostRecord } from "../src/store.js";

test("weAreAdminIn: device suffix is normalised and superadmin counts", () => {
  const meta = { participants: [{ id: "447700900100@s.whatsapp.net", admin: "superadmin" }, { id: "447700900101@s.whatsapp.net", admin: null }] };
  assert.equal(weAreAdminIn(meta, ["447700900100:12@s.whatsapp.net"]), true);
  assert.equal(weAreAdminIn(meta, ["447700900101:3@s.whatsapp.net"]), false);
  assert.equal(weAreAdminIn(meta, ["447700900199:1@s.whatsapp.net"]), false);
  assert.equal(weAreAdminIn({ participants: [{ id: "447700900100@s.whatsapp.net", admin: "admin" }] }, ["447700900100:1@s.whatsapp.net"]), true);
  assert.equal(weAreAdminIn(meta, []), false);
});

test("participantResultsFromCreate: in meta is added, unresolved is not_on_whatsapp, the rest invite_needed", () => {
  const meta = { participants: [{ id: "447700900100@s.whatsapp.net" }, { id: "447700900101@s.whatsapp.net" }] };
  const r = participantResultsFromCreate(meta, [
    { phone: "+447700900101", jid: "447700900101@s.whatsapp.net" },
    { phone: "+447700900102", jid: "447700900102@s.whatsapp.net" },
    { phone: "+447700900103", jid: null },
  ]);
  assert.deepEqual(r.map((x) => x.outcome), ["added", "invite_needed", "not_on_whatsapp"]);
  assert.deepEqual(r.map((x) => x.code), ["200", "403", "404"]);
});

test("contentForQueueItem: a group post is plain text with link previews off", () => {
  const post = { id: "p" } as GroupPostRecord;
  assert.deepEqual(contentForQueueItem({ kind: "group_post", post, text: "hello https://x.test" }), { text: "hello https://x.test", linkPreview: null });
});

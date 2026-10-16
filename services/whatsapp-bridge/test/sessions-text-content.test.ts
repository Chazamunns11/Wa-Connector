/**
 * src/sessions.ts's `buildOutboundTextContent` — pins the deliberate
 * `linkPreview: null` decision (see that function's own JSDoc and README's
 * "Why outbound messages never render link previews"). Baileys only
 * attempts preview generation when `linkPreview` is STRICTLY `undefined`
 * (node_modules/@whiskeysockets/baileys/lib/Utils/messages.js,
 * `generateWAMessageContent`); an explicit `null` skips it entirely,
 * without adding the `link-preview-js` dependency that would otherwise make
 * this bridge fetch arbitrary URLs found in message text — attacker
 * reachable, since the text is whatever the portal forwarded from a
 * client's own typing — on every outbound send (a new SSRF / outbound-fetch
 * surface for a purely cosmetic preview card). If this test starts failing
 * because `linkPreview: null` was removed: don't remove it — that decision
 * is exactly what this test exists to pin.
 *
 * The final test below pins a SECOND, separate thing: that `drainQueue`
 * actually calls this builder, not just that the builder itself is correct
 * in isolation — pinning the shape alone would happily pass even if the call
 * site quietly stopped using it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { buildOutboundTextContent } from "../src/sessions.js";

test("buildOutboundTextContent: returns { text, linkPreview: null } — explicit null, not omitted/undefined", () => {
  const content = buildOutboundTextContent("check https://example.com for details");
  assert.deepEqual(content, { text: "check https://example.com for details", linkPreview: null });
  assert.equal(content.linkPreview, null, "must be the literal null (Baileys treats undefined as 'go fetch a preview')");
  assert.ok(Object.prototype.hasOwnProperty.call(content, "linkPreview"), "the key must be PRESENT (a strictly-undefined/omitted key means Baileys attempts a fetch)");
});

test("buildOutboundTextContent: plain text with no URL is unaffected — same shape either way", () => {
  const content = buildOutboundTextContent("hey, following up on our chat");
  assert.deepEqual(content, { text: "hey, following up on our chat", linkPreview: null });
});

test("LOCKSTEP (SOURCE-LEVEL, not behavioural): drainQueue's text branch actually calls buildOutboundTextContent — not `{ text: payload.text }` reconstructed inline", () => {
  // `drainQueue` needs a live Baileys socket (`sock.sendMessage`, the
  // existence-check round trip, etc.) that a unit test cannot construct
  // without dragging in Baileys/Supabase wholesale (see this file's own
  // header on why buildOutboundTextContent was extracted to be testable at
  // all). So this is NOT a behavioural test of drainQueue — it is a plain
  // text-search over src/sessions.ts, asserting the call site is wired to
  // the builder. Mutating sessions.ts's text branch back to
  // `messageContent = { text: payload.text }` would pass every other test
  // in this suite while silently reintroducing the link-preview
  // fetch/SSRF path buildOutboundTextContent's own JSDoc (and this test's
  // sibling above) exist to keep closed.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const sessionsSource = readFileSync(path.resolve(here, "../src/sessions.ts"), "utf8");
  assert.match(
    sessionsSource,
    /messageContent\s*=\s*buildOutboundTextContent\(payload\.text\)/,
    "drainQueue's text branch must read `messageContent = buildOutboundTextContent(payload.text)` verbatim — if this changed intentionally, update this regex AND confirm the new call site still skips Baileys' link-preview fetch"
  );
});

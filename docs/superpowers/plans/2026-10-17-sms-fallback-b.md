# SMS fallback B (send the text as an SMS automatically) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a contact isn't on WhatsApp, PingWren sends the same text as an SMS through GHL, so the message still arrives. Charlie decided this on 17 Oct 2026: "Text should send as replacement if not on WA".

**Architecture:** At the two places the app learns a contact isn't on WhatsApp (the status drain, and the 30-day memory's fast refusal), the app asks GHL's Conversations API to send the text as an SMS on that contact. PingWren is itself the sub-account's SMS conversation provider, so GHL may hand that SMS straight back to PingWren. A loop guard detects the echo, refuses it, and switches the fallback off for that sub-account, with a visible notice. The SMS cost lands on the sub-account's own SMS provider.

**Tech Stack:** Next.js 16, Supabase, `node:test`.

**Spec:** `docs/superpowers/specs/2026-10-17-calls-receipts-fallback-ai-design.md` §6 option B, with Charlie's 17 Oct answer: send automatically.

## Global Constraints

- GHL call: `POST https://services.leadconnectorhq.com/conversations/messages` with the location token, the same `Version` header as the other conversations calls, and body `{ type: "SMS", contactId, message }`. It never throws. Its timeout is 5 s. It is unverified until the sandbox check.
- Global flag `GHL_SMS_FALLBACK_ENABLED === "true"`, default **off**, until the sandbox shows which provider sends the SMS. Per-sub-account setting `ghl_accounts.sms_fallback_enabled boolean not null default true` (Charlie's decision: it's on unless a sub-account turns it off).
- Embed toggle label: "Send as SMS when a contact isn't on WhatsApp". Line under it: "Uses this sub-account's own SMS provider, so normal SMS charges apply."
- STOP wins. An opted-out contact gets nothing. Group sends never fall back. Text only: a message with attachments falls back with its text, or not at all if it has no text.
- Once per message. The SMS is sent only when this pass won the report (the existing `reportGhlOutcome` "reported" result), or on the fast-refusal path, once per send.
- When the SMS fallback is sent (the GHL call succeeded), the `whatsapp_not_on_whatsapp` trigger is **not** fired, so a workflow doesn't send a second SMS. If it isn't sent (flag off, switched off, blocked or failed), the trigger fires as today.
- GHL message status for the original: failed, with the reason `Not on WhatsApp — sent as SMS instead` when the SMS call succeeded, else the existing `recipient has no WhatsApp account`.
- **Loop guard:**
  - Before calling GHL, record a pending echo: (location, contactId, sha256(text)), valid for 10 minutes.
  - When our provider webhook (`handleProviderOutboundMessage`) receives an outbound message for that contact whose text hash matches a pending echo, it consumes the echo and refuses the message. The reason is `This sub-account sends SMS through PingWren, so the SMS fallback can't be used — not sent`.
  - It never sends that message over WhatsApp.
  - It sets `ghl_accounts.sms_fallback_blocked_at = now()`. While that is set, that sub-account never falls back.
  - The embed shows "Turned off: this sub-account's SMS goes through PingWren. Connect another SMS provider (LC Phone or Twilio) in GHL, then switch it back on." Switching the toggle on again clears `blocked_at`.
- The text to send comes from `pending_text`. Keep it on accepted rows when the SMS fallback flag **or** the trigger flag is on (extend the current "trigger flag" rule).
- Never log phones, contact ids or text. Store only the text hash in the echo table.
- New migration `0014_sms_fallback.sql`.

## Review Focus

1. **GHL echoes the SMS back through PingWren.** It is refused, it isn't sent on WhatsApp, the fallback switches off for that sub-account, and no further SMS is attempted (Task 2).
2. **Two drains report the same row.** One SMS (Task 2).
3. **An opted-out contact.** No SMS (Task 2).
4. **The SMS call fails.** The trigger fires instead, and the status says "recipient has no WhatsApp account" (Task 2).
5. **A coach sends the same text to the same contact by hand within 10 minutes of a fallback.** Accepted risk: it is treated as the echo, refused, and the fallback switches off. This is documented in Task 3.

---

### Task 1: Migration, repo and the GHL send call

**Files:** Create `supabase/migrations/0014_sms_fallback.sql`. Modify `src/lib/types.ts` (`GhlAccount.smsFallbackEnabled`, `smsFallbackBlockedAt`), `src/lib/data/repository.ts`, `src/lib/data/supabase.ts`, `src/lib/ghl.ts`. Test: `scripts/test/repository-shape.test.ts`, `scripts/test/ghl.test.ts`.

**Interfaces:**
- SQL:
  - `ghl_accounts.sms_fallback_enabled boolean not null default true`, `ghl_accounts.sms_fallback_blocked_at timestamptz null`;
  - `ghl_sms_fallback_echoes (location_id text references ghl_accounts(location_id) on delete cascade, contact_id text not null, text_sha256 text not null, expires_at timestamptz not null, primary key (location_id, contact_id, text_sha256))`;
  - RLS on, no policies.
- Repo:
  - `recordSmsFallbackEcho(locationId, contactId, textSha256, expiresIso)`;
  - `consumeSmsFallbackEcho(locationId, contactId, textSha256, nowIso): Promise<boolean>`, which deletes a matching unexpired row and returns whether one existed;
  - `blockSmsFallback(locationId)`;
  - `setSmsFallbackEnabled(locationId, enabled)`, which also clears `blocked_at` when enabling.
- `sendGhlSms(accessToken, { contactId, message }): Promise<{ ok: true } | { ok: false; status: number | null }>` in `ghl.ts`. It never throws, has a 5 s timeout and logs no text.
- [ ] Write the tests: the request shape, a rejection and a network error. Implement. Apply 0001–0014 locally. Run `npm run check`. Commit `db: SMS fallback`.

### Task 2: Send, guard and wire

**Files:** Create `src/lib/sms-fallback.ts`. Modify `src/lib/ghl-provider.ts`. Test: new `scripts/test/sms-fallback.test.ts`.

**Interfaces:**
- `trySmsFallback(repo, deps, { account, row, text }): Promise<"sent" | "skipped" | "failed">`:
  - It skips when the flag is off, the account is switched off or blocked, there's no contact or text, it's a group row, or the contact opted out (`optedOutReason`).
  - Otherwise it records the echo, resolves the token and calls `sendGhlSms`.
  - It never throws.
- Status drain:
  - on a not_on_whatsapp report it calls `trySmsFallback` **before** reporting, so the reason can say "sent as SMS instead";
  - it reports, and only a winning report (`"reported"`) counts. If this pass lost the report but had sent, that is the accepted duplicate risk; avoid it by checking `reported_status` is still null just before sending;
  - it fires the trigger only when the result isn't "sent".
- Fast-refusal path (the memory): the same, once per send.
- `handleProviderOutboundMessage`: at the very start, before any send, compute the text hash. If `consumeSmsFallbackEcho` matches, block the fallback, refuse with the loop string, and stop. It fails open on a read error, meaning it carries on as normal.
- [ ] Tests:
  - sent → the status reason and no trigger;
  - SMS fails → the trigger fires and the old reason;
  - flag off, switched off or blocked → no SMS;
  - opted out → no SMS and no trigger (STOP wins, as today);
  - group → no SMS;
  - echo comes back → refused, blocked, never sent to the bridge, and the next not_on_whatsapp sends no SMS;
  - two drains → one SMS;
  - attachments with text → the SMS carries the text.

  Then run `npm run check` and commit `fallback: send the text as an SMS when a contact isn't on WhatsApp`.

### Task 3: Embed toggle and docs

**Files:** Modify `src/app/api/crm/embed/message-events/` (extend it to `{ showReactions, showDeletes, smsFallback, smsFallbackBlocked }`; keep the route path) and `src/app/embed/crm/MessageEventSettings.tsx` (add the toggle with the exact label, line and blocked notice), plus docs: `docs/GO-LIVE-FOUNDATION.md` (0014, the flag), the calls spec §6 (B built), `docs/GHL-WORKFLOW-TRIGGERS-SETUP.md` (the trigger isn't fired when the SMS was sent), the sandbox check (send to a non-WhatsApp number, see which provider sends the SMS; if it loops, the guard fires and the setting shows blocked), and Review Focus 5 as a known limit.
- [ ] Tests:
  - the read and write of smsFallback;
  - enabling clears the blocked state;
  - one sub-account never changes another's.

  Then `npm run check`, the production build, and commit `embed: SMS fallback setting`.

# WhatsApp ban risk of a private login, and how PingWren stays under it

## The risk, plainly

PingWren links each coach's own WhatsApp number as a **linked device**, through
the open-source Baileys library (`services/whatsapp-bridge`, `@whiskeysockets/baileys`).
That is not Meta's official WhatsApp Business Platform. WhatsApp's terms do not
allow unofficial clients, and WhatsApp can log out or **ban** a number at any
time, with no appeal route we control.

Meta publishes no sending limits for unofficial clients, so nobody can give a
"safe number". What triggers bans in practice (industry experience, not a
Meta-published rule):

- many messages to people who have **not** messaged the number first or saved it;
- contacts **blocking or reporting** the number;
- **identical** text sent to many people in a short time;
- a **brand-new** number, or one that was idle, suddenly sending volume;
- machine-regular timing (exactly every N seconds);
- linking and unlinking the device repeatedly.

A ban is per number. It does not touch HighLevel, other coaches, or the
coach's other numbers.

## What the code already does

| Control | Where | Default |
| --- | --- | --- |
| Minimum gap between two sends on one number | `WA_SEND_MIN_GAP_MS` (bridge `src/pacing.ts`) | 45 s |
| Random jitter on top of the gap | `WA_SEND_JITTER_MS` | 0–30 s |
| Daily cap per number (UTC day, survives restarts). Conversation replies don't count | `WA_DAILY_CAP` | 150 |
| Conversation replies: a 1:1 send to someone who messaged the number in the window is exempt from the daily cap and warm-up, and only waits the reply gap. `0` turns it off | `WA_REPLY_WINDOW_HOURS` | 24 h |
| Gap before a conversation reply, plus jitter | `WA_REPLY_MIN_GAP_MS`, `WA_REPLY_JITTER_MS` | 3 s + 0–2 s |
| Warm-up for a newly linked number: 20/day for days 0–2, 50 for days 3–6, 100 for days 7–13, then the daily cap | `WA_WARMUP_ENABLED` | **off** |
| STOP / START opt-outs honoured before any send | portal `src/lib/opt-out.ts` | on |
| Group invites only to people who messaged the number in the last 90 days | bridge `group-management.ts` | on |
| Banned number: credentials wiped, status `banned`, sends refused at once | bridge `sessions.ts` (403) | on |
| Outage alert (email to coach and operator, with a reconnect link) | portal `src/lib/session-alerts.ts`, `/api/cron/health` | on once `RESEND_API_KEY` + `EMAIL_FROM` are set |

### Why conversation replies are exempt

Bans come from unsolicited volume: cold first touches, bulk sends, a new
number blasting a list. Replying to someone who has just messaged you is what
normal people do, and PingWren is mostly two-way chats, so pacing those like
outreach burned the daily cap and held each reply 45–75 s.

A send counts as a reply only when it is 1:1 and that phone sent the number a
1:1 message (not a missed call, reaction or edit) within
`WA_REPLY_WINDOW_HOURS`. Replies cost no daily-cap units, so they are never
refused at the cap or by warm-up (warm-up is about unsolicited volume from a
new number). They still go out one at a time per number, at least
`WA_REPLY_MIN_GAP_MS` + jitter apart, and they go ahead of queued cold sends.
Cold sends keep the full 45 s + jitter between each other, and the cap counts
them exactly as before, including after a restart. Group sends are never
replies. Group creates and adds stay blocked during warm-up.

## What we do to stay under it

1. **Turn warm-up on in production**: set `WA_WARMUP_ENABLED=true` on the
   bridge (Railway). It only lowers caps for numbers linked less than 14 days
   ago; older numbers are unaffected.
2. **Keep the daily cap at 150 or lower** per number. A coach who needs more
   volume should add a second number (from £7.99 a month) rather than raise the cap.
3. **Use numbers that have a history**: the coach's real business number,
   at least a few weeks old, with normal person-to-person chats. Never a
   freshly bought SIM linked on day one.
4. **Mostly reply, rarely blast.** PingWren is for conversations with leads who
   opted in (form fills, ads, inbound). Cold lists, scraped numbers and
   identical bulk campaigns belong on the official API or SMS, not here. Put
   this in the client agreement.
5. **Vary bulk text** with HighLevel custom values (first name, a detail), and
   send bulk actions in small batches.
6. **Ask contacts to save the number** in the first message of a sequence.
7. **Watch the signals**: a `logged_out` alert with no one touching the phone,
   or rising "not on WhatsApp" / failed sends, is an early warning. Pause that
   coach's bulk sends before WhatsApp escalates to a ban.
8. **If a number is banned**: it cannot be reconnected. Connect a different
   number (Add a number on the PingWren page), make it the default, and remove
   the banned one. Held messages for the banned number fail into HighLevel so
   they are visible; nothing is silently dropped.

## When to move a client to the official API

If a coach needs cold outreach or more than a few hundred messages a day, the
private login is the wrong tool. Point them to the official WhatsApp Business
Platform (through HighLevel's own WhatsApp integration or a BSP), which has
published limits and no ban risk for policy-compliant use.

# Create and manage WhatsApp groups from GHL: design

17 Oct 2026. Builds on the opt-in groups work (`docs/superpowers/specs/2026-10-17-whatsapp-groups-design.md`, plan `docs/superpowers/plans/2026-10-17-multiple-numbers-and-groups.md`). Draft for Charlie's review.

## Why

Coaches run cohort and accountability groups. Today they create them by hand on their phone. Stevo and GoGHL already let users create and manage groups from GHL. With this, a coach can create a cohort group from GHL, invite the cohort, and remove people when their programme ends, all from the CRM.

## What the user can do

From the in-GHL page, on any connected number:

1. **Create a group:** a name (up to 100 characters), an optional description, and who to invite (picked contacts, or every contact with a GHL tag).
2. **Invite people:** each invitee gets a WhatsApp message from that number with the group's invite link. They tap to join.
3. **Manage a group the number created or is an admin of:**
   - rename it, or change its description;
   - "Only admins can send": announcement mode, for a coach's broadcast group;
   - "Approve new members": join requests wait for the coach;
   - remove a member;
   - make a member an admin, or remove their admin rights;
   - get or reset the invite link;
   - leave the group.

A group created here is switched on for sync straight away. It appears in GHL Conversations like any synced group, with the `whatsapp-group` tag.

From GHL workflows (later, see "Workflow actions"):
- Create a group for a contact or cohort.
- Invite a contact to a group.
- Remove a contact from a group (for example when a programme-ended tag is added).

## Decisions (proposed)

| Topic | Decision | Why |
|---|---|---|
| How people join | **Invite link sent by WhatsApp message**, by default | WhatsApp blocks direct adds for anyone whose privacy setting is "My contacts", and adding strangers is a strong spam signal. A link respects their choice and protects the number. |
| Direct add | Allowed only for a contact who has **messaged that number before** (there is a row for them in `whatsapp_inbound_messages` on that tenant) | Someone already talking to the coach is the lowest-risk add. If WhatsApp refuses the add (privacy setting), fall back to sending the invite link. |
| Members on creation | **Try creating with nobody first** (`groupCreate(subject, [])`). If WhatsApp refuses, retry with the first contact eligible for a direct add; if there is none, refuse with "Add at least one person who has messaged this number before, then invite the rest by link." | Charlie, 17 Oct: test it. Built to work either way, and the sandbox script below records which path WhatsApp takes. |
| Limits per number per day | 3 groups created, **50 direct adds** (Charlie, 17 Oct: at least 50), invite messages count as normal sends against the daily cap | Mass group creation and mass adds are classic ban triggers. Config like the other pacing values (`WA_GROUP_CREATE_DAILY` default 3, `WA_GROUP_ADD_DAILY` default 50). |
| Warm-up | While a number is in warm-up (`WA_WARMUP_ENABLED`, first 14 days), group creation and direct adds are refused | A new number creating groups is the riskiest pattern there is. |
| Who can manage | Only groups where our number is an admin; the buttons don't show otherwise | WhatsApp refuses admin actions from non-admins anyway. |
| Leaving | Asks for confirmation in the page, then leaves and marks the group left (`left_at`) | |
| Removing a member | Never removes the coach's own number; never removes the last admin | Prevents locking the coach out. |

## Bridge (services/whatsapp-bridge)

New authenticated routes, all only for a connected session, each one validating the group JID with `isGroupJid` and refusing a group that isn't enabled for this tenant (except create):

| Route | Baileys call | Notes |
|---|---|---|
| `POST /sessions/:id/groups` `{ name, description?, participants: E164[] }` | `groupCreate`, then `groupUpdateDescription` | Each participant goes through `onWhatsApp` first and uses the JID WhatsApp returns (hard rule 3). Counts against the create limit. Returns `{ jid, name }`. |
| `POST /sessions/:id/groups/:jid/participants` `{ action: add\|remove\|promote\|demote, phones: E164[] }` | `groupParticipantsUpdate` | Per-person results; "add" refused for privacy returns `invite_required` for that person. Adds count against the add limit. |
| `PATCH /sessions/:id/groups/:jid` `{ name?, description?, announcement?, approval? }` | `groupUpdateSubject`, `groupUpdateDescription`, `groupSettingUpdate`, `groupJoinApprovalMode` | |
| `GET /sessions/:id/groups/:jid/invite` and `POST …/invite/reset` | `groupInviteCode`, `groupRevokeInvite` | Returns the `https://chat.whatsapp.com/<code>` link. Never logged. |
| `POST /sessions/:id/groups/:jid/leave` | `groupLeave` | |
| `GET /sessions/:id/groups/:jid` | `groupMetadata` | Members (as E.164 where resolvable), admins, settings, whether we're an admin. |

Group names, descriptions, invite codes and member numbers are never logged (same privacy rule as the groups work). A new limits counter sits beside the pacer, seeded from the ledger on restart like the daily cap.

## App (src/)

- **Repository:** `whatsapp_groups` gains `created_by_us boolean default false`. A small `whatsapp_group_actions` log table (tenant, group, action, count, created_at) backs the daily limits and the owner admin view. Migration `0009_group_management.sql`.
- **Embed route** `src/app/api/crm/embed/groups/manage/route.ts`: slot-guarded like the existing groups route; never returns tenant ids; validates names (≤100) and descriptions (≤512).
- **Invites:** the app resolves picked contacts or a tag to E.164 numbers through the GHL contacts API (location token), then sends each invite as a normal outbound message on that number. These go through the usual pacing, typing and daily cap.
- **Editable invite message** (Charlie, 17 Oct): per account, up to 500 characters, with placeholders `{first_name}`, `{group_name}`, `{coach_name}` and a required `{link}`; saving without `{link}` is refused with the fixed string below. Default: "Hi {first_name}, {coach_name} invited you to join {group_name} on WhatsApp: {link}". Stored on `accounts` (new column `group_invite_template text null`, in 0009).
- **UI:** in each number's Groups section, a "Create group" button and, per group where we're an admin, a "Manage" panel (rename, settings toggles, members list with Remove / Make admin, invite link with Copy and Reset, Leave). Confirmations in the page, never `confirm()`.

## Workflow actions (phase 2)

Once the GHL workflow triggers (`docs/superpowers/specs/2026-10-17-ghl-workflow-triggers-actions-design.md`) are proven in a sandbox, add three custom actions: Create WhatsApp group, Invite contact to group, Remove contact from group. Each run costs the customer GHL's $0.01. Built after the in-page version, because the page is free to use and covers the main coach need.

## Fixed strings

- `Add at least one person who has messaged this number before, then invite the rest by link.`
- `This number has created its 3 groups for today. Try again tomorrow.`
- `This number has reached today's limit for adding people. Invite the rest by link.`
- `The invite message must include {link}.`
- `New numbers can't create groups during their first 14 days.`
- `This number isn't an admin of that group.`
- `You can't remove the group's last admin.`
- `You can't remove this WhatsApp number from the group. Use Leave instead.`

## Tests (to be planned)

- Bridge: each route refuses a disabled or malformed group JID; participants go through `onWhatsApp`; a privacy-refused add returns `invite_required`; limits refuse past 3 creates or 50 adds and survive a restart; warm-up refuses creates and adds; nothing logs names, links or numbers.
- App: tag → contacts → invites goes through normal outbound with pacing; a created group is enabled and synced; no tenant ids in responses; admin-only actions hidden and refused for non-admin groups; last-admin and self-removal refused.

## Sandbox test (before planning)

A one-off script, `services/whatsapp-bridge/scripts/group-sandbox.ts`, run by hand against a spare test number (never a client's): link by QR, call `groupCreate('PingWren sandbox', [])`, record whether it succeeds or the exact error, then create with one test participant, add a second by `groupParticipantsUpdate`, fetch the invite link, set announcement mode, and leave and clean up. It prints a pass/fail line per step. Needs a real phone to scan, so it runs on Charlie's machine or a Railway shell, not in CI.

## Member addressing

Members are managed by their WhatsApp `memberId` (a `@s.whatsapp.net` or `@lid` id) taken from the group details, because some members have no phone number we can see. Phone numbers are only used to add people. The embed route's `participants` action takes `memberIds` and only remove, promote and demote. Adds go through `invite`, so the browser never sends a phone.

## App-originated invites

| Case | Result |
|---|---|
| Sent through the normal outbound path | Pacing, daily cap, STOP check and the hold queue apply. Sent from the slot's own number, no sticky lookup. |
| Accepted by WhatsApp | Posted once into the contact's GHL conversation as an outbound message. |
| Held, queued for retry, refused or skipped | Not posted to GHL. |
| GHL post fails | Logged with a fixed string. The invite result does not change. |
| Same `requestId` again within 10 minutes | Same group returned. No invites are sent or posted again. |
| STOP on any number of the sub-account | No invite and no direct add. |

## Decisions log

- 17 Oct, Charlie: test the empty-group create (built to handle either result); at least 50 direct adds a day; the invite message is editable.
- Limits count attempts: a create or add that reached WhatsApp is never refunded, even if it failed.
- 17 Oct, Charlie: invites sent by WhatsApp are also posted into the contact's GHL conversation, after WhatsApp accepts them. The invite message is per sub-account.
- 17 Oct, Charlie: 50 direct adds a day (the earlier 20 was out of date). Warm-up refusals follow `WA_WARMUP_ENABLED`. During warm-up, direct adds become invite links.
- Sandbox result for the empty create (`groupCreate(name, [])`): not run yet. Record the result here after running `services/whatsapp-bridge/scripts/group-sandbox.ts` on a spare number.

# WhatsApp groups in GHL Conversations: design

17 Oct 2026. Roadmap item E (`docs/superpowers/plans/2026-10-16-competitor-gap-roadmap.md`). Draft for Charlie's review.

## What rivals do (checked 17 Oct)

- **Every vendor uses one synthetic GHL contact per group.** GHL's inbound message API needs a `contactId` or `conversationId` and has no group concept ([add inbound message](https://marketplace.gohighlevel.com/docs/ghl/conversations/add-an-inbound-message/index.html)).
  - WAGHL: contact named "Group name - WA Group", tagged `wa group`, and **every group syncs** ([help](https://waghl.com/help/wagroup)).
  - GoGHL: **opt-in per group** ("leave out private groups"; "Can I enable all my WhatsApp groups at once? No."), with an optional auto-sync toggle. The group gets a random proxy number. Senders arrive as trigger fields and don't become contacts automatically ([help](https://help.goghl.ai/whatsapp/whatsapp-groups-and-community-announcements)).
  - GREEN-API: contact `[Group] Sales Team`, tag `whatsapp-group`, group id in the phone field, and each message prefixed `John Doe (+1234567890): Hello everyone!` ([docs](https://green-api.com/en/docs/integration/gohighlevel/development/)).
- None of them warns about group-specific ban risk.

## Decisions (proposed)

| Topic | Decision |
|---|---|
| Which groups sync | **Opt-in per group**, like GoGHL. Nothing syncs until the user picks it. A coach's number is often their personal phone, sitting in family and friends groups that must never land in a CRM. No auto-sync toggle at launch. |
| Who can turn it on | The account owner, on the dashboard and the in-GHL page: "Groups" → list of the number's groups (name, member count) → a toggle each. |
| Group contact | One GHL contact per synced group, named `<group name> (WhatsApp group)`, tagged `whatsapp-group`, **with no phone number** (a fake number would collide with real contacts and could get messaged by an SMS step). If GHL refuses a contact with no phone or email, use a placeholder email `group-<id>@groups.pingwren.invalid` instead. Confirm during planning. |
| Senders | Each inbound line prefixed `<sender name or number>: ` (the sender's WhatsApp push name, else their number). Senders are **not** created as contacts. Group members didn't opt in to the CRM. |
| Outbound | Replying in the group contact's conversation sends to the group, through the same "Send SMS" provider path. No custom action at launch (they cost $0.01 per run; see item D). |
| Pacing | Group sends count against the number's own pacer and daily cap like any send. A group message reaches every member, so one group send counts as **5** cap units. |
| Media | Same rules as 1:1 messages (existing media flags and caps). |

## Data (new migration)

`whatsapp_groups`: `id`, `tenant_id` references `whatsapp_tenants`, `group_jid text` (must end `@g.us`), `name`, `enabled boolean default false`, `ghl_contact_id text null` (set when first synced), `created_at`, `updated_at`, unique `(tenant_id, group_jid)`. RLS on, no policies.

## Bridge changes

- **List groups:** a new authenticated route `GET /sessions/:id/groups` returns `{ jid, name, size }[]` from Baileys' `groupFetchAllParticipating()`. The list is shown to the owner only and never stored beyond what they enable.
- **Inbound:** filter step 3 (`isPnUser || isLidUser`) stays the default. A group JID passes only if `(tenant, jid)` is in the bridge's in-memory set of enabled groups, refreshed from `whatsapp_groups` on connect and when the app calls `POST /sessions/:id/groups/refresh`. The row records `group_jid` and the sender's number and push name. New columns on `whatsapp_inbound_messages`: `group_jid text null`, `sender_name text null`.
- **Outbound:** `POST /sessions/:id/send` takes either `to` (E.164, as today) or `groupJid`. `groupJid` must match `^[0-9-]+@g\.us$` **and** be an enabled group for this tenant. The existence check (`onWhatsApp`) is skipped for groups; the check is "this number is still a participant", via `groupMetadata`. Hard rule 3 (never send to a built JID) holds: the JID comes from WhatsApp's own group list, stored when the owner enabled it.

## App changes

- `src/lib/ghl-inbound.ts`: a group row resolves to the group's GHL contact (created on first message if `ghl_contact_id` is null), and the body is posted with the sender prefix.
- `src/lib/ghl-provider.ts`: before phone normalisation, check whether `contactId` is a synced group's contact; if so, send with `groupJid`. If the group was disabled, refuse with **"WhatsApp group sync is turned off for this group"**.
- Disabling a group stops inbound and outbound at once, and leaves the GHL contact and its history as they are.

## Error cases

- The number leaves or is removed from the group → the next send fails with **"This WhatsApp number is no longer in that group"**, and the group shows as "Left" in the list.
- A group renamed on WhatsApp → the name updates on the next refresh. The GHL contact name is left alone (users may have renamed it).
- A GHL workflow sending to every contact with an SMS step would include group contacts. The `whatsapp-group` tag lets users exclude them. The dashboard says so when the first group is enabled.

## Tests (to be planned)

- Inbound: a group message for a disabled or unknown group is dropped; for an enabled group it's stored with sender fields; the prefix uses push name, then number.
- Outbound: `groupJid` refused unless it's enabled for the tenant; malformed JIDs refused; a group send costs 5 cap units; a non-participant send fails with the fixed message.
- Provider: a group contact routes to `groupJid`; a disabled group refuses with the fixed message.
- Privacy: nothing is stored for any group until it's enabled.

## Open questions for Charlie

- Is 5 cap units per group send right? It's a guess at the extra ban risk of reaching many people with one message.
- Should coaches be able to create groups or manage members from GHL (Stevo and GoGHL can)? Proposed: not at launch.

# Several WhatsApp numbers per sub-account: design

17 Oct 2026. Roadmap item B (`docs/superpowers/plans/2026-10-16-competitor-gap-roadmap.md`). Draft for Charlie's review.

## Decisions

| Topic | Decision | Source |
|---|---|---|
| Numbers included | Up to **3** per activated sub-account; more as a paid add-on later | Charlie, 17 Oct |
| Which number sends | **One default number per sub-account. A contact who has messaged a particular number gets replies from that number (sticky).** | Charlie, 17 Oct |
| Model | **One tenant per number** (option 1 in the roadmap). Every bridge path (session, lease, pacer, queue, daily cap, warm-up) is already per tenant, so the bridge needs no change. | Proposed |
| Sticky lifetime | The stickiness follows the **most recent inbound**. If a contact last wrote to number 2, replies go from number 2 until they write to a different number. It never expires on its own. | Proposed |
| Disconnected sticky number | If the sticky number is not connected, the send **does not** fall back to another number. It is refused with a fixed reason. Switching numbers silently would confuse the contact ("who is this?") and splits the thread on their phone. | Proposed |
| Billing | Still one billed unit per activated sub-account, whatever the number count (spec §2). | Follows the pricing decision |

## Why one tenant per number

Today `ghl_accounts.tenant_id` is `unique`: one location, one tenant, one WhatsApp session. The bridge keys everything on the tenant (`coach_id` on every `whatsapp_*` table). Giving each number its own tenant means:
- no bridge change at all, and per-number pacing, caps and warm-up come for free (a ban risk is per number, so these must be per number);
- `ghl_outbound_messages.tenant_id` already exists per row, separate from the account's tenant (the "finding 9" comment in `src/lib/ghl-provider.ts`), so the outbound status drain already looks a row up by the tenant that sent it.

## Data (new migration)

- **`ghl_location_numbers`**: `tenant_id uuid primary key references whatsapp_tenants`, `location_id text not null references ghl_accounts on delete cascade`, `slot smallint not null check (slot between 1 and 3)` (the number's position, unique per location), `is_default boolean not null default false`, `label text` of at most 40 characters (for example "Sales line"), `created_at`. A unique partial index on `(location_id) where is_default` gives exactly one default per location. RLS on, no policies.
- **Slots, not tenant ids, at the browser**: every browser-facing surface (embed routes, connect links, UI) addresses a number by its slot (1-3), scoped by the location the session or token already proves. Tenant ids stay server-side.
- **Backfill**: one row per existing `ghl_accounts` row with its `tenant_id`, `slot = 1`, `is_default = true`. `ghl_accounts.tenant_id` stays as it is and keeps meaning "the default number's tenant", so every existing read keeps working.
- **`ghl_contact_numbers`**: `location_id`, `ghl_contact_id`, `tenant_id`, `last_inbound_at`, primary key `(location_id, ghl_contact_id)`. Written by the inbound drain; read by outbound.
- Limit: at most 3 rows per location in `ghl_location_numbers`, enforced in the add-number server action (not a trigger), with the fixed message "This sub-account already has 3 WhatsApp numbers."

## Outbound (`src/lib/ghl-provider.ts`)

1. `handleProviderOutboundMessage` resolves the sending tenant **before** `recordGhlOutboundMessage`: look up `ghl_contact_numbers` for `(locationId, contactId)`; if found and that tenant is still in `ghl_location_numbers`, use it; otherwise use the default tenant.
2. The resolved tenant is what goes into `recordGhlOutboundMessage({ tenantId })` and every later `sendWhatsapp({ coachId })`. Retries and the status drain already read `row.tenantId`, so they follow automatically.
3. Budget check (`hasSufficientOutboundBudget`) runs against the resolved tenant.
4. If the resolved number isn't connected, refuse with the fixed string **"The WhatsApp number this contact uses is disconnected — reconnect it to reply"**, reported as failed in GHL.

New repository methods: `getStickyTenant(locationId, contactId): Promise<string | null>`, `setStickyTenant(locationId, contactId, tenantId, at)`, `listLocationNumbers(locationId)`, `addLocationNumber(locationId, label)` (creates the `whatsapp_tenants` row and the `ghl_location_numbers` row in one call), `removeLocationNumber(tenantId)`, `setDefaultNumber(locationId, tenantId)`.

## Inbound (`src/lib/ghl-inbound.ts`)

- The drain resolves a row's location through `ghl_location_numbers` (by `tenant_id`) instead of `ghl_accounts.tenant_id`. `getGhlAccountByTenantId` changes to join through the new table, so its callers don't change.
- After a successful push to GHL, upsert `ghl_contact_numbers` with the row's tenant and its timestamp, **only if newer** than the stored `last_inbound_at` (rows can drain out of order).
- The GHL message gets a short prefix only when the location has more than one number, so the user can tell lines apart: `[Sales line] ` + body. (GHL's inbound message API has no per-message "to number" field we can use. Confirm against GHL's docs during planning.)

## UI

- In-GHL embed (`/embed/crm`) and the dashboard row: a list of the location's numbers, each addressed by slot, with its own status, QR / connect link, label, "Make default" and "Remove". "Add a number" until 3 exist.
- Removing a number logs out its bridge session, wipes its credentials (the existing `/logout` path), deletes its sticky rows, and moves the default if needed. Removing the last number is refused; use Deactivate instead.
- Connect links (`src/lib/ghl-connect-link.ts`) become per number: the signed token carries the location and the slot (never the tenant id), and the server resolves the slot to the tenant.

## Error cases

- A contact sticky to a number that was removed → falls back to the default (the sticky row is deleted with the number).
- Two numbers both receive from the same contact → the later inbound wins the stickiness.
- A number's session is banned → its rows still show it as the sticky number, so sends refuse with the fixed disconnected message until the user removes or reconnects it. The dashboard's Needs attention column shows it.

## Tests (to be planned)

- Outbound picks sticky over default; falls back to default when no sticky row or when the sticky tenant was removed; refuses (no fallback) when the sticky number is disconnected.
- Inbound sets stickiness only for newer timestamps; out-of-order rows don't overwrite.
- Migration backfill: every existing location gets exactly one default row, matching `ghl_accounts.tenant_id`.
- Limit of 3 numbers; refuse removing the last number.
- Prefix appears only with more than one number.

## Out of scope

Rotation or load-spreading across numbers; per-user (team member) numbers; more than 3 numbers; moving a number between sub-accounts.

# Competitor-gap roadmap

16 Oct 2026. Follows `docs/research/2026-10-16-competitor-gap-analysis.md`.

The writing-plans scope check applies here: these are separate subsystems, each needing its own spec (brainstorm first) and its own implementation plan. This file sets the order, the decision each one waits on, and what each touches, so each can be specced on its own.

Order of work from the design spec (`docs/superpowers/specs/2026-10-12-brand-whatsapp-saas-design.md`) still holds: **Foundation → Reliability (held messages, STOP) → Product §1-§4 (accounts, billing, dashboard, embed) → move FitClosers across → soft launch.** Everything below fits around that.

## Done (16 Oct, this branch)

| Item | Where | Notes |
|---|---|---|
| Typing simulation before each text | `services/whatsapp-bridge/src/typing.ts` | On by default |
| Warm-up for newly linked numbers | `src/pacing.ts`, migration `0002` | Off by default; apply 0002 before deploying the bridge |
| Public status page | `src/app/status/page.tsx`, `src/lib/public-status.ts` | No customer data, 60s cache |
| B. Several numbers per sub-account | Built on branch `claude/eloquent-mccarthy-m60n6c`. Plan: `docs/superpowers/plans/2026-10-17-multiple-numbers-and-groups.md` | Migration `0003`. Up to 3 numbers by slot, default plus sticky sending number |
| E. Groups | Built on the same branch, same plan | Migrations `0004` and `0005`. Opt-in groups, 5 cap units per send. Apply 0003 to 0005 before deploying |

## Specs written (17 Oct, drafts for review)

| Item | Spec |
|---|---|
| B. Several numbers per sub-account | `docs/superpowers/specs/2026-10-17-multiple-numbers-per-sub-account-design.md` |
| D. Triggers and actions in GHL workflows | `docs/superpowers/specs/2026-10-17-ghl-workflow-triggers-actions-design.md`. GHL charges $0.01 per custom execution and needs LC Premium, so this builds triggers (disconnected, reconnected, message received), not a "Send WhatsApp" action. Firing a trigger is undocumented and needs a sandbox prototype first. |
| E. Groups | `docs/superpowers/specs/2026-10-17-whatsapp-groups-design.md`. Opt-in per group, one synthetic contact per group, no sender contacts. |
| F. Voice notes and message events | `docs/superpowers/specs/2026-10-17-voice-notes-and-message-events-design.md`. Reactions and deletes are off by default, because anything posted as inbound fires GHL's "Customer replied". |

**Build order (Charlie, 17 Oct): B (several numbers) and E (groups) first.** Each spec ends with its open questions. Once Charlie signs one off, the next step is its implementation plan (`superpowers:writing-plans`).

## Decisions (A, B and C decided 17 Oct)

### A. Pricing and trial: decided 17 Oct, written into the spec
- **Decided:** per sub-account, 3 numbers included, with volume tiers and an annual discount. Amounts still Charlie's to set.
- **Decided 17 Oct:** 7-day trial with no card; sending pauses when it ends without one.
- **Spec:** `docs/superpowers/specs/2026-10-12-brand-whatsapp-saas-design.md` Decisions table and §2 updated. Stripe quantity was already activated locations, so the billing mechanics barely change: the trial limit is now 3 sub-accounts, and a `paused` state covers a trial ending with no card.

### B. Several numbers per sub-account
- **Decided 17 Oct:** up to 3 included; one default sending number, and a contact who has messaged a particular number gets replies from that number (sticky).
- **Shape:** today a tenant (`whatsapp_tenants`) is one GHL location and `whatsapp_sessions` is keyed by tenant (`coach_id`), so one number per location. Either (1) a tenant per number, with `ghl_accounts` pointing at several tenants, or (2) a `whatsapp_numbers` table under the tenant. Option 1 reuses every bridge path unchanged (session, lease, pacer and queue are all per tenant) and is the recommended start.
- **Touches:** `supabase/migrations`, `src/lib/ghl-provider.ts` (pick the tenant for an outbound), `src/lib/ghl-inbound.ts` (which number a reply came to), the embed and connect pages (connect a second number), the dashboard rows.
- **Why it matters:** GHL's top WhatsApp request (607 votes); native GHL still allows one.

### C. White-label, agency install, affiliates
- **Decided 17 Oct:** at launch, agency branding inherited by every sub-account plus auto-claiming new sub-accounts; a 20% recurring affiliate scheme after the soft launch; custom domains later. Still to pick: affiliate tooling (Stripe-native coupons, or a tool such as Rewardful or Reditus).
- **Already there:** per-location branding (`src/lib/brand.ts`, `client-logos` bucket, `saveGhlAccountBrandingAction`) and agency-level OAuth installs (spec §1).
- **Missing:** agency-level branding that every sub-account inherits; auto-claiming locations added to an agency after the install (needs GHL's location-created webhook, to be confirmed in GHL's docs); wholesale pricing for SaaS-mode agencies (depends on A).

## Needs its own spec (no business decision blocking)

### D. WhatsApp triggers and actions in GHL workflows
- First: triggers **Inbound WhatsApp message** and **WhatsApp disconnected**; action **Send WhatsApp message**.
- GHL Marketplace apps declare custom triggers and actions in the developer portal. Confirm the current mechanism and payloads against GHL's developer docs before speccing; nothing in this repo uses them yet.
- **Touches:** a new action webhook route under `src/app/api/webhooks/`, trigger firing from `src/lib/ghl-inbound.ts` and from the bridge's disconnect path (`services/whatsapp-bridge/src/sessions.ts` `handleClose`), and the GHL app config.
- **Side benefit:** a disconnect trigger lets agencies build their own alerts, on top of the planned email.

### E. Groups in GHL Conversations
- The bridge drops group messages today. Groups need: opt-in per group (never sync all groups by default, for privacy and volume), a GHL contact or conversation per group, and outbound to a group JID.
- **Risk:** GHL Conversations are per contact. Confirm how GoGHL and Stevo represent a group (a synthetic contact is likely) before speccing.
- **Why it matters:** 325 votes on GHL's board, native can't do it, coaches run accountability groups.

### F. Voice notes, then reactions, quoted replies, edits and deletes
- Voice notes: outbound audio already goes through the media path, and `services/whatsapp-bridge/src/media.ts` sends genuine ogg/opus as a push-to-talk voice note (`ptt: true`). Other formats (GHL's own recordings may be webm or mp3; check) go as plain audio files. Showing them as voice notes means transcoding to opus, which means ffmpeg on Railway.
- Reactions, replies, edits and deletes: inbound handling in `services/whatsapp-bridge/src/inbound.ts`. GHL has no native reaction or edit type, so the likely rendering is a short text note in the conversation ("Reacted 👍 to: …"). No rival claims this, so it's a differentiator.

### G. Later
- **SMS fallback** for contacts not on WhatsApp: the bridge already reports "not on WhatsApp" (`recordNotOnWhatsapp`). A GHL workflow can branch on that once D exists, so build D first and document the recipe rather than building a gateway.
- **Missed-call text-back:** Baileys sees call offers (`call` events). A "Missed WhatsApp call" trigger fits D.
- **AI replies:** go through GHL's own AI agents (which act on Conversations already), not a bespoke bot.
- **Official API upgrade path:** Coexistence is now available in the UK and EU (Meta changelog). For a risk-averse client, the honest answer may be GHL's native WhatsApp, not a second PingWren product.

## Risk to watch before launch

WhatsApp's passkey prompt during device linking (Baileys issue #2672, open since 30 Jun 2026, no fix in 7.0.0-rc14). Test linking a brand-new number on several real accounts before the soft launch. If linking fails for a meaningful share of users, the "connected in 2 minutes" pitch and the whole onboarding flow are at risk.

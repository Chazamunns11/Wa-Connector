# PingWren competitor gap analysis

16 Oct 2026. Question: what do similar and competing WhatsApp-for-GoHighLevel products offer that PingWren doesn't?

Updated the same day after a final follow-up pass and the first build work (see "What's been built since").

Method: a deep-research run (5 search angles, 20 sources, 25 claims checked by three independent reviewers each, 4 killed), then five follow-up passes on the gaps it left: Stevo/WhatsHub/ChatArchitect and other GHL connectors; TimelinesAI, 2Chat, Maytapi, Callbell, Respond.io; reliability, support and message-level features; native GHL WhatsApp, Coexistence and UK/EU compliance; user reviews and GHL Marketplace numbers.

**Read this with one caveat.** Almost everything comes from vendors' own pages. It shows what they advertise, not what works. The only independent evidence is GHL Marketplace ratings and installs (pulled from the Marketplace's public API on 16 Oct), the GHL ideas board, and a handful of Trustpilot and GetApp reviews. Reddit, G2 and Capterra refused automated access.

## The short version

PingWren is behind on four things, in this order of importance for agencies and coaches:

1. **How it's sold.** Every QR competitor prices per sub-account with 3 to 5 numbers included, runs a free trial without a card, offers white-label, and pays affiliates 15 to 30% recurring. PingWren does none of these.
2. **How deep it goes into GHL.** The leader (GoGHL) adds its own workflow actions and triggers, syncs WhatsApp groups into Conversations, and sends voice notes and buttons. PingWren rides GHL's "Send SMS" step and stops there.
3. **Multiple numbers and groups.** These are the two biggest wishes on GHL's own ideas board (607 and 325 votes). Native GHL can't do either yet. Every serious QR rival does both.
4. **Visible ban protection.** Rivals sell proxies, drip pacing, spintax, typing simulation and number warm-up. PingWren already had a 45-75 second jittered gap between sends and a daily cap, and now also has typing simulation and an optional warm-up. It doesn't market any of it yet.

PingWren is ahead on onboarding (QR inside GHL plus shareable connect links), held messages, STOP opt-outs and disconnect alerts. No competitor page mentions held messages or opt-out handling. Users' top complaint across QR apps is disconnects and downtime, so reliability is the opening, as long as PingWren can show it on screen.

## Who the competitors are

| Product | Connection | Marketplace installs / rating (reviews) | Price | Trial |
|---|---|---|---|---|
| **GoGHL / MessageSync** | QR | 64,086 / 4.7 (126) | $29, $22 at 3+, $19 at 10+ per sub-account; 5 numbers incl., extra $9 | 7 days, no card |
| **myCRMSIM** | QR (SMS, iMessage, WA) | 89,987 / 4.4 (13) | WhatsApp $29 per line | none (a review con) |
| **"WA Connector – Unlimited WhatsApp"** (Whizz Solutions) | QR | 27,991 / 4.5 (8) | same as WAGHL (it is WAGHL) | 14 days, no card |
| **waautoreply** | QR | 13,146 / 3.1 (37) | not checked | not checked |
| **WAGHL** | QR | 5,232 / 5.0 (1) | $29 per sub-account (3 numbers, extra $10); $19 at 11+ | 14 days, no card, 50% off 3 months |
| **WAsendr** | QR | 2,631 / 3.7 (8) | not checked | not checked |
| **AppLevel** | QR | 1,796 / 4.3 (3) | $49, $39 at 11+, $34 at 31+ per account; 5 devices incl. | no card |
| **GREEN-API** | QR (API vendor) | 409 / 4.3 (3) | per instance | – |
| **TimelinesAI** | QR (likely) | 47 / 5.0 (8) | $35 or $49 per seat | 10 days, no card |
| **WhatGHL** | "No Meta API" | not found | $14.99 per sub-account, 5 sessions, extra $3 | 5 days, no card |
| **Wazzap** (Latin America) | QR | no listing | $19 to $199 tiers, 5 numbers per sub-account, extra $3 | 7 days |
| **Stevo** (Brazil) | QR (Evolution API) + official option | no listing | $11 (1 number), $25 (3), $37 (5) | 5 days, no card |
| **GHL native WhatsApp** | Official Cloud API | built in | $10 per sub-account + Meta message fees | – |

**Name clash:** a Marketplace app already called "WA Connector – Unlimited WhatsApp" has about 28,000 installs. It is the WAGHL team relisted: its website, waconnector.com, redirects to waghl.com, and its in-app page is titled "WAGHL". Listed 16 Sep 2026, it reached 28,000 installs in a month, which makes WAGHL a much bigger player than its old 5,232-install listing suggests. Don't ship under the working name. PingWren is clear.

Not GHL competitors: ChatArchitect (official API, no GHL integration), Maytapi (developer API, $24 per phone), 2Chat (Make.com recipe only), Callbell and Respond.io (official API, Zapier only). TimelinesAI does have a GHL app, but inbound messages land as contact notes, not in GHL Conversations, and the inbox stays in TimelinesAI. "WhatsHub" as a GHL product couldn't be found.

## Gaps in detail

### 1. Pricing and trial

- **Unit.** The market charges per sub-account and includes 3 to 5 numbers. Going rate: $19 to $29 per sub-account per month. Cheap end: Stevo $11 for one number, WhatGHL $14.99 for five sessions. PingWren's per-number price looks dear to any client with two numbers.
- **Card at signup.** Every rival we could check runs a no-card trial of 5 to 14 days. PingWren's card-required 7-day trial is the outlier. It does protect against free-trial abuse, but it costs signups.
- **Annual billing.** GoGHL gives two months free, Wazzap 20% off, Stevo 20 to 30% off.
- **Price anchor.** Native GHL WhatsApp is $10 per sub-account plus Meta fees. Agencies resell it at $30 to $100. GHL dropped its 5% WhatsApp processing fee from 1 Oct 2026. **Meta now charges for service messages too:** from 1 Oct 2026 every business number gets 1,000 free service messages a month, then pays per message, and in-window utility messages are billable. Meta's live pricing page and GHL's changelog agree. That strengthens the QR pitch: no per-message fees at all.
- **Cost stacking** is a user complaint: one ideas-board user puts QR providers at "$40 to $50 a month".

### 2. Agency resale

- **White-label:** GoGHL ("sub-accounts never see GoGHL branding"), WAGHL ("your customers will never know"), Wazzap (logo, colours, custom domain on every plan), Stevo, WhatGHL (with Stripe Connect rebilling).
- **Agency-level install** that adds future sub-accounts automatically: WAGHL. GoGHL has an agency dashboard.
- **Affiliates:** Wazzap 30% (existing clients only), WAGHL 20%, TimelinesAI 20% (60-day cookie), GoGHL 15%, Stevo has a full programme with coupons.
- SaaS Mode resale with markup needs GHL Agency Pro ($497). Those agencies want a wholesale price they can mark up.

### 3. GHL integration depth

- **Custom workflow actions:** GoGHL has "Send WhatsApp Message" and "Send Group Message". TimelinesAI has one action.
- **Custom triggers:** GoGHL has Inbound, Outbound, Missed Call, Group Participant Change and Disconnected. WAGHL says every event (sent, delivered, read, replied) is a trigger.
- **Groups in Conversations:** GoGHL and Stevo sync selected groups into the GHL Conversations tab. Wazzap adds member export, removing inactive members, welcome DMs and AI spam moderation. Native GHL doesn't support groups ("Create WhatsApp Groups", 325 votes, marked upcoming).
- **Multiple numbers per sub-account:** WAGHL ("unlimited"), GoGHL (5, with routing rules), Wazzap (5, "spread the load"), Stevo ("contacts are split across every selected number"). Native GHL allows one, and the request has 607 votes, is "in progress" and has slipped past August. An agency on that thread: "This is a blocker for us."
- **Read receipts as triggers:** WAGHL; Whapi through a DIY webhook.
- **SMS fallback** for non-WhatsApp numbers: WAGHL (Twilio or its own Android gateway), Wazzap, Stevo (Android SIM app).
- **Calls:** GoGHL has a Missed Call trigger, WAGHL has call events and missed-call text-back, and Stevo sells a voice add-on ($15 for 50 calls, $29 unlimited).
- **Reactions, quoted replies, edits and deletes synced to GHL:** no QR vendor claims this. Whapi's API supports them, but its GHL route is DIY. This is open ground, and a GHL user complained Coexistence loses edit and delete.

### 4. Engagement and AI

- **Buttons, lists and carousels:** WAGHL, Wazzap, Stevo ("#List command"), GoGHL. These are unreliable over WhatsApp Web, so treat the claims with care. Native GHL has buttons (up to 3) and lists on the official API.
- **Voice notes:** GoGHL and Wazzap (ElevenLabs), WAGHL (AI voice notes), AppLevel, WhatGHL. One GHL user: "The only way to send audios is with external providers such as GOGHL."
- **AI replies:** WAGHL (ChatGPT, booking bot), Wazzap (Claude or ChatGPT webhooks, Claude MCP), GoGHL (HighLevel AI, Closebot, Assistable), AppLevel (OpenAI), Stevo (AI audio transcription), GOWA (GHL AI Agents).
- **Bulk and scheduling:** WAGHL (a separate "Bulk lane" with 3 to 9 second pacing), Wazzap, Stevo. PingWren rules bulk out, which is the right call for ban risk and for Meta ad review.
- **Team logins:** WAGHL and TimelinesAI.

### 5. Ban protection

- GoGHL: residential proxies in 195+ countries, Smart Drip Mode, spintax, "AI Ban Protection Insights" ("results may vary").
- Wazzap: per-number proxies, random delays, typing indicator, split traffic.
- Whapi: automatic number-warming module on Premium; support moves a banned channel to a new server and proxy.
- Maytapi: a warm-up tool.
- Stevo: proxy subscriptions.
- PingWren: a 45-second minimum gap plus 0-30 seconds of random jitter between sends (already built, `src/pacing.ts`), a daily cap of 150, and now typing simulation and an optional warm-up (see below). Nobody else mentions held messages or STOP handling.

User evidence on bans is thin but real. A TimelinesAI Trustpilot reviewer wrote: "Tried sending to 40 contacts and it suspended my number."

### 6. Reliability and support

- **Uptime claims:** WAGHL and GoGHL say "99.9% uptime SLA". GREEN-API runs the only real public status page (status.green-api.com). Maytapi claims 99.98% with a status page. Nobody publishes response times.
- **Support:** 24/7 WhatsApp support is the norm (WAGHL "almost immediately", GoGHL, AppLevel "human 24/7", Stevo's WhatsApp support group).
- **What users actually complain about** (Marketplace review summaries): waautoreply at 3.1 stars has "frequent disconnections", "extended downtimes" and "poor customer support". WAsendr has "issues with connecting or reconnecting". GoGHL's reviews praise its support and say it "resolves issues experienced with other tools".

A public status page, a stated support response time, and held messages shown on screen would put PingWren's reliability story above every rival. None of them offer all three.

### 7. Official API path

- ChatDaddy tells users to move to the official API in Coexistence mode for "lower ban risk". Stevo has a Meta Embedded Signup path. WAGHL has a separate "Official APP" listing (165 installs).
- Coexistence (phone app and Cloud API on one number) is in GHL native, capped at one number. Meta's limits: groups don't sync, broadcast lists switch off, calls aren't supported, 20 messages per second. **It is available in the UK and EU:** Meta's own WhatsApp Platform changelog lists the EEA, EU and UK as supported (reported as dated 20 Oct 2025). Callbell's and Respond.io's "blocked in the UK/EU" pages are out of date. So the official route is a real option for UK coaches who want it.
- That leaves QR with groups, broadcast lists, calls on the phone, several numbers, no templates, no 24-hour window and no per-message fees. That's the pitch.

## Compliance and risk

- **WhatsApp's EEA terms** forbid reverse engineering, using automated means, and building software "that function[s] substantially the same as our Services" without authorisation. A Baileys client almost certainly breaches them. No Meta lawsuit against QR vendors was found for 2025 to 2026.
- **How rivals handle it:** Whapi says plainly it is "unofficial… not endorsed by… WhatsApp" and not responsible for bans. GREEN-API says bans depend on user behaviour, not the app. TimelinesAI hosts in Frankfurt and builds a GDPR Article 28 DPA into its terms. No terms or DPA pages were found for WAGHL, GoGHL or Wazzap. PingWren's planned DPA, plain unofficial-use wording and UK/EU positioning would be ahead of the GHL-specific rivals.
- **Technical risk, confirmed and unfixed:** since late June 2026 WhatsApp can ask for a passkey when a new device links ("You may need to scan another QR code to use your passkey"). Baileys issue [#2672](https://github.com/WhiskeySockets/Baileys/issues/2672) is still open, a workaround PR (#2676) was closed unmerged, and a separate new-pairing 428 failure ([#2691](https://github.com/WhiskeySockets/Baileys/issues/2691)) is also open. 7.0.0-rc14, which PingWren is locked to, is still the latest release, so no fixed version exists. Some users say the prompt later stopped appearing. **This hits PingWren's core flow (scan a QR to link) and every Baileys-based rival equally.** Test new-number linking on several real accounts before the soft launch, and watch #2672.
- **Security:** CVE-2026-48063 affects Baileys before 6.7.22 and 7.0.0-rc12. PingWren's bridge is locked to 7.0.0-rc14, so it's not affected.
- **Meta's AI rule** (from 15 Jan 2026) bars general-purpose AI assistants from the Business Platform. It doesn't touch businesses using AI to serve their own customers, so it gives QR no real selling point.

## What's been built since

On branch `claude/eloquent-mccarthy-m60n6c`, all with tests (bridge 299 passing on Node 24, app 345 passing, production build clean):

- **Typing simulation** (`services/whatsapp-bridge/src/typing.ts`). "Typing…" shows in the recipient's chat before each text: 1 second plus 30ms per character, ±20%, capped at 4 seconds. A dropped socket during the window fails the message as not sent, so it's safe to retry. On by default (`WA_TYPING_INDICATOR_ENABLED`, `WA_TYPING_MAX_MS`).
- **Warm-up for new numbers** (`src/pacing.ts`, migration `0005`). Daily cap of 20 for days 0-2, 50 for days 3-6, 100 for days 7-13, then the normal cap. **Off by default** (`WA_WARMUP_ENABLED`), because FitClosers' 11 established numbers will be re-scanned during the move and would count as new. Migration 0005 must be applied before this bridge is deployed.
- **Public status page** at `/status`. One state each for "WhatsApp sending" and "GoHighLevel sync", no customer data, cached for 60 seconds.

The rest of the list below needs either a decision from Charlie or its own spec. See `docs/superpowers/plans/2026-10-16-competitor-gap-roadmap.md`.

## What to do, in priority order

This is judgement built on the findings above.

1. **Reprice before launch.** Per sub-account, 3 to 5 numbers included, around $19 to $29 with volume tiers, annual discount. Reconsider the card-required trial, or offer a longer one (14 days) if keeping the card. This is a spec change to §2 (billing), not new code yet.
2. **Multiple numbers per sub-account.** The single biggest user wish, and native GHL can't do it. PingWren's data model is one number per location today.
3. **White-label, agency-level install with auto-provisioning, and an affiliate programme** (20% recurring is the middle of the market).
4. **Custom GHL workflow triggers and actions.** Start with Inbound WhatsApp, Disconnected and Send WhatsApp. These also fix the "Telephony Provider not set" support problem the spec already worries about.
5. **Groups in GHL Conversations.** High demand, native can't do it, and it matters for coaches running accountability groups.
6. **Visible ban protection.** Pacing, jitter, typing and warm-up are now built. What's left is to market it, with held messages and opt-outs, as "built not to get you banned", and to decide when to turn warm-up on.
7. **Voice notes, then reactions, quoted replies, edits and deletes synced to GHL.** Voice notes are table stakes. The message-level sync is something nobody else claims.
8. **A public status page and a stated support response time.** The status page is built. The response time is Charlie's to set and publish.
9. **Later:** AI replies (through GHL's own AI agents, not a bespoke bot), SMS fallback, missed-call text-back, and an official-API upgrade path.

## Settled in the follow-up pass

- **"WhatsHub"** isn't a GHL product. None of the 2,675 GHL Marketplace apps match (about 55 are WhatsApp apps), and whatshub.io redirects to a Pipedrive tool.
- **"WA Connector" (28,000 installs)** is WAGHL relisted (above).
- **myCRMSIM** charges $29 per WhatsApp line per month and has no free trial. It advertises no templates, no 24-hour window and SMS fallback.
- **Meta billing:** service messages are billable from 1 Oct 2026 after 1,000 free a month (above).
- **Coexistence** is supported in the UK and EU per Meta (above).
- **Passkey linking problem:** real and unfixed (above).

## Still open

- Which advertised features actually work: buttons over WhatsApp Web, group sync, proxies and warm-up. Only hands-on trials will tell.
- Whether Wazzap's 7-day trial takes a card. Probably yes: its sign-up funnel's settings include `"requireCreditCard": true` and a Stripe step, though the page shows no card field. Only a real sign-up would confirm it.
- Whether GHL ships multiple numbers per sub-account soon. It's "in progress" with 607 votes and has already slipped once.

## Sources

Vendor pages: [goghl.ai](https://goghl.ai/en), [waghl.com](https://waghl.com/), [waghl.com/features](https://waghl.com/features), [wazzap.mx](https://www.wazzap.mx/en), [stevo.chat](https://stevo.chat/) (from its app script), [applevel.ilumosdigital.com](https://applevel.ilumosdigital.com/), [whatghl.com](https://whatghl.com/), [green-api.com GHL docs](https://green-api.com/en/docs/integration/gohighlevel/integration/), [whapi.cloud/price](https://whapi.cloud/price), [whapi.cloud/terms](https://whapi.cloud/terms), [timelines.ai GHL integration](https://timelines.ai/gohighlevel-whatsapp-integration), [timelines.ai/pricing](https://timelines.ai/pricing/), [timelines.ai/security-standards](https://timelines.ai/security-standards), [2chat.co/pricing](https://2chat.co/pricing), [maytapi.com pricing](https://maytapi.com/whatsapp-api-pricing), [callbell.eu pricing](https://www.callbell.eu/en/pricing/), [respond.io/pricing](https://respond.io/pricing), [chatarchitect.com pricing](https://www.chatarchitect.com/whatsapp-pricing), [ChatDaddy help](https://help.chatdaddy.tech/article/whatsapp-not-working-fix-bans-delays-disconnections-blocks).

GHL and Meta: [GHL pricing](https://www.gohighlevel.com/pricing), [GHL WhatsApp billing guide](https://help.gohighlevel.com/support/solutions/articles/155000001428-whatsapp-pricing-billing-and-rebilling-guide), [GHL 5% fee change](https://ideas.gohighlevel.com/changelog/removing-the-5-processing-fee-and-meta-pricing-changes-from-1-october), [GHL Coexistence](https://help.gohighlevel.com/support/solutions/articles/155000001980), [ideas: multiple numbers](https://ideas.gohighlevel.com/whatsapp/p/multiple-wa-phone-numbers-per-account), [ideas: groups and mobile](https://ideas.gohighlevel.com/whatsapp/p/whatsapp-group-chat-support-mobile-app-access), [ideas: QR request](https://ideas.gohighlevel.com/whatsapp/p/mejora-para-integracion-de-whatsapp-via-codigo-qr-en-gohighlevel), [Meta pricing](https://developers.facebook.com/docs/whatsapp/pricing/), [Meta Coexistence docs](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/onboarding-business-app-users), [WhatsApp EEA terms](https://www.whatsapp.com/legal/terms-of-service-eea), [Meta Business Platform terms](https://www.facebook.com/legal/Meta-Terms-for-WhatsApp-Business-Platform), [CVE-2026-48063](https://nvd.nist.gov/vuln/detail/CVE-2026-48063).

Independent: GHL Marketplace public API (`backend.leadconnectorhq.com/marketplace/public/all`), [appsforghl.com WAGHL](https://www.appsforghl.com/apps/waghl-whatsapp), [TimelinesAI on Trustpilot](https://www.trustpilot.com/review/timelines.ai), [TimelinesAI on GetApp](https://www.getapp.com/customer-management-software/a/timelinesai/reviews/).

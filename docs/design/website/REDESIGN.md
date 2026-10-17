# PingWren website redesign (Task 13)

16 Oct 2026. Planner: Fable. Binding inputs: `global-constraints.md` and rulings W1 to W33 in `.superpowers/sdd/2026-10-16-website/progress.md`; `public/brand/README.md`; the owner's six decisions (voice, hero, imagery, signature section, pricing, palette). The copy is in `COPY-DECK.md`; the build is split in `.superpowers/sdd/2026-10-16-website/task-13-plan.md`.

## What the owner said and what it means

"Looks so much like it's been done with Claude on the text etc." The current site is correct and accessible, and it reads like a template: every section is a left-aligned heading plus a paragraph, dark then cream then dark; the product never appears; the hero figure is a small schematic in a lot of empty space; the pricing page is a card kit. The copy has no one speaking and hedges every sentence.

The target: a site that a small team who use the product would plausibly have built. It shows the product, speaks in one voice, puts the owner's real result first, and keeps every claim that is already pinned by the rulings.

Accessibility and the 375px layout already pass (`docs/website-screenshots/a11y-report.md`) and stay passing. Nothing in this plan trades either away.

---

## 1. Tokens

Token names in `globals.css` stay as they are (bg, card, raised, well, ink, ink-dim, accent, accent-text...), so existing call sites repaint. The values move: Paper becomes the default ground, Cream becomes a note colour, Ink keeps the hero and the signature band, and Wren gets a job.

### Colour

| Token | Light scope (`:root`) | Ink scope (`.surface-dark`) | Role |
|---|---|---|---|
| `--color-bg` | **#FFFFFF Paper** (was Cream) | #1B1F2A Ink | page ground |
| `--color-card` | #FFFFFF | #242938 | sample-screen chrome |
| `--color-raised` | #F6F1EA Cream (was #EFE8DD) | #2D3345 | the one cream note band per page, the calculator's sentence box, "Before you start" |
| `--color-well` | #F6F1EA Cream (was white) | #151823 | inside a phone frame, behind messages |
| `--color-ink` | #1B1F2A | #F6F1EA | body text |
| `--color-ink-dim` | #454A57 | #D3CCC0 | secondary |
| `--color-ink-faint` | #5F6270 | #A8A296 | captions, footnotes (never below 14px) |
| `--color-accent` | #FF5A36 Coral | same | the primary button, the ping dot. Nothing else. |
| `--color-accent-ink` | #1B1F2A | same | text on Coral (5.3:1) |
| `--color-accent-text` | #7A4E2D Wren | #D9A47A Tan | links, the big number's "to", sample-screen labels, rules on Cream |
| `--color-rule` (new) | #7A4E2D Wren at 100% | #D9A47A Tan | the 2px section rules and the footnote rule. The one structural colour. |
| `--color-border` | rgba(27,31,42,.14) | rgba(246,241,234,.16) | hairlines inside sample screens only |
| `--color-border-strong` | #8C8478 | #7E8290 | inputs, secondary buttons (3.3:1 on Paper: 3.29 measured on Cream, higher on white) |
| `--color-sms` (new) | #E9E9EB | — | the SMS bubble on the signature pair (grey, with Ink text, 13.9:1) |
| `--color-paper` / `--color-paper-ink` | #FFFFFF / #1B1F2A | same | WhatsApp-side bubbles, as now |
| status win/loss/warn/info | unchanged | unchanged | dashboard mock chips |

Measured pairs that matter (WCAG): Ink on Paper 16.5; ink-dim on Paper 8.9; ink-faint on Paper 6.1, on Cream 5.4; Wren on Paper 7.1, on Cream 6.3; Ink on Coral 5.3; Tan on Ink 7.5; Ink on `--color-sms` 13.9. Wren as a 2px rule on Paper is 7.1 (non-text minimum is 3).

Rule: Coral appears on a page at most twice (header button, section CTA) plus the ping dot. Wren does the structural work. Cream appears once per page as a band or box, never as the ground.

### Type

- Display: Bricolage Grotesque 800 (h1, h2, the price, the big number) and 500 (h3, sample-screen titles). No change of family; the change is scale and setting.
- Body: Instrument Sans 400/500/600, 17px on marketing pages (was 16), line-height 1.55. The one-point rise and the Paper ground make the body feel printed rather than app-like.
- Mono: JetBrains Mono only inside the dashboard mock for phone numbers (the real app does this; `.font-mono-nums`). Nowhere else.

Scale (ratio 1.25 from 16, the Task 9c scale, kept): 16 / 20 / 25 / 31 / 39 / 49 / 61, plus two display sizes that the price and the hero number use: 76 and 96.

| Role | 1280 | 375 | Weight / tracking / leading |
|---|---|---|---|
| Hero h1 | 61 | 39 | 800, -0.035em, 1.02 |
| Hero number (inside the h1 as a `<span>`) | 96 | 56 | 800, -0.04em, 0.95, tabular |
| h2 | 39 | 31 | 800, -0.03em, 1.1 |
| h3 | 25 | 22 | 500, -0.015em, 1.25 |
| Lead paragraph | 22 | 19 | 400, 1.4 |
| Body | 17 | 17 | 400, 1.55, max 62ch |
| Footnote / caption | 15 | 14 | 400, ink-faint, 1.45 |
| Pricing page price | 96 (`clamp(56px, 10vw, 96px)`) | 56 | 800, -0.04em, tabular |
| Buttons | 17 | 17 | 600 |

Setting rules: headings are sentence case; no eyebrow labels above headings; no ALL CAPS anywhere; no italic or coloured single words inside a heading; the big number is set in the same Ink as the heading, with only the small word "to" in Wren. Numbers that are compared sit on one baseline.

### Space and shape

- Grid: 4/8. Gutter 16px at 375, 32px from 768, max content width 72rem (unchanged `Container`).
- Section rhythm: 64 / 112px (375 / 1280) between sections, measured rule to rule. Each marketing section opens with a 2px Wren rule the width of the content column, then the h2 24px below it. That rule is the section device; there are no cards, no alternating backgrounds, no dividers between paragraphs.
- Radius: 4px on controls, 20px/4px asymmetric on bubbles (existing), 28px on the phone frame, 8px on the browser-ish chrome of a sample screen. Nothing else is rounded.
- Shadow: none, except the phone frame's one `0 24px 48px -24px rgba(27,31,42,.35)` so it sits on the page.

---

## 2. The one signature element: the same reminder, twice

Two phones side by side, overlapping by 48px at 1280, stacked at 375. Both show the same reminder text. The left phone is an SMS thread: grey bubble (`--color-sms`), the time stamp "Yesterday 14:02", nothing after it. The right phone is the WhatsApp thread: the same reminder as a Paper bubble with the status word "Delivered", then the reply "Yes, see you at 2" as an inbound bubble, then "Back in Conversations" as a status word under it.

What it says without a claim: here is a reminder nobody answered, here is the same one someone did. No open rate, no read rate, no tick marks, no green, no WhatsApp logo (W22, W25, W32). The caption says the messages are samples.

It lives in the hero, on the Ink ground, at the full height of the hero column, so the first screen is the memorable thing and the figure no longer floats (owner audit). The rest of the page is quiet by comparison: Paper, one Cream note, Wren rules.

Markup: one `<figure role="img" aria-label="...">` (label text in the copy deck), both phones `aria-hidden`, the caption visible as `<figcaption>`. Pure markup and CSS; no client JS (the `site-pricing` test's island allow-list stays at two).

---

## 3. Sample screens (owner decision 3, W31)

Three built mocks, all from our own app, all labelled "Sample screen" in the visible caption, none a copy of GoHighLevel's UI:

1. **Connect panel** (`src/components/whatsapp/WhatsappConnectionPanel.tsx` is the source of truth): card title "WhatsApp", status chip "Waiting for QR scan" (warn), a QR placeholder (`QrMark` from `diagram-parts.tsx`, enlarged), the instruction line "On your phone: WhatsApp → Settings → Linked devices → Link a device, then scan this code." and the safety line in `--color-loss`, and the "Get a new QR code" secondary button. A second state, "Connected as +44 7700 900101", is shown as a small strip under it in the setup guide only.
2. **Dashboard**: the real `/dashboard` table reduced to three rows (Harbour Street Physio, Connected, 42 / 150; Millbrook Vets, Disconnected · 4 waiting, Reconnect; Fernbank Dental, Connected, 0 / 150, "Is the Telephony Provider set?"). Same chips, same wording as the preview page (the sample data in `src/lib/account-data`), so the site never shows something the app does not say.
3. **Phone thread**: the right-hand phone of the signature pair, reused on its own in the setup guide's step 6.

Mocks are server components in `src/components/site/samples/`. They use the existing `Chip`, `buttonClasses` and bubble classes, so when the app's chrome changes the mocks follow. Each is one `role="img"` with an `aria-label` that says what the sample shows, and nothing inside is focusable.

Why mocks and not screenshots: the preview dashboard is sample data anyway; a built mock keeps text crisp at 375, costs no image bytes, and cannot drift from the brand tokens.

---

## 4. Home page, section by section

Section order follows the sales-page skill's approach (hook with the result, then what it is, then how it works, then the objection block, then price), not its template.

### 1280

```
┌──────────────────────────────────────────────────────────────────────────┐
│ [pingwren]            Pricing   Setup guide   Docs        Log in [Start 7-day free trial] │  Ink
├──────────────────────────────────────────────────────────────────────────┤
│                                                                          │  Ink
│  About half of booked                    ┌────────┐  ┌────────────┐      │
│  clients turned up.                      │  SMS   │  │  WhatsApp  │      │
│  With WhatsApp reminders                 │        │  │            │      │
│  it's 85%+                               │ ░░░░░░ │  │  ▓▓▓▓▓▓▓▓  │      │
│  ────────────────────────                │ ░░░░░░ │  │  Delivered │      │
│  PingWren sends the reminders your       │Yesterday│ │     ▓▓▓▓▓  │      │
│  GoHighLevel workflows already send...   │  14:02 │  │ Back in    │      │
│                                          └────────┘  │Conversations│     │
│  [Start 7-day free trial] [Read the setup guide]     └────────────┘      │
│  We take a card up front...                                              │
│  ¹ Our own average ... not a study ... results vary.   Sample messages.  │
├──────────────────────────────────────────────────────────────────────────┤
│ ══ Wren rule ═════════════════════                                       │  Paper
│ Why we made it                                                           │
│ (two short paragraphs in "we", max 62ch)                                 │
│ One sourced line on the research, small, with the two PMC links.         │
├──────────────────────────────────────────────────────────────────────────┤
│ ══ Wren rule ═════════════════════                                       │  Paper
│ How you set it up                                                        │
│  1 Install ─────── 2 Telephony Provider ─────── 3 Scan ───────           │
│  (text)            (text, the exact path)        ┌─────────────┐         │
│                                                  │Connect panel│ sample  │
│                                                  └─────────────┘         │
├──────────────────────────────────────────────────────────────────────────┤
│ ┌── Cream band (the one on this page) ─────────────────────────────────┐ │
│ │ What you look at afterwards            ┌────────────────────────┐    │ │
│ │ (one paragraph)                        │ Dashboard sample (3 rows)│   │ │
│ │                                        └────────────────────────┘    │ │
│ └──────────────────────────────────────────────────────────────────────┘ │
├──────────────────────────────────────────────────────────────────────────┤
│ ══ Wren rule ═════════════════════                                       │  Paper
│ How it treats your number                                                │
│  (annotated thread from Task 9c, three rows, unchanged structure)        │
├──────────────────────────────────────────────────────────────────────────┤
│ ══ Wren rule ═════════════════════                                       │  Paper
│ Read this before you sign up                                             │
│  (the disclosure block: linked device, not the official API, the ban     │
│   risk, the phone must stay online. Four short paragraphs, 62ch.)        │
├──────────────────────────────────────────────────────────────────────────┤
│ ══ Wren rule ═════════════════════                                       │  Paper
│ Questions we get                                                         │
│  (seven <details>, the ones the block above does not already answer)     │
├──────────────────────────────────────────────────────────────────────────┤
│  £29  per WhatsApp number, per month        [Start 7-day free trial]     │  Ink
│  (one line of terms)                        See the full pricing         │
├──────────────────────────────────────────────────────────────────────────┤
│ [pingwren]  linked-device line + W12 disclaimer        Terms Privacy Docs│  Ink
└──────────────────────────────────────────────────────────────────────────┘
```

### 375

```
┌───────────────────┐
│[pingwren] [Start] ≡│ Ink
├───────────────────┤
│ About half of     │ Ink
│ booked clients    │
│ turned up.        │
│ With WhatsApp     │
│ reminders it's    │
│ 85%+              │
│ PingWren sends... │
│ [Start 7-day free │
│  trial]           │
│ [Read the setup   │
│  guide]           │
│ We take a card... │
│ ┌───────────────┐ │
│ │ SMS phone     │ │
│ │ (short)       │ │
│ └───────────────┘ │
│ ┌───────────────┐ │
│ │ WhatsApp phone│ │
│ └───────────────┘ │
│ Sample messages.  │
│ ¹ footnote        │
├───────────────────┤
│ ══ rule           │ Paper
│ Why we made it    │
│ ...               │
├───────────────────┤
│ ══ rule           │
│ How you set it up │
│ 1 ...             │
│ 2 ...             │
│ 3 ...             │
│ ┌───────────────┐ │
│ │Connect sample │ │
│ └───────────────┘ │
├───────────────────┤
│ ┌ Cream ────────┐ │
│ │What you look  │ │
│ │at afterwards  │ │
│ │┌────────────┐ │ │
│ ││Dashboard   │ │ │ (rows become the
│ ││3 rows      │ │ │  existing mobile
│ │└────────────┘ │ │  card list)
│ └───────────────┘ │
├───────────────────┤
│ ══ rule           │
│ How it treats     │
│ your number       │
│ (thread, stacked) │
├───────────────────┤
│ ══ rule           │
│ Read this before  │
│ you sign up       │
├───────────────────┤
│ ══ rule           │
│ Questions we get  │
├───────────────────┤
│ £29 per number... │ Ink
│ [Start 7-day...]  │
├───────────────────┤
│ footer            │ Ink
└───────────────────┘
```

At 375 the phones stack with the SMS phone cropped to 180px tall (its thread is short anyway) and the WhatsApp phone at full height; both stay inside the 16px gutters, so no horizontal scroll. The hero text comes first in DOM and on screen.

Alignment: everything left-aligned on the content column. Headings never centred. The price strip and footer keep their two-column split at 1280 and stack at 375.

What was removed versus today: the "Live in three steps" numbered ladder as a standalone band; the "Keep your workflows" one-liner band (its fact moves into "Why we made it"); the full research band (shrinks to one sourced line, W30); the "What we've seen" band (moves into the hero, W30); five of the twelve FAQ entries from the home page (the disclosure block says them once; `/docs/faq` keeps all twelve).

---

## 5. Pricing page

No cards. One column of type with Wren rules, a Cream box for the calculator sentence, a plain two-column comparison with a dated source line.

### 1280

```
┌──────────────────────────────────────────────────────────────────────────┐
│ header (Ink)                                                             │
├──────────────────────────────────────────────────────────────────────────┤
│                                                                          │ Paper
│  £29                                                                     │ 96px, 800
│  per WhatsApp number, per month                                          │ 22px
│                                                                          │
│  No setup fee. We don't charge per message. The price is the same        │
│  whether you have one number or forty.                                   │
│                                                                          │
│ ┌ Cream ───────────────────────────────────────────────────────────────┐ │
│ │  If I connect [ 5 ▲▼] numbers, I'll pay  £145 a month.               │ │  inline calculator
│ │  Whole numbers from 1 to 500.                                        │ │
│ └──────────────────────────────────────────────────────────────────────┘ │
│  1 number £29 · 3 numbers £87 · 5 numbers £145 · 10 numbers £290 · 25 numbers £725   (the no-JS fallback, one line, tabular) │
│                                                                          │
│ ══ Wren rule ═══════════════════                                         │
│ The trial, and what happens after                                        │
│  (three short paragraphs: trial, cancelling, failed payment)             │
│                                                                          │
│ ══ Wren rule ═══════════════════                                         │
│ Against GoHighLevel's own WhatsApp                                       │
│  ┌──────────────────────────────┬──────────────────────────────┐        │
│  │ PingWren                     │ GoHighLevel's WhatsApp        │        │  plain grid, hairline column
│  │ £29 per number per month     │ $10 per sub-account per month │        │
│  │ no per-message charge        │ plus a charge per delivered   │        │
│  │ your own number, linked      │ template message at Meta's    │        │
│  │ device                       │ country rates (their US       │        │
│  │ no green tick, no templates  │ example: $0.0263 marketing)   │        │
│  │ ban risk is yours to weigh   │ the official API: green tick, │        │
│  │                              │ approved templates, no phone  │        │
│  └──────────────────────────────┴──────────────────────────────┘        │
│  Source: HighLevel help centre, "WhatsApp Pricing, Billing, and          │
│  Rebilling Guide", modified 22 Sep 2026, checked 16 Oct 2026. ...        │
│                                                                          │
│ ══ Wren rule ═══════════════════                                         │
│ Billing questions   (five <details>)                                     │
│                                                                          │
│  [Start 7-day free trial]                                                │
├──────────────────────────────────────────────────────────────────────────┤
│ footer                                                                   │
└──────────────────────────────────────────────────────────────────────────┘
```

At 375 the comparison grid becomes two stacked lists with their own h3s; the fallback price line wraps to one price per line; the calculator sentence wraps naturally with the input inline (min 44px tall, 5ch wide).

The calculator stays the one client island on this page (`PricingCalculator.tsx`, rewritten to render the sentence). The server-rendered fallback is the one-line preset list, which keeps `site-pricing.test.ts`'s "1, 3, 5, 10 and 25" check honest.

Comparison honesty (W25, W33): the GHL figures are HighLevel's own, quoted in USD as published, with the article name and modified date. The UK per-message rate was not verifiable from Meta's page (it links a CSV), so the page says "at Meta's country rates" and gives HighLevel's own US example rather than inventing a UK figure. The comparison also states what the native option has that we do not (official API, green tick, template approval, no phone), so it reads as a fair table and not an attack.

---

## 6. Setup guide: intro and hero area

The steps, diagrams, tabs and troubleshooting stay as built (tests pin them). Only the top of the page changes.

```
1280
┌──────────────────────────────────────────────────────────────────────────┐
│ header                                                                   │
├──────────────────────────────────────────────────────────────────────────┤
│  Setting up PingWren in GoHighLevel            ┌──────────────────────┐  │ Paper
│  (lead paragraph in "we", 62ch)                │ Connect panel sample │  │
│                                                │ with the Connected   │  │
│  Before you start                              │ strip under it       │  │
│   · a GoHighLevel account with a sub-account   └──────────────────────┘  │
│   · a PingWren account (the trial is fine)       Sample screen.          │
│   · the phone with the WhatsApp number           This is the page you    │
│   · a second phone for the test                  will see in step 4.     │
│                                                                          │
│  [Agency owner] [Single sub-account]                                     │
│  ...steps as now...                                                      │
```

At 375 the sample screen sits under the "Before you start" list and above the tabs. The Cream box around "Before you start" goes; the list is plain with a Wren rule above the heading.

---

## 7. Motion plan

One orchestrated moment on the whole site, in the hero: the WhatsApp phone's reply arrives.

- 0 to 150ms: nothing (the page settles).
- 150 to 600ms: the outgoing reminder bubble on the WhatsApp phone slides up 16px into place at full opacity (no fade on the bubble itself; `site-home-visual.test.ts` pins that the keyframes carry no opacity). The SMS phone does not move at any point. That stillness is the point.
- 600 to 900ms: "Delivered" fades in (opacity only, 200ms).
- 950 to 1300ms: the reply bubble and "Back in Conversations" rise 8px and fade in.
- The Coral ping dot on the reminder's tail corner, as now, at 650ms.

Total 1.3s, CSS only, keyframes named `hero-land`, `hero-fade-up`, `hero-ping-ring` (kept, so the existing tests keep matching), delays set on the elements. `@media (prefers-reduced-motion: reduce)` sets `animation: none` on every hero class and `display: none` on the ping ring, so the finished frame renders straight away.

Nothing else on the site moves on its own: no section fade-ins (`.rise-in` stays unused on marketing pages), no hover lifts, no count-up on the price or the number. Interaction feedback is the existing 120ms button transition and the `<details>` open state.

---

## 8. Anti-patterns (what the build must not do)

From the frontend-design generic-defaults list, applied to this brief:

1. No cream ground with a serif and a terracotta accent. Cream is a note colour here; the ground is Paper; the accent is the brand's Coral on buttons only.
2. No SaaS card kit: no rounded white panels with a shared grey shadow, no tick lists, no "Examples" table in a card, no three-up feature cards.
3. No eyebrow labels, no ALL CAPS, no middle-dot meta strings ("A · B · C") in prose. The one place a middle dot appears is the dashboard mock's "Disconnected · 4 waiting" chip, because the app prints it.
4. No "→" appended to link or button text.
5. No numbered markers except the real three-step sequence and the setup guide's steps.
6. No accent word inside a heading (no coloured "85%", no italic "WhatsApp").
7. No per-section entrance animation; one moment only.
8. No invented proof: no testimonials, logos, star ratings, open or read rates, "trusted by" (W25). The hero number is the owner's, footnoted (W27, W30).
9. No WhatsApp green, no WhatsApp logo, no tick marks, no GoHighLevel UI copies (W22, W31).
10. No brand name in consecutive sentences. Target: "PingWren" at most once per paragraph, and "we" or "it" otherwise.
11. No staccato fragments as copy ("Card needed up front. 3 numbers. Cancel any time."). Every customer-facing line is a sentence with a subject.
12. No caveat sentence glued to every claim. The disclosures live in one block on the home page, the footnote under the hero, and the FAQ.
13. No monospace for small labels; mono only where the app itself uses it.
14. No tinted near-black; Ink is #1B1F2A, the brand's.

## 9. Review against the generic defaults: what changed

I drafted the plan, then ran the frontend-design check ("would I arrive here for any WhatsApp-for-CRM landing page?") and changed four things:

- **First draft had the signature pair as its own band below the hero and the workflow-step schematic still in the hero.** That is the default "hero mock on the right" again, and the owner's audit named it. Changed: the pair is the hero figure; the schematic goes.
- **First draft kept alternating Ink/Cream/Ink bands to separate sections.** That is the alternating-stripe default. Changed: Paper ground with a Wren rule opening each section; Ink only at the top (hero) and bottom (price strip, footer); Cream once per page.
- **First draft put "How you set it up" in three equal columns with a number above each.** That is the three-up feature grid. Changed: a single horizontal timeline at 1280 (a Wren line with three stops, the third carrying the sample screen), stacked at 375. Numbers stay because the content is a sequence.
- **First draft's pricing page used a table for the comparison.** A table is fine for data, but a bordered table under a big price reads as the card kit's cousin. Changed: a two-column plain grid with one hairline between the columns and sentence-length cells, which also stacks cleanly at 375.

One thing I kept despite looking at it twice: the annotated safety thread from Task 9c. It is already specific to this product and was reviewed clean; rebuilding it would be change for its own sake.

Chanel test, applied to the plan: the first draft had a small Wren wren-mark watermark behind the hero number. Removed; the logo is in the header and the mark would read as decoration.

---

## Direction B (chosen): the coral field

16 Oct 2026. The owner compared three static drafts (`direction-a.html`, `direction-b.html`, `direction-c.html`; Superdesign's canvas was unavailable from the cloud session, W1) and chose B "by a country mile". Rulings W36 and W37 in `progress.md` bind; the build is split in `.superpowers/sdd/2026-10-16-website/task-14-plan.md`. Where this section and §1 to §9 above disagree, this section wins.

### What B is

Coral `#FF5A36` becomes a ground, not an accent. The header and hero, the safety band and the price strip sit on it, and every word on it is Ink `#1B1F2A` (5.3:1; nothing lighter passes, so there is no secondary grey, no Wren and never white text on coral). White sections carry "Why we made it", the dashboard board and the disclosure slab. Ink `#1B1F2A` sections carry the setup steps and the footer. The FAQ sits on Mist `#EEF0F4`. Cream `#F6F1EA` leaves every surface and every text token; it survives only inside the logo artwork, which stays untouched.

The devices, top to bottom on the home page:

1. Coral field: header (standard logo, Ink nav, Ink pill button) and hero in one colour. The h1 reads as one sentence; its last span is the number at `clamp(6.5rem, 24vw, 19rem)` in Bricolage 800 (104px at 375, 304px at 1280). Footnote link "Our own average¹" stays a sibling of the h1 (W34).
2. The two sample phones, tilted (-4° and 3°), hanging `clamp(150px, 27vw, 350px)` past the coral edge into the white section below. Both full height at every width; side by side at 375 (158px each).
3. "Why we made it" on white, two columns, the lead paragraph at 1.3rem; the research line and the hero footnote end the section under 2px Ink rules.
4. "How you set it up" on Ink: three columns with 3px Coral top rules, Coral numerals at `clamp(4.5rem, 9vw, 8rem)`, and the GoHighLevel path as a Coral chip with Ink text. No sample screen here (it stays on the setup guide).
5. "What you look at afterwards" on white: the dashboard sample as a board with a 3px Ink outline, 20px radius, an Ink top bar with a Coral "Sample" pill, Ink status dots (always with the word), Ink meters, Coral attention chips.
6. "How it treats your number" on Coral: h2 left, three ruled rows (3px Ink rules, Bricolage 800 titles) right. No bubbles.
7. "Read this before you sign up" on white: a 3px Ink slab, 24px radius, with a hard Coral offset shadow (12px, 6px below 640px). The three approved paragraphs; no invented sub-headings.
8. "Questions we get" on Mist: sticky h2 at 1280, `<details>` with 2px Ink rules and CSS chevrons.
9. Price strip on Coral: the price sentence as a large h2, the terms line, an Ink pill button.
10. Footer on Ink.

Type scale (B's): h1 `clamp(2.1rem, 4.6vw, 4.1rem)`; h2 `clamp(2.1rem, 5.2vw, 4rem)`; h3 1.35rem; all Bricolage 800, sentence case, no eyebrows, no accent word. Body stays Instrument Sans 17px/1.55.

Shape: buttons are 52px pills with a 2px Ink border (Ink fill on coral, Coral fill with Ink text on white and Ink grounds, outline for the secondary); slabs 3px Ink at 20 to 24px radius; phones 34px/26px; chips 8px; the "Sample" pill 999px. Structural lines are 2 or 3px Ink (Coral on Ink). Wren and Tan retire to the logo.

Motion: still one orchestrated moment in the hero, now opening with both phones rising (600ms, the second 120ms later) before the existing bubble, "Delivered", ping and reply sequence; done by 1.9s; `prefers-reduced-motion` renders the finished frame. Nothing else moves on its own.

### Tokens

| Token | White ground (`:root`) | Ink (`.surface-dark`) | Coral (`.surface-coral`) |
|---|---|---|---|
| `--color-bg` | `#FFFFFF` | `#1B1F2A` | `#FF5A36` |
| `--color-raised` / `--color-well` | `#EEF0F4` Mist | `#2D3345` / `#151823` | `#FFFFFF` |
| `--color-ink` | `#1B1F2A` | `#FFFFFF` | `#1B1F2A` |
| `--color-ink-dim` / `-faint` | `#4A5162` | `#E4E7EE` / `#C3C7D1` | `#1B1F2A` |
| `--color-accent` (fills) | `#FF5A36` | `#FF5A36` | `#1B1F2A` |
| `--color-accent-ink` (text on the fill) | `#1B1F2A` | `#1B1F2A` | `#FFFFFF` |
| `--color-accent-text` (links) | `#1B1F2A` | `#FFFFFF` | `#1B1F2A` |
| `--color-rule` | `#1B1F2A` | `#FF5A36` | `#1B1F2A` |
| `--color-border` | `#D5D9E1` | `rgba(255,255,255,.18)` | `rgba(27,31,42,.35)` |
| `--color-border-strong` | `#1B1F2A` | `#FFFFFF` | `#1B1F2A` |

Measured: Ink on Coral 5.3; Ink on Mist 14.4; `#4A5162` on white 8.3, on Mist 7.2; white on Ink 16.5; `#E4E7EE` on Ink 14.3; `#C3C7D1` on Ink 9.7; Coral on Ink 5.3 (numerals); Coral on white 3.1, so Coral is only ever a fill on white, never small text.

### What carries to the other pages

The same chrome (coral header, Ink footer) on every marketing page; the pricing page opens with the price on coral, then the calculator in an Ink slab, ruled comparison columns, and the billing questions on Mist; the setup guide and docs are white with Ink outlines on samples and diagrams, chevron disclosures for troubleshooting and the FAQ; signup, checkout and login use the slab and the pill buttons; the account dashboard keeps its Ink header and calmer app panels, with Cream gone through the tokens.

### Copy

Unchanged (W37). B's draft lines, including "Clients read WhatsApp" (a read claim, W25), are not used. The one structural edit: step 2's GoHighLevel path moves out of the sentence into the Coral chip, and the sentence says "open the path below". The safety intro line and the connect-sample caption are no longer rendered on the home page; the hero footnote moves to the end of "Why we made it". The full list is in the task plan, §7.

### Anti-patterns, revised for B

§8 above stands except item 1 (Cream is now banned outright, not reduced to a note band) and the Task 13 "Coral at most twice" rule, which W36 supersedes: Coral is a ground on three bands and a fill elsewhere. Still banned: white on Coral, Cream anywhere, WhatsApp green or logo, eyebrows, caps, accent words in headings, per-section fade-ins, invented proof, cards with soft grey shadows, "→" on links.

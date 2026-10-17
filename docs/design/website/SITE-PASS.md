# PingWren site pass: Ink header, features, phone mock-ups

17 Oct 2026. Planner: Fable. Branch `claude/pingwren-site-pass` from `main` 7ec85fb. Binding inputs: `global-constraints.md` and rulings W1 to W41 in `/home/user/wa-connector-site/.superpowers/sdd/2026-10-16-website/progress.md`; `REDESIGN.md` (Direction B, W36); `COPY-DECK.md`; the owner's request of 17 Oct. Where this file and REDESIGN.md disagree, this file wins. The build is split in `.superpowers/sdd/site-pass/plan.md`.

## What the owner said and what it means

> "Banner at top needs to be not orange. Needs to be really clear in terms of what it can do i.e. it's not just a WhatsApp reminder. It is a group creator. It has a lot of different functionalities with clear, transparent pricing, etc. We also need some better mockups for the phones, as it looks terrible. Please make sure all of the borders are correct and the segregation and the different colours for the pages are also working and all up to date."

Four jobs:

1. **Top of every page goes Ink.** Header and the band under it (hero on home, the price on `/pricing`, `PageTop` on docs and legal) become Ink `#1B1F2A` with the reverse logo. Coral stays for buttons and as a ground further down the page.
2. **Say what it does.** The hero stops being a single statistic and states the product: two-way chat in GoHighLevel, on WhatsApp, from your own number. A features section lists the rest (dashboard and connect links, pacing and cap, 24-hour hold, STOP per number, optional Do Not Disturb sync, pictures and files) and carries a marked slot for WhatsApp groups, rendered behind one flag so it ships "Coming soon" and flips to live without a redesign.
3. **Phones that look like phones.** Rebuilt in code with proportional (container-query) sizing, a correct bezel, status bar and island that never collide, a plain SMS app on one, a WhatsApp-style chat on the other, grey ticks, no green, no logo.
4. **One system across every page.** A border scale, a radius scale, a spacing scale, one heading scale and a band map per page, then a fix list with `file:line`.

Honesty stays as it was: W25 (no read or open-rate claims, nothing that isn't built), W27/W30 (the 85%+ figure is our own average, footnoted), W40 (volume pricing), W41 (resale calculator). Decisions this pass adds are listed at the end as proposed rulings W42 to W46 for the controller.

---

## 1. Tokens

Token names in `globals.css` stay. Values and scopes change as below. The file currently carries three `:root` blocks and two `.phone` blocks from the append-only era; Task A consolidates them into one block per scope while keeping the two things tests pin (a later `:root` block exists, `site-samples.test.ts`; the last `.surface-dark` block carries `--color-rule: #FF5A36`, `site-direction-b.test.ts`). The clean way: one `:root` for the few shared values (fonts, easing, status colours), one `:root` for the light scope, one `.surface-dark`, one `.surface-coral`.

### Colour

| Token | White ground `:root` | Ink `.surface-dark` | Coral `.surface-coral` | Role |
|---|---|---|---|---|
| `--color-bg` | `#FFFFFF` | `#1B1F2A` | `#FF5A36` | ground |
| `--color-card` | `#FFFFFF` | `#242938` | `#FFFFFF` | sample chrome, slabs |
| `--color-raised` | `#EEF0F4` Mist | `#2D3345` | `#FFFFFF` | FAQ band, wells, meters |
| `--color-well` | `#EEF0F4` | `#151823` | `#FFFFFF` | inputs |
| `--color-ink` | `#1B1F2A` | `#FFFFFF` | `#1B1F2A` | text |
| `--color-ink-dim` | `#4A5162` | `#E4E7EE` | `#1B1F2A` | secondary |
| `--color-ink-faint` | `#4A5162` | `#C3C7D1` | `#1B1F2A` | captions (never below 15px) |
| `--color-accent` | `#FF5A36` | `#FF5A36` | `#1B1F2A` | the primary fill |
| `--color-accent-ink` | `#1B1F2A` | `#1B1F2A` | `#FFFFFF` | text on the fill |
| `--color-rule` | `#1B1F2A` | `#FF5A36` | `#1B1F2A` | list rules |
| `--color-outline` (new) | `#1B1F2A` | `#FFFFFF` | `#1B1F2A` | object outlines (slab, board, phone screen edge, inputs) |
| `--color-border` | `#D5D9E1` | `rgba(255,255,255,.18)` | `rgba(27,31,42,.35)` | hairlines inside samples only |
| `--color-chip` (new) | `#1B1F2A` on `#EEF0F4` | `#1B1F2A` on `#FF5A36` | `#FFFFFF` on `#1B1F2A` | path chips, "Sample", "Coming soon" |

Measured pairs that matter: white on Ink 16.5; `#E4E7EE` on Ink 14.3; `#C3C7D1` on Ink 9.7; Coral on Ink 5.3 (numerals and rules, never small text); Ink on Coral 5.3; Ink on Mist 14.4; `#4A5162` on white 8.3 and on Mist 7.2. Coral buttons keep Ink text on every ground (W22). White on Coral never (W36). Cream nowhere (W36, tests).

Rule for the top of the page: the header has no bottom border. The band under it is the same Ink, so header and band read as one block, which is what the owner is reacting to today in orange. Below the first band the grounds alternate white, Coral, white, Mist, Coral, Ink (footer) on the home page; the per-page map is in §5.

### Type

Unchanged families: Bricolage Grotesque 800/500 display, Instrument Sans 400/500/600 body at 17px/1.55 on marketing pages, JetBrains Mono only for phone numbers in the dashboard. Inside the phone mock-ups the type is the system UI stack (`-apple-system, "SF Pro Text", "Segoe UI", Roboto, system-ui, sans-serif`), because a phone screen set in the site's fonts reads as a drawing of a phone, not a phone.

One heading scale, four classes, no inline `clamp()` on headings anywhere else (today the docs pages repeat `text-[clamp(1.5rem,3vw,2.2rem)]` nine times and the home and pricing pages carry two names for the same h2 size, `.h2-b` and `.h-display`):

| Class | Size | Use |
|---|---|---|
| `.h-hero` | `clamp(2.3rem, 4.8vw, 4.25rem)`, 0.98, -0.03em, 800 | the one h1 on `/` and `/pricing` |
| `.h-page` | `clamp(2.1rem, 5.2vw, 4rem)`, 0.98, -0.025em, 800 | `PageTop` h1 on docs and legal, 404 h1, marketing h2 (replaces `.h2-b` and `.h-display`) |
| `.h-section` | `clamp(1.5rem, 3vw, 2.2rem)`, 1.05, -0.02em, 800 | h2 inside docs bodies, pricing sub-sections, troubleshooting |
| `.h-item` | `1.35rem`, 1.1, -0.015em, 800 | h3 everywhere: feature titles, steps, comparison columns, FAQ summaries stay on their own clamp |
| `.h-app` | `clamp(1.75rem, 3vw, 2.5rem)`, 1.15, 800 | dashboard and billing h1; AuthShell h1 at 28px becomes this at its small end |

Price and hero number: `.num-display` `clamp(3.5rem, 8vw, 6rem)`, 0.95, -0.04em, tabular. The 85%+ no longer runs at 15rem; it is a supporting figure now, not the headline (§3).

Small text: one class, `.small` = 15px/1.45. It replaces the mix of `text-[.95rem]`, `text-[0.95rem]`, `text-[15px]`, `text-[0.9rem]` and `text-sm` on marketing pages. `text-sm` (14px) stays inside the app and the phone mock-ups only.

### Borders, radius, space

Borders are information. Three weights, each with one job:

| Weight | Token | Job | Examples |
|---|---|---|---|
| 3px | `--color-outline` | the edge of an object you could pick up | `.slab`, `.board`, `.sample-chrome`, the phone screen edge, the comparison's column divider |
| 2px | `--color-rule` | a rule between items in a list | `.rules`, `.disclosure`, `TierList`, setup steps, feature entries, comparison items, footnote rule |
| 1px | `--color-border` | hairlines inside a sample screen or an app table | dashboard rows, phone composer field |

Everything else is wrong by definition: `border-t-2 border-border-strong` on `/docs/connect`, `border border-border-strong` on CustomerResults, `border-l-[3px]` next to 2px list rules on `/pricing`, `border-b` hairline under the app header, `rounded-lg border` on app cards.

Radius scale: 4px (chips, tabs, the app's inline buttons), 8px (inputs, path chips), 12px (notes and alerts), 20px (slabs, boards, sample chrome, app panels), 24px (`.slab-lift` only), 999px (pills, status pills, day chips). Phone bezel and screen radii are proportional (§4).

Spacing: `.band` = `clamp(64px, 9vw, 120px)` block padding for every marketing section, including pricing (today pricing uses `pt-` only plus `mt-` on the next section, which doubles up unpredictably) and docs bodies (today `pt-12`, `pt-4` and `pt-2` on sibling pages). `.band-tight` = `clamp(40px, 6vw, 72px)` for the price strip, the FAQ page's "Not here?" line and the 404. Inside a section: 24px heading to lead, 40px lead to content, 16px between paragraphs. Gutters unchanged (16px, 32px from 768). Content column `max-w-6xl`; prose `max-w-[62ch]`; docs bodies `max-w-[760px]` stays because the diagrams need it.

Shadow: none anywhere except `.slab-lift`'s hard Coral offset (12px / 6px) and the phone's one hard drop (§4). No soft grey shadows (anti-pattern 4).

---

## 2. Principles for this pass

- **The product is the hero.** The first screen says what it does and shows it doing it. The statistic supports; it does not lead.
- **Ink frames, Coral acts.** Ink opens and closes every page. Coral is a button and, twice on the home page, a ground. It is never a header again.
- **A feature is a sentence and, where we have one, a real screen.** No icons, no three-up card kit. Ruled entries, each with a title and one or two plain sentences; the two that have a built screen (chat, dashboard) show it.
- **Nothing unbuilt is presented as built.** The groups slot is visibly "Coming soon" until `FEATURES.groupsLive` is true, and the Do Not Disturb and media entries carry go-live checks (§6).
- **Phones are phones.** Proportional, system-font, status bar correct, the thread fills the screen. If a reader squints and thinks it is a screenshot, the mock-up is right.

---

## 3. Home page

### Hero copy (new)

h1 (`.h-hero`, max 18ch):

> Your GoHighLevel workflows, on WhatsApp, from your own number.

Sub-line (`text-[clamp(1.1rem,1.6vw,1.3rem)]`, max 48ch):

> Set {name} as the Telephony Provider and the Send SMS steps you already have go out on WhatsApp. When the customer writes back, the reply lands in Conversations.

Buttons: `Start 7-day free trial` (Coral pill, Ink text) [pinned], `See everything it does` (outline pill, white border, links to `#features`). Line under the buttons (`.small`): `We take a card up front. The trial covers up to 3 numbers, and you can cancel from the billing portal whenever you like.` [unchanged]

Result line, under the buttons, as a sibling of the h1 (W34), two figures on one baseline:

> **about 50%** of booked clients used to turn up. With WhatsApp reminders it's **85%+**. [Our own average¹](#own-result)

Rendered as `<p class="hero-result">` with the two figures in `.num-display` at `clamp(2.2rem, 4vw, 3.25rem)` and the words at body size between them. The footnote text and `id="own-result"` stay inside the disclosure slab, unchanged (W38). `OWN_RESULTS_AVERAGE.headingLead` and `.headingTail` are no longer rendered as the h1; `proof.ts` keeps them (tests read them) and gains `resultLead: "of booked clients used to turn up. With WhatsApp reminders it's"`.

Hero figure: the two phones (§4), right-hand column at 1280, hanging `clamp(120px, 22vw, 280px)` past the Ink edge into the white features section. At 375 they sit side by side under the result line, 165px each, hanging 96px.

### Section order and grounds

| # | Section | Ground | Device |
|---|---|---|---|
| 1 | Header + hero | Ink | one block, no border between |
| 2 | **What it does** (`#features`, new) | White | ruled entries, two columns at 1280; the chat and dashboard screens inside their entries |
| 3 | How you set it up | Coral | three columns, 3px Ink top rules, Ink numerals, Ink path chip with white text |
| 4 | Read this before you sign up | White | `.slab.slab-lift`, with the footnote |
| 5 | Questions we get | Mist | sticky h2, disclosures |
| 6 | Price strip | Coral | both prices, what's included in one line, trial terms, resale pointer, Ink pill |
| 7 | Footer | Ink | unchanged |

Removed from the home page: the separate "What you look at afterwards" band (its paragraph and the dashboard sample move into the features entry "Every client's WhatsApp on one screen") and the separate "How it treats your number" Coral band (its three items become three features entries, same pinned sentences). `SafetyThread.tsx` stays in the repo for `/docs` use later but is no longer rendered on `/`; `CustomerResults` stays where it is (still renders nothing).

### 1280

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ [pingwren reverse]      Pricing   Setup guide   Docs          Log in [Start 7-day free trial] │ INK
│                                                                              │
│  Your GoHighLevel workflows,                         ┌────────┐ ┌────────┐   │ INK
│  on WhatsApp, from your                              │  SMS   │ │  chat  │   │
│  own number.                                         │ phone  │ │ phone  │   │
│                                                      │        │ │        │   │
│  Set PingWren as the Telephony Provider and the      │  grey  │ │ ▓▓▓▓ ✓✓│   │
│  Send SMS steps you already have go out on...        │ bubble │ │   ▓▓▓▓ │   │
│  [Start 7-day free trial] [See everything it does]   │        │ │Back in │   │
│  We take a card up front...                          │        │ │Convers.│   │
│  about 50% of booked clients used to turn up.        │        │ │        │   │
│  With WhatsApp reminders it's 85%+  Our own average¹ │        │ │        │   │
├──────────────────────────────────────────────────────┼────────┼─┼────────┼───┤
│                                                      └────────┘ └────────┘   │ WHITE
│  What it does                                                                │
│  Everything below is on every plan, for every number.                        │
│  ════════════════════════════════   ════════════════════════════════         │
│  Two-way chat inside GoHighLevel    Every client's WhatsApp on one screen    │
│  (two sentences)                    (two sentences)                          │
│  ┌ reply flow mini-screen ┐         ┌ dashboard board, 3 rows + actions ┐    │
│  └────────────────────────┘         └───────────────────────────────────┘    │
│  ════════════════════════════════   ════════════════════════════════         │
│  Paced sending and a daily cap      Held while the phone is offline          │
│  ════════════════════════════════   ════════════════════════════════         │
│  STOP opt-outs, per number          Do Not Disturb, kept in step             │
│  ════════════════════════════════   ════════════════════════════════         │
│  Pictures and files                 WhatsApp groups    [Coming soon]         │
│                                     (one sentence; or the live entry + the   │
│                                      group phone when FEATURES.groupsLive)   │
├──────────────────────────────────────────────────────────────────────────────┤
│  How you set it up                                                           │ CORAL
│  About ten minutes. The setup guide walks through every screen.              │
│  ━━━━━━━━━━━━━━━━━━   ━━━━━━━━━━━━━━━━━━   ━━━━━━━━━━━━━━━━━━                 │
│  1 Install the app    2 Set the Telephony   3 Scan the QR code               │
│                         Provider [path chip]                                 │
├──────────────────────────────────────────────────────────────────────────────┤
│  ┌─ slab-lift ──────────────────────────────────────────────────────────┐    │ WHITE
│  │ Read this before you sign up      (three paragraphs + footnote ¹)    │    │
│  └──────────────────────────────────────────────────────────────────────┘    │
├──────────────────────────────────────────────────────────────────────────────┤
│  Questions we get                 ══ Do I have to rebuild my workflows?  ˅   │ MIST
│  All the questions, on one page   ══ ...                                     │
├──────────────────────────────────────────────────────────────────────────────┤
│  £14.99 a month per WhatsApp number.                   [Start 7-day free trial] │ CORAL
│  Connect 10 or more and every number drops to £7.99.    See the full pricing │
│  Every feature on every plan. No setup fee, no charge per message.           │
│  The 7-day trial covers up to 3 numbers... Reselling to clients? See what... │
├──────────────────────────────────────────────────────────────────────────────┤
│ [pingwren reverse]  linked-device line + W12 disclaimer     Terms Privacy Docs │ INK
└──────────────────────────────────────────────────────────────────────────────┘
```

### 375

```
┌─────────────────────┐
│[pingwren] [Start] ≡ │ INK
│ Your GoHighLevel    │ INK
│ workflows, on       │
│ WhatsApp, from your │
│ own number.         │
│ Set PingWren as...  │
│ [Start 7-day free   │
│  trial]             │
│ [See everything it  │
│  does]              │
│ We take a card...   │
│ about 50% ... 85%+  │
│ Our own average¹    │
│ ┌───────┐ ┌───────┐ │
│ │ SMS   │ │ chat  │ │  165px each, 10px gap,
│ │       │ │       │ │  no tilt below 600px
├─┤       ├─┤       ├─┤
│ └───────┘ └───────┘ │ WHITE
│ What it does        │
│ ══ Two-way chat...  │
│ ┌ reply mini ┐      │
│ ══ Every client's   │
│ ┌ board, stacked ┐  │
│ ══ Paced sending    │
│ ══ Held while...    │
│ ══ STOP opt-outs    │
│ ══ Do Not Disturb   │
│ ══ Pictures & files │
│ ══ WhatsApp groups  │
│    [Coming soon]    │
├─────────────────────┤
│ How you set it up   │ CORAL
│ ━━ 1 ...            │
│ ━━ 2 ... [path]     │
│ ━━ 3 ...            │
├─────────────────────┤
│ ┌ slab ───────────┐ │ WHITE
│ │ Read this...    │ │
│ └─────────────────┘ │
├─────────────────────┤
│ Questions we get    │ MIST
│ ══ ... ˅            │
├─────────────────────┤
│ £14.99 a month...   │ CORAL
│ [Start 7-day...]    │
├─────────────────────┤
│ footer              │ INK
└─────────────────────┘
```

Alignment: everything left on the content column; headings never centred; the phones are the only element that crosses a band edge.

Motion: unchanged plan (one orchestrated moment in the hero: phones rise, bubble lands, ticks fade, reply arrives; `prefers-reduced-motion` renders the finished frame). Class names `hero-rise`, `hero-land`, `hero-fade`, `hero-fade-up`, `hero-bubble`, `hero-delivered`, `hero-late` stay so the tests keep matching. Nothing else moves on its own.

---

## 4. Phone mock-ups

Why the current ones look wrong (from `docs/website-screenshots/home-375.png` and the 1280 crop): the island overlaps the clock at small sizes ("10:" is all that shows at 375); the SMS thread is one bubble at the top of a tall white void; message text is large relative to the screen so a 13-word reminder wraps to five lines; the composer truncates ("Text M..."); the wallpaper doodles are busy; the "Yesterday" chip and the "Back in Conversations" chip look identical, so the second reads as a date; the avatar is brand Tan; every size is in fixed px, so the phone's proportions change with its width.

### Geometry

`.phone` is a container (`container-type: inline-size`) and every inner size is in `cqw`, so the mock-up is the same object at 165px and 300px. Width `clamp(165px, 23vw, 300px)`, aspect `9 / 19.4` on the outer shell.

| Part | Size (cqw = 1% of phone width) | Colour |
|---|---|---|
| Shell | padding 3.6cqw; radius 15.5cqw; `#0E1118`; `box-shadow: inset 0 0 0 0.6cqw #3A4052, 0 2.5cqw 0 -1cqw rgba(27,31,42,.18)` | bezel with a thin lighter rim and one hard drop |
| Side buttons | `::before` (left, 2 bars: 9cqw and 16cqw tall, at 22cqw and 34cqw from top), `::after` (right, 1 bar 24cqw tall at 30cqw); width 1cqw; `#262B38` | decorative |
| Screen | radius 12cqw; white (SMS) or wallpaper (chat); `overflow: hidden`; `isolation: isolate` | |
| Island | 26cqw × 8cqw, radius 999, top 3.6cqw, centred | `#0E1118` |
| Status bar | height 17cqw; padding-inline 8cqw; time left in 5cqw/600 tabular system font; right cluster = signal (4 bars), wifi, battery as one 15cqw × 4cqw SVG | the clock occupies at most 20cqw and the island begins at 37cqw, so they never meet |
| App header | SMS: 20cqw tall, centred avatar 11cqw + name 4.4cqw, back chevron left, 1px hairline below, `#F6F7F9` ground. Chat: 17cqw tall, `#1F2433`, back chevron, avatar 10.5cqw (initial on `#D5D9E1`, Ink text), name 4.6cqw/600 white, sub-line 3.3cqw `#C3C7D1` = the number `+44 7700 900103`; video and call glyphs right | no presence word ("online") |
| Thread | padding 3.5cqw; gap 2cqw; `display:flex; flex-direction:column; justify-content:flex-end; min-height: 0; flex: 1` so the messages sit at the bottom like a real thread and the empty space is above them, not below | |
| Day chip | 3.2cqw text, padding 1cqw 3cqw, radius 2cqw, white, Ink-dim text | |
| Bubble | max-width 80%; padding 2.4cqw 3cqw 2cqw; radius 3cqw; text 4.1cqw/1.3 (= 12.3px at 300, 6.8px at 165, so below 200px the text size is `max(11px, 4.1cqw)`); meta 2.9cqw right-aligned | SMS out: `#E4E7EE`, radius 5cqw, no tail. Chat out: `#FFE3DA`, top-right 0 + tail. Chat in: white, top-left 0 + tail |
| Tail | 2.6cqw × 3.2cqw wedge on the square corner, `background: inherit` | |
| Ticks | 5cqw × 3cqw, two strokes, `#6B7280` | grey = delivered; never blue (W25/W39) |
| Composer | SMS: `+` disc 7.5cqw, pill field 1px hairline "Text Message" 3.8cqw, mic glyph. Chat: white pill with smiley, "Message", then a 9cqw Ink disc with a mic | the field is `flex:1; min-width:0` and the label never truncates at or above 165px (measured 9 characters at 3.8cqw = 6.3cqw ≈ 10px at 165 -- fits) |
| Home bar | 34cqw × 1.3cqw, radius 999, Ink at .85, bottom 2cqw | |

Fonts: system UI stack; `-webkit-font-smoothing: antialiased`; numerals tabular. Colours inside the phones are literal hexes on purpose (a phone is a light object on every ground), the same values as the tokens.

### Threads

SMS phone (title `Sam`, variant `sms`):
- day chip `Text Message · Yesterday 14:02` (the app's own meta style, centred, 3.2cqw)
- outgoing grey bubble: `Hi Sam, your appointment is at 2pm tomorrow. Reply YES to confirm.`
- under it, right-aligned 3cqw Ink-dim: `No reply` (kept verbatim for `site-samples.test.ts`)
- the thread is bottom-anchored, so the void is above the message where an older conversation would scroll away

Chat phone (title `Sam`, variant `whatsapp`):
- day chip `Yesterday`
- outgoing bubble `Hi Sam, your appointment is at 2pm tomorrow. Reply YES to confirm.` with meta `14:02` + grey ticks (`.hero-bubble`, `.hero-delivered`)
- inbound bubble `Yes, see you at 2` with `14:09` (`.hero-late`)
- a system line, not a chip: `Back in Conversations` set as a centred 3.2cqw Ink-dim line with a 1px hairline either side, so it reads as a note from us and not as a date

Group phone (variant `group`, built now, rendered only when `FEATURES.groupsLive`): header avatar is a two-letter group mark on Mist, title `Spring challenge`, sub-line `You, Sam, Priya, Dev, +4`; thread: day chip `Today`, inbound from `Priya` (name in 3.4cqw/600 `#7A4E2D`-free colour: use `#1D5596` info blue, the site's own status token) `Day 3 done`, inbound from `Sam` `Same here`, outgoing `Nice work both. Tomorrow's session is at 7am.` with ticks. Names are coloured because group chats colour sender names; the three colours come from `--color-info`, `--color-warn`, `--color-win` (all already in the palette, none WhatsApp green).

Labels: `SameReminderTwice` keeps its `role="img"` figure and `LABEL`; the group phone, when shown, is its own `role="img"` with `aria-label="A WhatsApp-style group chat called Spring challenge with eight members: two members report finishing day three, and the business replies that tomorrow's session is at 7am."`

### Placement

- Hero at 1280: `.phones` right column, phones tilted -4° and 3° as now, SMS 30px lower than chat, gap 24px, hanging `clamp(120px, 22vw, 280px)`. The features section opens with `padding-top: clamp(150px, 22vw, 320px)` (`.hang-pad`).
- Below 600px: no tilt (tilted phones at 165px clip their own corners), side by side, hang 96px, `.hang-pad` 150px.
- The reply-flow mini-screen inside the first feature is `ReplyDiagram` (exists) in `.sample-chrome`; no third phone there.
- `/docs/setup` step 6 and `/docs/connect` keep `ConnectPanelSample`; nothing else changes there.

### Feature visuals

- Dashboard board (`DashboardSample`): keep the three rows; Millbrook Vets' action cell gains a second action pill, `Send connect link` (the real `RowActions` label), so the "connect links for clients" claim has its evidence on the screen. Board outline 3px `--color-outline`, header bar Ink, status pills unchanged.
- Group chat: the group phone above, right of the groups entry at 1280, under it at 375, only when live.

---

## 5. Per-page band map and chrome

Header: `surface-dark`, reverse logo at 40px, nav links white 600, `Log in` white, primary pill Coral with Ink text (`btn-coral`, `btn-sm`). Mobile menu: Ink panel (`bg-bg` inside `.surface-dark`), white links, 2px Coral rule under it. No `border-b`. Footer unchanged (Ink). The app header in `(app)/layout.tsx` becomes the same `SiteHeader` markup with an `account` nav variant (Dashboard, Billing, Log out) so the two headers cannot drift again.

| Page | Top band (Ink, continues the header) | Then | 
|---|---|---|
| `/` | hero | white features, Coral setup, white slab, Mist FAQ, Coral price strip, Ink footer |
| `/pricing` | price h1 + tier sentence + "no setup fee, no charge per message" | white: calculator slab + tiers + "What's included"; Coral: resale; white: trial, comparison; Mist: billing questions + CTA |
| `/docs` | `PageTop` | white tiles |
| `/docs/setup` | `PageTop` | white body |
| `/docs/connect` | `PageTop` with the print buttons (print styles already strip the band) | white |
| `/docs/faq` | `PageTop` | Mist list, white "Not here?" line |
| `/docs/billing`, `/docs/privacy-and-data` | `PageTop` | white |
| `/legal/*` | `PageTop` | white with the draft note |
| `/signup`, `/signup/check-email`, `/signup/complete` | header only | white, centred slab |
| `/login` | header only (gains the site shell) | white, centred slab |
| 404 | header only | white, `.band-tight` |
| `/dashboard`, `/dashboard/billing` | app header (same component) | white app body, panels at 20px/2px Ink |

`PageTop` on Ink: h1 white `.h-page`, lead `#E4E7EE` at 1.3rem, bottom padding `clamp(48px, 6vw, 80px)`.

---

## 6. Features section

### Data

New file `src/lib/site/features.ts`:

```ts
export const FEATURES = {
  /** WhatsApp group creation is being built on a separate branch. False ships the "Coming soon" entry. */
  groupsLive: false,
  /** GHL_SYNC_DND and WA_MEDIA_OUTBOUND_ENABLED are deployment switches; confirm both are on in production before go-live (see SITE-PASS.md §6). */
  dndSyncLive: true,
  mediaLive: true,
} as const;

export interface Feature { id: string; title: string; body: string; soon?: boolean; visual?: "reply" | "dashboard" | "group" }
export function featureEntries(brand: BrandConfig): Feature[]  // in the order below, groups last while soon, second when live
```

`FeatureList.tsx` renders `<ul class="features">` of `<li>` with a 2px rule above each, h3 `.h-item`, body, optional visual; two columns from 901px with a 48px column gap; the dashboard entry spans both columns because the board needs the width. The "Coming soon" tag is a `--color-chip` pill after the title, with the words in it (never colour alone), and the entry's `aria-label` is not needed because the tag is text.

### Copy (`featureEntries`)

Section heading: `What it does`
Lead: `Everything here is on every plan, for every number you connect.`

1. **Two-way chat inside GoHighLevel** (visual: reply)
   > Your workflow messages go out on WhatsApp from your own number. When someone writes back, the reply lands in Conversations against their contact, where your team already works.

2. **Every client's WhatsApp on one screen** (visual: dashboard; caption `Sample screen, sample businesses.` [kept])
   > An agency sees each sub-account's number, whether its phone is connected, and how much it has sent today against its daily cap. When a client needs to scan the code themselves, send them a connect link from their row and they do it on their own phone.

3. **Paced sending and a daily cap**
   > Messages leave at a steady rate through the day, and each number has a daily cap. Anything over the cap is reported back to GoHighLevel as not sent, and the number starts again at midnight UTC. [pinned sentence kept]

4. **Held while the phone is offline**
   > If a phone drops off, that number's messages wait for up to 24 hours and go out when it reconnects. Anything older is reported back to GoHighLevel as not sent, and the dashboard shows how many are waiting.

5. **STOP opt-outs, per number**
   > If someone replies STOP, they get no more messages from that number, and START brings them back. Other numbers aren't affected. [W10 wording kept]

6. **Do Not Disturb, kept in step** (shown when `dndSyncLive`)
   > If you'd like, a STOP also switches on Do Not Disturb for WhatsApp and SMS on that contact in GoHighLevel, so nothing else messages them by the same routes.

7. **Pictures and files** (shown when `mediaLive`)
   > A workflow step that attaches an image or a PDF sends it on WhatsApp as a picture or a file, with the text alongside. Attachments are held while a phone is offline, the same as text.

8. **WhatsApp groups**
   - while `soon` (tag `Coming soon`):
     > Create a WhatsApp group from GoHighLevel and add contacts to it: an onboarding cohort, a challenge, a client community. It's being built now, and it will appear here the day it's live.
   - when live (visual: group; placeholder until the groups branch confirms the exact behaviour):
     > Create a WhatsApp group from GoHighLevel and add contacts to it as they come in. Messages to the group go from your own number, and replies in the group reach Conversations like any other.

Truth checks before go-live (recorded in the plan's acceptance): `GHL_SYNC_DND=true` in production or flip `dndSyncLive` to false; `WA_MEDIA_OUTBOUND_ENABLED=true` on both the portal and the bridge or flip `mediaLive` to false; the live groups copy is re-read against the groups branch before `groupsLive` flips.

Self-scrub: no banned vocabulary; no "not just / not only" (the owner's phrase stays in the quote, not in the copy); no "-ing" tails; the one list of three ("an onboarding cohort, a challenge, a client community") is the only triplet on the page; no em dashes in customer-facing prose; straight quotes; the brand name at most once per entry.

---

## 7. Pricing

`/pricing` top (Ink):

h1 (`.h-hero`, reads as one sentence; the price in `.num-display`):
> **£14.99** a month per WhatsApp number.

Lines under it (1.3rem, `#E4E7EE`):
> Connect 10 or more and every number drops to £7.99 a month. [tierSentence, unchanged]
> There is no setup fee, and {name} does not charge per message. [pinned]

White section, in the `.slab.slab-lift`: the calculator sentence, `TierList`, the fallback sentence (all unchanged), then a new ruled list **What's included** (`IncludedList.tsx`, data from `featureEntries` plus the terms):

- Every feature on every plan: two-way chat, the dashboard and connect links, paced sending with a daily cap, 24-hour hold while a phone is offline, STOP opt-outs per number, Do Not Disturb sync, pictures and files. (Groups listed with `Coming soon` while `soon`.)
- No setup fee and no charge per message. [W40 wording]
- A 7-day free trial covering up to 3 numbers. We take a card when you sign up and charge nothing until the trial ends. [pinned]
- Billed monthly per active number. Cancel any time from the billing portal; it takes effect at the end of the period you've paid for. [W14, pinned]

Then: resale on Coral (`.surface-coral`; the `text-accent` "keep" line becomes Ink there, which is correct on Coral); "The trial, and what happens after" white; the comparison white with the column divider at 3px `--color-outline` and items at 2px rules (as the scale says); billing questions on Mist with the CTA.

Home price strip (Coral) copy:
> **£14.99 a month per WhatsApp number.** Connect 10 or more and every number drops to £7.99 a month.
> Every feature on every plan. No setup fee, no charge per message.
> The 7-day trial covers up to 3 numbers. We take a card up front, and you can cancel any time from the billing portal. [unchanged]
> Reselling to clients? [See what you would keep](/pricing#resale). [unchanged]

No "cheaper than" claims (W40). Prices only via `pricing.ts` (`site-copy.test.ts` pins no literal currency outside it).

---

## 8. Per-page fix list

Format: file:line, what is wrong, what to do. Line numbers are at 7ec85fb.

### Chrome and layout

- `src/components/site/SiteHeader.tsx:13` `surface-coral` header; `:15` `BrandMark surface="light"`. Ink header, `surface="dark"`, white nav; the Coral pill via `siteButton("coral", "btn-sm")`.
- `src/components/site/SiteHeader.tsx:40` mobile menu `bg-card ... border-b-2 border-rule` is a white panel; on the Ink header make it `bg-bg` (Ink in scope) with white links and a 2px Coral rule.
- `src/components/site/PageTop.tsx:9` `surface-coral`. Becomes `surface-dark`; lead colour via `text-ink-dim`.
- `src/app/(app)/layout.tsx:19` `surface-dark border-b` and `:9` 14px dim links, `:21` logo at 44px. Replace with `<SiteHeader nav="account" />`; logo 40px everywhere (AuthShell `:27` is 36px; make it 40).
- `src/app/login/page.tsx:54` renders `<main>` with no header or footer; every other page has both. Wrap in the site shell (`SiteHeader`, `main#main`, `SiteFooter`) as `(site)/layout.tsx:8-17` does. Foundation file; visual-only edit (W24).
- `src/app/(site)/docs/layout.tsx:5` and `src/app/(site)/legal/layout.tsx:5` `surface-light` is a no-op alias (`globals.css:93`). Delete the class and the alias.
- `src/app/(site)/not-found.tsx:8` `py-16`, `:9` inline h1 clamp. `.band-tight`, `.h-page`.
- `src/app/not-found.tsx:9` duplicates the site shell by hand; fine, but it must pick up the Ink header automatically (it does, via `SiteHeader`).

### Headings (one scale)

- `src/app/(site)/page.tsx:27` `H2 = "h2-b ..."` and `src/app/(site)/pricing/page.tsx:26` `H2 = "h-display ..."`: two names, one size. Both `.h-page`.
- `src/app/(site)/page.tsx:107` disclosure h2 carries its own inline clamp `text-[clamp(1.9rem,4vw,3rem)]`. `.h-page`.
- `src/app/(site)/docs/setup/page.tsx:55,85,106,124`, `docs/connect/page.tsx:18`, `docs/billing/page.tsx:21`, `docs/privacy-and-data/page.tsx:18`, `legal/terms/page.tsx:23`, `legal/privacy/page.tsx` (same line): the inline `text-[clamp(1.5rem,3vw,2.2rem)] ...` string. `.h-section`.
- `src/app/(site)/pricing/page.tsx:27` `H3` inline; `src/components/site/HowItWorks.tsx:13` h3 `text-[1.35rem] leading-[1.1]`; `SetupStep.tsx:47`; `docs/connect/page.tsx:59` (1.2rem) and `:100` (1.15rem). All `.h-item`.
- `src/components/auth/AuthShell.tsx:30` h1 fixed 28px; `src/components/app/PlanHeader.tsx:26` and `dashboard/billing/page.tsx:54` `clamp(28px,5vw,40px)`. `.h-app`.

### Spacing

- `src/app/(site)/pricing/page.tsx:29` `SECTION = "pt-[clamp(64px,9vw,120px)]"` (top only) and `:71,150` `mt-[clamp(64px,9vw,120px)]` plus `:57` `pt-[clamp(48px,6vw,80px)]`: four different rhythms on one page. Every section `.band`; no `mt-`.
- `src/app/(site)/docs/page.tsx:31` `pb-12 pt-12 md:pb-20`; `docs/setup/page.tsx:80` same; `docs/connect/page.tsx:34` `pb-12 pt-10 md:pb-16 md:pt-14`; `docs/billing/page.tsx:27` `pb-12 pt-4`; `docs/privacy-and-data/page.tsx:31` `pb-12 pt-4`; `legal/terms/page.tsx:18` `pb-12 pt-2`. All `.band`.
- `src/app/(site)/docs/faq/page.tsx:23` `band bg-raised !pb-[clamp(40px,5vw,64px)]` uses `!important`; `:28` second section `py-10 md:py-14`. `.band` on the Mist list, `.band-tight` on the line under it.
- `src/app/(site)/page.tsx:139` price strip `py-[clamp(40px,6vw,72px)]` inline. `.band-tight`.

### Borders and radius

- `src/app/(site)/pricing/page.tsx:28` `LI = border-t-2 border-rule` next to `:124` `md:border-l-[3px] md:border-rule`. Column divider becomes `border-outline` (3px is right for the divider; the token was wrong), list rules stay 2px.
- `src/app/(site)/docs/connect/page.tsx:99` `border-t-2 border-border-strong`. `border-rule`.
- `src/app/(site)/docs/connect/page.tsx:54` step numeral disc `border-2 border-border-strong`. `border-outline`.
- `src/components/site/CustomerResults.tsx:20` `border-t border-border-strong` (1px), `:30` blockquote `border-l-2 border-border-strong`. `border-t-2 border-rule`; blockquote `border-rule`.
- `src/components/site/samples/DashboardSample.tsx:59` header `border-b-2 border-rule` inside a board whose rows are 1px `border-border` (`:67`). Header rule 1px too: inside a sample everything is hairline.
- `src/components/site/samples/ConnectPanelSample.tsx:86` `border-b` and `:97` `border-t` hairlines: correct (inside a sample). `:69` QR `border border-border rounded-[4px]`: correct.
- `src/components/site/SetupStep.tsx:44` `border-t-2 border-rule`: correct. `:57` figure `rounded-[20px] border-2 border-rule bg-well`: a diagram is an object, so 3px `border-outline`.
- `src/components/site/DraftNotice.tsx:7` `rounded-[12px] bg-raised`: correct on the radius scale; add nothing.
- `src/app/(site)/signup/page.tsx:49`, `SignupForm.tsx:38` alerts `rounded-[12px] border-2 border-loss`: 2px on a 12px note is right (it is a rule-weight edge on a note, not an object); keep.
- `src/app/login/page.tsx:62` alert `rounded-[12px] border-2 border-border-strong bg-well`: match the signup alert (`border-loss bg-loss-soft`) when it is an error, which it is.
- `src/components/auth/field.ts:3` inputs `rounded-lg border-2 border-border-strong`; `PricingCalculator.tsx:38` and `ResaleCalculator.tsx:8` the same: consistent (8px, 2px); rename the colour to `border-outline` so the Ink scope flips it to white.
- `src/components/site/AudienceTabs.tsx:84` tabs `rounded border` (1px) `border-ink-faint`. 2px `border-outline`, 4px radius; selected state unchanged.
- `src/components/ui/Card.tsx:17` `rounded-lg border` (8px, hairline) and `src/components/app/LocationTable.tsx:41` `rounded-lg border`; `PlanHeader.tsx:29` and `dashboard/billing/page.tsx:56,62` alerts `rounded-lg border border-loss/30`: the app reads as another product next to the site. App panels become 20px radius, 2px `border-outline`; alerts 12px radius with a 2px status-colour edge; `LocationTable`'s inner rows stay hairline. `ui/Button` keeps its sizes (38px is right for a dense table) but takes `rounded-full` so the pill is the one button shape in the product.
- `src/components/ui/Chip.tsx:19` `rounded` 4px: keep (chips are 4px on the scale).
- `src/app/globals.css:962` second `.phone` block overrides `:392`; `:670` `.h-display` and `:1060` `.h2-b` duplicate; `:10`, `:354`, `:601` three `:root` blocks and `:65`, `:362`, `:620` three `.surface-dark` blocks. Consolidate (§1), keeping a later `:root` block and the Coral rule in the last `.surface-dark` block for the pinned tests.

### Colour per page

- `src/app/(site)/page.tsx:47` hero `surface-coral`; `:71` setup `surface-dark`; `:95` safety `surface-coral`. Per §3: hero `surface-dark`, setup `surface-coral`, safety band removed (its items move to features).
- `src/app/(site)/pricing/page.tsx:41` top `surface-coral`; `:71` resale `surface-dark`. Top `surface-dark`; resale `surface-coral`.
- `src/components/site/PricingSummary.tsx:11` and `Cta.tsx:21` pick the button colour by `onCoral`; add `onDark` (Coral pill on Ink) so the hero's primary is Coral with Ink text, not an Ink pill on Ink.
- `src/components/site/ResaleCalculator.tsx:76` `text-accent` keep line: on Coral the accent token is Ink, which is what we want; nothing to change but check the screenshot.
- `src/components/site/HowItWorks.tsx:11` `border-rule` (Coral on Ink today) and `.step-num` `#FF5A36` in `globals.css:948`: on the Coral band the rule token is Ink and the numeral must be Ink too. Make `.step-num` use `var(--color-rule)`.
- `src/app/globals.css:936` `.path-chip` `#FF5A36` fill with Ink text: on Coral, use `var(--color-chip)` (Ink fill, white text).

### Small text

- `Cta.tsx:30`, `PricingSummary.tsx:18-28`, `page.tsx:36` figcaption, `page.tsx:111` footnote, `pricing/page.tsx:91,126`, `docs/setup/page.tsx:96`, `docs/connect/page.tsx:70,107`, `PricingCalculator.tsx:53`, `ResaleCalculator.tsx:46,66`, `DashboardSample.tsx:59`: `.small`.

### Copy and labels

- `src/lib/site/sales-copy.ts:28` `heroSub` and `OWN_RESULTS_AVERAGE` usage in `page.tsx:57-62`: the hero copy in §3; `proof.ts` gains `resultLead`.
- `src/lib/site/sales-copy.ts:50-53` `afterwards` and `:55-70` `safety` move into `features.ts` (the strings themselves are unchanged; `safety` stays exported because `site-copy.test.ts` and `site-home-visual.test.ts` read it).
- `src/app/(site)/docs/page.tsx:17` setup tile text starts "Install, set the Telephony Provider, scan the QR code and send a test." Fine. Add a sixth tile? No: docs are complete as listed.
- `src/components/site/samples/DashboardSample.tsx:34-40` Millbrook Vets gains `actions: ["Reconnect", "Send connect link"]`; label updated to say so.

---

## 9. Review against the generic defaults

I drafted the plan, then asked where I would have landed for any "WhatsApp for CRM" landing page, and changed four things:

- **First draft put the features in a three-up grid of cards with an icon each.** That is the SaaS card kit (trait 4). Changed: ruled entries in two columns, no icons, the two real screens inside the entries that have them, the dashboard spanning the row because it needs the width.
- **First draft kept the 85%+ as the h1 and added a "what it does" sub-line.** The owner's request is that a visitor should know what it does before anything else, and a statistic as the headline is the generic "big number, small label" treatment (frontend-design, hero guidance). Changed: the h1 states the product; the result is a two-figure line under the CTAs with its footnote intact.
- **First draft added a "Coming soon" ribbon in Coral across the corner of the groups entry.** Decoration. Changed: a plain text tag after the title in the chip colour, which also reads for screen readers without extra attributes.
- **First draft gave the phones a soft blurred shadow and a glossy screen highlight.** Both are stock mock-up tells. Changed: one hard offset drop (the site's own shadow idiom), a thin bezel rim, no gloss; realism comes from proportion, the status bar, system type and a bottom-anchored thread.

Chanel test: the first phone spec had a tiny front-camera dot inside the island. Removed; at 165px it is a smudge.

What I kept after looking twice: the Coral `slab-lift` offset shadow on the disclosure slab and the calculator. It is specific to this site and carries the brand's one bold move now that the header is quiet.

---

## 10. Proposed rulings (for the controller)

- **W42**: the site header and the band under it are Ink `#1B1F2A` with the reverse logo on every page; Coral is a button colour and a ground for at most two bands per page (home: setup and price strip; pricing: resale). Cost if wrong: a token flip.
- **W43**: the home hero leads with the capability (two-way chat on WhatsApp from your own number, replies in Conversations); the 85%+ result stays in the hero as a supporting line with its footnote (W27, W30 amended). Cost: a copy edit.
- **W44**: features shown on the site are the built set (two-way chat, dashboard with connect links, pacing and cap, 24-hour hold, STOP/START per number, Do Not Disturb sync, pictures and files); WhatsApp groups render behind `FEATURES.groupsLive` and say "Coming soon" until it flips; `dndSyncLive` and `mediaLive` are go-live checks against the production env. Cost: a flag flip.
- **W45**: the border scale is 3px outline (objects), 2px rule (lists), 1px hairline (inside samples and app tables); the radius scale is 4/8/12/20/24/999; the heading scale is `.h-hero/.h-page/.h-section/.h-item/.h-app`; `.band` and `.band-tight` are the only section paddings. Cost: none.
- **W46**: phone mock-ups size every part in container-query units from one spec (§4), use the system UI font inside the screen, and show grey ticks only. Cost: none.

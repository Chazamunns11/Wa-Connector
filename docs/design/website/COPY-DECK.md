# PingWren copy deck (Task 13)

16 Oct 2026. Final strings for the home page, the pricing page, the FAQ and the setup guide's intro. British English. Voice: first person plural, a small team that uses the product (W29). No named founder, no FitClosers, no "sales".

Conventions: `{name}` is `brandConfig().name` (PingWren). `{one}` is `priceLine(1, pricingConfig())`. `{price}` is `formatMoney(pricePerNumber, currency)`. `{N}` and `{cost}` are the calculator's live values. Straight quotes in source. Every figure is traceable: the hero number is `OWN_RESULTS_AVERAGE` (W27); the research figures are `RESEARCH_FINDINGS` (W25); the trial and billing facts are the product spec and rulings W4, W10, W11, W14, W20; the GoHighLevel figures are cited in §4.

Where a test pins a phrase, the phrase is kept and marked `[pinned]`.

---

## 1. Site chrome

Header: `Pricing`, `Setup guide`, `Docs`, `Log in`, `Start 7-day free trial` (below 640px: `Start free trial`), `Menu`, `Skip to main content`.

Footer:

> {name} connects to WhatsApp as a linked device, not through the official WhatsApp Business API. {name} is not affiliated with or endorsed by Meta, WhatsApp or HighLevel.

(The second sentence is W12 verbatim.) Links: `Terms`, `Privacy`, `Docs`, the support email, `WhatsApp support`.

---

## 2. Home page

### Metadata

Title: `{name} — WhatsApp for GoHighLevel`
Description: the hero sub-line below.

### Hero (Ink)

h1, set as two lines then the big number (`OWN_RESULTS_AVERAGE.after`):

> About half of booked clients used to turn up.
> With WhatsApp reminders, it's **85%+**

Plain reading of the h1 (what a screen reader hears): "About half of booked clients used to turn up. With WhatsApp reminders, it's 85%+."

Sub-line:

> {name} takes the reminders your GoHighLevel workflows already send and sends them on WhatsApp, from your own number. Replies come back into Conversations.

Buttons: `Start 7-day free trial` [pinned] and `Read the setup guide`.

Line under the buttons:

> We take a card up front. The trial covers up to 3 numbers, and you can cancel from the billing portal whenever you like.

Footnote (small, under a Wren rule, linked from a `¹` after the number):

> ¹ That's our own average across the businesses we've run WhatsApp appointment reminders for, and it's from before {name} existed. It is not an independent study, and your numbers will vary.

(`OWN_RESULTS_AVERAGE.note` carries this text; `before` "50%", `after` "85%+", `measure` "Show rate: about 50% before WhatsApp reminders, 85% or more with them" stay as data.)

Signature figure `aria-label`:

> Two phones showing the same appointment reminder, "Hi Sam, your appointment is at 2pm tomorrow. Reply YES to confirm." On the left it is a text message sent yesterday at 14:02 with no reply. On the right it is a WhatsApp message marked Delivered, and Sam has replied "Yes, see you at 2", which appears back in Conversations.

Text inside the phones (aria-hidden, visible):
- SMS phone: header `Messages`, bubble `Hi Sam, your appointment is at 2pm tomorrow. Reply YES to confirm.`, time stamp `Yesterday 14:02`.
- WhatsApp phone: header `Sam`, outgoing bubble (same text), status word `Delivered`, inbound bubble `Yes, see you at 2`, status word `Back in Conversations`.

Caption: `Sample messages. Sam is made up.`

### Why we made it (Paper)

h2: `Why we made it`

> We look after appointment reminders for a few small businesses. Texts sat there. The same reminder on WhatsApp got a reply, and the person turned up. The trouble was that everything we'd built lived in GoHighLevel workflows as Send SMS steps, and nobody wanted to rebuild them.

> So we built the thing we wanted. Pick {name} as the Telephony Provider, scan a QR code with the phone, and the workflows you already have go out on WhatsApp. Nothing gets rebuilt, and replies land in Conversations like they always did.

Research line (small, Wren rule above, figures and links from `RESEARCH_FINDINGS`):

> Outside our own numbers, two published trials found the same direction: a children's clinic went from [38% to 24%](PMC5227159) of appointments missed when a text reminder was added, and a hospital went from [21% to 14%](PMC7310733) across about 160,000 appointments by rewording its reminder. Both studies used SMS reminders. {name} sends the same kind of reminder on WhatsApp instead, from your own number, and replies land back in Conversations. [pinned: "used SMS reminders", "from your own number, and replies land back in Conversations"]

### How you set it up (Paper)

h2: `How you set it up`
Lead: `About ten minutes. The setup guide walks through every screen.`

1. `Install the app`
   > Add {name} to your GoHighLevel account from the install link. An agency installs once and picks the sub-accounts; a single business installs on its own sub-account.
2. `Set the Telephony Provider`
   > In the sub-account, go to Settings → Phone System → Advanced Settings → Telephony Provider, choose {name} and save. This is the step people miss, and until it's done a connected number sends nothing.
3. `Scan the QR code`
   > Open the {name} page in the left menu, click Connect WhatsApp and scan the code with the phone, the same way you'd link WhatsApp Web. When the status says Connected, you're sending. [pinned: "left menu"]

Sample caption: `Sample screen: the connect page inside GoHighLevel.`
Sample `aria-label`: `The {name} connect page: a WhatsApp panel with the status Waiting for QR scan, a QR code, the instruction to open WhatsApp, Settings, Linked devices, Link a device and scan it, a warning that whoever scans can send as your business, and a button to get a new QR code.`

### What you look at afterwards (the Cream band)

h2: `What you look at afterwards`

> The dashboard lists every sub-account with its WhatsApp status, how many messages it has sent today against its daily cap, and anything that needs you: a phone that has dropped off, or a number that's connected but hasn't had a message from GoHighLevel yet, which almost always means the Telephony Provider isn't set.

Sample caption: `Sample screen, sample businesses.`
Sample `aria-label`: `The {name} dashboard with three sample sub-accounts: Harbour Street Physio, connected, 42 of 150 sent today; Millbrook Vets, disconnected with 4 messages waiting and a Reconnect button; Fernbank Dental, connected, 0 of 150, with the note "No messages from GHL yet. Is the Telephony Provider set?"`

(Rows, chips and notes are the preview dashboard's own sample data. Nothing new is invented.)

### How it treats your number (Paper)

h2: `How it treats your number`
Lead: `Three things happen on every number. They are not settings; they're always on.`

- `Paced sending` [pinned]
  > Messages leave at a steady rate through the day, and each number has a daily cap. Anything over the cap is reported back to GoHighLevel as not sent, and the number starts again at midnight UTC. [pinned: "reported back to GoHighLevel as not sent"]
- `Held while disconnected`
  > If the phone goes offline, that number's messages wait and go out when it reconnects. The dashboard shows how many are waiting.
- `STOP opt-outs`
  > If someone replies STOP, they get no more messages from that number. Other numbers aren't affected. [W10: "from that number"; never "from your account"]

Thread bubbles (aria-hidden, unchanged from Task 9c): `Hi Sam, your call is booked for 2pm tomorrow.` / `Delivered`; `Your booking link is ready.` / `Waiting for the phone to reconnect`; inbound `STOP`; `We have a new offer for you.` / `Not sent. Sam opted out.`

### Read this before you sign up (Paper)

h2: `Read this before you sign up`

> {name} works as a linked device on your WhatsApp number, the same mechanism WhatsApp Web uses. It is not the official WhatsApp Business API. You don't get a green tick or Meta's template approval, Meta doesn't charge you per conversation, and the phone that holds the number has to stay switched on and online.

> WhatsApp can restrict or ban any number it decides is misusing the service, and automated sending through a linked device is the kind of thing it looks at. The pacing, the daily cap and STOP handling lower that risk. They cannot remove it, and we can't promise a number will never be restricted.

> Use a dedicated business number rather than your personal one, and only message people who expect to hear from you. If you need the official API, this isn't it, and we'd rather say so now.

### Questions we get (Paper)

h2: `Questions we get`
Entries (from §5, in this order): `workflows`, `disconnected`, `daily-cap`, `trial`, `cancel`, `agency-or-single`, `white-label`. The other five are answered by the block above or the thread, and all twelve stay on `/docs/faq`.

Link under the list: `All the questions, on one page` → `/docs/faq`.

### Price strip (Ink)

> **{price}** per WhatsApp number, per month
> The 7-day trial covers up to 3 numbers. We take a card up front, and you can cancel any time from the billing portal.

Button: `Start 7-day free trial`. Link: `See the full pricing`.

---

## 3. Pricing page

### Metadata

Title: `Pricing — {name}`
Description: `One price per WhatsApp number, per month: {one}. 7-day free trial, cancel any time.`

### Top

h1 (the price is the big display span; the h1 reads as one sentence):

> **{price}** per WhatsApp number, per month

> There is no setup fee, and {name} does not charge per message. [pinned] The price is the same whether you connect one number or forty.

### Calculator (the Cream box; one client island)

The sentence is the control. The `<label>` wraps the first clause; the amount is in the `aria-live="polite"` region.

> If I connect [ {N} ] numbers, I'll pay **{cost}** a month.

Help line: `Whole numbers from 1 to 500.`
Invalid or empty input: the existing `calculatorDisplay` note, unchanged: `Enter a whole number from 1 to 500.` and `Enter a whole number from 1 to 500. Showing the price for {n}.`

Server-rendered fallback, one sentence built from `CALCULATOR_PRESETS` (always in the HTML):

> For reference: 1 number is £29 a month, 3 numbers £87, 5 numbers £145, 10 numbers £290 and 25 numbers £725.

`<noscript>` line: `The calculator needs JavaScript. For any other number, multiply by {price}.`

### The trial, and what happens after

h2: `The trial, and what happens after`

`trialTerms` (rendered as one paragraph):
> The 7-day trial covers up to 3 numbers. We take a card when you sign up and charge nothing until the trial ends. After that it's one price per active number, billed monthly. [pinned: "7-day", "card", "3 numbers"; W14 "per active number"]

`cancel`:
> You can cancel any time from the billing portal. It takes effect at the end of the period you've paid for, and your numbers keep sending until then. [pinned: "any time", "end of", "billing portal"]

`failedPayment` (two paragraphs):
> If a payment fails, Stripe retries it for about 7 days. Sending continues while that happens, and a banner on your dashboard asks you to update the card. [pinned: "retr", "continues", "banner"]
> If the subscription still ends unpaid, sending pauses until you pay. [pinned: "pauses"]

### Against GoHighLevel's own WhatsApp

h2: `Against GoHighLevel's own WhatsApp`

> GoHighLevel sells its own WhatsApp integration, built on the official API. It's the fair thing to compare us with, so here are their published numbers next to ours.

Column h3: `{name}`
- `{price} per number, per month.`
- `No charge per message.`
- `Your own number, connected as a linked device.`
- `No green tick and no template approval, because it isn't the official API.`
- `A ban risk, explained on the home page, that we can't remove.`

Column h3: `GoHighLevel's WhatsApp`
- `$10 per sub-account, per month, paid to HighLevel.`
- `Plus a charge for every delivered template message at Meta's rate for the recipient's country. HighLevel's own example is $0.0263 per marketing message in the US, and an agency can add its own mark-up.`
- `The official WhatsApp Business API: Meta business verification, a green tick if you qualify, and templates that Meta approves before they send.`
- `No phone to keep online.`

Source line (small):
> Source: HighLevel help centre, "WhatsApp Pricing, Billing, and Rebilling Guide" (last modified 22 September 2026) and "WhatsApp Platform Pricing & Feature Comparison" (last modified 15 October 2026), both checked on 16 October 2026. Prices are in US dollars as HighLevel publishes them; we haven't converted them, and they can change.

Links: https://help.gohighlevel.com/support/solutions/articles/155000001428-whatsapp-pricing-billing-and-rebilling-guide and https://help.gohighlevel.com/support/solutions/articles/155000007602-whatsapp-platform-pricing-feature-comparison

Closing line:
> If you send a lot of marketing templates, or you need the green tick, their option may suit you better. If you want the workflows you already have on your own number for a flat price, that's us.

### Billing questions

h2: `Billing questions`. Entries: `trial`, `cancel`, `ban-risk`, `official-api`, `disconnected` (as now).

Button: `Start 7-day free trial`.

---

## 4. Verification of the GoHighLevel figures (W33)

Checked 16 October 2026 with WebFetch against HighLevel's own help centre:

- Article 155000001428 "WhatsApp Pricing, Billing, and Rebilling Guide", "Modified on: Tue, 22 Sep, 2026": "$10 / month per sub-account"; per-delivered-message pricing by category (Marketing, Utility, Authentication, Service); example rates "Marketing, North America (US & Canada): $0.0263", "Utility: $0.0036"; "The default multiplier is set at 1.05X"; a 5% Stripe fee added to message rates; service messages free through 30 Sep 2026, billable after the first 1,000 per number per month from 1 Oct 2026.
- Article 155000007602 "WhatsApp Platform Pricing & Feature Comparison", "Modified on: Thu, 15 Oct, 2026": add-on price "$10 per month"; GHL column says per-message costs follow "Meta's official pricing (country-based)".
- Meta's own rate page (developers.facebook.com/docs/whatsapp/pricing) states a UK marketing rate rise effective 1 July 2026 but publishes the figures only in a CSV the fetch could not open. So the page quotes HighLevel's US example and says "Meta's rate for the recipient's country" rather than inventing a UK number.

Not verified, so not on the page: which HighLevel plans include the add-on; any GBP figure; any claim that one option is cheaper overall (it depends on message volume and country).

---

## 5. FAQ (`src/lib/site/faq.ts`, all twelve, in `FAQ_IDS` order)

**what-is-it** — `What is {name}?`
> An app for GoHighLevel that sends your messages on WhatsApp. You link a WhatsApp number by scanning a QR code, choose {name} as the Telephony Provider, and the Send SMS steps in your workflows go out on WhatsApp instead. Replies land in Conversations.

**workflows** — `Do I have to rebuild my workflows?`
> No. Your workflows, templates and conversations stay exactly as they are. Once the Telephony Provider is set, the Send SMS steps you already have deliver on WhatsApp.

**linked-device** — `How does it connect to my number?`
> You scan a QR code with the phone, the same way you'd link WhatsApp Web, and {name} then acts as a linked device on that number. The phone has to stay switched on and online.

**official-api** — `Is this the official WhatsApp Business API?`
> No. {name} uses WhatsApp's linked-device mechanism, the one WhatsApp Web uses, not the official WhatsApp Business API. You don't get the green tick or Meta's template approval, Meta doesn't charge you per conversation, and the phone with the number must stay online. If you need the official API, this is not it. [pinned: "linked device", "not the official WhatsApp Business API", "green tick"; must not contain "no green tick, no template approval"]

**ban-risk** — `Can my number get banned?`
> Yes, it can. WhatsApp can restrict or ban any number it decides is misusing the service, and automated messaging through a linked device is the kind of thing it looks at. Pacing, the daily cap and STOP handling lower the risk, but they cannot remove it, and we can't promise a number will never be restricted. Use a dedicated business number rather than your personal one, and only message people who expect to hear from you. [pinned: ban|restrict, can't|cannot, dedicated]

**disconnected** — `What happens if the phone goes offline?`
> That number's messages are held. They wait in the queue and send when the phone reconnects, and the dashboard shows which numbers are disconnected and how many messages are waiting.

**stop** — `What if someone replies STOP?`
> They're opted out straight away and get no more messages from that number. [pinned: "from that number"]

**daily-cap** — `What is the daily cap?`
> Each number can only send so many messages in a day, and they go out at a steady pace rather than in a burst. Once a number hits its cap, the rest of that day's messages are reported back to GoHighLevel as not sent, and the number starts again at midnight (UTC). The cap is there to protect the number, so it isn't something you can switch off. [pinned: "reported back to GoHighLevel as not sent", "midnight (UTC)"]

**trial** — `How does the free trial work?`
> You get 7 days free with up to 3 numbers. We take a card up front and charge nothing until the trial ends. After that you pay per number: {one}. [pinned: "After that you pay per number: 1 number = "]

**cancel** — `Can I cancel, and what happens if a payment fails?`
> You can cancel whenever you like from the billing portal, and it takes effect at the end of the period you've paid for. If a payment fails, sending carries on while Stripe retries it. If the subscription ends unpaid, sending pauses until you pay.

**agency-or-single** — `Is it for agencies or a single business?`
> Both. A single business connects one or more numbers to its own account; an agency connects numbers across its sub-accounts. Either way you pay per number.

**white-label** — `Does it work on a white-labelled GoHighLevel account?`
> It depends on the agency. Some switch off app installs on white-label accounts. If the install link is blocked, ask your agency to allow {name} for your sub-account. The setup guide has the wording to send them. [pinned: "It depends on the agency", "ask your agency to allow {name}"]

---

## 6. Setup guide: intro only

Metadata title: `Setting up {name} in GoHighLevel`
Description: `Step-by-step setup for {name}: install, set the Telephony Provider, scan the QR code and send a test message. About ten minutes.` (unchanged)

h1: `Setting up {name} in GoHighLevel`

Lead:
> About ten minutes, start to finish. Pick the guide that matches your account, and by the end the workflows you already have will be sending on WhatsApp.

h2: `Before you start`
- `A GoHighLevel account with at least one sub-account.`
- `A {name} account. The free trial is fine.`
- `The phone that has the WhatsApp number you want to send from, with you.`
- `A second phone to receive the test message.`

Sample caption: `Sample screen: the connect page you'll see in step 4, before and after the scan.`
Sample `aria-label`: `The {name} connect page in two states: Waiting for QR scan with a QR code, and Connected as +44 7700 900101.`

Tabs: `Agency owner`, `Single sub-account` (unchanged). Everything below the tabs is unchanged.

---

## 7. Self-scrub record

Checked against the human-writing checklist (the installed skill has no `ai-tells.md`, so the SKILL.md list was applied): no banned puffery vocabulary; no "not just / not only / no X, no Y" shapes (the old FAQ triple was rewritten in Task 12b and the new copy has none; "No green tick and no template approval, because..." in the comparison is a factual list of two absences with a reason, kept deliberately); no "-ing" tails claiming significance; one rule-of-three per page at most ("the pacing, the daily cap and STOP handling" on home; "install, set the Telephony Provider, scan..." only in the setup metadata); em dashes: none in customer-facing prose (the W12 sentence and the dashboard's own chip text are the app's); no summarising final paragraphs; straight quotes.

Hedges removed: the old "we can't promise" appears once (the disclosure block, and again in the ban-risk FAQ on a different page), not after every claim. The brand name appears at most once per paragraph.

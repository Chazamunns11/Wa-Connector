# PingWren design system (for Superdesign)

## Product
PingWren connects a business's own WhatsApp number to GoHighLevel (GHL) as a linked device. The "Send SMS" steps in existing GoHighLevel workflows go out on WhatsApp instead, and replies land back in GoHighLevel Conversations. Setup: install the app, set PingWren as the Telephony Provider, scan a QR code with the phone. Priced per WhatsApp number per month (£29 placeholder), 7-day free trial on up to 3 numbers, card taken up front.

Audience: agency owners running many GoHighLevel sub-accounts, and single businesses (coaches, clinics, physios, vets, gyms) who book appointments and send reminders.
Job of the home page: get a GoHighLevel user to start the trial. Main proof: across the businesses we've run WhatsApp appointment reminders for, show rate went from about 50% to 85%+ (our own average, from before PingWren, not a study; results vary).

## Voice
First person plural ("we"), a small team that uses the product. British English, sentence case, plain verbs. No hype, no staccato fragments, no "not X, it's Y". Honest disclosures said once: linked device, not the official WhatsApp Business API, WhatsApp can restrict or ban a number, pacing + daily cap + STOP handling lower that risk.

## Hard constraints
- Logo: use the supplied PingWren logo asset in every logo position (light version on light grounds, reverse on dark). Never initials, emoji, an invented mark or text-only. Do not recolour the logo.
- Never use WhatsApp green (#25D366) or WhatsApp's logo. Never copy GoHighLevel's UI. "GoHighLevel", never "GHL", in copy.
- No read/open-rate claims. No invented testimonials, logos or customer names presented as real (sample screens say "Sample").
- WCAG 2.1 AA: text 4.5:1, visible focus, 44px targets, works at 375px with no horizontal scroll.

## Avoid (the owner says the current site "looks so Claude")
- Warm cream (#F4F1EA–#F6F1EA) page grounds with a coral/terracotta accent: this is Claude's own look. Do not use cream as a page background.
- Identical rounded white cards with soft grey shadows; tick-mark lists; "+" accordions as the main FAQ treatment.
- ALL-CAPS tracked eyebrow labels, "01 / 02 / 03" markers where not a real sequence, middle-dot meta strings, arrow-suffixed links.
- Big-number-with-small-label stat strips used as decoration; gradient washes; floating chat bubbles on empty dark fields.
- Every section being heading-left + paragraph; alternating dark/light bands as the only rhythm.

## Fixed brand elements
- Logo colours (inside the logo only): Ink #1B1F2A bubble, Cream wren, Coral #FF5A36 beak.
- Display type: Bricolage Grotesque (500, 800). Body: Instrument Sans (400/500/600).
- Palette beyond the logo is open per direction, but must sit well beside the logo and keep coral as at most one accent, never with white text (white on coral fails AA; use Ink text on coral).

## Content to use (real copy)
- Hero h1: "About half of booked clients used to turn up. With WhatsApp reminders, it's 85%+" with a footnote "Our own average".
- Sub-line: "PingWren takes the reminders your GoHighLevel workflows already send and puts them on WhatsApp, from your own number. Replies come back into Conversations."
- Buttons: "Start 7-day free trial", "Read the setup guide". Under: "We take a card up front. The trial covers up to 3 numbers, and you can cancel from the billing portal whenever you like."
- Signature: the same reminder twice: SMS "Hi Sam, your appointment is at 2pm tomorrow. Reply YES to confirm." (Yesterday 14:02, no reply) beside the WhatsApp version (Delivered, reply "Yes, see you at 2", Back in Conversations). Caption "Sample messages. Sam is made up."
- Sections: Why we made it; How you set it up (3 steps: Install the app; Set the Telephony Provider — Settings → Phone System → Advanced Settings → Telephony Provider; Scan the QR code); What you look at afterwards (dashboard: sub-accounts, WhatsApp status, sent today x/150, needs attention); How it treats your number (paced sending, held while disconnected, STOP opt-outs); Read this before you sign up (disclosures); Questions we get; price strip "£29 per WhatsApp number, per month".
- Footer: "PingWren connects to WhatsApp as a linked device, not through the official WhatsApp Business API. PingWren is not affiliated with or endorsed by Meta, WhatsApp or HighLevel."

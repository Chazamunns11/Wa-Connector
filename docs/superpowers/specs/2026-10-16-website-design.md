# `<Brand>` website — design

Charlie, 16 Oct 2026. Approved in conversation. It builds on `2026-10-12-brand-whatsapp-saas-design.md` (product decisions, pricing, login, dashboard, in-GHL page). That spec is the authority on product behaviour; this one covers the customer-facing website.

## Goal

A fully working, easy-to-use site that sells `<Brand>`, signs people up, and shows them step by step how to set it up inside GoHighLevel, with clear billing. Someone who has never seen it understands what it does, what it costs and how to get sending in under 10 minutes.

## Decisions

| Topic | Decision |
|---|---|
| Where | The `Wa-Connector` repo, branch `claude/adoring-brown-hvwuyz-site` (a worktree off the foundation). Merged once the foundation lands. |
| Skills | **superdesign** for visual drafts and variant comparison before building; **frontend-design** and **ui-ux-pro-max** for the build; **sales-page** for the sales copy. Copy also follows the `human-writing` rules (no AI tells). |
| Models | **Fable** plans and tests. **Sonnet** implements. |
| Brand | A placeholder until Charlie picks from the brand research. Name, tagline, colours, logo and support contacts all come from one config (`brandConfig()`, extended), so applying the brand is one change. |
| Real vs sample data | Sales page, pricing and setup guide are fully real now. Login, signup, dashboard and billing screens are built as **working screens on sample data**, behind one data interface, so the accounts-and-billing stage swaps in real accounts and Stripe without redesign. Nothing takes money or creates accounts until that stage lands. Sample-data screens are visibly marked ("Preview") until then. |

## Pages

| Route | Content |
|---|---|
| `/` (signed out): **sales page** | Hook; how it works in 3 steps; "keep your workflows, no rebuilding"; safety (pacing, messages held while disconnected, STOP opt-outs); honest FAQ including ban risk and that it's a linked device, not the official Business API; pricing summary; **Start 7-day free trial** CTA. |
| `/pricing` | One price per number per month; a live calculator ("5 numbers = £X/month"); trial terms (7 days, card up front, 3 numbers on trial); cancel anytime; what happens if a payment fails. The price comes from config. |
| `/docs/setup`: **GHL setup guide** | Two tabs, **Agency owner** and **Single sub-account**. Steps: Install (`<Brand>` install link / Marketplace) → open the `<Brand>` WhatsApp page in the GHL left menu → **set the Telephony Provider** (exact GHL menu path: Settings → Phone System → Advanced Settings → Telephony Provider → `<Brand>` → Save) → scan the QR (WhatsApp → Settings → Linked Devices → Link a Device) → confirm connected → send a test workflow SMS → reply and see it in Conversations. Each step has an illustrative screenshot or diagram. Troubleshooting: connected but not sending (Telephony Provider), QR expired, messages waiting, white-label agency blocks installs, number at the linked-device limit. |
| `/docs` | Index: setup guide, FAQ, billing help, privacy and data handling summary. |
| `/login`, `/signup` | Emailed sign-in link (no passwords). Signup asks for account name, "agency or single business?" and email, then goes to checkout (Preview: simulated). |
| `/dashboard` (signed in) | Plan status (trial days left / active / payment failed banner), "N numbers active · £X/month", the sub-account list with WhatsApp status, today's sends against the cap, a **Needs attention** filter and row actions, and a **Billing** button (Stripe Customer Portal later). In Preview this runs on sample data. |
| `/legal/terms`, `/legal/privacy` | Placeholder pages with headings and a clear "draft, to be replaced by real legal text" notice. No invented legal text. |

## Quality bar

- Works at 375px and desktop, with no horizontal scroll. Keyboard and screen-reader accessible (WCAG 2.1 AA). Fast: no heavy client JS on marketing pages.
- No "FitClosers" anywhere. The existing `no-fitclosers` test covers this.
- Every claim on the sales page is true of the product as specified. No invented stats, testimonials or logos.

## Testing (Fable)

Browser walkthrough of every page at both widths with screenshots. Check every setup-guide step against the real app flow (the foundation's embed and connect pages). Run an accessibility audit. `npm run check` and `npm run build` pass.

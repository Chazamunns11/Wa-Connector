# Go-live: paste this into Claude in Chrome

Everything left before PingWren can take money happens in accounts only you
can sign in to: Stripe, Vercel, Resend, Supabase and GoDaddy. Open Chrome,
sign in to each of them, start Claude in Chrome and paste everything in the
box below. It copies keys straight from one tab into the other, so no secret
ever goes into a chat.

It sets up **Stripe in test mode**. When the test run in
`docs/GO-LIVE-ACCOUNTS.md` Part 6 passes, Part 9 repeats it in live mode.

---

```
You are setting up PingWren (a WhatsApp app for GoHighLevel) to go live. Work
through the steps below in order, in my already-signed-in Chrome tabs. Open a
new tab for each site.

HARD RULES. Never break these, and stop to ask me if a step would:
1. Never type, paste or repeat any secret key, signing secret or API key into
   this chat or any message. Copy it from the site that shows it and paste it
   straight into the Vercel field it belongs in. Nowhere else.
2. Never touch the Stripe account called "join.fitclosers.co.uk" (FitClosers).
   Everything in Stripe happens in a separate account called PingWren.
3. In GoDaddy, only ADD DNS records. Never edit or delete an existing record.
   pingwren.co.uk's website (Netlify) and email must keep working.
4. Stripe stays in TEST MODE (toggle at the top right) for this whole run.
5. Don't create charges, customers or subscriptions. Only configure.
6. If a page looks different from what I describe, or something already
   exists, tell me what you see and do the sensible thing (reuse what exists,
   never make duplicates). If you are unsure, stop and ask.

STEP 1. STRIPE (dashboard.stripe.com), TEST MODE
a. Account switcher (top left): open the account named "PingWren". If there
   isn't one, choose "New account", name it PingWren, country United Kingdom.
   Confirm the switcher shows PingWren, NOT join.fitclosers.co.uk. Turn on
   Test mode.
b. Product catalogue > Add product. Name: PingWren WhatsApp number.
   Add ONE price:
   - Recurring, Monthly, GBP
   - Pricing model: Graduated (tiered, graduated)
   - Tier 1: units 1 to 10, £9.99 per unit, no flat fee
   - Tier 2: units 11 and above, £7.99 per unit, no flat fee
   Save. Note the price id (starts price_). It is not a secret.
c. Settings > Billing > Customer portal: turn on "Update payment method",
   "Invoice history" and "Cancel subscriptions" (cancel at end of billing
   period). Leave quantity changes and plan switching OFF.
   Return link (default redirect): https://pingwren.vercel.app/dashboard/billing
d. Billing > Revenue recovery > Retries (or Settings > Billing >
   Subscriptions and emails > Manage failed payments): Smart Retries on,
   about 1 week. "If all retries for a payment fail": Mark the subscription
   as UNPAID. Not "cancel", not "pause".
e. Revenue recovery > Emails / Settings > Customer emails: turn on emails for
   successful payments (receipts) and failed card payments.
f. Settings > Business > Public details: business name PingWren, website
   https://pingwren.co.uk, support email charlie@pingwren.co.uk. Statement
   descriptor PINGWREN.
g. Settings > Branding:
   - Icon: https://pingwren.vercel.app/brand/pingwren-app-icon-512.png
   - Logo: https://pingwren.vercel.app/brand/pingwren-logo@3x.png
     (download each one first, then upload it)
   - Brand colour #FF5A36, accent colour #1B1F2A
h. Developers > Webhooks > Add endpoint:
   URL: https://pingwren.vercel.app/api/webhooks/billing
   Select exactly these 8 events:
     checkout.session.completed
     customer.subscription.created
     customer.subscription.updated
     customer.subscription.deleted
     customer.subscription.paused
     customer.subscription.resumed
     invoice.payment_failed
     customer.updated
   Save. Leave this tab open: you'll copy its signing secret (whsec_...) in
   step 3.
i. Developers > API keys: leave this tab open too. You'll copy the TEST
   secret key (sk_test_...) in step 3. Never the publishable key.

STEP 2. RESEND (resend.com), the email sender
a. Domains: if pingwren.co.uk isn't there, add it (region EU/London if
   offered). Resend lists some DNS records (TXT/MX/CNAME for SPF, DKIM and
   bounces).
b. In GoDaddy (dcc.godaddy.com > pingwren.co.uk > DNS), ADD each of those
   records exactly as Resend shows them. Only add. If a record with the same
   name and type already exists, don't change it. Tell me instead.
c. Back in Resend, click Verify. It can take a few minutes, so carry on and
   check again at the end.
d. API Keys > Create API key, name "PingWren Vercel", permission "Sending
   access", domain pingwren.co.uk. It's only shown once: keep the tab open
   for step 3.

STEP 3. VERCEL (vercel.com), project "pingwren" (team sync-me)
Settings > Environment Variables. For each one below, add it for
Production (and Preview), or edit the value if it already exists. Paste each
secret straight from its tab:
   STRIPE_SECRET_KEY      = the sk_test_ key from Stripe step 1i
   STRIPE_PRICE_ID        = the price_ id from step 1b
   STRIPE_WEBHOOK_SECRET  = the signing secret (whsec_) from step 1h
                            (click "Reveal" on the webhook endpoint page)
   RESEND_API_KEY         = the key from Resend step 2d
   EMAIL_FROM             = PingWren <hello@pingwren.co.uk>
Then Deployments > the latest Production deployment > ⋯ > Redeploy.

STEP 4. HUB ADDRESS: hub.pingwren.co.uk
a. In the Vercel project "pingwren": Settings > Domains > Add
   hub.pingwren.co.uk. Vercel shows the DNS record it needs (usually a CNAME
   "hub" pointing to something like cname.vercel-dns.com or a
   ...vercel-dns-0xx.com value). Use exactly what Vercel shows.
b. GoDaddy > pingwren.co.uk > DNS > Add new record: that CNAME, name hub,
   TTL default. ADD only. If a "hub" record already exists, stop and tell me.
c. Back in Vercel, wait for the domain to show "Valid Configuration".

STEP 5. SUPABASE (supabase.com), project cvqaghghuyxolpcfuzrw (PingWren)
a. Project Settings > Authentication > SMTP Settings: enable custom SMTP.
   Host smtp.resend.com, port 465, username resend, password = a Resend API
   key (create a second one called "PingWren Supabase SMTP", sending access),
   sender email hello@pingwren.co.uk, sender name PingWren.
b. Authentication > Email Templates:
   - "Confirm signup": subject "Your PingWren link". Body: paste the full
     contents of
     https://github.com/Chazamunns11/Wa-Connector/blob/claude/adoring-brown-hvwuyz/docs/email-templates/confirm-signup.html
     (open the file, click "Raw", select all, copy).
   - "Magic Link": subject "Your PingWren link". Body: the full contents of
     .../docs/email-templates/magic-link.html from the same folder.
   Save both.

STEP 6. CHECK AND REPORT
- Resend: is pingwren.co.uk Verified?
- Vercel: has the redeploy finished, and is hub.pingwren.co.uk "Valid"?
- Open https://pingwren.vercel.app/api/webhooks/billing in a new tab. It
  should NOT say "STRIPE_WEBHOOK_SECRET not configured" any more (a
  "method"/405 or "invalid signature" style answer is fine).
- In Stripe > Webhooks > the endpoint, use "Send test event" with
  customer.updated. It should get a 200.
Then tell me, in plain words, what you did, anything you skipped and why,
and anything that still needs me. Don't include any keys or secrets in that
summary.
```

---

## After it finishes

Tell Claude Code "done". It will check the webhook, the hub address and the
emails from its side, then walk you through the test-mode run (Part 6 of
`docs/GO-LIVE-ACCOUNTS.md`).

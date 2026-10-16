import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { siteButton } from "@/components/site/button";
import { Container } from "@/components/site/Container";
import { PreviewBadge } from "@/components/site/PreviewBadge";
import { brandConfig } from "@/lib/brand-config";
import { TRIAL_DAYS, TRIAL_MAX_NUMBERS, formatMoney, pricingConfig } from "@/lib/pricing";
import { SITE_ROUTES } from "@/lib/site/routes";
import { validateSignup } from "@/lib/site/signup";

export function generateMetadata(): Metadata {
  return {
    title: `Checkout (preview) — ${brandConfig().name}`,
    robots: { index: false },
  };
}

const KIND_LABEL = { agency: "Agency", business: "Single business" } as const;

export default async function CheckoutPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const p = await searchParams;
  const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : null);
  const result = validateSignup({ accountName: one(p.name), kind: one(p.kind), email: one(p.email) });
  if (!result.ok) redirect(SITE_ROUTES.signup);
  const { accountName, kind, email } = result.value;
  const claim = typeof p.claim === "string" && p.claim ? p.claim : null;
  const brand = brandConfig();
  const pricing = pricingConfig();

  return (
    <Container className="py-10 md:py-16">
      <div className="mx-auto max-w-2xl">
        <header>
          <PreviewBadge />
        </header>
        <h1 className="h-display mt-4 font-display font-extrabold">Checkout</h1>
        <p className="mt-3 max-w-[60ch] text-lg text-ink-dim">
          This is a preview of the last step. Nothing here creates an account, sends an email or takes a card.
        </p>

        {claim ? <p className="mt-3 text-ink-dim">You arrived from GoHighLevel.</p> : null}
        <div className="mt-8 grid gap-4">
          <div className="slab slab-2 p-5 sm:p-6">
            <h2 className="font-display text-[1.35rem] font-extrabold leading-[1.1] tracking-[-0.015em]">Your details</h2>
            <dl className="mt-4 grid gap-x-3 gap-y-1 sm:grid-cols-[8rem_1fr] sm:gap-y-3">
              <dt className="text-ink-dim">Account</dt>
              <dd className="mb-2 break-words sm:mb-0">{accountName}</dd>
              <dt className="text-ink-dim">Type</dt>
              <dd className="mb-2 sm:mb-0">{KIND_LABEL[kind]}</dd>
              <dt className="text-ink-dim">Email</dt>
              <dd className="break-all">{email}</dd>
            </dl>
            <p className="mt-4">
              <Link href={claim ? `${SITE_ROUTES.signup}?claim=${encodeURIComponent(claim)}` : SITE_ROUTES.signup} className="font-semibold text-ink underline underline-offset-2">
                Change these details
              </Link>
            </p>
          </div>

          <div className="slab slab-2 p-5 sm:p-6">
            <h2 className="font-display text-[1.35rem] font-extrabold leading-[1.1] tracking-[-0.015em]">What happens next</h2>
            <ul className="mt-4 grid gap-3 text-ink-dim">
              <li>
                <span className="font-semibold text-ink">{formatMoney(pricing.pricePerNumber, pricing.currency)}</span> per
                active number per month, once the trial ends.
              </li>
              <li>
                A {TRIAL_DAYS}-day free trial, with up to {TRIAL_MAX_NUMBERS} numbers.
              </li>
              <li>You pay on Stripe&rsquo;s own page, and {brand.name} never sees your card details.</li>
              <li>A card is required to start the trial. Nothing is billed until the trial ends.</li>
              <li>Cancel any time from the billing portal.</li>
            </ul>
          </div>

          <div className="slab slab-2 p-5 sm:p-6">
            <h2 className="font-display text-[1.35rem] font-extrabold leading-[1.1] tracking-[-0.015em]">Payment</h2>
            <p className="mt-2 text-ink-dim">Preview — no card is taken. This form does nothing.</p>
            <form className="mt-4 grid gap-4" aria-label="Card details (preview, disabled)">
              <fieldset disabled className="grid gap-4 opacity-60">
                <legend className="sr-only">Card details</legend>
                <label className="grid gap-1.5 text-sm text-ink-dim">
                  Card number
                  <input type="text" inputMode="numeric" autoComplete="cc-number" placeholder="1234 1234 1234 1234" className="min-h-11 w-full min-w-0 rounded-lg border-2 border-border bg-well px-3 text-base" />
                </label>
                <div className="grid grid-cols-2 gap-4 [&>label]:min-w-0">
                  <label className="grid gap-1.5 text-sm text-ink-dim">
                    Expiry
                    <input type="text" autoComplete="cc-exp" placeholder="MM / YY" className="min-h-11 w-full min-w-0 rounded-lg border-2 border-border bg-well px-3 text-base" />
                  </label>
                  <label className="grid gap-1.5 text-sm text-ink-dim">
                    Security code
                    <input type="text" autoComplete="cc-csc" placeholder="CVC" className="min-h-11 w-full min-w-0 rounded-lg border-2 border-border bg-well px-3 text-base" />
                  </label>
                </div>
              </fieldset>
            </form>
          </div>

          <div>
            <Link href={SITE_ROUTES.dashboard} className={siteButton("coral")}>
              Continue to the dashboard (preview)
            </Link>
            <p className="mt-3 text-sm text-ink-dim">The dashboard shows sample data only.</p>
          </div>
        </div>
      </div>
    </Container>
  );
}

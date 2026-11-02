import type { Metadata } from "next";
import Link from "next/link";
import { Container } from "@/components/site/Container";
import { PageTop } from "@/components/site/PageTop";
import { brandConfig } from "@/lib/brand-config";
import { pricingConfig, priceSentence, TRIAL_DAYS } from "@/lib/pricing";
import { pricingCopy } from "@/lib/site/pricing-copy";
import { SITE_ROUTES } from "@/lib/site/routes";

export function generateMetadata(): Metadata {
  const { name } = brandConfig();
  return {
    title: `Billing | ${name}`,
    description: `How the ${name} free trial, monthly billing, failed payments and cancelling work.`,
  };
}

export default function BillingHelpPage() {
  const pricing = pricingConfig();
  const copy = pricingCopy();
  const h2 = "mt-12 h-section font-display first:mt-0";
  return (
    <>
    <PageTop title="Billing">
      <p>
        {priceSentence(pricing.currency)} Each WhatsApp number on an active sub-account is billed as its own monthly
        payment, with its own {TRIAL_DAYS}-day free trial, on the day that trial ended. A number you remove stops billing at
        once, and the unused part of its month is credited to your next bill.
      </p>
    </PageTop>
    <section className="band">
      <Container>
        <div className="max-w-[760px]">
          <h2 className={h2}>The free trial</h2>
          {copy.trialTerms.map((t) => (
            <p key={t} className="mt-3 max-w-[62ch] text-ink-dim">{t}</p>
          ))}

          <h2 className={h2}>If a payment fails</h2>
          <div className="mt-3 grid max-w-[62ch] gap-3 text-ink-dim">
            {copy.failedPayment.map((p) => (
              <p key={p}>{p}</p>
            ))}
          </div>

          <h2 className={h2}>Changing your card or cancelling</h2>
          <p className="mt-3 max-w-[62ch] text-ink-dim">{copy.cancel}</p>
          <p className="mt-3 max-w-[62ch] text-ink-dim">
            You save a card, with its billing address, when you sign up; nothing is charged then. Each number is charged
            to it when that number&apos;s trial ends. Change the card in the billing portal on your dashboard&apos;s Billing
            page; if a number stopped sending because a payment could not be taken, Add a card there restarts it. Until
            your account is live, the{" "}
            <Link href={SITE_ROUTES.pricing} className="underline underline-offset-2">
              pricing page
            </Link>{" "}
            has the trial and billing terms.
          </p>
        </div>
      </Container>
    </section>
    </>
  );
}

import { pricePerNumber } from "@/lib/pricing";

/** The price, plainly: one flat price per WhatsApp number (Nov 2026; this used to list three tiers). */
export function TierList({ currency }: { currency: string }) {
  return (
    <dl className="grid max-w-[34rem] gap-0 [font-variant-numeric:tabular-nums]" aria-label="Price per WhatsApp number, per month">
      <div className="flex items-baseline justify-between gap-6 border-y-2 border-rule py-3">
        <dt className="font-medium">Each WhatsApp number</dt>
        <dd className="font-display text-[1.35rem] font-extrabold leading-none">
          {pricePerNumber(currency)} <span className="text-base font-medium">a month</span>
        </dd>
      </div>
    </dl>
  );
}

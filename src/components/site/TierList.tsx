import { FIRST_TIER_NUMBERS, laterPricePerNumber, pricePerNumber } from "@/lib/pricing";

/** The price per WhatsApp number, plainly: £9.99 for each of the first 10, £7.99 for each after. */
export function TierList({ currency }: { currency: string }) {
  const rows = [
    { range: `Your first ${FIRST_TIER_NUMBERS} numbers`, each: pricePerNumber(currency) },
    { range: `Every number after that`, each: laterPricePerNumber(currency) },
  ];
  return (
    <dl className="grid max-w-[34rem] gap-0 [font-variant-numeric:tabular-nums]" aria-label="Price per WhatsApp number, per month">
      {rows.map((row) => (
        <div key={row.range} className="flex items-baseline justify-between gap-6 border-t-2 border-rule py-3 last:border-b-2">
          <dt className="font-medium">{row.range}</dt>
          <dd className="font-display text-[1.35rem] font-extrabold leading-none">
            {row.each} <span className="text-base font-medium">each, a month</span>
          </dd>
        </div>
      ))}
    </dl>
  );
}

import { VOLUME_FROM_NUMBERS, pricePerNumber, volumePricePerNumber } from "@/lib/pricing";

/** The price per WhatsApp number, plainly: £7.99, or £5.99 for every number from 25 (volume pricing). */
export function TierList({ currency }: { currency: string }) {
  const rows = [
    { range: `1 to ${VOLUME_FROM_NUMBERS - 1} numbers`, each: pricePerNumber(currency) },
    { range: `${VOLUME_FROM_NUMBERS} or more numbers`, each: volumePricePerNumber(currency) },
  ];
  return (
    <dl className="grid max-w-[34rem] gap-0 [font-variant-numeric:tabular-nums]" aria-label="Price per WhatsApp number, per month, applied to every number">
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

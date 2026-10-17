import { tierRows } from "@/lib/pricing";

/** The two price tiers, plainly. A list rather than a table: two rows do not need a grid. */
export function TierList({ currency }: { currency: string }) {
  return (
    <dl className="grid max-w-[34rem] gap-0 [font-variant-numeric:tabular-nums]" aria-label="Price per number, per month">
      {tierRows(currency).map((row) => (
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

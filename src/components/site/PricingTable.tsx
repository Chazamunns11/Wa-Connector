import { CALCULATOR_PRESETS, formatMoney, monthlyCost, type PricingConfig } from "@/lib/pricing";

/** "1 number is £29 a month, 3 numbers £87 ..." as one sentence built from the presets. */
function fallbackSentence(pricing: PricingConfig): string {
  const parts = CALCULATOR_PRESETS.map((n) => {
    const cost = formatMoney(monthlyCost(n, pricing.pricePerNumber), pricing.currency);
    const label = n === 1 ? "1 number is" : `${n} numbers`;
    return n === 1 ? `${label} ${cost} a month` : `${label} ${cost}`;
  });
  return `For reference: ${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}.`;
}

/**
 * The calculator's no-JS fallback: one sentence, always in the HTML, plus a
 * <noscript> line for the calculator's own slot. Not a table.
 */
export function PricingTable({ pricing }: { pricing: PricingConfig }) {
  return (
    <div>
      <p className="max-w-[62ch] text-ink-dim [font-variant-numeric:tabular-nums]">{fallbackSentence(pricing)}</p>
      <noscript>
        <p className="mt-2 max-w-[62ch] text-ink-dim">
          The calculator needs JavaScript. For any other number, multiply by{" "}
          {formatMoney(pricing.pricePerNumber, pricing.currency)}.
        </p>
      </noscript>
    </div>
  );
}

import { CALCULATOR_PRESETS, formatMoney, monthlyCost, type PricingConfig } from "@/lib/pricing";

/** "1 sub-account is £14.99 a month, 3 sub-accounts £44.97 ..." as one sentence built from the presets. */
function fallbackSentence(pricing: PricingConfig): string {
  const parts = CALCULATOR_PRESETS.map((n) => {
    const cost = formatMoney(monthlyCost(n), pricing.currency);
    const label = n === 1 ? "1 sub-account is" : `${n} sub-accounts`;
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
          The calculator needs JavaScript. For any other count, the tiers above give the price per sub-account, and the tier you reach applies to every sub-account.
        </p>
      </noscript>
    </div>
  );
}

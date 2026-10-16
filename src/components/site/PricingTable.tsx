import {
  CALCULATOR_PRESETS,
  formatMoney,
  monthlyCost,
  type PricingConfig,
} from "@/lib/pricing";

function Rows({ pricing }: { pricing: PricingConfig }) {
  return (
    <>
      {CALCULATOR_PRESETS.map((n) => (
        <tr key={n}>
          <td className="border-b border-divider px-4 py-3 [font-variant-numeric:tabular-nums]">
            {n} {n === 1 ? "number" : "numbers"}
          </td>
          <td className="border-b border-divider px-4 py-3 [font-variant-numeric:tabular-nums]">
            {formatMoney(monthlyCost(n, pricing.pricePerNumber), pricing.currency)}/month
          </td>
        </tr>
      ))}
    </>
  );
}

/**
 * Example prices for common sizes. Always visible (the no-JS fallback for the
 * calculator); the <noscript> copy is an extra guarantee for the calculator's
 * own slot and is kept as a plain list.
 */
export function PricingTable({ pricing }: { pricing: PricingConfig }) {
  return (
    <div>
      <h2 className="font-display text-lg font-medium">Examples</h2>
      <div className="mt-3 overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <caption className="pb-2 text-left text-sm text-ink-dim">Monthly price by number of WhatsApp numbers</caption>
          <thead>
            <tr>
              <th scope="col" className="border-b px-4 py-3 text-left font-medium text-ink-dim">Numbers</th>
              <th scope="col" className="border-b px-4 py-3 text-left font-medium text-ink-dim">Per month</th>
            </tr>
          </thead>
          <tbody>
            <Rows pricing={pricing} />
          </tbody>
        </table>
      </div>
      <noscript>
        <p className="mt-3 text-sm text-ink-dim">
          The calculator needs JavaScript. The table above shows the price for common sizes; for any other number, multiply
          by {formatMoney(pricing.pricePerNumber, pricing.currency)}.
        </p>
      </noscript>
    </div>
  );
}

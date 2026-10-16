"use client";

import { useId, useState } from "react";
import { formatMoney, monthlyCost } from "@/lib/pricing";
import { CALC_MAX, CALC_MIN, calculatorValue } from "@/lib/site/calculator";

const DEFAULT = "5";

/**
 * The calculator is one sentence: "If I connect [5] numbers, I'll pay £145 a month."
 * The label is the first clause; the amount sits in a polite live region, and
 * the help or error line below is the input's description.
 */
export function PricingCalculator({ pricePerNumber, currency }: { pricePerNumber: number; currency: string }) {
  const id = useId();
  const [raw, setRaw] = useState(DEFAULT);
  const { n, note, empty } = calculatorValue(raw);
  const cost = formatMoney(monthlyCost(n, pricePerNumber), currency);
  const invalid = note !== null && !empty;
  const messageId = `${id}-message`;
  return (
    <div>
      <p className="font-display text-[clamp(25px,3.6vw,39px)] font-medium leading-[1.3] tracking-[-0.015em]">
        <label htmlFor={id}>If I connect</label>{" "}
        <input
          id={id}
          type="number"
          min={CALC_MIN}
          max={CALC_MAX}
          step={1}
          inputMode="numeric"
          value={raw}
          onChange={(e) => setRaw(e.target.value)}
          aria-describedby={messageId}
          aria-invalid={invalid}
          className="mx-1 min-h-11 w-[5.5ch] rounded border border-border-strong bg-card px-2 text-center font-display font-extrabold [font-variant-numeric:tabular-nums] [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
        />{" "}
        numbers,{" "}
        <span aria-live="polite" className="whitespace-nowrap">
          {empty ? null : (
            <>
              I&apos;ll pay <strong className="font-extrabold [font-variant-numeric:tabular-nums]">{cost}</strong> a month.
            </>
          )}
        </span>
      </p>
      <p
        id={messageId}
        role="status"
        className={`mt-3 min-h-[1.45em] text-[15px] ${note ? "font-medium text-warn" : "text-ink-faint"}`}
      >
        {note ?? `Whole numbers from ${CALC_MIN} to ${CALC_MAX}.`}
      </p>
    </div>
  );
}

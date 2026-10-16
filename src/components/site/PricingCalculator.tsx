"use client";

import { useId, useState } from "react";
import { CALC_MAX, CALC_MIN, calculatorDisplay } from "@/lib/site/calculator";

const DEFAULT = 5;

export function PricingCalculator({
  pricePerNumber,
  currency,
  brandName,
}: {
  pricePerNumber: number;
  currency: string;
  brandName: string;
}) {
  const id = useId();
  const [raw, setRaw] = useState(String(DEFAULT));
  const { line, note, empty } = calculatorDisplay(raw, { pricePerNumber, currency });
  return (
    <div>
      <label htmlFor={id} className="font-semibold">
        How many WhatsApp numbers will you connect with {brandName}?
      </label>
      <input
        id={id}
        type="number"
        min={CALC_MIN}
        max={CALC_MAX}
        step={1}
        inputMode="numeric"
        value={raw}
        onChange={(e) => setRaw(e.target.value)}
        aria-describedby={`${id}-help`}
        aria-invalid={note !== null && !empty}
        className="mt-3 block min-h-11 w-full max-w-[12rem] rounded border border-border-strong bg-well px-3 text-lg [font-variant-numeric:tabular-nums]"
      />
      <p id={`${id}-help`} className="mt-2 text-sm text-ink-dim">
        Whole numbers from {CALC_MIN} to {CALC_MAX}.
      </p>
      <div aria-live="polite" className="mt-4">
        <p className="min-h-[1.2em] font-display text-[clamp(24px,5vw,32px)] font-extrabold leading-tight [font-variant-numeric:tabular-nums]">
          {line}
        </p>
        {note ? <p className="mt-1 text-sm text-warn">{note}</p> : null}
      </div>
    </div>
  );
}

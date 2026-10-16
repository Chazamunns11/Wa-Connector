"use client";

import { useId, useState } from "react";
import { priceLine } from "@/lib/pricing";

const MIN = 0;
const MAX = 500;
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
  const parsed = raw.trim() === "" ? NaN : Number(raw);
  const valid = Number.isFinite(parsed) && parsed >= MIN && parsed <= MAX;
  const n = valid ? Math.floor(parsed) : 0;
  return (
    <div>
      <label htmlFor={id} className="font-semibold">
        How many WhatsApp numbers will you connect with {brandName}?
      </label>
      <input
        id={id}
        type="number"
        min={MIN}
        max={MAX}
        step={1}
        inputMode="numeric"
        value={raw}
        onChange={(e) => setRaw(e.target.value)}
        aria-describedby={`${id}-help`}
        aria-invalid={!valid}
        className="mt-3 block min-h-11 w-full max-w-[12rem] rounded border border-white/40 bg-well px-3 text-lg [font-variant-numeric:tabular-nums]"
      />
      <p id={`${id}-help`} className={`mt-2 text-sm ${valid ? "text-ink-dim" : "text-loss"}`}>
        {valid ? `Enter a whole number from ${MIN} to ${MAX}.` : `Enter a whole number from ${MIN} to ${MAX} to see a price.`}
      </p>
      <p
        aria-live="polite"
        className="mt-4 font-display text-[clamp(24px,5vw,32px)] font-bold leading-tight [font-variant-numeric:tabular-nums]"
      >
        {valid ? priceLine(n, { pricePerNumber, currency }) : " "}
      </p>
    </div>
  );
}

"use client";

import { useId, useState } from "react";
import { RESALE_DEFAULT_NUMBERS, RESALE_DEFAULT_PRICE, resaleView } from "@/lib/site/resale";
import { CALC_MAX, CALC_MIN } from "@/lib/site/calculator";

const FIELD =
  "min-h-12 w-full rounded-lg border-2 border-outline bg-well px-3 font-display text-xl font-extrabold text-ink [font-variant-numeric:tabular-nums] [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none aria-[invalid=true]:border-[3px]";

/**
 * Two numbers in, three sentences out. On the Coral band: Ink text, an Ink rule for the
 * figure rule only. Labels are visible, the output is a polite live region, and each
 * field's help or error line is its description (and a status, so a bad value is announced).
 */
export function ResaleCalculator({ currency }: { currency: string }) {
  const id = useId();
  const [count, setCount] = useState(RESALE_DEFAULT_NUMBERS);
  const [price, setPrice] = useState(RESALE_DEFAULT_PRICE);
  const view = resaleView(count, price, currency);
  const countInvalid = view.numbersNote !== null;
  const countMsg = `${id}-count-msg`;
  const priceMsg = `${id}-price-msg`;
  return (
    <div>
      <div className="grid gap-6 sm:grid-cols-2 sm:gap-8">
        <div>
          <label htmlFor={`${id}-count`} className="block text-[1.05rem] font-semibold">
            Client WhatsApp numbers
          </label>
          <input
            id={`${id}-count`}
            type="number"
            min={CALC_MIN}
            max={CALC_MAX}
            step={1}
            inputMode="numeric"
            value={count}
            onChange={(e) => setCount(e.target.value)}
            aria-describedby={countMsg}
            aria-invalid={countInvalid}
            className={`${FIELD} mt-2`}
          />
          <p id={countMsg} role="status" className="mt-2 min-h-[1.45em] small text-ink-dim">
            {view.numbersNote ?? `Whole numbers from ${CALC_MIN} to ${CALC_MAX}.`}
          </p>
        </div>
        <div>
          <label htmlFor={`${id}-price`} className="block text-[1.05rem] font-semibold">
            Your price per number, a month
          </label>
          <input
            id={`${id}-price`}
            type="text"
            inputMode="decimal"
            autoComplete="off"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            aria-describedby={priceMsg}
            aria-invalid={view.priceInvalid}
            className={`${FIELD} mt-2`}
          />
          <p id={priceMsg} role="status" className="mt-2 min-h-[1.45em] small text-ink-dim">
            {view.priceNote ?? "In pounds. Pence are fine, like 19.99."}
          </p>
        </div>
      </div>

      <div aria-live="polite" className="mt-8 border-t-[3px] border-rule pt-6">
        {view.sentences ? (
          <p className="max-w-[40ch] font-display text-[clamp(1.5rem,3.2vw,2.3rem)] font-extrabold leading-[1.2] tracking-[-0.02em] [font-variant-numeric:tabular-nums]">
            {view.sentences.map((s, i) => (
              <span key={i} className={i === 2 ? "block text-accent" : "block"}>
                {s}
              </span>
            ))}
          </p>
        ) : (
          <p className="text-[1.15rem] font-semibold">Fill in both boxes to see the figures.</p>
        )}
        {view.warning ? <p className="mt-4 max-w-[52ch] font-semibold">{view.warning}</p> : null}
      </div>
    </div>
  );
}

import type { ReactNode } from "react";
import type { LocationRow } from "@/lib/account-data";
import { TELEPHONY_PROVIDER_PATH } from "@/lib/site/setup-steps";

function Stat({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-sm text-ink-faint">{label}</dt>
      <dd className="mt-0.5 text-ink-dim">{children}</dd>
    </div>
  );
}

/** Expanded row: held messages, failures with reasons, opt-outs, provider nudge, and the row actions. */
export function LocationRowDetail({ row, actions }: { row: LocationRow; actions: ReactNode }) {
  const { count, reasons } = row.failedLast7Days;
  return (
    <details className="group border-t border-divider">
      <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 px-4 py-2 text-sm font-medium text-accent-text md:px-6 [&::-webkit-details-marker]:hidden">
        <span>
          Details and actions<span className="sr-only"> for {row.name}</span>
        </span>
        <span aria-hidden className="text-lg leading-none group-open:hidden">+</span>
        <span aria-hidden className="hidden text-lg leading-none group-open:inline">&minus;</span>
      </summary>
      <div className="grid gap-5 px-4 pb-5 md:px-6">
        <dl className="grid gap-4 sm:grid-cols-3">
          <Stat label="Held messages">
            {row.heldMessages === 0 ? "None" : `${row.heldMessages} waiting for the phone to reconnect`}
          </Stat>
          <Stat label="Failed in the last 7 days">
            {count === 0 ? (
              "None"
            ) : (
              <>
                {count}
                {reasons.length > 0 ? <span>: {reasons.join("; ")}</span> : null}
              </>
            )}
          </Stat>
          <Stat label="Opt-outs (STOP) from this number">{row.optOuts}</Stat>
        </dl>
        {row.providerNudge ? (
          <p className="rounded border border-warn/30 bg-warn-soft p-3 text-sm text-ink">
            <strong className="font-semibold">No messages from GoHighLevel yet.</strong> Check that this sub-account&rsquo;s
            Telephony Provider is set: <span className="font-medium">{TELEPHONY_PROVIDER_PATH.join(" → ")}</span>.
          </p>
        ) : null}
        {actions}
      </div>
    </details>
  );
}

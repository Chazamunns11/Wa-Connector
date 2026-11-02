"use client";

/**
 * Dashboard: one sub-account's WhatsApp numbers (up to 3) for the agency
 * owner — status, connect by QR, make default, rename, remove, add. Every
 * call goes through `src/app/(app)/dashboard/number-actions.ts`, which checks
 * the sub-account belongs to the signed-in account and applies the same rules
 * as the in-HighLevel page. Numbers are named by slot; no tenant id reaches
 * the browser.
 */
import { useCallback, useEffect, useState } from "react";
import { WhatsappConnectionPanel } from "@/components/whatsapp/WhatsappConnectionPanel";
import { Button } from "@/components/ui/Button";
import { Chip } from "@/components/ui/Chip";
import { copyFor } from "@/components/app/LocationQrPanel";
import type { EmbedNumberView } from "@/app/api/crm/embed/numbers/logic";
import type { PanelBridgeSessionResult } from "@/lib/bridge-panel-guard";
import type { BridgeSessionResult } from "@/lib/whatsapp-bridge";
import { MAX_NUMBER_LABEL_LENGTH, parseLabelInput } from "@/lib/location-numbers";
import {
  addNumberAction,
  connectNumberAction,
  listNumbersAction,
  logoutNumberAction,
  numberLinkAction,
  pollNumberAction,
  removeNumberAction,
  updateNumberAction,
  type NumbersResult,
} from "@/app/(app)/dashboard/number-actions";

const MAX_NUMBERS = 3;

function withCoachId(r: PanelBridgeSessionResult): BridgeSessionResult {
  return r.ok ? { ok: true, session: { ...r.session, coachId: "" } } : r;
}

function statusText(n: EmbedNumberView): string {
  const s = n.summary;
  if (!s) return "Not connected yet";
  const label = s.status === "connected" ? "Connected" : s.status === "waiting_qr" ? "Waiting for QR scan" : s.status === "logged_out" ? "Logged out" : s.status === "banned" ? "Banned by WhatsApp" : "Disconnected";
  return s.phoneNumber ? `${label} · ${s.phoneNumber}` : label;
}

export function LocationNumbersPanel({
  locationId,
  name,
  bridgeConfigured,
  nowMs,
}: {
  locationId: string;
  name: string;
  bridgeConfigured: boolean;
  nowMs: number;
}) {
  const [numbers, setNumbers] = useState<EmbedNumberView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<number | null>(null);
  const [renaming, setRenaming] = useState<number | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  const [newLabel, setNewLabel] = useState("");
  const [link, setLink] = useState<{ slot: number; url: string } | null>(null);

  const apply = useCallback((r: NumbersResult) => {
    if (r.ok) {
      setNumbers(r.numbers);
      setError(null);
    } else setError(r.message);
  }, []);

  const run = useCallback(
    async (fn: () => Promise<NumbersResult>, after?: () => void) => {
      setBusy(true);
      try {
        const r = await fn();
        apply(r);
        if (r.ok) after?.();
      } catch {
        setError("Something went wrong. Please try again.");
      } finally {
        setBusy(false);
      }
    },
    [apply]
  );

  useEffect(() => {
    let live = true;
    listNumbersAction(locationId)
      .then((r) => {
        if (live) apply(r);
      })
      .catch(() => {
        if (live) setError("Couldn't load the numbers. Reload the page to try again.");
      });
    return () => {
      live = false;
    };
  }, [locationId, apply]);

  if (numbers === null) {
    return <p className="text-sm text-ink-dim">{error ?? "Loading numbers…"}</p>;
  }

  const onlyNumber = numbers.length <= 1;

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h3 className="text-base font-semibold text-ink">WhatsApp numbers for {name}</h3>
        <p className="text-sm text-ink-dim">
          Up to {MAX_NUMBERS} numbers. Replies go out from the number the contact last messaged, otherwise the default.
        </p>
      </div>

      {error ? (
        <p role="alert" className="text-sm text-loss">
          {error}
        </p>
      ) : null}

      <ul className="flex flex-col gap-3">
        {numbers.map((n) => {
          const title = n.label ?? `Number ${n.slot}`;
          return (
            <li key={n.key} className="rounded-lg border border-divider p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-ink">{title}</span>
                  {n.isDefault ? <Chip tone="accent">Default</Chip> : null}
                  <span className="text-sm text-ink-dim">{statusText(n)}</span>
                </div>
                <div className="flex flex-wrap gap-1">
                  <Button size="sm" variant="secondary" disabled={busy} onClick={() => setOpen(open === n.slot ? null : n.slot)}>
                    {open === n.slot ? "Close" : n.summary?.status === "connected" ? "Manage" : "Connect"}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={async () => {
                      const url = await numberLinkAction(locationId, n.slot);
                      if (url) setLink({ slot: n.slot, url });
                      else setError("Links aren't available right now. Use Connect to show the QR code here instead.");
                    }}
                  >
                    Get link
                  </Button>
                  {!n.isDefault ? (
                    <Button size="sm" variant="ghost" disabled={busy} onClick={() => void run(() => updateNumberAction(locationId, { slot: n.slot, makeDefault: true }))}>
                      Make default
                    </Button>
                  ) : null}
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => {
                      setDraft(n.label ?? "");
                      setRenaming(n.slot);
                    }}
                  >
                    Rename
                  </Button>
                  {!onlyNumber ? (
                    <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirmRemove(n.slot)}>
                      Remove
                    </Button>
                  ) : null}
                </div>
              </div>

              {link?.slot === n.slot ? (
                <div className="mt-2 flex flex-col gap-1">
                  <input
                    readOnly
                    aria-label={`Connect link for ${title}`}
                    value={link.url}
                    onFocus={(e) => e.currentTarget.select()}
                    className="w-full rounded-md border border-divider bg-transparent px-2 py-1 font-mono text-xs text-ink"
                  />
                  <p className="text-xs text-ink-dim">Send this to whoever has this number&rsquo;s phone. They open it and scan the QR code. It works for 7 days.</p>
                </div>
              ) : null}

              {renaming === n.slot ? (
                <form
                  className="mt-2 flex flex-wrap items-center gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const parsed = parseLabelInput(draft);
                    if (!parsed.ok) return setError(`Names can be up to ${MAX_NUMBER_LABEL_LENGTH} characters.`);
                    void run(() => updateNumberAction(locationId, { slot: n.slot, label: parsed.label }), () => setRenaming(null));
                  }}
                >
                  <input
                    aria-label={`New name for ${title}`}
                    value={draft}
                    maxLength={MAX_NUMBER_LABEL_LENGTH}
                    onChange={(e) => setDraft(e.target.value)}
                    className="rounded-md border border-divider bg-transparent px-2 py-1 text-sm text-ink"
                    placeholder="e.g. Setter"
                  />
                  <Button size="sm" type="submit" disabled={busy}>
                    Save
                  </Button>
                  <Button size="sm" variant="ghost" type="button" onClick={() => setRenaming(null)}>
                    Cancel
                  </Button>
                </form>
              ) : null}

              {confirmRemove === n.slot ? (
                <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-ink">
                  <span>Remove {title}? It is unlinked from WhatsApp and its contacts move to the default number.</span>
                  <Button size="sm" variant="danger" disabled={busy} onClick={() => void run(() => removeNumberAction(locationId, n.slot), () => setConfirmRemove(null))}>
                    Remove
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setConfirmRemove(null)}>
                    Keep it
                  </Button>
                </div>
              ) : null}

              {open === n.slot ? (
                <div className="mt-3">
                  <WhatsappConnectionPanel
                    copy={copyFor(`${name} — ${title}`)}
                    summary={n.summary ? { ...n.summary, coachId: "" } : null}
                    bridgeConfigured={bridgeConfigured}
                    bridgeReachable={bridgeConfigured ? true : null}
                    nowMs={nowMs}
                    connect={async () => withCoachId(await connectNumberAction(locationId, n.slot))}
                    poll={async () => {
                      const r = withCoachId(await pollNumberAction(locationId, n.slot));
                      // Refresh the list once a number settles, so its status line catches up.
                      if (r.ok && r.session.status !== "waiting_qr") void listNumbersAction(locationId).then(apply);
                      return r;
                    }}
                    logout={() => logoutNumberAction(locationId, n.slot)}
                  />
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>

      {numbers.length < MAX_NUMBERS ? (
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const parsed = parseLabelInput(newLabel);
            if (!parsed.ok) return setError(`Names can be up to ${MAX_NUMBER_LABEL_LENGTH} characters.`);
            void run(() => addNumberAction(locationId, parsed.label ?? ""), () => setNewLabel(""));
          }}
        >
          <input
            aria-label="Name for the new number (optional)"
            value={newLabel}
            maxLength={MAX_NUMBER_LABEL_LENGTH}
            onChange={(e) => setNewLabel(e.target.value)}
            className="rounded-md border border-divider bg-transparent px-2 py-1 text-sm text-ink"
            placeholder="Name (optional), e.g. Setter"
          />
          <Button size="sm" variant="secondary" type="submit" disabled={busy}>
            Add a number
          </Button>
        </form>
      ) : null}
    </div>
  );
}

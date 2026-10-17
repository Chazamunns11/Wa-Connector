"use client";

import { useEffect, useState } from "react";
import { Card, CardHeader } from "@/components/ui/Card";
import { errorText, messageOf } from "./CreateGroupForm";

const PATH = "/api/crm/embed/message-events";
const WARNING = "These appear as new messages and can trigger 'Customer replied' workflows.";
const SMS_FALLBACK_NOTE = "Uses this sub-account's own SMS provider, so normal SMS charges apply.";
const SMS_FALLBACK_BLOCKED =
  "Turned off: this sub-account's SMS goes through PingWren. Connect another SMS provider (LC Phone or Twilio) in GHL, then switch it back on.";

type CallEmbedApi = (path: string, method: "POST" | "DELETE" | "PATCH", body: Record<string, unknown>) => Promise<Record<string, unknown>>;
type Key = "showReactions" | "showDeletes" | "smsFallback";
type Values = Record<Key, boolean> & { smsFallbackBlocked: boolean };

const SWITCHES: { key: Key; label: string; note: string }[] = [
  { key: "showReactions", label: "Show reactions in GHL", note: WARNING },
  { key: "showDeletes", label: "Show deleted-message notices in GHL", note: WARNING },
  { key: "smsFallback", label: "Send as SMS when a contact isn't on WhatsApp", note: SMS_FALLBACK_NOTE },
];

/**
 * Per-SUB-ACCOUNT switches (rendered once, not per number): whether WhatsApp
 * reactions and deleted-message notices are posted into GHL (both off until
 * switched on), and whether a message to a contact who isn't on WhatsApp is
 * sent as an SMS instead (on unless switched off). When the loop guard turned
 * the SMS fallback off, the notice says why; switching it on again clears it.
 * Saved on change; disabled while saving.
 */
export function MessageEventSettings({ callEmbedApi }: { callEmbedApi: CallEmbedApi }) {
  const [values, setValues] = useState<Values | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function call(body: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    await send(body);
    setBusy(false);
  }

  async function send(body: Record<string, unknown>) {
    try {
      const json = await callEmbedApi(PATH, "POST", body);
      if (
        json.ok === true &&
        typeof json.showReactions === "boolean" &&
        typeof json.showDeletes === "boolean" &&
        typeof json.smsFallback === "boolean" &&
        typeof json.smsFallbackBlocked === "boolean"
      ) {
        setValues({ showReactions: json.showReactions, showDeletes: json.showDeletes, smsFallback: json.smsFallback, smsFallbackBlocked: json.smsFallbackBlocked });
      } else {
        setError(messageOf(json));
      }
    } catch (err) {
      setError(errorText(err));
    }
  }

  useEffect(() => {
    // Initial read (`busy` starts true, so no synchronous state change here).
    void send({}).then(() => setBusy(false));
    // Load once; `callEmbedApi` is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <Card>
      <CardHeader title="Message events" />
      <div className="flex flex-col gap-3">
        {values === null ? (
          error ? null : <p className="text-xs text-ink-faint">Loading…</p>
        ) : (
          SWITCHES.map(({ key, label, note }) => (
            <div key={key} className="flex flex-col gap-1">
              <div className="flex items-center justify-between gap-3">
                <span id={`message-events-${key}`} className="text-sm text-ink">
                  {label}
                </span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={values[key]}
                  aria-labelledby={`message-events-${key}`}
                  disabled={busy}
                  onClick={() => void call({ [key]: !values[key] })}
                  className={`relative h-6 w-11 shrink-0 rounded-full transition-colors disabled:opacity-60 ${values[key] ? "bg-[var(--color-accent)]" : "bg-ink-faint/40"}`}
                >
                  <span
                    aria-hidden="true"
                    className={`absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white transition-transform ${values[key] ? "translate-x-5" : ""}`}
                  />
                </button>
              </div>
              <p className="text-xs text-ink-faint">{note}</p>
              {key === "smsFallback" && values.smsFallbackBlocked ? <p className="text-xs text-loss">{SMS_FALLBACK_BLOCKED}</p> : null}
            </div>
          ))
        )}
        {error ? <p className="text-xs text-loss">{error}</p> : null}
      </div>
    </Card>
  );
}

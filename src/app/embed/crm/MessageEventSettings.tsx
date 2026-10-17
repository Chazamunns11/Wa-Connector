"use client";

import { useEffect, useState } from "react";
import { Card, CardHeader } from "@/components/ui/Card";
import { errorText, messageOf } from "./CreateGroupForm";

const PATH = "/api/crm/embed/message-events";
const WARNING = "These appear as new messages and can trigger 'Customer replied' workflows.";

type CallEmbedApi = (path: string, method: "POST" | "DELETE" | "PATCH", body: Record<string, unknown>) => Promise<Record<string, unknown>>;
type Key = "showReactions" | "showDeletes";

const SWITCHES: { key: Key; label: string }[] = [
  { key: "showReactions", label: "Show reactions in GHL" },
  { key: "showDeletes", label: "Show deleted-message notices in GHL" },
];

/**
 * Two per-SUB-ACCOUNT switches (rendered once, not per number): whether
 * WhatsApp reactions and deleted-message notices are posted into GHL. Both
 * are off until switched on. Saved on change; disabled while saving.
 */
export function MessageEventSettings({ callEmbedApi }: { callEmbedApi: CallEmbedApi }) {
  const [values, setValues] = useState<Record<Key, boolean> | null>(null);
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
      if (json.ok === true && typeof json.showReactions === "boolean" && typeof json.showDeletes === "boolean") {
        setValues({ showReactions: json.showReactions, showDeletes: json.showDeletes });
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
          SWITCHES.map(({ key, label }) => (
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
              <p className="text-xs text-ink-faint">{WARNING}</p>
            </div>
          ))
        )}
        {error ? <p className="text-xs text-loss">{error}</p> : null}
      </div>
    </Card>
  );
}

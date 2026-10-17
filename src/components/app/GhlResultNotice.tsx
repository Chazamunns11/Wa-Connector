import { brandConfig } from "@/lib/brand-config";

type Tone = "win" | "loss" | "warn" | "muted";

const TONE: Record<Tone, string> = {
  win: "border-win/30 bg-win-soft",
  loss: "border-loss/30 bg-loss-soft",
  warn: "border-warn/30 bg-warn-soft",
  muted: "border-divider bg-raised",
};

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Copy for every `?ghl=` reason the OAuth routes redirect back with. Fixed sentences; counts are plain numbers. */
export function ghlNoticeMessage(
  reason: string | undefined,
  counts: { installed?: number; failed?: number; conflicts?: number } = {},
): { tone: Tone; text: string } | null {
  if (!reason) return null;
  const installed = counts.installed ?? 0;
  const failed = counts.failed ?? 0;
  const conflicts = counts.conflicts ?? 0;
  const conflictText = `This sub-account is already connected to another ${brandConfig().name} account. Contact support.`;
  const conflictSuffix = conflicts > 0 ? ` ${plural(conflicts, "sub-account was", "sub-accounts were")} already connected to another ${brandConfig().name} account and ${conflicts === 1 ? "was" : "were"} skipped.` : "";
  switch (reason) {
    case "connected":
      return { tone: "win", text: "GoHighLevel sub-account connected. Activate its number below to start sending." };
    case "conflict":
      return { tone: "loss", text: conflictText };
    case "cancelled":
      return { tone: "muted", text: "No problem. Nothing was connected." };
    case "forbidden":
      return { tone: "loss", text: "That account cannot connect a GoHighLevel sub-account here." };
    case "unavailable":
      return { tone: "loss", text: "GoHighLevel connections are not switched on for this site yet." };
    case "expired":
      return { tone: "loss", text: "That link timed out. Please try connecting again." };
    case "invalid":
      return { tone: "loss", text: "Something went wrong with that link. Please try again." };
    case "exchange_failed":
      return { tone: "loss", text: "GoHighLevel did not complete the connection. Please try again." };
    case "no_location":
      return { tone: "loss", text: "GoHighLevel did not say which sub-account that was. Please try again." };
    case "no_refresh_token":
      return { tone: "loss", text: "GoHighLevel did not grant long-term access, so the connection would have stopped working within a day. Please try again." };
    case "save_failed":
      return { tone: "loss", text: "We could not save that connection. Please try again." };
    case "bulk_locations_failed":
      return { tone: "loss", text: "GoHighLevel accepted the agency connection but did not say which sub-accounts it covers. Please try again." };
    case "bulk_no_locations":
      return { tone: "loss", text: "GoHighLevel reported no sub-accounts for this agency connection. There is nothing to connect yet." };
    case "bulk_installed":
      return { tone: "win", text: `Connected ${plural(installed, "sub-account", "sub-accounts")}.${conflictSuffix}` };
    case "bulk_partial":
      return { tone: "warn", text: `Connected ${plural(installed, "sub-account", "sub-accounts")}, ${failed} failed. Connect again to retry the failed ones.${conflictSuffix}` };
    case "bulk_failed":
      return { tone: "loss", text: `${plural(failed, "sub-account", "sub-accounts")} failed to connect. Please try again.${conflictSuffix}` };
    default:
      return null;
  }
}

export function GhlResultNotice({
  reason,
  installed,
  failed,
  conflicts,
}: {
  reason?: string;
  installed?: number;
  failed?: number;
  conflicts?: number;
}) {
  const m = ghlNoticeMessage(reason, { installed, failed, conflicts });
  if (!m) return null;
  return (
    <p role="status" className={`mt-4 rounded-lg border p-3 font-medium text-ink ${TONE[m.tone]}`}>
      {m.text}
    </p>
  );
}

"use client";

import { WhatsappConnectionPanel, type WhatsappPanelCopy } from "@/components/whatsapp/WhatsappConnectionPanel";
import type { BridgeOkResult, BridgeSessionResult } from "@/lib/whatsapp-bridge";
import type { PanelBridgeSessionResult } from "@/lib/bridge-panel-guard";
import type { WhatsappSessionSummary } from "@/lib/types";
import {
  connectLocationWhatsappAction,
  logoutLocationWhatsappAction,
  pollLocationWhatsappAction,
} from "@/app/(app)/dashboard/whatsapp-actions";

function copyFor(name: string): WhatsappPanelCopy {
  return {
    cardTitle: `Link WhatsApp for ${name}`,
    cardSubtitle: `Messages sent from ${name} in GoHighLevel will go out from the number you link here.`,
    emptyTitle: "No WhatsApp linked yet",
    emptyDescription: "Scan a QR code with the phone that runs this business's WhatsApp, the same as WhatsApp Web.",
    connectLabel: "Connect WhatsApp",
    freshCodeLabel: "Get a new QR code",
    qrInstruction: "On the phone: WhatsApp → Settings → Linked devices → Link a device, then scan this code.",
    qrWarning:
      "Only scan this on the business phone. Whoever scans this code links their phone to the WhatsApp number and can read and send messages as the business, so treat it exactly like a password.",
    logoutConfirm:
      "This unlinks the number and wipes its stored credentials. Messages will stop going out over WhatsApp until it is reconnected.",
    disconnectedFallback: "WhatsApp isn't connected at the moment.",
    unlinkedMessage: "WhatsApp was unlinked. Reconnecting is safe whenever you're ready.",
    unknownAccountMessage: "This sub-account isn't recognised right now. Reload the page and try again.",
    bannedHelp: "This number was blocked by WhatsApp, so reconnecting the same number is likely to fail. Get in touch with support before trying anything else.",
    unauthorizedMessage: "The WhatsApp service rejected the connection. This needs to be checked by support.",
  };
}

/** The panel's types still carry the bridge's coachId; the account actions never return it, so it is an empty placeholder. */
function withCoachId(r: PanelBridgeSessionResult): BridgeSessionResult {
  return r.ok ? { ok: true, session: { ...r.session, coachId: "" } } : r;
}

export function LocationQrPanel({
  locationId,
  name,
  summary,
  bridgeConfigured,
  nowMs,
}: {
  locationId: string;
  name: string;
  summary: WhatsappSessionSummary | null;
  bridgeConfigured: boolean;
  nowMs: number;
}) {
  return (
    <WhatsappConnectionPanel
      copy={copyFor(name)}
      summary={summary}
      bridgeConfigured={bridgeConfigured}
      bridgeReachable={bridgeConfigured ? true : null}
      nowMs={nowMs}
      connect={async () => withCoachId(await connectLocationWhatsappAction(locationId))}
      poll={async () => withCoachId(await pollLocationWhatsappAction(locationId))}
      logout={(): Promise<BridgeOkResult> => logoutLocationWhatsappAction(locationId)}
    />
  );
}

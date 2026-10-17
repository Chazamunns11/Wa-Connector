import type { BrandConfig } from "@/lib/brand-config";
import { ALT_PATH_NOTE, QR_WARNING, TELEPHONY_PROVIDER_PATH } from "@/lib/site/setup-steps";

export const CONNECT_SHEET_PDF = "/help/pingwren-how-to-connect.pdf";

/**
 * The words the app itself shows on the connect page. The test reads
 * CrmEmbedClient, WhatsappConnectionPanel and ConnectLinkClient and checks
 * each one is still there, so the sheet cannot drift from the product.
 */
export const APP_LABELS = {
  connect: "Connect WhatsApp",
  freshCode: "Get a new QR code",
  reconnect: "Reconnect",
  connected: "Connected",
  waiting: "Waiting for QR scan",
  disconnected: "Disconnected",
  qrInstruction: "On your phone: WhatsApp → Settings → Linked devices → Link a device, then scan this code.",
  openElsewhere: "Open this link on a computer, tablet, or a second phone.",
} as const;

export interface SheetItem {
  title: string;
  body: string;
}

export function connectSheet(brand: Pick<BrandConfig, "name">) {
  const { name } = brand;
  const L = APP_LABELS;
  const path = `${TELEPHONY_PROVIDER_PATH.join(" → ")} → ${name}`;
  return {
    labels: L,
    need: [
      "The phone that has your business WhatsApp number on it, unlocked.",
      "Wi-Fi or mobile data on that phone.",
      "A computer, tablet or second phone to show the code on. A phone can't scan its own screen.",
      "About 2 minutes.",
    ],
    steps: [
      {
        title: `Open the ${name} page`,
        body: `In GoHighLevel, choose ${name} in the left menu of your sub-account. Or open the connect link your agency sent you. ${L.openElsewhere}`,
      },
      {
        title: `Click ${L.connect}`,
        body: `A QR code appears and the status reads ${L.waiting}.`,
      },
      {
        title: "Open WhatsApp on the phone",
        body: "Go to WhatsApp → Settings → Linked devices → Link a device.",
      },
      {
        title: "Scan the code",
        body: "Point the phone's camera at the code on the screen.",
      },
      {
        title: `Wait for ${L.connected}`,
        body: "It takes a few seconds. Once the status changes you're done.",
      },
    ] satisfies SheetItem[],
    after: [
      "Keep the phone switched on and online.",
      `If the phone goes offline, your messages wait for it for up to 24 hours and send once it's connected again. Anything older is reported to GoHighLevel as not sent. If the page says ${L.disconnected}, click ${L.reconnect}.`,
      "Don't log out of the linked device in WhatsApp → Settings → Linked devices. That disconnects your number.",
    ],
    problems: [
      {
        title: "The code expired",
        body: `Click ${L.freshCode} and scan the new one straight away.`,
      },
      {
        title: `It's stuck on ${L.waiting}`,
        body: `Refresh the page, then check the phone has Wi-Fi or mobile data. If it's still stuck, click ${L.freshCode}.`,
      },
      {
        title: `It says ${L.connected} but nothing sends`,
        body: `The Telephony Provider needs to be ${name}. In GoHighLevel, go to ${path} → Save. ${ALT_PATH_NOTE}`,
      },
      {
        title: "WhatsApp says too many linked devices",
        body: "On the phone, go to WhatsApp → Settings → Linked devices, open one you no longer use and log it out. Then connect again.",
      },
    ] satisfies SheetItem[],
    safety: [
      QR_WARNING,
      "If anyone you don't know asks you to scan a code, say no.",
    ],
    disclosure: `${name} links your number as a linked device, the way WhatsApp Web does. It is not the official WhatsApp Business API, and WhatsApp can restrict numbers. We pace sending to keep the risk down, but we can't remove it.`,
    notAffiliated: `${name} is not affiliated with or endorsed by Meta, WhatsApp or HighLevel.`,
  };
}

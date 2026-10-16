import type { BrandConfig } from "@/lib/brand-config";

export interface SalesCopy {
  hook: { heading: string; sub: string };
  steps: { title: string; body: string }[];
  keepWorkflows: { heading: string; body: string };
  safety: { title: string; body: string }[];
  ctaLabel: "Start 7-day free trial";
}

/** Sales page copy. The brand name is interpolated; prices live in PricingSummary. */
export function salesCopy(brand: BrandConfig): SalesCopy {
  const { name } = brand;
  return {
    hook: {
      heading: "Send WhatsApp from the GoHighLevel workflows you already have",
      sub: `${name} links your WhatsApp number to GoHighLevel. Your Send SMS actions go out on WhatsApp, and replies show up in Conversations.`,
    },
    steps: [
      {
        title: "Install the app",
        body: `Add ${name} to your GoHighLevel account from the install link. It takes a couple of minutes.`,
      },
      {
        title: "Set the Telephony Provider",
        body: `In the sub-account, choose ${name} as the Telephony Provider. Your workflows and conversations stay where they are.`,
      },
      {
        title: "Scan the QR code",
        body: `Open the ${name} page in the left menu and scan the code with the phone. The number shows as Connected when it is ready.`,
      },
    ],
    keepWorkflows: {
      heading: "Keep your workflows. Nothing to rebuild.",
      body: `Every Send SMS step, every conversation and every reply carries on as before. The only difference is that the message arrives on WhatsApp instead of as a text.`,
    },
    safety: [
      {
        title: "Paced sending",
        body: "Messages leave at a steady rate, spread out over the day, and each number has a daily cap. It will not send more than the cap in a day. Anything over the cap is reported back to GoHighLevel as not sent, and the number starts again the next day.",
      },
      {
        title: "Held while disconnected",
        body: "If a phone goes offline, its messages wait in the queue and go out when it reconnects. Nothing is dropped without telling you.",
      },
      {
        title: "STOP opt-outs",
        body: "When someone replies STOP, that contact is opted out and gets no more messages from that number.",
      },
    ],
    ctaLabel: "Start 7-day free trial",
  };
}

/**
 * The GoHighLevel comparison on /pricing (Ruling W33).
 *
 * Every figure here is HighLevel's own, published in its help centre and
 * checked on 16 October 2026. They are US dollars exactly as HighLevel prints
 * them: not converted, not rounded, not extended to a UK rate (the UK per-message
 * rate was not verifiable, so the copy says "Meta's rate for the recipient's
 * country"). The comparison makes no claim that either option is cheaper, and it
 * says what the native option has that we do not. This is the one website source
 * allowed to contain a literal currency amount (see site-copy.test.ts).
 */

import { VOLUME_FROM, standardPrice, volumePrice } from "@/lib/pricing";

export interface GhlSource {
  title: string;
  modified: string;
  href: string;
}

export const GHL_NATIVE = {
  monthlyPerSubAccount: "$10",
  perMessageExample: "$0.0263",
  perMessageExampleLabel: "per marketing message in the US",
  sources: [
    {
      title: "WhatsApp Pricing, Billing, and Rebilling Guide",
      modified: "22 September 2026",
      href: "https://help.gohighlevel.com/support/solutions/articles/155000001428-whatsapp-pricing-billing-and-rebilling-guide",
    },
    {
      title: "WhatsApp Platform Pricing & Feature Comparison",
      modified: "15 October 2026",
      href: "https://help.gohighlevel.com/support/solutions/articles/155000007602-whatsapp-platform-pricing-feature-comparison",
    },
  ] as GhlSource[],
  checkedOn: "16 October 2026",
};

export type SourcePart = string | { text: string; href: string };

const SOURCE_TAIL =
  "Prices are in US dollars as HighLevel publishes them; we haven't converted them, and they can change.";

/** The source line as text and links, so the page can link each article. */
export function sourceParts(): SourcePart[] {
  const [a, b] = GHL_NATIVE.sources;
  return [
    "Source: HighLevel help centre, ",
    { text: `"${a.title}"`, href: a.href },
    ` (last modified ${a.modified}) and `,
    { text: `"${b.title}"`, href: b.href },
    ` (last modified ${b.modified}), both checked on ${GHL_NATIVE.checkedOn}. ${SOURCE_TAIL}`,
  ];
}

export const COMPARISON = {
  heading: "Against GoHighLevel's own WhatsApp",
  intro:
    "GoHighLevel sells its own WhatsApp integration, built on the official API. It's the fair thing to compare us with, so here are their published numbers next to ours.",
  nativeHeading: "GoHighLevel's WhatsApp",
  native: [
    `${GHL_NATIVE.monthlyPerSubAccount} per sub-account, per month, paid to HighLevel.`,
    `Plus a charge for every delivered template message at Meta's rate for the recipient's country. HighLevel's own example is ${GHL_NATIVE.perMessageExample} ${GHL_NATIVE.perMessageExampleLabel}, and an agency can add its own mark-up.`,
    "The official WhatsApp Business API: Meta business verification, a verified badge if you qualify, and templates that Meta approves before they send.",
    "No phone to keep online.",
  ],
  sourceLine: sourceParts()
    .map((p) => (typeof p === "string" ? p : p.text))
    .join(""),
  closing:
    "If you send a lot of marketing templates, or you need the verified badge, their option may suit you better. If you want the workflows you already have on your own number with a simple per-number price, that's us.",
};

/** Our column. Prices come from src/lib/pricing.ts. */
export function ourColumn(currency: string): string[] {
  return [
    `${standardPrice(currency)} a month per number, or ${volumePrice(currency)} each once you connect ${VOLUME_FROM} or more.`,
    "No charge per message.",
    "Your own number, connected as a linked device.",
    "No verified badge and no template approval, because it isn't the official API.",
    "A ban risk, explained on the home page, that we can't remove.",
  ];
}

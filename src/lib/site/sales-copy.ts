import type { BrandConfig } from "@/lib/brand-config";
import { MID_FROM } from "@/lib/pricing";
import { OWN_RESULTS_AVERAGE } from "@/lib/site/proof";

export interface SalesCopy {
  heroH1: string;
  heroSub: string;
  ctaNote: string;
  setup: {
    heading: string;
    lead: string;
    steps: { title: string; body: string; path?: string }[];
  };
  afterwards: { heading: string; body: string; caption: string };
  safetyHeading: string;
  /** Not rendered on the home page since Direction B (W37); kept for the tests and the docs. */
  safetyIntro: string;
  safety: { title: string; body: string }[];
  /** "Why use us": the reasons to pick this over the alternatives, said plainly. */
  reasons: { heading: string; items: { title: string; body: string; footnote?: true }[] };
  faqHeading: string;
  faqAllLink: string;
  priceStrip: { terms: string };
  ctaLabel: "Start 7-day free trial";
}

/** Home page copy, in the first person plural (Ruling W29). The brand name is interpolated; prices live in PricingSummary. */
export function salesCopy(brand: BrandConfig): SalesCopy {
  const { name } = brand;
  return {
    heroH1: "Two-way WhatsApp chat in GoHighLevel, from your own number.",
    heroSub: `Set ${name} as the Telephony Provider and the Send SMS steps you already have go out on WhatsApp. When the customer writes back, the reply lands in Conversations.`,
    ctaNote:
      "7-day free trial, no card needed. The trial covers up to 3 sub-accounts, and if it ends before you add a card, sending pauses until you do.",
    setup: {
      heading: "How you set it up",
      lead: "About ten minutes. The setup guide walks through every screen.",
      steps: [
        {
          title: "Install the app",
          body: `Add ${name} to your GoHighLevel account from the install link. An agency installs once and picks the sub-accounts; a single business installs on its own sub-account.`,
        },
        {
          title: "Set the Telephony Provider",
          body: `In the sub-account, open the path below, choose ${name} as the provider and save. This is the step people miss, and until it's done a connected number sends nothing.`,
          path: "Settings → Phone System → Advanced Settings → Telephony Provider",
        },
        {
          title: "Scan the QR code",
          body: `Open the ${name} page in the left menu, click Connect WhatsApp and scan the code with the phone, the same way you'd link WhatsApp Web. When the status says Connected, you're sending.`,
        },
      ],
    },
    afterwards: {
      heading: "What you look at afterwards",
      body: "The dashboard lists every sub-account with its WhatsApp status, how many messages it has sent today against its daily cap, and anything that needs you: a phone that has dropped off, or a number that's connected but hasn't had a message from GoHighLevel yet, which almost always means the Telephony Provider isn't set.",
      caption: "Sample screen, sample businesses.",
    },
    safetyHeading: "How it treats your number",
    safetyIntro: "Three things happen on every number, and none of them can be switched off.",
    safety: [
      {
        title: "Paced sending",
        body: "Messages leave at a steady rate through the day, and each number has a daily cap. Anything over the cap is reported back to GoHighLevel as not sent, and the number starts again at midnight UTC.",
      },
      {
        title: "Held while disconnected",
        body: "If a phone is offline, messages wait for up to 24 hours and go out when it reconnects; anything older is reported back to GoHighLevel as not sent. The dashboard shows how many are waiting.",
      },
      {
        title: "STOP opt-outs",
        body: "If someone replies STOP, they get no more messages from that sub-account's WhatsApp numbers until they reply START. Other sub-accounts aren't affected.",
      },
    ],
    reasons: {
      heading: `Why use ${name}`,
      items: [
        {
          title: "Nothing to rebuild",
          body: "Your workflows, triggers and Send SMS steps stay exactly as they are. Change one setting and they go out on WhatsApp, with no template approval to wait for.",
        },
        {
          title: "Your own number",
          body: "Customers see the business number they already have saved, not a new one. Neither Meta nor we charge per message, so a busy month costs the same as a quiet one.",
        },
        {
          title: "Replies stay in GoHighLevel",
          body: "When someone writes back, it lands in Conversations next to their contact record, where your team already works. Nobody has to watch a phone.",
        },
        {
          title: "Made for agencies",
          body: `One dashboard shows every sub-account and its numbers. From ${MID_FROM} sub-accounts every sub-account drops to the lower price, and you set what your clients pay.`,
        },
        {
          title: "Careful with your number",
          body: "Paced sending, a daily cap, messages held while a phone is offline and STOP opt-outs are on every number, and none of them can be switched off.",
        },
        {
          title: "We run reminders ourselves",
          body: `WhatsApp reminders took the businesses we run them for from about half of booked clients turning up to ${OWN_RESULTS_AVERAGE.after}. We built this to do the same job inside GoHighLevel.`,
          footnote: true,
        },
      ],
    },
    faqHeading: "Questions we get",
    faqAllLink: "All the questions, on one page",
    priceStrip: {
      terms:
        "7-day free trial, no card needed. The trial covers up to 3 sub-accounts, and you can cancel any time from the billing portal.",
    },
    ctaLabel: "Start 7-day free trial",
  };
}

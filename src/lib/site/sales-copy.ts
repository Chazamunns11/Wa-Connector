import type { BrandConfig } from "@/lib/brand-config";

export interface SalesCopy {
  heroSub: string;
  ctaNote: string;
  why: { heading: string; paragraphs: [string, string] };
  setup: {
    heading: string;
    lead: string;
    steps: { title: string; body: string }[];
    sampleCaption: string;
  };
  afterwards: { heading: string; body: string; caption: string };
  safetyHeading: string;
  safetyIntro: string;
  safety: { title: string; body: string }[];
  disclosure: { heading: string; paragraphs: [string, string, string] };
  faqHeading: string;
  faqAllLink: string;
  priceStrip: { terms: string };
  ctaLabel: "Start 7-day free trial";
}

/** Home page copy, in the first person plural (Ruling W29). The brand name is interpolated; prices live in PricingSummary. */
export function salesCopy(brand: BrandConfig): SalesCopy {
  const { name } = brand;
  return {
    heroSub: `${name} takes the reminders your GoHighLevel workflows already send and puts them on WhatsApp, from your own number. Replies come back into Conversations.`,
    ctaNote:
      "We take a card up front. The trial covers up to 3 numbers, and you can cancel from the billing portal whenever you like.",
    why: {
      heading: "Why we made it",
      paragraphs: [
        "We look after appointment reminders for a few small businesses. Texts sat there. The same reminder on WhatsApp got a reply, and the person turned up. The trouble was that everything we'd built lived in GoHighLevel workflows as Send SMS steps, and nobody wanted to rebuild them.",
        `So we built the thing we wanted. Pick ${name} as the Telephony Provider, scan a QR code with the phone, and the workflows you already have go out on WhatsApp. Nothing gets rebuilt, and replies land in Conversations like they always did.`,
      ],
    },
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
          body: `In the sub-account, go to Settings → Phone System → Advanced Settings → Telephony Provider, choose ${name} and save. This is the step people miss, and until it's done a connected number sends nothing.`,
        },
        {
          title: "Scan the QR code",
          body: `Open the ${name} page in the left menu, click Connect WhatsApp and scan the code with the phone, the same way you'd link WhatsApp Web. When the status says Connected, you're sending.`,
        },
      ],
      sampleCaption: "Sample screen: the connect page inside GoHighLevel.",
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
        body: "If the phone goes offline, that number's messages wait and go out when it reconnects. The dashboard shows how many are waiting.",
      },
      {
        title: "STOP opt-outs",
        body: "If someone replies STOP, they get no more messages from that number. Other numbers aren't affected.",
      },
    ],
    disclosure: {
      heading: "Read this before you sign up",
      paragraphs: [
        `${name} works as a linked device on your WhatsApp number, the same mechanism WhatsApp Web uses. It is not the official WhatsApp Business API. You don't get the verified badge or Meta's template approval, Meta doesn't charge you per message, and the phone that holds the number has to stay switched on and online.`,
        "WhatsApp can restrict or ban any number it decides is misusing the service, and automated sending through a linked device is the kind of thing it looks at. The pacing, the daily cap and STOP handling lower that risk. They cannot remove it, and we can't promise a number will never be restricted.",
        "Use a dedicated business number rather than your personal one, and only message people who expect to hear from you. If you need the official API, this isn't it, and we'd rather say so now.",
      ],
    },
    faqHeading: "Questions we get",
    faqAllLink: "All the questions, on one page",
    priceStrip: {
      terms:
        "The 7-day trial covers up to 3 numbers. We take a card up front, and you can cancel any time from the billing portal.",
    },
    ctaLabel: "Start 7-day free trial",
  };
}

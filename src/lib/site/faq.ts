import type { BrandConfig } from "@/lib/brand-config";
import { TRIAL_DAYS, TRIAL_MAX_NUMBERS, pricingConfig, tierSentence } from "@/lib/pricing";

export interface FaqEntry {
  id: string;
  question: string;
  answer: string;
  /** Optional follow-on link shown after the answer. */
  link?: { text: string; href: string };
}

export const FAQ_IDS = [
  "what-is-it",
  "workflows",
  "linked-device",
  "official-api",
  "ban-risk",
  "disconnected",
  "stop",
  "daily-cap",
  "trial",
  "cancel",
  "agency-or-single",
  "white-label",
] as const;

/** The entries the home page shows; the disclosure block there already says the other two uncomfortable ones. */
export const HOME_FAQ_IDS = ["workflows", "disconnected", "daily-cap", "trial", "cancel", "agency-or-single", "white-label"] as const;

type FaqId = (typeof FAQ_IDS)[number];

/** The honest FAQ, in FAQ_IDS order. The brand name and prices are interpolated. */
export function faqEntries(brand: BrandConfig): FaqEntry[] {
  const { name } = brand;
  const tiers = tierSentence(pricingConfig().currency);
  const copy: Record<FaqId, Omit<FaqEntry, "id">> = {
    "what-is-it": {
      question: `What is ${name}?`,
      answer: `An app for GoHighLevel that sends your messages on WhatsApp. You link a WhatsApp number by scanning a QR code, choose ${name} as the Telephony Provider, and the Send SMS steps in your workflows go out on WhatsApp instead. Replies land in Conversations.`,
    },
    workflows: {
      question: "Do I have to rebuild my workflows?",
      answer:
        "No. Your workflows, templates and conversations stay exactly as they are. Once the Telephony Provider is set, the Send SMS steps you already have deliver on WhatsApp.",
    },
    "linked-device": {
      question: "How does it connect to my number?",
      answer: `You scan a QR code with the phone, the same way you'd link WhatsApp Web, and ${name} then acts as a linked device on that number. The phone has to stay switched on and online.`,
    },
    "official-api": {
      question: "Is this the official WhatsApp Business API?",
      answer: `No. ${name} uses WhatsApp's linked-device mechanism, the one WhatsApp Web uses, not the official WhatsApp Business API. You don't get the verified badge or Meta's template approval, Meta doesn't charge you per message, and the phone with the number must stay online. If you need the official API, this is not it.`,
    },
    "ban-risk": {
      question: "Can my number get banned?",
      answer:
        "Yes. WhatsApp can restrict or ban a number it thinks is misusing the service, and automated sending from a linked device is on its list. Pacing, the daily cap and STOP handling lower the risk, but they cannot remove it, and we can't promise a number will never be restricted. Use a dedicated business number rather than your personal one, and only message people who expect to hear from you.",
    },
    disconnected: {
      question: "What happens if the phone goes offline?",
      answer:
        "If a phone is offline, messages wait for up to 24 hours and go out at the usual paced rate once it reconnects; anything older is reported back to GoHighLevel as not sent. The dashboard shows which numbers are disconnected and how many messages are waiting. Picture and file messages aren't held while a phone is offline.",
    },
    stop: {
      question: "What if someone replies STOP?",
      answer: "They're opted out and get no more messages from that number. A message already in the sending queue at that moment can still go out; nothing after it does.",
    },
    "daily-cap": {
      question: "What is the daily cap?",
      answer:
        "Each number can only send so many messages in a day, and they go out at a steady pace rather than in a burst. Once a number hits its cap, the rest of that day's messages are reported back to GoHighLevel as not sent, and the number starts again at midnight (UTC). The cap is there to protect the number, so it isn't something you can switch off.",
    },
    trial: {
      question: "How does the free trial work?",
      answer: `You get ${TRIAL_DAYS} days free with up to ${TRIAL_MAX_NUMBERS} numbers. We take a card up front and charge nothing until the trial ends. After that it's ${tiers}`,
    },
    cancel: {
      question: "Can I cancel, and what happens if a payment fails?",
      answer:
        "You can cancel whenever you like from the billing portal, and it takes effect at the end of the period you've paid for. If a payment fails, sending carries on while Stripe retries it. If the subscription ends unpaid, sending pauses until you pay.",
    },
    "agency-or-single": {
      question: "Is it for agencies or a single business?",
      answer:
        "Both. A single business connects one or more numbers to its own account; an agency connects numbers across its sub-accounts. Either way you pay per number. If you resell it to your own clients, you set your price and can work out what you would keep.",
      link: { text: "Try the resale calculator", href: "/pricing#resale" },
    },
    "white-label": {
      question: "Does it work on a white-labelled GoHighLevel account?",
      answer: `It depends on the agency. Some switch off app installs on white-label accounts. If the install link is blocked, ask your agency to allow ${name} for your sub-account. The setup guide has the wording to send them.`,
    },
  };
  return FAQ_IDS.map((id) => ({ id, ...copy[id] }));
}

import type { BrandConfig } from "@/lib/brand-config";
import { TRIAL_DAYS, TRIAL_MAX_NUMBERS, pricingConfig, priceLine } from "@/lib/pricing";

export interface FaqEntry {
  id: string;
  question: string;
  answer: string;
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

type FaqId = (typeof FAQ_IDS)[number];

/** The honest FAQ, in FAQ_IDS order. The brand name and prices are interpolated. */
export function faqEntries(brand: BrandConfig): FaqEntry[] {
  const { name } = brand;
  const one = priceLine(1, pricingConfig());
  const copy: Record<FaqId, { question: string; answer: string }> = {
    "what-is-it": {
      question: `What is ${name}?`,
      answer: `${name} is an app for GoHighLevel that sends your messages on WhatsApp. You link a WhatsApp number by scanning a QR code, pick ${name} as the Telephony Provider, and your Send SMS actions go out on WhatsApp. Replies land in Conversations.`,
    },
    workflows: {
      question: "Do I have to rebuild my workflows?",
      answer:
        "No. Your existing workflows, templates and conversations stay as they are. Once the Telephony Provider is set, the Send SMS steps you already use deliver on WhatsApp.",
    },
    "linked-device": {
      question: "How does it connect to my number?",
      answer: `You scan a QR code with the phone, the same way you would link WhatsApp Web. ${name} then works as a linked device on that number. The phone has to stay switched on and online.`,
    },
    "official-api": {
      question: "Is this the official WhatsApp Business API?",
      answer: `No. ${name} uses WhatsApp's linked-device mechanism (the one WhatsApp Web uses), not the official WhatsApp Business API. In practice you don't get the green tick or Meta's template approval, Meta doesn't charge you per conversation, and the phone with the number must stay online. If you need the official API, this is not it.`,
    },
    "ban-risk": {
      question: "Can my number get banned?",
      answer: `Yes, it can. WhatsApp can restrict or ban any number it decides is misusing the service, and automated messaging through a linked device is the kind of thing it looks at. ${name} lowers the risk with a daily cap on every number, paced sending and automatic STOP handling, but it cannot remove the risk and we can't promise a number will never be restricted. Use a dedicated business number rather than your personal one, and only message people who expect to hear from you.`,
    },
    disconnected: {
      question: "What happens if a phone goes offline?",
      answer:
        "Its messages are held. They wait in the queue and send when the phone reconnects. You can see which numbers are disconnected from your dashboard.",
    },
    stop: {
      question: "What if someone replies STOP?",
      answer:
        "That contact is opted out straight away and gets no more messages from that number.",
    },
    "daily-cap": {
      question: "What is the daily cap?",
      answer: `Each number has a limit on how many messages it sends in a day, and messages go out at a steady pace rather than all at once. Once a number reaches its daily cap, further messages that day are reported back to GoHighLevel as not sent. The number starts again at midnight (UTC). This is there to protect your number, so it is not something you switch off.`,
    },
    trial: {
      question: "How does the free trial work?",
      answer: `You get ${TRIAL_DAYS} days free with up to ${TRIAL_MAX_NUMBERS} numbers. We take your card up front and charge nothing until the trial ends. After that you pay per number: ${one}.`,
    },
    cancel: {
      question: "Can I cancel, and what if a payment fails?",
      answer:
        "You can cancel at any time from the billing portal. If a payment fails, sending continues while the payment is retried. If the subscription ends unpaid, sending pauses.",
    },
    "agency-or-single": {
      question: "Is it for agencies or a single business?",
      answer: `Both. A single business connects one or more numbers to its own account. An agency can connect numbers across its sub-accounts. You pay per number, so the cost follows how many you use.`,
    },
    "white-label": {
      question: "Does it work on a white-labelled GoHighLevel account?",
      answer: `It depends on the agency. Some block app installs on white-label accounts. If the install link is blocked, ask your agency to allow ${name} for your sub-account. The setup guide has the wording to send them.`,
    },
  };
  return FAQ_IDS.map((id) => ({ id, ...copy[id] }));
}

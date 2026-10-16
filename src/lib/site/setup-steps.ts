import type { BrandConfig } from "@/lib/brand-config";

export type Audience = "agency" | "business";
export const AUDIENCE_LABELS: Record<Audience, string> = {
  agency: "Agency owner",
  business: "Single sub-account",
};
export const AUDIENCES: readonly Audience[] = ["agency", "business"];

export const TELEPHONY_PROVIDER_PATH = ["Settings", "Phone System", "Advanced Settings", "Telephony Provider"] as const;

export type DiagramId = "install" | "menu" | "telephony" | "qr" | "connected" | "test-send" | "reply";

export interface SetupStep {
  id: DiagramId;
  title: string;
  summary: string;
  detail: Record<Audience, string[]>;
  diagram: DiagramId;
}

export const SETUP_STEP_IDS: readonly DiagramId[] = [
  "install",
  "menu",
  "telephony",
  "qr",
  "connected",
  "test-send",
  "reply",
];

/** The warning the connection panel shows before anyone scans (kept in step with the app). */
export const QR_WARNING =
  "Only scan the code yourself, on your own business phone. Whoever scans it can read and send messages as your business, so treat it like a password.";

export const ALT_PATH_NOTE =
  "Some accounts label this Settings → Phone Numbers → Advanced Settings → SMS Provider. It is the same setting.";

const NOT_ACTIVE =
  "If the page says \"WhatsApp isn't active for this sub-account\", activate it from your dashboard, or ask your account owner to.";
const TRIAL_FIRST =
  "If it offers \"Start your 7-day free trial\", follow that first. The sub-account is installed but not yet on an account.";

/** The seven setup steps, in SETUP_STEP_IDS order, with the brand name filled in. */
export function setupSteps(brand: BrandConfig): SetupStep[] {
  const { name } = brand;
  const path = `${TELEPHONY_PROVIDER_PATH.join(" → ")} → ${name} → Save`;
  const copy: Record<DiagramId, Omit<SetupStep, "id" | "diagram">> = {
    install: {
      title: `Install ${name}`,
      summary: `Add ${name} to your GoHighLevel account. This is a one-off.`,
      detail: {
        agency: [
          `Open the ${name} install link, or find ${name} in the Marketplace.`,
          "Install it at agency level, then choose the sub-accounts that should get it.",
          "Steps 2 to 6 are per sub-account, so you repeat them for each number you connect.",
        ],
        business: [
          `Open the ${name} install link, or find ${name} in the Marketplace.`,
          "Install it on your one sub-account and approve the permissions it asks for.",
          `If the install is blocked, your agency has switched off app installs. See "My agency blocks the install" below.`,
        ],
      },
    },
    menu: {
      title: `Open the ${name} page`,
      summary: `The ${name} page lives in the left menu of the sub-account.`,
      detail: {
        agency: [
          `Switch into a sub-account (Sub-Account view) and choose ${name} in the left menu.`,
          "The page does not work from Agency view, because there is no active sub-account to connect.",
          NOT_ACTIVE,
        ],
        business: [`In your sub-account, choose ${name} in the left menu.`, TRIAL_FIRST, NOT_ACTIVE],
      },
    },
    telephony: {
      title: "Set the Telephony Provider",
      summary: `This is the step people miss. It tells GoHighLevel to send its text messages through ${name}.`,
      detail: {
        agency: [
          `In the sub-account, go to ${path}.`,
          `Do this in every sub-account you connect. Until it is set, a connected number will not send anything.`,
          ALT_PATH_NOTE,
        ],
        business: [
          `In your sub-account, go to ${path}.`,
          "Until it is set, a connected number will not send anything.",
          ALT_PATH_NOTE,
        ],
      },
    },
    qr: {
      title: "Scan the QR code",
      summary: "Link the WhatsApp number the same way you would link WhatsApp Web.",
      detail: {
        agency: [
          `On the ${name} page, click Connect WhatsApp. A QR code appears.`,
          NOT_ACTIVE,
          "On your phone: WhatsApp → Settings → Linked devices → Link a device, then scan this code.",
          QR_WARNING,
          "If the phone belongs to your client, they need to be the one holding it when you scan.",
        ],
        business: [
          `On the ${name} page, click Connect WhatsApp. A QR code appears.`,
          TRIAL_FIRST,
          NOT_ACTIVE,
          "On your phone: WhatsApp → Settings → Linked devices → Link a device, then scan this code.",
          QR_WARNING,
          "Use a dedicated business number if you can, and keep the phone switched on and online.",
        ],
      },
    },
    connected: {
      title: "Check it says Connected",
      summary: "The status at the top of the page changes once the scan works.",
      detail: {
        agency: ["The page shows Connected. If it still says Waiting for QR scan, click Get a new QR code and scan the new one."],
        business: ["The page shows Connected. If it still says Waiting for QR scan, click Get a new QR code and scan the new one."],
      },
    },
    "test-send": {
      title: "Send a test message",
      summary: "Use a workflow you already have, or a quick new one.",
      detail: {
        agency: [
          "Create a contact whose phone number is your own mobile. Use a different phone from the one you just linked.",
          "Run a workflow with a Send SMS step on that contact.",
          "Sending is paced, so give the first message a minute or two. It arrives on WhatsApp, and GoHighLevel marks it delivered.",
        ],
        business: [
          "Create a contact whose phone number is your own mobile. Use a different phone from the one you just linked.",
          "Run a workflow with a Send SMS step on that contact.",
          "Sending is paced, so give the first message a minute or two. It arrives on WhatsApp, and GoHighLevel marks it delivered.",
        ],
      },
    },
    reply: {
      title: "Reply and see it in Conversations",
      summary: "Replies come back into the same GoHighLevel conversation.",
      detail: {
        agency: ["Reply from that WhatsApp chat. The reply shows up in the contact's thread under Conversations."],
        business: ["Reply from that WhatsApp chat. The reply shows up in the contact's thread under Conversations."],
      },
    },
  };
  return SETUP_STEP_IDS.map((id) => ({ id, diagram: id, ...copy[id] }));
}

export const TROUBLESHOOTING_IDS = [
  "connected-not-sending",
  "qr-expired",
  "messages-waiting",
  "white-label-blocks-install",
  "linked-device-limit",
] as const;

export function troubleshooting(brand: BrandConfig): { id: string; title: string; body: string[] }[] {
  const { name } = brand;
  const path = `${TELEPHONY_PROVIDER_PATH.join(" → ")} → ${name} → Save`;
  return [
    {
      id: "connected-not-sending",
      title: "It says Connected but nothing sends",
      body: [
        `Check the Telephony Provider first: ${path}. If another provider is selected, GoHighLevel is still sending through that one.`,
        ALT_PATH_NOTE,
        "Then check that the contact has a phone number and that the workflow step is Send SMS.",
      ],
    },
    {
      id: "qr-expired",
      title: "The QR code expired",
      body: [
        `Codes only last a short while. On the ${name} page, click Get a new QR code and scan the new one straight away.`,
      ],
    },
    {
      id: "messages-waiting",
      title: "Messages are waiting and not going out",
      body: [
        "The phone has disconnected, usually because it is offline or WhatsApp was logged out on it. Messages for that number are held for up to 24 hours.",
        `Open the ${name} page. If it says Disconnected, click Reconnect (scan the QR again if one appears) and the held messages go out. Anything older than 24 hours is reported to GoHighLevel as not sent. Picture and file messages aren't held.`,
        "Messages over the number's daily cap are different. They are reported to GoHighLevel as not sent, and the number starts again at midnight UTC.",
      ],
    },
    {
      id: "white-label-blocks-install",
      title: "My agency blocks the install",
      body: [
        `Some white-labelled agencies switch off app installs. If that is you, ask your agency to allow ${name} for your sub-account. You can send them this: "Please allow ${name} as an app on my sub-account so I can install it."`,
        `If the install works but the ${name} page shows blank inside a white-labelled account, get in touch and tell us your agency's white-label address. We may need to allow it.`,
      ],
    },
    {
      id: "linked-device-limit",
      title: "WhatsApp says the number has too many linked devices",
      body: [
        "WhatsApp caps how many devices one number can have linked. On the phone, go to WhatsApp → Settings → Linked devices, open one you no longer use and log it out. Then connect again.",
      ],
    },
  ];
}

export const DRAFT_NOTICE =
  "Draft — this page is a placeholder outline and will be replaced by the real legal text before launch.";

export const LEGAL_OUTLINE: Record<"terms" | "privacy", { title: string; headings: string[] }> = {
  terms: {
    title: "Terms of service",
    headings: [
      "Who we are",
      "The service",
      "Your account and billing",
      "Acceptable use",
      "WhatsApp's linked-device mechanism and restrictions",
      "Data we process",
      "Liability",
      "Changes",
      "Contact",
    ],
  },
  privacy: {
    title: "Privacy policy",
    headings: [
      "Who we are",
      "What we collect",
      "Why we process it",
      "Message content (we act as a processor)",
      "Retention",
      "Sub-processors",
      "Your rights (UK GDPR)",
      "Contact",
    ],
  },
};

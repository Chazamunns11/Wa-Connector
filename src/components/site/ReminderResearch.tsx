import { RESEARCH_FINDINGS } from "@/lib/site/proof";
import { brandConfig } from "@/lib/brand-config";

/**
 * One sourced line (Ruling W30). The figure pairs are the link text and come
 * from RESEARCH_FINDINGS, so the line cannot drift from the cited papers.
 */
export function ReminderResearch() {
  const { name } = brandConfig();
  const [clinic, hospital] = RESEARCH_FINDINGS;
  const link = (f: (typeof RESEARCH_FINDINGS)[number]) => (
    <a href={f.href} rel="noopener" className="font-semibold text-accent-text underline underline-offset-2">
      {f.from} to {f.to}
    </a>
  );
  return (
    <p className="max-w-[44ch] text-[0.9375rem] leading-[1.5]">
      Outside our own numbers, two published trials found the same direction: a children&apos;s clinic went from {link(clinic)} of
      appointments missed when a text reminder was added, and a hospital went from {link(hospital)} across about 160,000
      appointments by rewording its reminder. Both studies used SMS reminders. {name} sends the same kind of reminder on
      WhatsApp instead, from your own number, and replies land back in Conversations.
    </p>
  );
}

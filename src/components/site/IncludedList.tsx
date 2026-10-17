import { NUMBERS_INCLUDED, TRIAL_DAYS, TRIAL_MAX_SUB_ACCOUNTS } from "@/lib/pricing";
import type { BrandConfig } from "@/lib/brand-config";
import { FEATURES, featureEntries } from "@/lib/site/features";

/** "What's included" on /pricing: one ruled list, fed by the same feature entries as the home page. */
export function IncludedList({ brand }: { brand: BrandConfig }) {
  const parts = [
    "two-way chat",
    "the dashboard and connect links",
    "paced sending with a daily cap",
    "a 24-hour hold while a phone is offline",
    "STOP opt-outs per sub-account",
    ...(FEATURES.dndSyncLive ? ["Do Not Disturb sync"] : []),
    ...(FEATURES.mediaLive ? ["pictures and files"] : []),
  ];
  const soon = featureEntries(brand).some((f) => f.soon);
  const list = `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
  const items: { title: string; body: string }[] = [
    {
      title: "Every feature on every plan",
      body: `${list[0].toUpperCase()}${list.slice(1)}.${soon ? " WhatsApp groups are coming soon, at no extra charge." : " WhatsApp groups too, at no extra charge."}`,
    },
    { title: "No setup fee and no charge per message", body: `${brand.name} bills per activated sub-account, with up to ${NUMBERS_INCLUDED} WhatsApp numbers included, and nothing else.` },
    {
      title: `A ${TRIAL_DAYS}-day free trial`,
      body: `No card needed. It covers up to ${TRIAL_MAX_SUB_ACCOUNTS} sub-accounts. If the trial ends before you add a card, sending pauses until you do.`,
    },
    {
      title: "Billed monthly per active sub-account",
      body: "Cancel any time from the billing portal. It takes effect at the end of the period you've paid for.",
    },
  ];
  return (
    <div>
      <h3 className="h-item font-display">What&apos;s included</h3>
      <ul role="list" className="mt-4 list-none p-0">
        {items.map((i) => (
          <li key={i.title} className="border-t-2 border-rule py-3.5">
            <b className="block font-semibold">{i.title}</b>
            <span className="block max-w-[62ch] pt-1">{i.body}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

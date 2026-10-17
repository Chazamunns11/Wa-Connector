import type { BrandConfig } from "@/lib/brand-config";
import { salesCopy } from "@/lib/site/sales-copy";

export interface FeatureFlags {
  groupsLive: boolean;
  dndSyncLive: boolean;
  mediaLive: boolean;
}

export const FEATURES: FeatureFlags = {
  /** WhatsApp group creation is built on a separate branch. False ships the "Coming soon" entry. */
  groupsLive: false,
  /** GHL_SYNC_DND is a deployment switch: confirm it is on in production before go-live, or set this to false. */
  dndSyncLive: true,
  /** WA_MEDIA_OUTBOUND_ENABLED on the portal and the bridge: confirm both before go-live, or set this to false. */
  mediaLive: true,
};

export interface Feature {
  id: string;
  title: string;
  body: string;
  soon?: boolean;
  visual?: "reply" | "dashboard" | "group";
}

/**
 * The groups wording is copied from the groups branch (claude/pingwren-groups,
 * src/lib/site/groups-copy.ts @210302c) and follows Ruling W47: groups are made and run
 * from the dashboard, replies stay on the phone and do not reach GoHighLevel, people whose
 * privacy settings block adding get the invite link by message, and it costs nothing extra.
 * Re-read it against that file before flipping `groupsLive`.
 */
const GROUPS_BODY =
  "Create a WhatsApp group from your own number, add people from your GoHighLevel contacts, share the invite link and post updates, all from your dashboard. Anyone whose privacy settings block adds gets the invite link by message instead. Replies in a group stay in WhatsApp on the phone; they don't appear in GoHighLevel. Included with every connected number, at no extra charge.";

export function featureEntriesFor(flags: FeatureFlags, brand: BrandConfig): Feature[] {
  const [paced, held, stop] = salesCopy(brand).safety;
  const groups: Feature = flags.groupsLive
    ? { id: "groups", title: "WhatsApp groups", body: GROUPS_BODY, visual: "group" }
    : {
        id: "groups",
        title: "WhatsApp groups",
        body: `${GROUPS_BODY} We're building it now.`,
        soon: true,
      };
  const entries: Feature[] = [
    {
      id: "chat",
      title: "Two-way chat inside GoHighLevel",
      body: "Your workflow messages go out on WhatsApp from your own number. When someone writes back, the reply lands in Conversations against their contact, where your team already works.",
      visual: "reply",
    },
    {
      id: "dashboard",
      title: "Every client's WhatsApp on one screen",
      body: "An agency sees each sub-account's number, whether its phone is connected, and how much it has sent today against its daily cap. When a client needs to scan the code themselves, send them a connect link from their row and they do it on their own phone.",
      visual: "dashboard",
    },
    { id: "pacing", title: "Paced sending and a daily cap", body: paced.body },
    { id: "held", title: "Held while the phone is offline", body: held.body },
    { id: "stop", title: "STOP opt-outs, per sub-account", body: stop.body },
  ];
  if (flags.dndSyncLive) {
    entries.push({
      id: "dnd",
      title: "Do Not Disturb, kept in step",
      body: "If you'd like, a STOP also switches on Do Not Disturb for WhatsApp and SMS on that contact in GoHighLevel, so nothing else messages them by the same routes.",
    });
  }
  if (flags.mediaLive) {
    entries.push({
      id: "media",
      title: "Pictures and files",
      body: "A workflow step that attaches an image or a PDF sends it on WhatsApp as a picture or a file, with the text alongside. Attachments are held while a phone is offline, the same as text.",
    });
  }
  if (flags.groupsLive) entries.splice(1, 0, groups);
  else entries.push(groups);
  return entries;
}

export function featureEntries(brand: BrandConfig): Feature[] {
  return featureEntriesFor(FEATURES, brand);
}

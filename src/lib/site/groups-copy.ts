export const GROUPS_FEATURE = {
  title: "WhatsApp groups",
  comingSoonBadge: "Coming soon",
  summary:
    "Create a WhatsApp group from your own number, add people from your GoHighLevel contacts, share the invite link and post updates, all from your dashboard.",
  points: [
    "Groups are created from the number you've connected, so you stay the admin on your own phone.",
    "Add people by searching your GoHighLevel contacts, picking a tag, or pasting numbers. Anyone whose privacy settings block adds gets the invite link by message instead.",
    "Posts to a group go out with the same pacing and daily limit as your other messages, and people who reply STOP are never added.",
  ],
  honest: "Replies in a group stay in WhatsApp on the phone; they don't appear in GoHighLevel.",
  included: "Included with every connected number. No extra charge.",
} as const;

/** `live` mirrors FEATURES.groupsLive (FEATURES_GROUPS_LIVE), read by the site branch. */
export function groupsFeatureCopy(live: boolean): { badge: string | null } & typeof GROUPS_FEATURE {
  return { ...GROUPS_FEATURE, badge: live ? null : GROUPS_FEATURE.comingSoonBadge };
}

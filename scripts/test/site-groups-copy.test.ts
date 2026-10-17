import { test } from "node:test";
import assert from "node:assert/strict";
import { GROUPS_FEATURE, groupsFeatureCopy } from "@/lib/site/groups-copy";

function allText(): string {
  const c = GROUPS_FEATURE;
  return [c.title, c.comingSoonBadge, c.summary, ...c.points, c.honest, c.included].join("\n");
}

test("groups copy names GoHighLevel and the invite link fallback", () => {
  const t = allText();
  assert.match(t, /GoHighLevel/);
  assert.match(t, /invite link/);
  assert.doesNotMatch(t, /\bGHL\b/);
});

test("groups copy makes no overclaims", () => {
  const t = allText().toLowerCase();
  for (const word of ["unlimited", "instantly", "broadcast", "bulk", "replies in gohighlevel", "fitclosers", "official", "whatsapp business"]) {
    assert.ok(!t.includes(word), `copy must not contain "${word}"`);
  }
});

test("groups copy states the v1 limits plainly", () => {
  assert.match(GROUPS_FEATURE.honest, /phone/);
  assert.match(GROUPS_FEATURE.honest, /don't appear in GoHighLevel/);
  assert.match(GROUPS_FEATURE.included, /No extra charge/);
  assert.doesNotMatch(allText(), /—/);
});

test("badge shows while not live and clears when live", () => {
  assert.equal(groupsFeatureCopy(false).badge, "Coming soon");
  assert.equal(groupsFeatureCopy(true).badge, null);
  assert.equal(groupsFeatureCopy(true).title, "WhatsApp groups");
  assert.deepEqual(groupsFeatureCopy(true).points, GROUPS_FEATURE.points);
});

import test from "node:test";
import assert from "node:assert/strict";

import { brandedEmailHtml, emailLogoUrl } from "@/lib/email-html";
import { inkFor } from "@/lib/brand";

const brand = {
  name: "PingWren",
  tagline: "WhatsApp for GoHighLevel",
  logoPath: "/brand/pingwren-logo.svg",
  accent: "#FF5A36",
  appUrl: "https://app.test",
};

test("the PingWren logo goes out as its PNG twin (email clients don't show SVG), as an absolute URL", () => {
  assert.equal(emailLogoUrl(brand), "https://app.test/brand/pingwren-logo@3x.png");
  assert.equal(emailLogoUrl({ ...brand, logoPath: "https://cdn.test/l.png" }), "https://cdn.test/l.png");
  assert.equal(emailLogoUrl({ ...brand, logoPath: "/custom.svg" }), null);
});

test("branded HTML: logo, Coral button with Ink text, paragraphs, footer; the action URL becomes the button", () => {
  const html = brandedEmailHtml(
    {
      subject: "Nothing is sending",
      text: "Hi,\n\nNothing is sending.\n\nhttps://app.test/dashboard/billing\n\nThe PingWren team",
      action: { label: "Update card and pay", url: "https://app.test/dashboard/billing" },
    },
    brand,
  );
  assert.match(html, /<img src="https:\/\/app\.test\/brand\/pingwren-logo@3x\.png" alt="PingWren"/);
  assert.match(html, /background:#FF5A36/);
  // Dark ink on Coral, exactly as the site's own buttons (inkFor); never white on Coral.
  assert.ok(html.includes(`color:${inkFor("#FF5A36")};text-decoration:none;border-radius:8px">Update card and pay</a>`));
  assert.notEqual(inkFor("#FF5A36").toUpperCase(), "#FFFFFF");
  assert.equal(html.match(/Update card and pay/g)?.length, 1);
  assert.match(html, /Nothing is sending\.<\/p>/);
  assert.match(html, /PingWren · WhatsApp for GoHighLevel/);
});

test("text is escaped and other URLs become links", () => {
  const html = brandedEmailHtml({ subject: "s", text: "<b>x</b> & see https://app.test/a" }, brand);
  assert.match(html, /&lt;b&gt;x&lt;\/b&gt; &amp; see <a href="https:\/\/app\.test\/a"/);
  assert.ok(!html.includes("<b>x</b>"));
});

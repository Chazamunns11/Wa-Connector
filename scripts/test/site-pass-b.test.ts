import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const read = (p: string) => readFileSync(join(root, p), "utf8");
const DIR = "src/components/site/samples";
const css = () => read("src/app/globals.css");

/** Body of the first rule whose selector line is exactly `selector {`. */
function rule(text: string, selector: string): string {
  const i = text.indexOf(`\n${selector} {`);
  assert.ok(i >= 0, `${selector} rule exists`);
  return text.slice(i, text.indexOf("\n}", i));
}

test("B: .phone is a size container and every inner size is in cqw", () => {
  const c = css();
  assert.match(rule(c, ".phone"), /container-type:\s*inline-size/);
  assert.ok((c.match(/\d(\.\d+)?cqw/g) ?? []).length >= 20, "at least 20 cqw values");
  assert.match(rule(c, ".phone-status"), /padding-inline:\s*[\d.]+cqw/);
});

test("B: the phone type is the system UI stack, antialiased", () => {
  const r = rule(css(), ".phone");
  assert.match(r, /font-family:[^;]*system-ui/);
  assert.match(r, /-webkit-font-smoothing:\s*antialiased/);
});

test("B: PhoneFrame has a group variant, a subline, no presence word", () => {
  const f = read(`${DIR}/PhoneFrame.tsx`);
  assert.match(f, /variant === "group"|"group"/);
  assert.match(f, /phone-subline/);
  assert.ok(!/online/i.test(f), "no 'online'");
  assert.match(f, /10:24/);
  assert.match(f, /subline\?:/);
});

test("B: GroupChatSample is a labelled image about the Spring challenge, replies stay on the phone (W47)", () => {
  assert.ok(existsSync(join(root, DIR, "GroupChatSample.tsx")));
  const g = read(`${DIR}/GroupChatSample.tsx`);
  assert.match(g, /role="img"/);
  assert.match(g, /aria-label=/);
  assert.match(g, /Spring challenge/);
  assert.ok(!/Conversations/.test(g), "no claim that group replies reach Conversations");
  assert.ok(!/"use client"/.test(g));
});

test("B: no WhatsApp green or read-receipt blue in the phone files or css", () => {
  const all = ["PhoneFrame", "SameReminderTwice", "Ticks", "GroupChatSample"].map((n) => read(`${DIR}/${n}.tsx`)).join("\n") + css();
  assert.ok(!/#(25D366|128C7E|075E54|DCF8C6|D9FDD3|00A884|008069|34B7F1|53BDEB)/i.test(all));
});

test("B: the first phone's tilt is only applied from 601px up", () => {
  const c = css();
  const m = c.match(/@media \(min-width: 601px\)\s*\{[^@]*?\.phones > \.phone:nth-child\(1\)\s*\{[^}]*rotate\(-4deg\)/);
  assert.ok(m, "tilt sits inside a min-width: 601px block");
});

test("B: the hang is a clamp at 901px and a fixed 96px below, and .hang-pad matches", () => {
  const c = css();
  assert.match(c, /\.phones\s*\{[^}]*translate:\s*0 96px/);
  assert.match(c, /@media \(min-width: 901px\)\s*\{[^@]*\.phones\s*\{[^}]*translate:\s*0 clamp\(120px, 22vw, 280px\)/);
  assert.match(c, /\.hang-pad\s*\{[^}]*padding-top:\s*150px/);
  assert.match(c, /@media \(min-width: 901px\)\s*\{[^@]*\.hang-pad\s*\{[^}]*padding-top:\s*clamp\(150px, 22vw, 320px\)/);
});

test("B: the thread is bottom-anchored and the SMS thread keeps a visible No reply", () => {
  assert.match(rule(css(), ".phone-body"), /justify-content:\s*flex-end/);
  assert.match(read(`${DIR}/SameReminderTwice.tsx`), />\s*No reply\s*</);
});

test("B: Back in Conversations is a hairline-flanked system line, not a day chip", () => {
  const t = read(`${DIR}/SameReminderTwice.tsx`);
  assert.match(t, /phone-system/);
  assert.ok(!/day-chip[^>]*>\s*Back in Conversations/.test(t));
  assert.match(css(), /\.phone-system::before/);
});

test("B: reduced motion still stops the phones and hero animations", () => {
  const reduced = css().split("@media (prefers-reduced-motion: reduce)").slice(1).join("\n");
  for (const s of [".phones .phone", ".hero-bubble", ".hero-delivered", ".hero-late"]) assert.ok(reduced.includes(s), s);
});

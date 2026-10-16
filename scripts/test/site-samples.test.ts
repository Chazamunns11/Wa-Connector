import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const read = (p: string) => readFileSync(join(root, p), "utf8");
const DIR = "src/components/site/samples";
const REPLY_TEXT = "Yes, see you at 2";
const files = readdirSync(join(root, DIR)).filter((f) => f.endsWith(".tsx"));

// Task 13A: the built sample screens used on the home page and setup guide.
test("sample screens are server components, labelled, and free of green and ticks", () => {
  assert.ok(files.length >= 4, "PhoneFrame plus three samples");
  for (const f of files) {
    const text = read(`${DIR}/${f}`);
    assert.ok(!/"use client"/.test(text), `${f} must not ship client JS`);
    assert.ok(!/#25D366/i.test(text), `${f} uses WhatsApp green`);
    assert.ok(!/[✓✔]/.test(text), `${f} has tick glyphs`);
    if (f !== "PhoneFrame.tsx" && f !== "Ticks.tsx") {
      assert.match(text, /role="img"/, f);
      assert.match(text, /aria-label=/, f);
    }
  }
});

test("SameReminderTwice shows the same reminder on both phones", () => {
  const t = read(`${DIR}/SameReminderTwice.tsx`);
  const reminder = "Hi Sam, your appointment is at 2pm tomorrow. Reply YES to confirm.";
  assert.match(t, /const REMINDER =/);
  assert.equal((t.match(/(?<!\$)\{REMINDER\}/g) ?? []).length, 2, "rendered once per phone");
  assert.equal(t.split(reminder).length - 1, 1, "defined once");
  for (const s of ["Yesterday 14:02", "14:02", REPLY_TEXT]) {
    assert.ok(t.includes(s), s);
  }
  assert.ok(!t.includes("Sample messages"), "caption removed (W39)");
  assert.ok(!t.includes("Sam is made up"), "caption removed (W39)");
  assert.ok(!/<figcaption/.test(t), "no caption element");
  const label = t.match(/const LABEL = `([^`]*)`/)![1];
  assert.match(label, /no reply/);
  assert.match(label, /Delivered/);
  assert.match(label, /Back in Conversations|Conversations/);
  for (const c of ["hero-bubble", "hero-delivered", "hero-late"]) assert.ok(t.includes(c), c);
  assert.ok(!t.includes("hero-ping"), "the ping dot is replaced by the ticks");
});

test("ConnectPanelSample uses the app's strings and the guide's warning", () => {
  const t = read(`${DIR}/ConnectPanelSample.tsx`);
  assert.ok(t.includes("Waiting for QR scan"));
  assert.ok(t.includes("Get a new QR code"));
  assert.ok(t.includes("On your phone: WhatsApp → Settings → Linked devices → Link a device, then scan this code."));
  assert.match(t, /import \{[^}]*QR_WARNING[^}]*\} from "@\/lib\/site\/setup-steps"/);
  assert.match(t, /connectedStrip/);
  assert.ok(t.includes("+44 7700 900101"));
});

test("DashboardSample carries the preview dashboard's rows and wording", () => {
  const t = read(`${DIR}/DashboardSample.tsx`);
  for (const s of ["Harbour Street Physio", "Millbrook Vets", "Fernbank Dental", "Is the Telephony Provider set?", "4 waiting"]) {
    assert.ok(t.includes(s), s);
  }
  assert.ok(!/LocationTable/.test(t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")), "must not import the interactive table");
});

test("globals.css defines the Paper ground, rule token, section rule and phone", () => {
  const css = read("src/app/globals.css");
  // Task 14: Direction B. The last .surface-dark block carries the Coral rule.
  const darkBlocks = css.match(/\.surface-dark \{[^}]*\}/g) ?? [];
  assert.match(darkBlocks[darkBlocks.length - 1], /--color-rule:\s*#FF5A36/);
  const firstRoot = css.indexOf(":root {");
  const lastRoot = css.lastIndexOf(":root {");
  assert.ok(lastRoot > firstRoot, "later :root block appended");
  const second = css.slice(lastRoot, css.indexOf("}", lastRoot));
  assert.match(second, /--color-bg:\s*#FFFFFF/);
  assert.match(second, /--color-rule:\s*#1B1F2A/);
  assert.match(css, /\.section-rule/);
  assert.match(css, /\.phone\s*\{/);
  assert.match(css, /\.site-body/);
});

// Task 13B: the figure must read as phones, and the QR as a QR.
test("phone frame has a status bar and the QR is a dense deterministic grid", () => {
  const f = read(`${DIR}/PhoneFrame.tsx`);
  assert.match(f, /phone-status/);
  assert.match(f, /phone-home/);
  const c = read(`${DIR}/ConnectPanelSample.tsx`);
  assert.match(c, /FakeQr/);
  assert.ok(!/Math\.random|Date\.now/.test(c), "QR must be deterministic");
  assert.match(read(`${DIR}/SameReminderTwice.tsx`), /hero-delivered/);
});

// Task 15 (W39): realistic WhatsApp-style chat vs a plain text-message app.
test("W39 chat mock-up: wallpaper, tails, header with avatar, timestamps, grey double ticks, no green, no logo", () => {
  const frame = read(`${DIR}/PhoneFrame.tsx`);
  const twice = read(`${DIR}/SameReminderTwice.tsx`);
  const css = read("src/app/globals.css");
  assert.match(frame, /chat-wallpaper/);
  assert.match(frame, /phone-avatar/);
  assert.match(twice, /bubble-tail/);
  assert.match(twice, /<Ticks/);
  const ticks = read(`${DIR}/Ticks.tsx`);
  assert.match(ticks, /aria-hidden="true"/);
  assert.equal((ticks.match(/<path/g) ?? []).length, 2, "two tick strokes");
  for (const c of [".chat-wallpaper", ".bubble-tail", ".wa-ticks", ".day-chip"]) assert.ok(css.includes(c), c);
  assert.ok(!/phones-cap/.test(css), "caption style removed");
  assert.ok(!/hero-ping/.test(css), "ping style removed");
  const all = frame + twice + ticks + css;
  assert.ok(!/#(25D366|128C7E|075E54|DCF8C6|D9FDD3|00A884|008069|34B7F1|53BDEB)/i.test(all), "no WhatsApp green or read-receipt blue");
  const waTicks = css.match(/\.wa-ticks \{[^}]*\}/)![0];
  assert.match(waTicks, /color:\s*#[0-9A-Fa-f]{6}/);
  assert.ok(!/<image|<img/i.test(all));
});

test("tester fixes: SMS phone shows a visible 'No reply'; chat phone shows 'Back in Conversations'; walkthrough says Coral", () => {
  const twice = read(`${DIR}/SameReminderTwice.tsx`);
  const sms = twice.slice(twice.indexOf('variant="sms"'), twice.indexOf('variant="whatsapp"'));
  const chat = twice.slice(twice.indexOf('variant="whatsapp"'));
  assert.match(sms, />\s*No reply\s*</);
  assert.match(chat, />\s*Back in Conversations\s*</);
  const walk = read("scripts/site-walkthrough.cjs");
  assert.ok(!/standard on Cream/.test(walk));
  assert.match(walk, /standard on Coral/);
  const css = read("src/app/globals.css");
  const big = css.match(/\.hero-big \{[^}]*\}/)![0];
  const max = Number(big.match(/font-size:\s*clamp\([^,]+,[^,]+,\s*([\d.]+)rem\)/)![1]);
  assert.ok(max <= 16.25, `hero-big max ${max}rem keeps the + clear of the phone`);
});

test("W39 SMS phone is a plain messages app: centred contact, grey bubble, no ticks", () => {
  const twice = read(`${DIR}/SameReminderTwice.tsx`);
  const sms = twice.slice(twice.indexOf('variant="sms"'), twice.indexOf('variant="whatsapp"'));
  assert.ok(!/<Ticks/.test(sms));
  assert.ok(!/bubble-tail/.test(sms));
  assert.match(sms, /Text Message/);
});

test("DashboardSample's provider note is the string derive.ts prints", () => {
  const d = readFileSync(join(process.cwd(), "src/lib/account-data/derive.ts"), "utf8");
  const m = d.match(/"(No messages from [^"]+)"/);
  assert.ok(m);
  assert.ok(readFileSync(join(process.cwd(), "src/components/site/samples/DashboardSample.tsx"), "utf8").includes(m![1]));
});

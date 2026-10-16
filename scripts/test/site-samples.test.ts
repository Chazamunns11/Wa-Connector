import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const read = (p: string) => readFileSync(join(root, p), "utf8");
const DIR = "src/components/site/samples";
const files = readdirSync(join(root, DIR)).filter((f) => f.endsWith(".tsx"));

// Task 13A: the built sample screens used on the home page and setup guide.
test("sample screens are server components, labelled, and free of green and ticks", () => {
  assert.ok(files.length >= 4, "PhoneFrame plus three samples");
  for (const f of files) {
    const text = read(`${DIR}/${f}`);
    assert.ok(!/"use client"/.test(text), `${f} must not ship client JS`);
    assert.ok(!/#25D366/i.test(text), `${f} uses WhatsApp green`);
    assert.ok(!/[✓✔]/.test(text), `${f} has tick glyphs`);
    if (f !== "PhoneFrame.tsx") {
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
  for (const s of ["Yesterday 14:02", "Delivered", "Yes, see you at 2", "Back in Conversations", "Sample messages. Sam is made up."]) {
    assert.ok(t.includes(s), s);
  }
  const label = t.match(/const LABEL = `([^`]*)`/)![1];
  assert.match(label, /no reply/);
  assert.match(label, /Delivered/);
  for (const c of ["hero-bubble", "hero-ping", "hero-late"]) assert.ok(t.includes(c), c);
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
  const dark = (css.match(/\.surface-dark \{[^}]*\}/g) ?? []).join("\n");
  assert.match(dark, /--color-rule:\s*#D9A47A/);
  const firstRoot = css.indexOf(":root {");
  const secondRoot = css.indexOf(":root {", firstRoot + 1);
  assert.ok(secondRoot > firstRoot, "second :root block appended");
  const second = css.slice(secondRoot, css.indexOf("}", secondRoot));
  assert.match(second, /--color-bg:\s*#FFFFFF/);
  assert.match(second, /--color-rule:\s*#7A4E2D/);
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

test("DashboardSample's provider note is the string derive.ts prints", () => {
  const d = readFileSync(join(process.cwd(), "src/lib/account-data/derive.ts"), "utf8");
  const m = d.match(/"(No messages from [^"]+)"/);
  assert.ok(m);
  assert.ok(readFileSync(join(process.cwd(), "src/components/site/samples/DashboardSample.tsx"), "utf8").includes(m![1]));
});

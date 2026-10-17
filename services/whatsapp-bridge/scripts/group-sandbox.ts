/**
 * One-off sandbox test for group creation and management
 * (docs/superpowers/specs/2026-10-17-group-creation-and-management-design.md,
 * "Sandbox test"). Run it BY HAND against a spare test number — never a
 * client's number. It links a throwaway session by QR, tries each group call
 * the spec relies on, prints one PASS/FAIL line per step, then leaves the
 * group and deletes the session files.
 *
 *   cd services/whatsapp-bridge
 *   SANDBOX_MEMBER=+447700900001 SANDBOX_MEMBER_2=+447700900002 npx tsx scripts/group-sandbox.ts
 *
 * SANDBOX_MEMBER / SANDBOX_MEMBER_2: two other phones you control, in E.164.
 * The first should have messaged the test number before (the spec's
 * direct-add rule); the second is added with groupParticipantsUpdate.
 *
 * Needs Node 24 (like the bridge). The QR is drawn with the root app's
 * `qrcode` package, so run `npm install` at the repo root first.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import makeWASocket, { DisconnectReason, fetchLatestBaileysVersion, useMultiFileAuthState, type WASocket } from "@whiskeysockets/baileys";
import type { Boom } from "@hapi/boom";
import { pino } from "pino";

const rootRequire = createRequire(new URL("../../../package.json", import.meta.url));
const QRCode = rootRequire("qrcode") as { toString(text: string, opts: { type: "terminal"; small: boolean }): Promise<string> };

const E164 = /^\+[1-9]\d{6,14}$/;
const member = process.env.SANDBOX_MEMBER ?? "";
const member2 = process.env.SANDBOX_MEMBER_2 ?? "";
if (!E164.test(member) || !E164.test(member2)) {
  console.error("Set SANDBOX_MEMBER and SANDBOX_MEMBER_2 to two other phones you control, in E.164 (e.g. +447700900001).");
  process.exit(2);
}

const authDir = mkdtempSync(path.join(tmpdir(), "pingwren-group-sandbox-"));
const results: { step: string; ok: boolean; detail: string }[] = [];

function record(step: string, ok: boolean, detail = ""): void {
  results.push({ step, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${step}${detail ? ` — ${detail}` : ""}`);
}

function errText(err: unknown): string {
  const boom = err as Partial<Boom> & { message?: string };
  const code = boom?.output?.statusCode;
  return `${code ? `${code} ` : ""}${boom?.message ?? String(err)}`;
}

async function resolveJid(sock: WASocket, phone: string): Promise<string | null> {
  const found = await sock.onWhatsApp(phone);
  return found?.find((r) => r.exists)?.jid ?? null;
}

async function connect(): Promise<WASocket> {
  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: undefined as unknown as [number, number, number] }));
  return new Promise((resolve, reject) => {
    const sock = makeWASocket({ ...(version ? { version } : {}), auth: state, logger: pino({ level: "silent" }), syncFullHistory: false, markOnlineOnConnect: false });
    sock.ev.on("creds.update", saveCreds);
    sock.ev.on("connection.update", async ({ connection, qr, lastDisconnect }) => {
      if (qr) {
        console.log("\nScan with the TEST phone: WhatsApp > Linked devices > Link a device\n");
        console.log(await QRCode.toString(qr, { type: "terminal", small: true }));
      }
      if (connection === "open") resolve(sock);
      if (connection === "close") {
        const code = (lastDisconnect?.error as Boom | undefined)?.output?.statusCode;
        // After the first scan WhatsApp asks for a restart; reconnect once with the saved creds.
        if (code === DisconnectReason.restartRequired) connect().then(resolve, reject);
        else reject(new Error(`connection closed (${code ?? "unknown"})`));
      }
    });
  });
}

async function main(): Promise<void> {
  const sock = await connect();
  console.log(`\nLinked as ${sock.user?.id?.split(":")[0] ?? "unknown"}. Running steps…\n`);

  const memberJid = await resolveJid(sock, member);
  const member2Jid = await resolveJid(sock, member2);
  record("SANDBOX_MEMBER is on WhatsApp", memberJid !== null);
  record("SANDBOX_MEMBER_2 is on WhatsApp", member2Jid !== null);

  // Open question 1: can a group be created with nobody in it?
  let groupJid: string | null = null;
  try {
    const meta = await sock.groupCreate("PingWren sandbox (empty)", []);
    groupJid = meta.id;
    record("groupCreate with no participants", true, "WhatsApp allows empty creates");
  } catch (err) {
    record("groupCreate with no participants", false, errText(err));
  }

  if (!groupJid && memberJid) {
    try {
      const meta = await sock.groupCreate("PingWren sandbox", [memberJid]);
      groupJid = meta.id;
      record("groupCreate with one participant", true);
    } catch (err) {
      record("groupCreate with one participant", false, errText(err));
    }
  }
  if (!groupJid) {
    console.log("\nNo group could be created; stopping.");
    return;
  }

  const step = async (name: string, fn: () => Promise<unknown>) => {
    try {
      const out = await fn();
      record(name, true, out === undefined ? "" : JSON.stringify(out).slice(0, 160));
    } catch (err) {
      record(name, false, errText(err));
    }
  };

  await step("groupUpdateDescription", () => sock.groupUpdateDescription(groupJid!, "Sandbox test — safe to ignore"));
  if (member2Jid) await step("groupParticipantsUpdate add (second member)", () => sock.groupParticipantsUpdate(groupJid!, [member2Jid], "add"));
  if (memberJid) await step("groupParticipantsUpdate promote", () => sock.groupParticipantsUpdate(groupJid!, [memberJid], "promote"));
  await step("groupInviteCode", async () => `https://chat.whatsapp.com/${await sock.groupInviteCode(groupJid!)}`);
  await step("groupRevokeInvite", () => sock.groupRevokeInvite(groupJid!));
  await step("groupSettingUpdate announcement", () => sock.groupSettingUpdate(groupJid!, "announcement"));
  await step("groupJoinApprovalMode on", () => sock.groupJoinApprovalMode(groupJid!, "on"));
  await step("groupMetadata after changes", async () => {
    const meta = await sock.groupMetadata(groupJid!);
    return { size: meta.participants.length, announce: meta.announce, joinApproval: meta.joinApprovalMode };
  });
  if (member2Jid) await step("groupParticipantsUpdate remove (second member)", () => sock.groupParticipantsUpdate(groupJid!, [member2Jid], "remove"));
  await step("groupLeave", () => sock.groupLeave(groupJid!));
  await step("groupMetadata after leaving (expect an error)", () => sock.groupMetadata(groupJid!));

  await sock.logout().catch(() => undefined);
}

main()
  .catch((err) => record("sandbox run", false, errText(err)))
  .finally(() => {
    rmSync(authDir, { recursive: true, force: true });
    const failed = results.filter((r) => !r.ok).length;
    console.log(`\n${results.length - failed}/${results.length} steps passed. Session files deleted. Paste this output back to Claude.`);
    process.exit(0);
  });

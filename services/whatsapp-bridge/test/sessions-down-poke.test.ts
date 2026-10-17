/** The delayed down-poke (Task 6): a close pokes now and once more after 5 min 15 s; an open cancels it. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { clearDownPoke, DOWN_POKE_DELAY_MS, recordClosed, shutdownOneSession, type DownPokeSession } from "../src/sessions.js";
import { PendingWrites } from "../src/pending-writes.js";
import type { PortalPoke } from "../src/poke.js";

function fakePoke() {
  let count = 0;
  return { poke: { schedule: () => void count++ } as unknown as PortalPoke, count: () => count };
}
const makeSession = (status: DownPokeSession["status"] = "disconnected"): DownPokeSession => ({ status, downPokeTimer: null });

test("the delay is 5 minutes 15 seconds", () => {
  assert.equal(DOWN_POKE_DELAY_MS, 315_000);
});

test("close schedules one delayed poke; open cancels it", async () => {
  const { poke, count } = fakePoke();
  const session = makeSession();
  recordClosed(session, poke, 20);
  assert.equal(count(), 1, "immediate poke on close");
  assert.ok(session.downPokeTimer);
  clearDownPoke(session); // open
  assert.equal(session.downPokeTimer, null);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(count(), 1, "the cancelled timer never pokes");
});

test("the delayed poke fires once if the session is still not open", async () => {
  const { poke, count } = fakePoke();
  const session = makeSession();
  recordClosed(session, poke, 20);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(count(), 2);
  assert.equal(session.downPokeTimer, null);
});

test("the delayed poke is skipped when the session came back without clearing", async () => {
  const { poke, count } = fakePoke();
  const session = makeSession();
  recordClosed(session, poke, 20);
  session.status = "connected";
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(count(), 1);
});

test("a second close replaces the timer: still one delayed poke", async () => {
  const { poke, count } = fakePoke();
  const session = makeSession();
  recordClosed(session, poke, 20);
  recordClosed(session, poke, 20);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(count(), 3, "two immediate pokes + exactly one delayed");
});

test("the timer is unref'd and shutdown clears it", async () => {
  const { poke } = fakePoke();
  const session = { ...makeSession(), coachId: "t", stopping: false, sock: null, pendingWrites: new PendingWrites(), lock: { release: async () => {} } };
  recordClosed(session, poke, 10_000);
  assert.equal(session.downPokeTimer?.hasRef(), false);
  const quiet = { info() {}, warn() {}, error() {} } as never;
  await shutdownOneSession(session, { flushTimeoutMs: 50 }, quiet);
  assert.equal(session.downPokeTimer, null);
});

test("sessions.ts wires close -> recordClosed and open -> clearDownPoke", () => {
  const src = readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/sessions.ts"), "utf8");
  assert.match(src, /recordClosed\(session, this\.outboundPoke\)/);
  assert.match(src, /clearDownPoke\(session\);\s*recordReconnected\(this\.outboundPoke\)/);
});

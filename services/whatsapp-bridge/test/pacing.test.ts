/**
 * Pacing unit checks (hard rule 4) — injected clock and RNG, so real pacing
 * decisions are exercised with zero real waiting and zero live sends
 * (hard rule 6).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { SessionPacer } from "../src/pacing.js";

function fixedClock(startMs: number) {
  let now = startMs;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

const CONFIG = { minGapMs: 45_000, jitterMs: 30_000, dailyCap: 3 };
const T0 = Date.parse("2026-07-29T10:00:00.000Z");

test("first send is immediate; second waits out gap + jitter", () => {
  const clock = fixedClock(T0);
  const pacer = new SessionPacer(CONFIG, 0, clock.now, () => 0.5); // jitter = 15s
  assert.equal(pacer.msUntilNextSendAllowed(), 0);
  pacer.recordSend();
  assert.equal(pacer.msUntilNextSendAllowed(), 60_000); // 45s gap + 15s jitter
  clock.advance(60_000);
  assert.equal(pacer.msUntilNextSendAllowed(), 0);
});

test("jitter varies the wait — never a metronome", () => {
  const clock = fixedClock(T0);
  let roll = 0;
  const pacer = new SessionPacer(CONFIG, 0, clock.now, () => roll);
  pacer.recordSend();
  roll = 0;
  const min = pacer.msUntilNextSendAllowed();
  roll = 0.999;
  const max = pacer.msUntilNextSendAllowed();
  assert.equal(min, 45_000);
  assert.ok(max > min && max <= 75_000, `expected 45s < wait <= 75s, got ${max}`);
});

test("daily cap counts attempts and blocks at the limit", () => {
  const clock = fixedClock(T0);
  const pacer = new SessionPacer(CONFIG, 0, clock.now, () => 0);
  assert.equal(pacer.atDailyCap(), false);
  pacer.recordSend();
  pacer.recordSend();
  pacer.recordSend();
  assert.equal(pacer.atDailyCap(), true);
  assert.equal(pacer.remainingToday(), 0);
});

test("daily counter is seeded from the ledger — a bridge restart cannot reset a spent budget", () => {
  const clock = fixedClock(T0);
  const pacer = new SessionPacer(CONFIG, 3, clock.now, () => 0); // 3 already sent today per DB
  assert.equal(pacer.atDailyCap(), true);
});

test("cap rolls at UTC midnight", () => {
  const clock = fixedClock(T0);
  const pacer = new SessionPacer(CONFIG, 3, clock.now, () => 0);
  assert.equal(pacer.atDailyCap(), true);
  clock.advance(15 * 60 * 60 * 1000); // 10:00 -> 01:00 next day UTC
  assert.equal(pacer.atDailyCap(), false);
  assert.equal(pacer.remainingToday(), 3);
});

test("min-gap clock survives a restart when seeded from the ledger's last dispatch", () => {
  const clock = fixedClock(T0);
  // Previous instance's last send was 10s ago per the ledger — a fresh
  // pacer with no seed would wrongly report "no wait needed" here.
  const seededLastSendAtMs = T0 - 10_000;
  const pacer = new SessionPacer(CONFIG, 1, clock.now, () => 0, seededLastSendAtMs);
  assert.equal(pacer.msUntilNextSendAllowed(), 35_000); // 45s gap - 10s already elapsed
});

test("with no prior activity today, an unseeded pacer allows an immediate first send", () => {
  const clock = fixedClock(T0);
  const pacer = new SessionPacer(CONFIG, 0, clock.now, () => 0, null);
  assert.equal(pacer.msUntilNextSendAllowed(), 0);
});

// --- Warm-up (WA_WARMUP_ENABLED) — a newly linked number ramps up to the
// full daily cap instead of starting at it. `warmupCapForAgeDays` is the
// schedule; the pacer applies min(dailyCap, warm-up cap) once told when the
// number was linked.
import { warmupCapForAgeDays, WARMUP_SCHEDULE } from "../src/pacing.js";

const DAY = 24 * 60 * 60 * 1000;

test("warmupCapForAgeDays: 20 for days 0-2, 50 for 3-6, 100 for 7-13, then no limit", () => {
  assert.equal(warmupCapForAgeDays(0), 20);
  assert.equal(warmupCapForAgeDays(2.9), 20);
  assert.equal(warmupCapForAgeDays(3), 50);
  assert.equal(warmupCapForAgeDays(6.9), 50);
  assert.equal(warmupCapForAgeDays(7), 100);
  assert.equal(warmupCapForAgeDays(13.9), 100);
  assert.equal(warmupCapForAgeDays(14), null);
  assert.equal(WARMUP_SCHEDULE.length, 3);
});

test("warmupCapForAgeDays: a clock-skewed future link date is treated as brand new", () => {
  assert.equal(warmupCapForAgeDays(-1), 20);
});

test("pacer: without a link date, warm-up never applies (the default)", () => {
  const clock = fixedClock(T0);
  const pacer = new SessionPacer({ minGapMs: 0, jitterMs: 0, dailyCap: 150 }, 25, clock.now, () => 0);
  assert.equal(pacer.effectiveDailyCap(), 150);
  assert.equal(pacer.atDailyCap(), false);
});

test("pacer: a number linked today is capped at 20, even under a higher daily cap", () => {
  const clock = fixedClock(T0);
  const pacer = new SessionPacer({ minGapMs: 0, jitterMs: 0, dailyCap: 150 }, 20, clock.now, () => 0);
  pacer.setLinkedAt(T0 - 60_000);
  assert.equal(pacer.effectiveDailyCap(), 20);
  assert.equal(pacer.atDailyCap(), true);
  assert.equal(pacer.remainingToday(), 0);
});

test("pacer: the warm-up cap rises as the number ages, and clearing the link date removes it", () => {
  const clock = fixedClock(T0);
  const pacer = new SessionPacer({ minGapMs: 0, jitterMs: 0, dailyCap: 150 }, 0, clock.now, () => 0);
  pacer.setLinkedAt(T0 - 8 * DAY);
  assert.equal(pacer.effectiveDailyCap(), 100);
  clock.advance(6 * DAY);
  assert.equal(pacer.effectiveDailyCap(), 150);
  pacer.setLinkedAt(null);
  assert.equal(pacer.effectiveDailyCap(), 150);
});

test("pacer: a daily cap below the warm-up cap still wins", () => {
  const clock = fixedClock(T0);
  const pacer = new SessionPacer({ minGapMs: 0, jitterMs: 0, dailyCap: 10 }, 0, clock.now, () => 0);
  pacer.setLinkedAt(T0);
  assert.equal(pacer.effectiveDailyCap(), 10);
});

// drainQueue/openSocket need a live Baileys socket, so the warm-up wiring is
// pinned at source level (same approach as test/sessions-text-content.test.ts).
import { readFileSync } from "node:fs";
const SESSIONS_SRC = readFileSync(new URL("../src/sessions.ts", import.meta.url), "utf8");
const STORE_SRC = readFileSync(new URL("../src/store.ts", import.meta.url), "utf8");

test("LOCKSTEP (SOURCE-LEVEL): warm-up is only wired when WA_WARMUP_ENABLED is set, provisional-strict first", () => {
  const at = SESSIONS_SRC.indexOf("this.config.warmupEnabled");
  assert.ok(at > 0, "openSocket must gate warm-up on config.warmupEnabled");
  const block = SESSIONS_SRC.slice(at, at + 1200);
  assert.ok(block.indexOf("setLinkedAt(Date.now())") < block.indexOf("markPhoneLinked("), "provisional strict link date must be set before the async read");
  assert.ok(block.indexOf("markPhoneLinked(") < block.indexOf("persistStatus("), "markPhoneLinked must run before the status write replaces phone_number");
});

test("LOCKSTEP (SOURCE-LEVEL): accept-time cap reservation counts queued UNITS against the pacer's effective (warm-up aware) cap", () => {
  assert.match(SESSIONS_SRC, /sentTodayCount\(\) \+ session\.inFlightUnits \+ queuedUnits\(session\) \+ units > session\.pacer\.effectiveDailyCap\(\)/);
  assert.doesNotMatch(SESSIONS_SRC, /queue\.length >= session\.pacer\.effectiveDailyCap\(\)/, "queue.length undercounts a queued group send (5 units)");
  assert.doesNotMatch(SESSIONS_SRC, /queue\.length >= this\.config\.dailyCap/);
});

test("recordSend(units): a group send spends 5 units; the default stays 1", () => {
  const clock = fixedClock(T0);
  const pacer = new SessionPacer({ minGapMs: 0, jitterMs: 0, dailyCap: 10 }, 0, clock.now, () => 0);
  pacer.recordSend();
  assert.equal(pacer.sentTodayCount(), 1);
  pacer.recordSend(5);
  assert.equal(pacer.sentTodayCount(), 6);
  assert.equal(pacer.remainingToday(), 4);
});

test("LOCKSTEP (SOURCE-LEVEL): wipeCreds clears phone_linked_at so a re-linked number warms up again", () => {
  const wipe = STORE_SRC.slice(STORE_SRC.indexOf("async wipeCreds("));
  assert.match(wipe.slice(0, 800), /phone_linked_at: null/);
});

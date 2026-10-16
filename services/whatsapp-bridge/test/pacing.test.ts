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

import assert from "node:assert/strict";
import test from "node:test";

import { classifyOptOutMessage, MAX_KEYWORD_BODY_LENGTH, OPT_IN_KEYWORDS, OPT_OUT_KEYWORDS } from "@/lib/opt-out";

test("whole-message STOP variants, case-insensitive, trailing punctuation ignored", () => {
  const cases: Array<[string, string]> = [
    ["STOP", "STOP"],
    ["stop", "STOP"],
    [" Stop ", "STOP"],
    [" STOP. ", "STOP"],
    ["stop!!", "STOP"],
    ["Stop all", "STOP ALL"],
    ["stop all", "STOP ALL"],
    ["STOPALL", "STOPALL"],
    ["unsubscribe", "UNSUBSCRIBE"],
    ["END", "END"],
    ["quit", "QUIT"],
    ["opt out", "OPT OUT"],
    ["OPTOUT", "OPTOUT"],
    ["stop\n", "STOP"],
  ];
  for (const [body, keyword] of cases) {
    assert.deepEqual(classifyOptOutMessage(body), { kind: "opt_out", keyword }, body);
  }
});

test("CANCEL is not an opt-out keyword (appointment cancellations)", () => {
  for (const b of ["Cancel", "CANCEL", "cancel", "cancel my appointment", "Cancel please"]) {
    assert.equal(classifyOptOutMessage(b), null, b);
  }
  assert.ok(!(OPT_OUT_KEYWORDS as readonly string[]).includes("CANCEL"));
});

test("START variants opt back in", () => {
  for (const b of ["START", "start", "Unstop", "SUBSCRIBE", "opt in", "OPTIN"]) {
    assert.equal(classifyOptOutMessage(b)?.kind, "opt_in", b);
  }
  assert.deepEqual(classifyOptOutMessage("start."), { kind: "opt_in", keyword: "START" });
  assert.equal(OPT_IN_KEYWORDS.length, 5);
});

test("not whole-message: null", () => {
  const long = "please stop sending me anything " + "x".repeat(40);
  for (const b of ["please stop", "stop sending me this", "I want to stop", "stop. thanks", "yes", "", "   ", null, "x".repeat(MAX_KEYWORD_BODY_LENGTH + 1), long, "stop " + "x".repeat(60)]) {
    assert.equal(classifyOptOutMessage(b), null, String(b));
  }
});

test("internal whitespace collapses: 'STOP   ALL' -> STOP ALL; NBSP is whitespace", () => {
  assert.deepEqual(classifyOptOutMessage("STOP  ALL"), { kind: "opt_out", keyword: "STOP ALL" });
  assert.deepEqual(classifyOptOutMessage("STOP ALL"), { kind: "opt_out", keyword: "STOP ALL" });
});

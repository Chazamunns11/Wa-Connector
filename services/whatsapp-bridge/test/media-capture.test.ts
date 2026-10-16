/**
 * src/media-capture.ts — the inbound download/sniff/store state machine
 * (docs/MEDIA-PLAN.md §6.1): pending -> stored/too_large/rate_limited/failed.
 * Every dependency (abuse gate, download, upload, status update, poke) is
 * faked — no network, no Baileys, no Supabase.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable, PassThrough } from "node:stream";
import { pino } from "pino";
import { runMediaCapture, type MediaCaptureDeps, type MediaStatusPatch } from "../src/media-capture.js";
import type { InboundMediaRef } from "../src/inbound.js";

const log = pino({ level: "silent" });

const MEDIA_REF: InboundMediaRef = {
  kind: "image",
  downloadable: { mediaKey: new Uint8Array([1, 2, 3]), directPath: "/v/abc", url: "https://mmg.whatsapp.net/abc" },
  claimedMimetype: "image/jpeg",
  claimedFileLength: 4,
};

function jpegStream(): Readable {
  return Readable.from([Buffer.from([0xff, 0xd8, 0xff, 0xe0])]);
}

interface Harness {
  deps: MediaCaptureDeps;
  statusUpdates: { coachId: string; waMessageId: string; patch: MediaStatusPatch }[];
  pokeCalls: number;
  uploadCalls: { path: string; contentType: string; bytesLength: number }[];
}

function makeHarness(overrides: Partial<MediaCaptureDeps> = {}): Harness {
  const statusUpdates: Harness["statusUpdates"] = [];
  const uploadCalls: Harness["uploadCalls"] = [];
  let pokeCalls = 0;
  const deps: MediaCaptureDeps = {
    checkAndReserve: async () => true,
    downloadContent: async () => jpegStream(),
    uploadObject: async (path, bytes, contentType) => {
      uploadCalls.push({ path, contentType, bytesLength: bytes.length });
    },
    updateMediaStatus: async (coachId, waMessageId, patch) => {
      statusUpdates.push({ coachId, waMessageId, patch });
    },
    poke: () => {
      pokeCalls += 1;
    },
    maxBytes: 25 * 1024 * 1024,
    log,
    ...overrides,
  };
  return {
    deps,
    statusUpdates,
    get pokeCalls() {
      return pokeCalls;
    },
    uploadCalls,
  };
}

const INPUT = { coachId: "tenant-1", fromPhone: "+447700900001", waMessageId: "WAMSG1", mediaRef: MEDIA_REF };

test("runMediaCapture: happy path — allowed, downloaded, sniffed, uploaded, status stored, poke fires exactly once", async () => {
  const h = makeHarness();
  const outcome = await runMediaCapture(INPUT, h.deps);
  assert.equal(outcome, "stored");
  assert.equal(h.uploadCalls.length, 1);
  assert.equal(h.uploadCalls[0]?.path, "tenant-1/WAMSG1.jpg");
  assert.equal(h.uploadCalls[0]?.contentType, "image/jpeg");
  assert.equal(h.statusUpdates.length, 1);
  assert.deepEqual(h.statusUpdates[0]?.patch, { status: "stored", path: "tenant-1/WAMSG1.jpg", mime: "image/jpeg", sizeBytes: 4 });
  assert.equal(h.pokeCalls, 1);
});

// ---------------------------------------------------------------------------
// QA Major 4 — `waMessageId` is sender-controlled (Baileys' `msg.key.id`)
// and becomes a storage-path segment (`{coachId}/{waMessageId}.{ext}`).
// A hostile id must be refused BEFORE any download or upload is attempted.
// ---------------------------------------------------------------------------

test("runMediaCapture: a waMessageId containing '../' is refused before any download is attempted", async () => {
  let downloadCalled = false;
  const h = makeHarness({
    downloadContent: async () => {
      downloadCalled = true;
      return jpegStream();
    },
  });
  const outcome = await runMediaCapture({ ...INPUT, waMessageId: "../../etc/passwd" }, h.deps);
  assert.equal(outcome, "failed");
  assert.equal(downloadCalled, false, "an unsafe id must be refused before spending any bandwidth");
  assert.equal(h.uploadCalls.length, 0);
  assert.deepEqual(h.statusUpdates[0]?.patch, { status: "failed" });
  assert.equal(h.pokeCalls, 1);
});

test("runMediaCapture: a waMessageId containing a bare '/' is refused before any download is attempted", async () => {
  let downloadCalled = false;
  const h = makeHarness({
    downloadContent: async () => {
      downloadCalled = true;
      return jpegStream();
    },
  });
  const outcome = await runMediaCapture({ ...INPUT, waMessageId: "other-tenant/secret" }, h.deps);
  assert.equal(outcome, "failed");
  assert.equal(downloadCalled, false);
  assert.equal(h.uploadCalls.length, 0);
  assert.deepEqual(h.statusUpdates[0]?.patch, { status: "failed" });
});

test("runMediaCapture: an empty waMessageId is refused", async () => {
  const h = makeHarness();
  const outcome = await runMediaCapture({ ...INPUT, waMessageId: "" }, h.deps);
  assert.equal(outcome, "failed");
  assert.equal(h.uploadCalls.length, 0);
});

test("runMediaCapture: a waMessageId over 128 characters is refused", async () => {
  const h = makeHarness();
  const outcome = await runMediaCapture({ ...INPUT, waMessageId: "A".repeat(129) }, h.deps);
  assert.equal(outcome, "failed");
  assert.equal(h.uploadCalls.length, 0);
});

test("runMediaCapture: a genuine WhatsApp-shaped id (letters, digits, '_', '-', '=', at 128 chars) is accepted through to upload", async () => {
  const h = makeHarness();
  const genuineId = "A".repeat(60) + "_-=" + "9".repeat(65); // 128 chars, every allowed character class present.
  const outcome = await runMediaCapture({ ...INPUT, waMessageId: genuineId }, h.deps);
  assert.equal(outcome, "stored");
  assert.equal(h.uploadCalls.length, 1);
  assert.equal(h.uploadCalls[0]?.path, `tenant-1/${genuineId}.jpg`);
});

test("runMediaCapture: rate_limited — the abuse gate refuses; NO download is attempted, poke still fires", async () => {
  let downloadCalled = false;
  const h = makeHarness({
    checkAndReserve: async () => false,
    downloadContent: async () => {
      downloadCalled = true;
      return jpegStream();
    },
  });
  const outcome = await runMediaCapture(INPUT, h.deps);
  assert.equal(outcome, "rate_limited");
  assert.equal(downloadCalled, false, "over-cap must never even attempt a download");
  assert.equal(h.uploadCalls.length, 0);
  assert.deepEqual(h.statusUpdates[0]?.patch, { status: "rate_limited" });
  assert.equal(h.pokeCalls, 1);
});

test("runMediaCapture: too_large — the byte-cap collector aborts, status too_large, no upload attempted", async () => {
  const h = makeHarness({
    downloadContent: async () => {
      const stream = new PassThrough();
      stream.end(Buffer.alloc(100));
      return stream;
    },
    maxBytes: 10,
  });
  const outcome = await runMediaCapture(INPUT, h.deps);
  assert.equal(outcome, "too_large");
  assert.equal(h.uploadCalls.length, 0);
  assert.deepEqual(h.statusUpdates[0]?.patch, { status: "too_large" });
  assert.equal(h.pokeCalls, 1);
});

test("runMediaCapture: download failing to even start -> failed, poke still fires", async () => {
  const h = makeHarness({
    downloadContent: async () => {
      throw new Error("media key expired");
    },
  });
  const outcome = await runMediaCapture(INPUT, h.deps);
  assert.equal(outcome, "failed");
  assert.deepEqual(h.statusUpdates[0]?.patch, { status: "failed" });
  assert.equal(h.pokeCalls, 1);
});

test("runMediaCapture: a stream error during download -> failed", async () => {
  const h = makeHarness({
    downloadContent: async () => {
      const stream = new PassThrough();
      // setImmediate (not queueMicrotask) — must fire AFTER collectWithByteCap
      // has attached its 'error' listener (which happens synchronously right
      // after this promise resolves); emitting 'error' with no listener yet
      // attached would otherwise throw as an unhandled EventEmitter error.
      setImmediate(() => stream.emit("error", new Error("connection dropped")));
      return stream;
    },
  });
  const outcome = await runMediaCapture(INPUT, h.deps);
  assert.equal(outcome, "failed");
  assert.deepEqual(h.statusUpdates[0]?.patch, { status: "failed" });
  assert.equal(h.pokeCalls, 1);
});

test("runMediaCapture: an unrecognised/denylisted sniffed type -> failed, no upload, no antivirus needed because the allowlist refuses it", async () => {
  const h = makeHarness({
    downloadContent: async () => Readable.from([Buffer.from("not a real media file")]),
  });
  const outcome = await runMediaCapture(INPUT, h.deps);
  assert.equal(outcome, "failed");
  assert.equal(h.uploadCalls.length, 0);
  assert.deepEqual(h.statusUpdates[0]?.patch, { status: "failed" });
  assert.equal(h.pokeCalls, 1);
});

test("runMediaCapture: an executable disguised as an image (claimed mimetype ignored) is refused — sniffing wins over the sender's claim", async () => {
  const exeRef: InboundMediaRef = { ...MEDIA_REF, claimedMimetype: "image/jpeg" }; // sender/WhatsApp CLAIMS image/jpeg
  const h = makeHarness({
    downloadContent: async () => Readable.from([Buffer.from([0x4d, 0x5a, 0x90, 0x00])]), // actual bytes: MZ (exe)
  });
  const outcome = await runMediaCapture({ ...INPUT, mediaRef: exeRef }, h.deps);
  assert.equal(outcome, "failed");
  assert.equal(h.uploadCalls.length, 0);
});

test("runMediaCapture: upload failure -> failed, status still written, poke still fires", async () => {
  const h = makeHarness({
    uploadObject: async () => {
      throw new Error("storage unavailable");
    },
  });
  const outcome = await runMediaCapture(INPUT, h.deps);
  assert.equal(outcome, "failed");
  assert.deepEqual(h.statusUpdates[0]?.patch, { status: "failed" });
  assert.equal(h.pokeCalls, 1);
});

test("runMediaCapture: the abuse-gate lookup itself throwing is caught — fails closed to 'failed', still pokes exactly once, never rejects", async () => {
  const h = makeHarness({
    checkAndReserve: async () => {
      throw new Error("Supabase blip");
    },
  });
  const outcome = await runMediaCapture(INPUT, h.deps);
  assert.equal(outcome, "failed");
  assert.equal(h.pokeCalls, 1);
});

test("runMediaCapture: the status-update write itself throwing still results in exactly one poke (never blocks the poke)", async () => {
  const h = makeHarness({
    updateMediaStatus: async () => {
      throw new Error("Supabase blip on the write");
    },
  });
  const outcome = await runMediaCapture(INPUT, h.deps);
  assert.equal(outcome, "stored"); // the CAPTURE itself succeeded — only the bookkeeping write failed.
  assert.equal(h.pokeCalls, 1, "poke must fire even when persisting the terminal status fails");
});

test("runMediaCapture: exactly ONE status update and ONE poke no matter which branch resolves — never double-written", async () => {
  for (const scenario of ["stored", "rate_limited", "too_large", "failed"] as const) {
    const h = makeHarness(
      scenario === "rate_limited"
        ? { checkAndReserve: async () => false }
        : scenario === "too_large"
          ? { maxBytes: 1 }
          : scenario === "failed"
            ? { downloadContent: async () => Readable.from([Buffer.from("junk")]) }
            : {}
    );
    const outcome = await runMediaCapture(INPUT, h.deps);
    assert.equal(outcome, scenario);
    assert.equal(h.statusUpdates.length, 1, `scenario ${scenario}: exactly one status update`);
    assert.equal(h.pokeCalls, 1, `scenario ${scenario}: exactly one poke`);
  }
});

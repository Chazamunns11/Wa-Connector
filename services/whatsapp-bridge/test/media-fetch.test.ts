/**
 * src/media-fetch.ts — the outbound attachment fetch integration (docs/MEDIA-PLAN.md
 * §5.4). Uses a real LOOPBACK `http` server (same pattern `test/server.test.ts`
 * already establishes) so the pipeline itself (byte-cap abort, timeout,
 * redirects) is exercised against real sockets — but the SSRF guard is
 * proven with a FAKE `lookup` (no real DNS query, and no requirement that
 * any real hostname resolve to anything in particular). The guard's own
 * range logic is unit-tested directly in test/media.test.ts; here it's
 * proven wired into the actual connection path.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { LookupAddress } from "node:dns";
import { buildGuardedLookup, fetchAttachment, resolveOutboundAttachment } from "../src/media-fetch.js";

async function withServer(handler: Parameters<typeof createServer>[0], fn: (port: number) => Promise<void>): Promise<void> {
  const server: Server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(port);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

/** Every test here targets a real loopback socket, which the REAL SSRF guard would refuse (127/8 is in the blocked list) — so every call injects a permissive `isBlockedAddress` and turns `requireHttps` off (loopback fixture server is plain http). The guard's actual enforcement is proven separately, below. */
const PERMISSIVE = { isBlockedAddress: () => false, requireHttps: false };

test("fetchAttachment: a normal small response is collected fully", async () => {
  await withServer(
    (req, res) => {
      res.writeHead(200, { "content-type": "application/octet-stream" });
      res.end(Buffer.from([0xff, 0xd8, 0xff, 0xe0])); // jpeg magic bytes
    },
    async (port) => {
      const result = await fetchAttachment(`http://127.0.0.1:${port}/file.jpg`, { timeoutMs: 2000, maxBytes: 1024, ...PERMISSIVE });
      assert.equal(result.ok, true);
      if (result.ok) {
        assert.equal(result.sniffedMime, "image/jpeg");
        assert.equal(result.buffer.length, 4);
      }
    }
  );
});

test("fetchAttachment: a response over maxBytes is aborted, not buffered", async () => {
  await withServer(
    (req, res) => {
      res.writeHead(200);
      res.write(Buffer.alloc(2000, 1));
      // Deliberately never end() quickly — but the client should abort well before this matters.
      setTimeout(() => res.end(), 50);
    },
    async (port) => {
      const result = await fetchAttachment(`http://127.0.0.1:${port}/big`, { timeoutMs: 2000, maxBytes: 100, ...PERMISSIVE });
      assert.deepEqual(result, { ok: false, reason: "too_large" });
    }
  );
});

test("fetchAttachment: a server that never responds times out with a fixed reason", async () => {
  await withServer(
    () => {
      /* never respond */
    },
    async (port) => {
      const result = await fetchAttachment(`http://127.0.0.1:${port}/hangs`, { timeoutMs: 50, maxBytes: 1024, ...PERMISSIVE });
      assert.deepEqual(result, { ok: false, reason: "timeout" });
    }
  );
});

test("fetchAttachment: follows a redirect chain within the cap", async () => {
  await withServer(
    (req, res) => {
      if (req.url === "/start") {
        res.writeHead(302, { location: "/final" });
        res.end();
        return;
      }
      res.writeHead(200);
      res.end(Buffer.from("%PDF-1.4"));
    },
    async (port) => {
      const result = await fetchAttachment(`http://127.0.0.1:${port}/start`, { timeoutMs: 2000, maxBytes: 1024, maxRedirects: 3, ...PERMISSIVE });
      assert.equal(result.ok, true);
      if (result.ok) assert.equal(result.sniffedMime, "application/pdf");
    }
  );
});

test("fetchAttachment: a redirect chain longer than maxRedirects is refused", async () => {
  await withServer(
    (req, res) => {
      const n = Number(req.url?.replace("/hop", "") || "0");
      res.writeHead(302, { location: `/hop${n + 1}` });
      res.end();
    },
    async (port) => {
      const result = await fetchAttachment(`http://127.0.0.1:${port}/hop0`, { timeoutMs: 2000, maxBytes: 1024, maxRedirects: 2, ...PERMISSIVE });
      assert.deepEqual(result, { ok: false, reason: "too_many_redirects" });
    }
  );
});

test("fetchAttachment: a URL over the length bound is refused before any connection is attempted", async () => {
  const hugeUrl = "https://example.com/" + "a".repeat(3000);
  const result = await fetchAttachment(hugeUrl, { timeoutMs: 2000, maxBytes: 1024 });
  assert.deepEqual(result, { ok: false, reason: "url_too_long" });
});

test("fetchAttachment: http:// is refused when requireHttps is on (the production default)", async () => {
  const result = await fetchAttachment("http://example.com/file", { timeoutMs: 2000, maxBytes: 1024, isBlockedAddress: () => false });
  assert.deepEqual(result, { ok: false, reason: "not_https" });
});

// ---------------------------------------------------------------------------
// SSRF guard, WIRED IN (not just the pure range check — proving the guard
// actually governs the connection, via an injected fake `lookup` so no real
// DNS resolution is needed).
// ---------------------------------------------------------------------------

test("fetchAttachment: a hostname that resolves (per the injected lookup) to a private/reserved address is refused with ssrf_blocked, and the target server is never actually reached", async () => {
  let serverWasHit = false;
  const server = createServer((req, res) => {
    serverWasHit = true;
    res.end("x");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const fakeLookup = ((_hostname: string, ...rest: unknown[]) => {
      const cb = rest[rest.length - 1] as (err: NodeJS.ErrnoException | null, address: string, family: number) => void;
      cb(null, "127.0.0.1", 4); // "attacker-controlled DNS" pointing at loopback.
    }) as unknown as typeof import("node:dns").lookup;
    const result = await fetchAttachment(`http://attacker-controlled.example/x`, {
      timeoutMs: 2000,
      maxBytes: 1024,
      requireHttps: false,
      lookup: fakeLookup,
      // REAL guard this time — no override.
    });
    assert.deepEqual(result, { ok: false, reason: "ssrf_blocked" });
    assert.equal(serverWasHit, false, "the guard must block the connection BEFORE any bytes are exchanged");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("fetchAttachment: a hostname resolving to a public-looking address is allowed through the guard (with a fake lookup pointed at the real fixture server)", async () => {
  await withServer(
    (req, res) => {
      res.writeHead(200);
      res.end(Buffer.from("OggS\x00\x02"));
    },
    async (port) => {
      const fakeLookup = ((_hostname: string, ...rest: unknown[]) => {
        const cb = rest[rest.length - 1] as (err: NodeJS.ErrnoException | null, address: string, family: number) => void;
        cb(null, "127.0.0.1", 4);
      }) as unknown as typeof import("node:dns").lookup;
      // isBlockedAddress override simulates "this resolved address happens to
      // be allowed" (in prod, DNS for a real public hostname would resolve
      // to a genuinely public IP; here the fixture server IS loopback, so we
      // permit it explicitly to isolate "does the rest of the pipeline still
      // work when the guard passes" from the guard's own range logic, which
      // is proven separately in test/media.test.ts and the blocked case just above).
      const result = await fetchAttachment(`http://looks-public.example:${port}/x`, {
        timeoutMs: 2000,
        maxBytes: 1024,
        requireHttps: false,
        lookup: fakeLookup,
        isBlockedAddress: () => false,
      });
      assert.equal(result.ok, true);
      if (result.ok) assert.equal(result.sniffedMime, "audio/ogg");
    }
  );
});

// ---------------------------------------------------------------------------
// QA Major 3 — literal-IP hosts bypass `dns.lookup` entirely (Node's
// `net.Socket` short-circuits `lookup` whenever `net.isIP(host) !== 0`), so
// `buildGuardedLookup` alone never sees them. `fetchAttachment` must catch
// this itself, on every hop, before ever reaching `singleRequest`.
// ---------------------------------------------------------------------------

test("fetchAttachment: a literal IPv4 loopback URL (https://127.0.0.1/...) is blocked WITHOUT any DNS lookup, and the target server is never reached", async () => {
  let serverWasHit = false;
  await withServer(
    (req, res) => {
      serverWasHit = true;
      res.end("x");
    },
    async (port) => {
      // Real (default) guard this time — no isBlockedAddress override, no
      // lookup override. 127.0.0.1 is in the blocked range regardless.
      const result = await fetchAttachment(`http://127.0.0.1:${port}/x`, { timeoutMs: 2000, maxBytes: 1024, requireHttps: false });
      assert.deepEqual(result, { ok: false, reason: "ssrf_blocked" });
      assert.equal(serverWasHit, false, "a literal-IP target must be blocked before any bytes are exchanged, exactly like a resolved-hostname target");
    }
  );
});

test("fetchAttachment: a literal IPv6 loopback URL (https://[::1]/...) is blocked WITHOUT any DNS lookup", async () => {
  const result = await fetchAttachment("http://[::1]/x", { timeoutMs: 2000, maxBytes: 1024, requireHttps: false });
  assert.deepEqual(result, { ok: false, reason: "ssrf_blocked" });
});

test("fetchAttachment: a redirect hop landing on a literal private-IP URL is blocked identically to the initial URL, not just the first hop", async () => {
  await withServer(
    (req, res) => {
      // The first hop is a normal hostname (resolved via the injected fake
      // DNS lookup below); the SECOND hop is a bare literal IP the attacker
      // controls via the Location header — the exact bypass shape (QA
      // Major 3): a URL that starts out looking safe and only becomes an
      // IP literal after a redirect the guard must still catch.
      res.writeHead(302, { location: "http://10.0.0.5/evil" });
      res.end();
    },
    async (port) => {
      const fakeLookup = ((_hostname: string, ...rest: unknown[]) => {
        const cb = rest[rest.length - 1] as (err: NodeJS.ErrnoException | null, address: string, family: number) => void;
        cb(null, "127.0.0.1", 4); // the first hop's hostname resolves to the fixture server.
      }) as unknown as typeof import("node:dns").lookup;
      const result = await fetchAttachment(`http://looks-public.example:${port}/start`, {
        timeoutMs: 2000,
        maxBytes: 1024,
        requireHttps: false,
        lookup: fakeLookup,
        // Only the literal redirect target is "private" in this fixture —
        // the fake-resolved first hop is allowed, isolating "does the
        // per-hop literal-IP check fire on hop 2" from hop 1's own guard.
        isBlockedAddress: (addr) => addr === "10.0.0.5",
      });
      assert.deepEqual(result, { ok: false, reason: "ssrf_blocked" });
    }
  );
});

// ---------------------------------------------------------------------------
// buildGuardedLookup — DIRECT unit tests of the {all:true} Happy-Eyeballs
// fix (a previous session's bug report: the guard used to hard-code
// `{all: false}` in its own call to the underlying lookup, which silently
// mismatched what Node's net.Socket actually asked for whenever
// autoSelectFamily was active — breaking EVERY outbound fetch, not just
// blocked ones, because the callback shape net.Socket expected back never
// matched what it got). These tests invoke the exported function directly
// with a fake underlying `dns.lookup`, so they exercise the array-shape
// contract deterministically regardless of this Node version's own
// autoSelectFamily default — a real end-to-end request (the tests above)
// would only exercise this branch if THIS Node happens to enable Happy
// Eyeballs for this exact call, which is not guaranteed.
// ---------------------------------------------------------------------------

/** Mimics real `dns.lookup`'s own contract: honours the caller's `all` option, returning an ARRAY when `all: true` was requested and a single `(address, family)` pair otherwise — exactly what a genuine Node `dns.lookup` does, which is the shape `buildGuardedLookup` must forward correctly in both directions. */
function realisticFakeLookup(addresses: { address: string; family: number }[]): typeof import("node:dns").lookup {
  return ((hostname: string, optionsOrCallback: unknown, maybeCallback?: unknown) => {
    const hasOptions = typeof optionsOrCallback !== "function";
    const options = (hasOptions ? optionsOrCallback : {}) as { all?: boolean };
    const callback = (hasOptions ? maybeCallback : optionsOrCallback) as (err: NodeJS.ErrnoException | null, address: LookupAddress[] | string, family?: number) => void;
    if (options.all === true) {
      callback(null, addresses.map((a) => ({ address: a.address, family: a.family })));
    } else {
      callback(null, addresses[0].address, addresses[0].family);
    }
  }) as unknown as typeof import("node:dns").lookup;
}

test("buildGuardedLookup: called with { all: true } (Happy-Eyeballs shape) forwards { all: true } to the underlying lookup and returns an ARRAY to the caller, not a single address/family pair", async () => {
  const underlying = realisticFakeLookup([{ address: "93.184.216.34", family: 4 }]);
  const guarded = buildGuardedLookup({ isBlockedAddress: () => false, lookup: underlying });

  const result = await new Promise<{ address: unknown; family: unknown }>((resolve, reject) => {
    (guarded as (h: string, o: { all: boolean }, cb: (err: NodeJS.ErrnoException | null, address: unknown, family: unknown) => void) => void)(
      "example.com",
      { all: true },
      (err, address, family) => {
        if (err) reject(err);
        else resolve({ address, family });
      }
    );
  });

  assert.ok(Array.isArray(result.address), "with {all:true} the callback must receive an ARRAY, matching what net.Socket's Happy-Eyeballs path actually asked for — this is the exact shape the previous {all:false}-hardcoded bug broke");
  assert.deepEqual(result.address, [{ address: "93.184.216.34", family: 4 }]);
});

test("buildGuardedLookup: called WITHOUT all (or all:false) returns a single (address, family) pair, never an array", async () => {
  const underlying = realisticFakeLookup([{ address: "93.184.216.34", family: 4 }]);
  const guarded = buildGuardedLookup({ isBlockedAddress: () => false, lookup: underlying });

  const result = await new Promise<{ address: unknown; family: unknown }>((resolve, reject) => {
    (guarded as (h: string, o: object, cb: (err: NodeJS.ErrnoException | null, address: unknown, family: unknown) => void) => void)("example.com", {}, (err, address, family) => {
      if (err) reject(err);
      else resolve({ address, family });
    });
  });

  assert.equal(typeof result.address, "string", "without {all:true} the callback must receive a single address string, matching a plain dns.lookup call");
  assert.equal(result.address, "93.184.216.34");
  assert.equal(result.family, 4);
});

test("buildGuardedLookup: the 2-arg call form (hostname, callback — no options object at all) is honoured, same as plain dns.lookup(hostname, callback)", async () => {
  const underlying = realisticFakeLookup([{ address: "93.184.216.34", family: 4 }]);
  const guarded = buildGuardedLookup({ isBlockedAddress: () => false, lookup: underlying });

  const result = await new Promise<{ address: unknown }>((resolve, reject) => {
    (guarded as (h: string, cb: (err: NodeJS.ErrnoException | null, address: unknown) => void) => void)("example.com", (err, address) => {
      if (err) reject(err);
      else resolve({ address });
    });
  });
  assert.equal(result.address, "93.184.216.34");
});

test("buildGuardedLookup: with { all: true }, a blocked address ANYWHERE in the array refuses the whole resolution, even when it is not first", async () => {
  const underlying = realisticFakeLookup([
    { address: "93.184.216.34", family: 4 }, // public — first in the list
    { address: "127.0.0.1", family: 4 }, // private — second, must still be caught
  ]);
  const guarded = buildGuardedLookup({ isBlockedAddress: (addr) => addr === "127.0.0.1", lookup: underlying });

  const err = await new Promise<NodeJS.ErrnoException | null>((resolve) => {
    (guarded as (h: string, o: { all: boolean }, cb: (err: NodeJS.ErrnoException | null, address?: unknown) => void) => void)("example.com", { all: true }, (e) => resolve(e));
  });
  assert.ok(err, "a blocked address anywhere in the {all:true} array must refuse the whole lookup");
  assert.equal(err?.code, "SSRF_BLOCKED");
});

test("buildGuardedLookup: an error from the underlying lookup is passed straight through, regardless of the all option requested", async () => {
  const dnsError = new Error("getaddrinfo ENOTFOUND example.invalid") as NodeJS.ErrnoException;
  dnsError.code = "ENOTFOUND";
  const underlying = ((_h: string, _o: unknown, cb: unknown) => {
    const callback = cb as (err: NodeJS.ErrnoException) => void;
    callback(dnsError);
  }) as unknown as typeof import("node:dns").lookup;
  const guarded = buildGuardedLookup({ isBlockedAddress: () => false, lookup: underlying });

  const err = await new Promise<NodeJS.ErrnoException | null>((resolve) => {
    (guarded as (h: string, o: { all: boolean }, cb: (err: NodeJS.ErrnoException | null) => void) => void)("example.invalid", { all: true }, (e) => resolve(e));
  });
  assert.equal(err?.code, "ENOTFOUND");
});

// ---------------------------------------------------------------------------
// resolveOutboundAttachment — the fetch+sniff+type-cap+map combination.
// ---------------------------------------------------------------------------

test("resolveOutboundAttachment: a jpeg under the image cap resolves to an image shape", async () => {
  await withServer(
    (req, res) => {
      res.writeHead(200);
      res.end(bytes(0xff, 0xd8, 0xff, 0xe0));
    },
    async (port) => {
      const result = await resolveOutboundAttachment(`http://127.0.0.1:${port}/x`, {
        timeoutMs: 2000,
        caps: { image: 10, video: 50, audio: 16, document: 100 },
        ...PERMISSIVE,
      });
      assert.equal(result.ok, true);
      if (result.ok) assert.deepEqual({ kind: result.kind, mimetype: result.mimetype }, { kind: "image", mimetype: "image/jpeg" });
    }
  );
});

test("resolveOutboundAttachment: an image OVER the image-specific cap is refused even though it fits under the larger document cap", async () => {
  await withServer(
    (req, res) => {
      res.writeHead(200);
      // jpeg magic bytes + padding, 20 bytes total — over a 10-byte image cap.
      res.end(Buffer.concat([bytes(0xff, 0xd8, 0xff, 0xe0), Buffer.alloc(16, 1)]));
    },
    async (port) => {
      const result = await resolveOutboundAttachment(`http://127.0.0.1:${port}/x`, {
        timeoutMs: 2000,
        caps: { image: 10, video: 50, audio: 16, document: 1000 }, // outer fetch cap (max of these) would happily admit 20 bytes
        ...PERMISSIVE,
      });
      assert.deepEqual(result, { ok: false, reason: "too_large_for_type" });
    }
  );
});

test("resolveOutboundAttachment: an unrecognised/denylisted type is refused as unsupported", async () => {
  await withServer(
    (req, res) => {
      res.writeHead(200);
      res.end(bytes(0x4d, 0x5a, 0x90, 0x00)); // exe
    },
    async (port) => {
      const result = await resolveOutboundAttachment(`http://127.0.0.1:${port}/x`, {
        timeoutMs: 2000,
        caps: { image: 10, video: 50, audio: 16, document: 100 },
        ...PERMISSIVE,
      });
      assert.deepEqual(result, { ok: false, reason: "unsupported_type" });
    }
  );
});

function bytes(...hex: number[]): Buffer {
  return Buffer.from(hex);
}

/**
 * Media plan (docs/MEDIA-PLAN.md §6.1) — the inbound download/sniff/store
 * state machine: `pending -> stored | too_large | rate_limited | failed`.
 * Deps-injected (download/upload/status-update/poke/abuse-gate all passed
 * in), exactly like `src/inbound.ts`'s `processInboundBatch`, so this is
 * fully unit-testable with fakes — no network, no Baileys, no Supabase (see
 * README.md's test convention). `sessions.ts` wires the real
 * `downloadContentFromMessage`/Supabase storage/`BridgeStore` calls in.
 *
 * INVARIANTS THIS FUNCTION UPHOLDS:
 *   - Exactly ONE `updateInboundMediaStatus` write and exactly ONE poke, no
 *     matter which branch resolves the row — the `finally` block below is
 *     the only place either happens.
 *   - The poke fires ONLY AFTER the row's `media_status` has actually left
 *     `'pending'` (plan §6.1 point 3 — "otherwise the drain races the upload
 *     and pushes a placeholder for a file that lands seconds later").
 *   - Never throws — every stage's own failure (abuse-gate lookup, download,
 *     upload, even the status-update write itself) is caught and mapped to a
 *     terminal `media_status`, mirroring `processInboundBatch`'s own
 *     per-message "never crash the caller" contract. `sessions.ts` still
 *     wraps its call site in `.catch()` as belt-and-braces, same posture as
 *     every other Baileys event handler in this package.
 */
import type { Readable } from "node:stream";
import type { Logger } from "pino";
import { collectWithByteCap, extensionForMime, isAllowedMime, isValidWaMessageId, sniffMime } from "./media.js";
import type { InboundMediaRef } from "./inbound.js";

export type MediaCaptureOutcome = "stored" | "too_large" | "rate_limited" | "failed";

export interface MediaCaptureInput {
  /** The bridge's session key — a tenant id (coach or GHL-location; see store.ts's tenantExists JSDoc for why this is never assumed to be "coach"). Also the storage path's tenant segment. */
  coachId: string;
  fromPhone: string;
  waMessageId: string;
  mediaRef: InboundMediaRef;
}

export type MediaStatusPatch =
  | { status: "stored"; path: string; mime: string; sizeBytes: number }
  | { status: "too_large" | "rate_limited" | "failed" };

export interface MediaCaptureDeps {
  /** `MediaAbuseGate.checkAndReserve`, or a fake in tests. */
  checkAndReserve(tenantId: string, senderPhone: string): Promise<boolean>;
  /** Wraps Baileys' `downloadContentFromMessage(mediaRef.downloadable, kind, opts)` — returns a readable byte stream, or throws if the download could not even start (e.g. an expired media key). */
  downloadContent(mediaRef: InboundMediaRef): Promise<Readable>;
  /** Wraps `BridgeStore.uploadMediaObject(bucket, path, bytes, contentType)`. */
  uploadObject(path: string, bytes: Buffer, contentType: string): Promise<void>;
  /** Wraps `BridgeStore.updateInboundMediaStatus`. */
  updateMediaStatus(coachId: string, waMessageId: string, patch: MediaStatusPatch): Promise<void>;
  /** Fire-and-forget "drain now" poke (src/poke.ts) — called exactly once, after the row resolves. */
  poke(): void;
  /** `WA_INBOUND_MEDIA_MAX_BYTES` — ONE flat cap regardless of type (plan §6.1/§9), unlike the outbound per-type table. */
  maxBytes: number;
  log: Logger;
}

export async function runMediaCapture(input: MediaCaptureInput, deps: MediaCaptureDeps): Promise<MediaCaptureOutcome> {
  const { coachId, fromPhone, waMessageId, mediaRef } = input;
  let patch: MediaStatusPatch = { status: "failed" };

  try {
    // QA Major 4 fix — `waMessageId` is sender-controlled (Baileys'
    // `msg.key.id`, see src/media.ts's `isValidWaMessageId` JSDoc) and
    // becomes a segment of the storage object path built below. Validate it
    // BEFORE building that path (and before spending any bandwidth on the
    // download) — an id that fails this check is refused exactly like any
    // other terminal capture failure, no upload attempted.
    if (!isValidWaMessageId(waMessageId)) {
      deps.log.warn({ coachId, waMessageId }, "media capture refused — waMessageId failed the storage-path safety check");
      patch = { status: "failed" };
      return patch.status;
    }

    const allowed = await deps.checkAndReserve(coachId, fromPhone);
    if (!allowed) {
      patch = { status: "rate_limited" };
      return patch.status;
    }

    let stream: Readable;
    try {
      stream = await deps.downloadContent(mediaRef);
    } catch (err) {
      deps.log.error({ coachId, waMessageId, err: (err as Error).message }, "media download failed to start");
      patch = { status: "failed" };
      return patch.status;
    }

    const collected = await collectWithByteCap(stream, deps.maxBytes);
    if (!collected.ok) {
      patch = { status: collected.reason === "too_large" ? "too_large" : "failed" };
      return patch.status;
    }

    // Sniffed type wins, always — never the sender's claimed mimetype (see
    // src/media.ts's file header and InboundMediaRef.claimedMimetype's own
    // JSDoc). An unrecognised or denylisted type is refused exactly like a
    // download/upload failure — no antivirus in v1, so the allowlist IS the
    // control (plan §10).
    const sniffed = sniffMime(collected.buffer);
    if (!isAllowedMime(sniffed)) {
      deps.log.warn({ coachId, waMessageId, sniffed }, "media sniffed type is not on the inbound allowlist — refused");
      patch = { status: "failed" };
      return patch.status;
    }

    const path = `${coachId}/${waMessageId}.${extensionForMime(sniffed)}`;
    try {
      await deps.uploadObject(path, collected.buffer, sniffed);
    } catch (err) {
      deps.log.error({ coachId, waMessageId, err: (err as Error).message }, "media storage upload failed");
      patch = { status: "failed" };
      return patch.status;
    }

    patch = { status: "stored", path, mime: sniffed, sizeBytes: collected.buffer.length };
    return patch.status;
  } catch (err) {
    // Belt-and-braces — the abuse-gate lookup itself throwing (a Supabase
    // blip) is the one path not already caught above; fail closed to
    // 'failed' rather than let this reject into sessions.ts's fire-and-forget
    // call site.
    deps.log.error({ coachId, waMessageId, err: (err as Error).message }, "media capture failed unexpectedly");
    patch = { status: "failed" };
    return patch.status;
  } finally {
    try {
      await deps.updateMediaStatus(coachId, waMessageId, patch);
    } catch (err) {
      // The row may be left at 'pending' — the portal drain's own staleness
      // fence (>10 minutes old) treats a still-pending row as failed, so this
      // degrades to a placeholder rather than blocking anything indefinitely
      // (plan §6.1's crash-window acceptance, same shape extended to this
      // failure mode).
      deps.log.error({ coachId, waMessageId, err: (err as Error).message }, "media status update failed — row may be left 'pending', portal drain's staleness fence covers it");
    }
    // ALWAYS poke, exactly once, regardless of outcome or of the status
    // write's own success — see this file's header invariant list.
    deps.poke();
  }
}

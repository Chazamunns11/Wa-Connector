/**
 * POST /api/webhooks/crm-provider — the GHL custom conversation provider's
 * Delivery URL (docs/GHL-PROVIDER-PLAN.md, plan §0/D3). GHL POSTs one JSON
 * body per outbound message (`type: "SMS"`) here; this route verifies the
 * Ed25519 signature over the RAW bytes, then delegates everything else to
 * `src/lib/ghl-provider.ts`'s `handleProviderOutboundMessage`.
 *
 * RAW BODY FIRST (same rule as `src/app/api/webhooks/stripe/route.ts`):
 * `await request.text()` runs BEFORE any JSON parsing — GHL signs the exact
 * bytes it sent, and re-serialising parsed JSON can reorder keys/whitespace
 * and silently break verification (`src/lib/ghl.ts`'s `verifyGhlSignature`
 * JSDoc has the full argument).
 *
 * FAIL-CLOSED (copied from the Stripe route's exact structure): the webhook
 * public key (`GHL_WEBHOOK_PUBLIC_KEY`, via `ghlWebhookPublicKeyPem()`) set
 * -> verify or 400; unset + live mode -> 503 (never process an
 * unauthenticated request); unset + demo/dev -> warn and continue, so this
 * route is testable/dev-runnable with zero GHL env vars.
 *
 * ALWAYS 200 ONCE THE SIGNATURE PASSED (plan's D3, restated): every outcome
 * `handleProviderOutboundMessage` can produce — ignored (non-SMS type,
 * unknown locationId, malformed payload), a duplicate, an accept, a pending
 * retry, or an inline refusal — returns 200 here. This portal owns retries
 * (the bridge's idempotency key + this route's own `(location_id,
 * ghl_message_id)` dedupe make a redelivery or a drain retry safe either
 * way) and deliberately never depends on GHL's own unknown retry semantics
 * (plan §6 risk 6). A non-200 from this route is reserved for "the request
 * itself could not be authenticated or parsed" — never for "the message
 * could not be sent", which the whole point of this design is to absorb
 * gracefully.
 *
 * ONE DELIBERATE EXCEPTION (adversarial-review finding 6): `{ kind: "error",
 * recorded: false }` — an unexpected repo failure BEFORE the intake row was
 * ever written, so nothing in our own system remembers this message
 * happened at all. This is the one case genuinely worth NOT absorbing
 * silently: unlike every other outcome, there is no ledger row for the drain
 * to pick up later, so a 200 here would just lose the message. GHL's retry
 * behaviour is still unknown/undepended-on in general, but a 502 here costs
 * nothing and gives GHL a chance to redeliver into a (hopefully by then
 * healthy) repo — strictly better than the alternative of certain silent
 * loss. `{ kind: "error", recorded: true }` (the row DOES exist) still
 * returns 200 — the drain owns that row from here, same as every other
 * post-intake outcome.
 */
import { NextResponse, type NextRequest } from "next/server";
import { repo } from "@/lib/data";
import { ghlWebhookPublicKeyPem, verifyGhlSignature } from "@/lib/ghl";
import { handleProviderOutboundMessage, type GhlProviderOutboundPayload } from "@/lib/ghl-provider";

/** The send can wait on the bridge and GHL, and the not-on-WhatsApp fire runs in `after()`; same ceiling as the cron route. */
export const maxDuration = 300;

export async function POST(request: NextRequest) {
  const rawBody = await request.text();
  const publicKeyPem = ghlWebhookPublicKeyPem();

  if (publicKeyPem) {
    const signatureHeader = request.headers.get("x-ghl-signature");
    if (!verifyGhlSignature(rawBody, signatureHeader, publicKeyPem)) {
      console.warn("[webhooks/crm-provider] signature verification failed");
      return NextResponse.json({ ok: false, error: "invalid_signature" }, { status: 400 });
    }
  } else {
    // No webhook key configured: never process an unauthenticated request
    // (mirrors the Stripe webhook route exactly).
    return NextResponse.json({ ok: false, error: "GHL_WEBHOOK_PUBLIC_KEY not configured" }, { status: 503 });
  }

  let payload: GhlProviderOutboundPayload;
  try {
    payload = JSON.parse(rawBody) as GhlProviderOutboundPayload;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json_body" }, { status: 400 });
  }

  const result = await handleProviderOutboundMessage(repo, payload);
  if (result.kind === "error" && !result.recorded) {
    // See this file's header — the one case worth letting GHL retry.
    return NextResponse.json({ ok: false, error: "internal_error" }, { status: 502 });
  }
  return NextResponse.json({ ok: true, result });
}

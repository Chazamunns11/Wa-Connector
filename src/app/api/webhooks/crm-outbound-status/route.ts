/**
 * POST /api/webhooks/crm-outbound-status — the bridge's contentless "drain
 * now" poke for GHL outbound delivery statuses (docs/GHL-PROVIDER-PLAN.md,
 * file list #14). Near-verbatim sibling of
 * `src/app/api/webhooks/whatsapp-replies/route.ts` — see that route's own
 * header for the full "the DB is the transport, this route carries no data"
 * argument, which applies identically here: the bridge writes to
 * `whatsapp_messages` with its own service-role client BEFORE ever calling
 * this route (`src/sessions.ts`'s dispatch path, via a second `PortalPoke`
 * instance), and this endpoint's only job is "go drain whatever's already
 * resolved". A forged/replayed request to this route is harmless by
 * construction — the worst it can do is ask the portal to re-run
 * `drainGhlOutboundStatuses` (src/lib/ghl-provider.ts) a moment early, an
 * idempotent no-op unless there is genuinely something unreported to report.
 *
 * AUTH: the SAME `WHATSAPP_INBOUND_POKE_SECRET` the inbound poke route uses
 * (plan's file list #14 — "one bridge->portal trust link; the name is
 * historical"). The bridge's `PORTAL_OUTBOUND_URL` pairs with its EXISTING
 * `WA_INBOUND_POKE_SECRET` rather than a second secret
 * (`services/whatsapp-bridge/src/config.ts`) — one shared secret authorises
 * both poke directions. Same constant-time Bearer compare, same
 * unset-in-live-mode 503 / unset-in-demo warn-and-continue fallback as every
 * other cron/webhook route in this codebase.
 *
 * HARD RULE 6 (works with no bridge): this route existing and never being
 * called changes nothing — the hourly reminders cron
 * (src/app/api/cron/reminders/route.ts) runs the SAME drain unconditionally.
 * A poke is a latency optimisation (seconds instead of up to an hour), never
 * a delivery guarantee.
 */
import { timingSafeEqual } from "crypto";
import { NextResponse } from "next/server";
import { repo } from "@/lib/data";
import { drainGhlOutboundStatuses } from "@/lib/ghl-provider";
import { releaseHeldOutboundMessages } from "@/lib/ghl-held";

/** Verbatim copy of `GET /api/cron/reminders`'s identical helper (same rationale as `whatsapp-replies/route.ts`'s own copy — small enough that duplicating beats a shared import for one function). */
function constantTimeEqualStr(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, "utf8");
  const bBuf = Buffer.from(b, "utf8");
  return aBuf.length === bBuf.length && timingSafeEqual(aBuf, bBuf);
}

/** Release (25 s budget) then status drain (25 s budget) run back to back; same ceiling as the cron route. */
export const maxDuration = 300;

export async function POST(request: Request) {
  const secret = process.env.WHATSAPP_INBOUND_POKE_SECRET;

  if (secret) {
    const authHeader = request.headers.get("authorization");
    if (!authHeader || !constantTimeEqualStr(authHeader, `Bearer ${secret}`)) {
      return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
    }
  } else {
    return NextResponse.json({ ok: false, error: "WHATSAPP_INBOUND_POKE_SECRET not configured" }, { status: 503 });
  }

  // Body ignored entirely — see file header. The bridge always sends "{}".
  // A reconnect poke releases held messages first (the release never trusts
  // the DB session status; the bridge's live answer decides), then drains.
  await releaseHeldOutboundMessages(repo);
  const result = await drainGhlOutboundStatuses(repo);
  return NextResponse.json({ ok: true, ...result });
}

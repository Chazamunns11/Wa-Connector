/**
 * POST /api/webhooks/whatsapp-replies — the bridge's contentless "drain now"
 * poke (inbound WhatsApp replies package, BATCH 2). See the architecture
 * plan's §1 "the DB is the transport" decision and
 * supabase/migrations/0048_whatsapp_inbound.sql's file header for the full
 * argument; the short version:
 *
 * THIS ROUTE CARRIES NO DATA. The bridge writes reply rows directly to
 * Supabase with its own service-role client BEFORE it ever calls this route
 * (services/whatsapp-bridge/src/poke.ts's `PortalPoke` always POSTs an empty
 * `"{}"` body) — this endpoint's only job is "go drain whatever's already
 * there". That makes a forged/replayed request to this route harmless by
 * construction: the worst it can do is ask the portal to re-run
 * `processInboundWhatsappReplies` (src/lib/whatsapp-replies.ts) a moment
 * early, which is a no-op idempotent drain, never a way to manufacture a
 * reply, cancel a run, or fire a trigger that a real service-role write
 * didn't already justify. Hard rule 1 (a forged reply must be impossible) is
 * satisfied by the DATA MODEL, not by this route's auth — the auth below
 * exists purely to stop drive-by load from hitting this route for free.
 *
 * AUTH: `WHATSAPP_INBOUND_POKE_SECRET`, constant-time Bearer compare — copies
 * `GET /api/cron/reminders`'s `constantTimeEqualStr` helper verbatim (same
 * rationale as that route's own copy of `GET /api/cron/weekly`'s: small
 * enough that duplicating beats introducing a shared import for one
 * function). Unset in live mode -> 503 "unconfigured", never processes an
 * unauthenticated request; unset in demo/dev -> warns and continues (mirrors
 * every other cron/webhook route in this codebase). Must match the bridge's
 * OWN `WA_INBOUND_POKE_SECRET` (services/whatsapp-bridge/.env.example) — the
 * two are validated independently on each side, ≥32 chars there, and this
 * route treats a shorter configured value as a caller mistake, not a security
 * boundary it needs to enforce itself (the bridge already refuses to boot
 * with a short one).
 *
 * HARD RULE 6 (works with no bridge): this route existing and never being
 * called changes nothing — `PORTAL_INBOUND_URL`/`WA_INBOUND_POKE_SECRET` are
 * both optional on the bridge side, and the hourly reminders cron
 * (src/app/api/cron/reminders/route.ts) runs the SAME drain unconditionally
 * regardless of whether a single poke ever arrives. A poke is a latency
 * optimisation (seconds instead of up to an hour), never a delivery
 * guarantee and never the only path a reply gets processed through.
 *
 * GHL PROVIDER PHASE 3 (docs/GHL-PROVIDER-PLAN.md's Phase 3 follow-on) — the
 * bridge's ONE inbound poke already fires identically for every session
 * kind (`processInboundBatch` is wired the same way for a coach tenant and a
 * `ghl_location` tenant — `services/whatsapp-bridge/src/sessions.ts` never
 * branches on tenant kind when scheduling it), so this route simply calls
 * BOTH drains: `processInboundWhatsappReplies` for coach-tenant rows (as
 * before) and `drainGhlInboundReplies` for GHL-tenant rows (new). No bridge
 * change needed — the poke was always kind-agnostic; only the portal side
 * had nowhere to send a GHL-tenant row until now.
 */
import { timingSafeEqual } from "crypto";
import { NextResponse } from "next/server";
import { repo } from "@/lib/data";
import { drainGhlInboundReplies } from "@/lib/ghl-inbound";
import { defaultGhlProviderDeps } from "@/lib/ghl-provider";
import { defaultTriggerDeps, isWorkflowTriggersEnabled } from "@/lib/ghl-triggers";
import { defaultSessionTriggerDeps, drainSessionTriggers } from "@/lib/session-triggers";

/** Verbatim copy of `GET /api/cron/reminders`'s identical helper — see that route's own comment for why this is duplicated rather than shared. */
function constantTimeEqualStr(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, "utf8");
  const bBuf = Buffer.from(b, "utf8");
  return aBuf.length === bBuf.length && timingSafeEqual(aBuf, bBuf);
}

export async function POST(request: Request) {
  const secret = process.env.WHATSAPP_INBOUND_POKE_SECRET;

  if (secret) {
    const authHeader = request.headers.get("authorization");
    if (!authHeader || !constantTimeEqualStr(authHeader, `Bearer ${secret}`)) {
      return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
    }
  } else {
    // No secret configured: never process an unauthenticated request
    // (mirrors GET /api/cron/reminders/weekly/monthly exactly).
    return NextResponse.json({ ok: false, error: "WHATSAPP_INBOUND_POKE_SECRET not configured" }, { status: 503 });
  }

  // Deliberately ignores the request body entirely (see file header — the
  // bridge always sends "{}", but this route wouldn't read it even if it
  // carried something, since a poke's whole point is that it can't).
  // Only the GHL-tenant drain runs here: every tenant in this app is a GHL
  // location (PortalHub's coach drain, processInboundWhatsappReplies, is
  // Hub-only). Same no-data poke, same never-throws contract.
  const ghlInboundReplies = await drainGhlInboundReplies(repo);
  // The bridge also pokes on every connection open or close: check the
  // disconnected / reconnected triggers (flag-gated, never throws into the poke).
  let sessionTriggers = { fired: 0 };
  if (isWorkflowTriggersEnabled()) {
    try {
      sessionTriggers = await drainSessionTriggers(repo, defaultSessionTriggerDeps(defaultTriggerDeps(defaultGhlProviderDeps)));
    } catch {
      console.error("[whatsapp-replies] session trigger drain failed (non-fatal)");
    }
  }
  return NextResponse.json({ ok: true, ghlInboundReplies, sessionTriggers });
}

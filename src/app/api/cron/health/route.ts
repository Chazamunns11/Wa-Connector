/**
 * GET /api/cron/health — the health endpoint and the 5-minute scheduled check
 * (vercel.json). Checks the bridge, every installed location's HighLevel
 * connection and every WhatsApp number, emails the coach and the operator
 * when one drops (src/lib/session-alerts.ts), and returns a per-location
 * report: statuses only, never a phone number or a token.
 *
 * Auth: `Authorization: Bearer $CRON_SECRET`, the same as /api/cron/drain
 * (Vercel cron sends it). 503 when unset. HTTP 200 with `ok: false` when
 * something is down, so an uptime monitor can alert on the body, and 500
 * only if the check itself could not run.
 */
import { timingSafeEqual } from "crypto";
import { NextResponse, type NextRequest } from "next/server";
import { repo } from "@/lib/data";
import { getWhatsappBridgeHealth, isWhatsappBridgeConfigured } from "@/lib/whatsapp-bridge";
import { operatorAlertEmails, sendEmail } from "@/lib/email";
import { runHealthCheck } from "@/lib/session-alerts";
import { defaultSessionTriggerDeps } from "@/lib/session-triggers";
import { defaultTriggerDeps } from "@/lib/ghl-triggers";
import { defaultGhlProviderDeps } from "@/lib/ghl-provider";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

function constantTimeEqualStr(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, "utf8");
  const bBuf = Buffer.from(b, "utf8");
  return aBuf.length === bBuf.length && timingSafeEqual(aBuf, bBuf);
}

export async function GET(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) return NextResponse.json({ ok: false, error: "CRON_SECRET not configured" }, { status: 503 });
  const authHeader = request.headers.get("authorization");
  if (!authHeader || !constantTimeEqualStr(authHeader, `Bearer ${cronSecret}`)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  try {
    const reconnect = defaultSessionTriggerDeps(defaultTriggerDeps(defaultGhlProviderDeps));
    const report = await runHealthCheck(repo, {
      bridgeConfigured: isWhatsappBridgeConfigured,
      bridgeHealthy: async () => (await getWhatsappBridgeHealth()).ok === true,
      sendEmail,
      operatorEmails: operatorAlertEmails,
      reconnectUrl: reconnect.reconnectUrl,
      notify: defaultGhlProviderDeps.notify,
    });
    if (!report.ok) console.warn(`[cron/health] not healthy: bridge reachable=${report.bridge.reachable}, alerts sent ${report.alertsSent}, errors ${report.errors}`);
    return NextResponse.json(report);
  } catch (err) {
    console.error("[cron/health] check failed:", err);
    return NextResponse.json({ ok: false, error: "health_check_failed" }, { status: 500 });
  }
}

/**
 * POST /api/webhooks/billing — Stripe's webhook endpoint. RAW BODY FIRST:
 * `await request.text()` runs before any JSON parsing because Stripe signs the
 * exact bytes it sent. Fail-closed: no `STRIPE_WEBHOOK_SECRET` -> 503. A bad
 * signature -> 400. `unknown_account` still returns 200 (a Stripe retry cannot
 * help); a thrown error returns 500 so Stripe retries.
 */
import { NextResponse, type NextRequest } from "next/server";
import { repo } from "@/lib/data";
import { notifyText } from "@/lib/slack";
import { verifyStripeSignature } from "@/lib/stripe/webhook";
import {
  endTrialNow,
  resumeSubscription,
  retrieveCheckoutSession,
  retrieveSubscription,
  setCustomerDefaultPaymentMethod,
  setSubscriptionDefaultPaymentMethod,
  setSubscriptionItemQuantity,
} from "@/lib/stripe/billing";
import { applyCardSetup } from "@/lib/billing/card";
import { handleBillingEvent, type StripeEvent } from "@/lib/billing/webhook-handler";
import { syncSubscriptionQuantity } from "@/lib/billing/quantity";
import { applyCheckoutSession } from "@/lib/billing/onboard";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const rawBody = await request.text();
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    return NextResponse.json({ ok: false, error: "STRIPE_WEBHOOK_SECRET not configured" }, { status: 503 });
  }
  if (!verifyStripeSignature(rawBody, request.headers.get("stripe-signature"), secret)) {
    console.warn("[webhooks/billing] signature verification failed");
    return NextResponse.json({ ok: false, error: "invalid_signature" }, { status: 400 });
  }

  let event: StripeEvent;
  try {
    event = JSON.parse(rawBody) as StripeEvent;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json_body" }, { status: 400 });
  }
  if (typeof event?.id !== "string" || typeof event?.type !== "string" || !event.data?.object) {
    return NextResponse.json({ ok: false, error: "invalid_event" }, { status: 400 });
  }

  const notify = (text: string) => {
    void notifyText(text);
  };
  try {
    const outcome = await handleBillingEvent(
      repo,
      {
        applyCheckout: (session) => applyCheckoutSession(repo, session),
        applyCardSetup: (session) =>
          applyCardSetup(
            repo,
            {
              retrieveSubscription,
              setCustomerDefault: setCustomerDefaultPaymentMethod,
              setSubscriptionDefault: setSubscriptionDefaultPaymentMethod,
              resume: resumeSubscription,
              endTrial: endTrialNow,
            },
            session,
          ),
        retrieveCheckoutSession,
        retrieveSubscription,
        syncQuantity: (account) =>
          syncSubscriptionQuantity(repo, { retrieveSubscription, setQuantity: setSubscriptionItemQuantity, notify }, account),
        notify,
      },
      event,
    );
    return NextResponse.json({ ok: true, outcome });
  } catch (err) {
    console.error("[webhooks/billing] handler failed:", err instanceof Error ? err.message : "unknown error");
    return NextResponse.json({ ok: false, error: "handler_failed" }, { status: 500 });
  }
}

import { createHmac, timingSafeEqual } from "node:crypto";

/** Verify a Stripe-Signature header against the raw request body. */
export function verifyStripeSignature(
  rawBody: string,
  header: string | null,
  secret: string,
  nowSec = Math.floor(Date.now() / 1000),
  toleranceSec = 300,
): boolean {
  if (!header || !secret) return false;
  let t: string | null = null;
  const sigs: string[] = [];
  for (const part of header.split(",")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k === "t") t = v;
    else if (k === "v1") sigs.push(v);
  }
  if (!t || !/^\d+$/.test(t) || sigs.length === 0) return false;
  if (Math.abs(nowSec - Number(t)) > toleranceSec) return false;
  const expected = Buffer.from(createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex"));
  let ok = false;
  for (const s of sigs) {
    const got = Buffer.from(s);
    if (got.length === expected.length && timingSafeEqual(got, expected)) ok = true;
  }
  return ok;
}

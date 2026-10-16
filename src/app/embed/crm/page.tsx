import { nowMs } from "@/lib/data";
import { brandConfig } from "@/lib/brand-config";
import { isWhatsappBridgeConfigured } from "@/lib/whatsapp-bridge";
import { isGhlEmbedConfigured } from "@/lib/ghl-embed";
import { CrmEmbedClient } from "./CrmEmbedClient";

/**
 * `/embed/crm` — rendered inside GoHighLevel's own left nav via the
 * marketplace app's "Custom Page" module (an iframe). Its whole reason to
 * exist: a GHL sub-account client has no login to the FitClosers portal, so
 * this is the only way they can reach their own WhatsApp QR — see
 * `src/lib/ghl-embed.ts`'s header for the full SSO mechanism and the
 * security rationale (a WhatsApp QR is a device-link grant, same severity as
 * a password).
 *
 * NOT IN THE URL PATH BY NAME: this route deliberately does not contain the
 * string "ghl" — GHL's own marketplace app validator rejects a Custom Page
 * URL that does (confirmed against the same validator that rejected the
 * OAuth routes' original `/api/ghl/*` naming — see `src/lib/ghl.ts`'s own
 * history). `/embed/crm` and its API counterpart `/api/crm/embed/*` are the
 * workaround, matching the existing `/api/crm/oauth/*` naming.
 *
 * RENDERS NOTHING SENSITIVE PRE-AUTH, AND MAKES ZERO NETWORK CALLS OF ITS OWN
 * (adversarial review lens 4, finding 4 — MINOR, fixed). This server
 * component never sees a GHL user's identity, a location id, a WhatsApp
 * session summary, or anything else that depends on the (client-side-only)
 * SSO handshake — it hands the client component three plain env booleans and
 * a timestamp, nothing more. It used to ALSO run the bridge's `/health` probe
 * on every render (`getWhatsappBridgeHealth()`) — meaning every anonymous GET
 * of this public URL cost one outbound Railway request with a 5s timeout,
 * whether or not anyone behind it ever completed a handshake, plus disclosed
 * `bridgeReachable` in the RSC payload before any authentication had
 * happened at all. That probe now lives in `POST /api/crm/embed/session`
 * instead (`bridgeReachable` rides in that route's response alongside
 * `token`/`summary`) — see that route's own header, "THE BRIDGE-HEALTH PROBE
 * LIVES HERE" — so it only ever fires once a real GHL-signed payload has
 * decrypted to a genuinely active, installed location. Every genuinely
 * sensitive read still happens only after `CrmEmbedClient` has decrypted
 * GHL's own signed payload.
 *
 * `dynamic = "force-dynamic"`: this must never be statically prerendered —
 * `isLiveMode()`/`isGhlEmbedConfigured()`/`isWhatsappBridgeConfigured()` all
 * need to reflect THIS deployment's current env, not whatever was true at
 * build time.
 */
export const dynamic = "force-dynamic";

export default async function GhlEmbedCrmPage() {
  const embedConfigured = isGhlEmbedConfigured();
  const bridgeConfigured = isWhatsappBridgeConfigured();

  return (
    <div className="min-h-screen bg-bg p-4 sm:p-6">
      <div className="mx-auto flex max-w-lg flex-col gap-4">
        <CrmEmbedClient embedConfigured={embedConfigured} bridgeConfigured={bridgeConfigured} nowMs={nowMs()} brandName={brandConfig().name} />
      </div>
    </div>
  );
}

import { headers } from "next/headers";
import { Wordmark } from "@/components/shell/Wordmark";
import { Card } from "@/components/ui/Card";
import { repo, nowMs } from "@/lib/data";
import { normaliseHex } from "@/lib/brand";
import { isConnectLinkConfigured, verifyConnectLinkToken } from "@/lib/ghl-connect-link";
import { isWhatsappBridgeConfigured } from "@/lib/whatsapp-bridge";
import { checkConnectSessionThrottle } from "@/lib/connect-throttle";
import { clientIpFromHeaders } from "@/lib/client-ip";
import { ConnectLinkClient } from "./ConnectLinkClient";

interface PageProps {
  params: Promise<{ token: string }>;
}

/**
 * /connect/[token] — the per-client connect-link feature's public landing
 * page (docs/GHL-PROVIDER-CLIENT-MIGRATION.md, src/lib/ghl-connect-link.ts).
 * Charlie mints a link per GHL location in the owner panel and sends it to
 * that client — this is what they land on. PUBLIC, UNAUTHENTICATED,
 * REACHABLE BY ANYONE HOLDING THE URL (src/proxy.ts's own comment block notes
 * this alongside `/onboard/[token]`/`/signup` for the identical shape of
 * reason — no session exists yet at this route).
 *
 * A CONNECT LINK IS A BEARER CREDENTIAL, PASSWORD-RESET-LINK SEVERITY — see
 * `src/lib/ghl-connect-link.ts`'s header for the full threat model. This
 * page's own job is narrow: turn a token into one of five honest states
 * (not-available-here / expired / revoked / invalid / disabled) or, for a
 * genuinely live link, hand off to `ConnectLinkClient` with nothing more than
 * the token and a display label.
 *
 * NEVER PARSES THE TOKEN IF THE DEPLOYMENT ISN'T EVEN CONFIGURED. The three
 * config gates (`isConnectLinkConfigured()`/`isLiveMode()`/
 * `isWhatsappBridgeConfigured()`) are checked FIRST, before
 * `verifyConnectLinkToken` is ever called — an unconfigured deployment must
 * render the same generic "not available here" card regardless of whether
 * the token in the URL happens to be well-formed, expired, or garbage, so
 * that card can never become an oracle for "is this token shaped right" on a
 * deployment where nothing can be verified against anyway.
 *
 * SERVER-SIDE VERIFICATION HERE IS FOR CARD SELECTION ONLY — NOTHING
 * SENSITIVE RIDES IN THE RENDER, AND NO BRIDGE PROBE HAPPENS HERE. This
 * component re-reads the account (same fresh, per-request read
 * `POST /api/connect/session` and every `/api/connect/*` guard call also
 * performs — never cached, never trusted across requests) purely to decide
 * WHICH of the five cards to show, so a client never sees a flash of
 * "Connecting…" for a link that is obviously already expired/revoked. It
 * does NOT mint a session token, fetch a WhatsApp summary, or probe the
 * bridge's health — `ConnectLinkClient` does its OWN full verification via
 * `POST /api/connect/session` on mount regardless of what this server
 * component decided, exactly mirroring `CrmEmbedClient.tsx`'s posture of
 * never trusting a prior check. What's ever handed to the client component is
 * the raw `token` (already public — it is the URL itself), `label` (already
 * public-adjacent — it identifies WHICH business this link is for, the same
 * information Charlie already put in the message he sent alongside the
 * link), and — W-CONNECT-BRAND, migration 0076 — `brandLogoPath`/
 * `brandAccentColor`, which are exactly as public-adjacent as `label`: a
 * client's own logo path and accent colour identify their OWN business, not
 * anyone else's, and are never sensitive in the way a token or a WhatsApp
 * summary would be. Nothing here re-derives them from anywhere but this same
 * fresh `account` read.
 *
 * `dynamic = "force-dynamic"` — same reasoning as `/embed/crm`'s page: this
 * must never be statically prerendered, since every env boolean and every
 * database read here needs to reflect the CURRENT deployment/account state,
 * not whatever was true at build time.
 *
 * THROTTLED, SAME LIMITER AS `POST /api/connect/session` — adversarial
 * review lens 5, finding 7a (MINOR, fixed). This page used to be the
 * cheapest surface in the whole feature to hammer: a full HMAC verify PLUS a
 * database read on EVERY hit, entirely unthrottled, while the session-exchange
 * route sitting right next to it was already rate-limited. `checkConnectSessionThrottle`
 * (src/lib/connect-throttle.ts) is called here too, keyed by `(ip, token)` —
 * the route param makes the token trivially available before ANY work at
 * all, so unlike `POST /api/connect/session` there is no ordering trade to
 * make: throttle runs first, before even `verifyConnectLinkToken`.
 */
export const dynamic = "force-dynamic";

export default async function ConnectPage({ params }: PageProps) {
  const { token } = await params;

  if (!isConnectLinkConfigured() || !isWhatsappBridgeConfigured()) {
    return (
      <ConnectShell>
        <StateCard
          title="This link isn't available on this deployment"
          description="WhatsApp connect links aren't switched on here yet. If you were expecting this to work, get in touch with whoever sent you this link."
        />
      </ConnectShell>
    );
  }

  const ip = clientIpFromHeaders(await headers());
  const throttle = checkConnectSessionThrottle(ip, token);
  if (!throttle.allowed) {
    return (
      <ConnectShell>
        <StateCard
          title="Too many attempts"
          description={`Try again in about ${throttle.retryAfterSeconds} seconds.`}
        />
      </ConnectShell>
    );
  }

  const verified = verifyConnectLinkToken(token);
  if (!verified.ok) {
    if (verified.reason === "expired") {
      return (
        <ConnectShell>
          <StateCard title="This link has expired" description="Ask whoever sent you this link for a fresh one." />
        </ConnectShell>
      );
    }
    // wrong_kind / invalid / missing_state_secret — deliberately one generic
    // card, same "never confirm what this token was supposed to be" posture
    // as `POST /api/connect/session`'s own identical fold (see that route's
    // own header).
    return (
      <ConnectShell>
        <StateCard title="This link isn't valid" description="Double-check the link, or ask whoever sent it to you for a fresh one." />
      </ConnectShell>
    );
  }

  // Fresh, per-request re-read — see this file's header. A missing row gets
  // the SAME generic card as an invalid token, for the same "never confirm a
  // location exists" reason `POST /api/connect/session` documents.
  const account = await repo.getGhlAccountByLocationId(verified.locationId);
  if (!account) {
    return (
      <ConnectShell>
        <StateCard title="This link isn't valid" description="Double-check the link, or ask whoever sent it to you for a fresh one." />
      </ConnectShell>
    );
  }

  if (account.connectLinkVersion === null || verified.v !== account.connectLinkVersion) {
    return (
      <ConnectShell accentColor={account.brandAccentColor}>
        <StateCard title="This link has been revoked" description="Ask whoever sent you this link for a fresh one." />
      </ConnectShell>
    );
  }

  if (account.status === "disabled") {
    return (
      <ConnectShell accentColor={account.brandAccentColor}>
        <StateCard
          title="WhatsApp connecting is switched off"
          description="An operator has disabled this for now. Get in touch with whoever sent you this link if you think that's a mistake."
        />
      </ConnectShell>
    );
  }

  return (
    <ConnectShell wide accentColor={account.brandAccentColor}>
      <ConnectLinkClient
        token={token}
        label={account.label}
        nowMs={nowMs()}
        brandLogoPath={account.brandLogoPath}
        brandAccentColor={account.brandAccentColor}
      />
    </ConnectShell>
  );
}

/**
 * Shared page chrome — mirrors `/onboard/[token]`'s centered, branded shell.
 * `wide` gives the ready-state client component (which renders the full
 * connect panel, not just a short message) a little more room than the
 * fixed-state cards need.
 *
 * `accentColor` — adversarial review lens 5, finding 11 (MINOR, fixed). The
 * ambient `bg-accent/10` blur below used to read the GLOBAL `--color-accent`
 * unconditionally, because this component sits OUTSIDE
 * `ConnectLinkClient.tsx`'s own styled wrapper (that component sets the same
 * variable on its own inner `<div>` via `brandStyle()`, which this glow —
 * rendered by this SERVER component, one level up — never inherits from). A
 * purple-branded client's page showed a teal halo behind their own purple
 * card. Passed only where a fresh `account` read is actually in hand (the
 * revoked/disabled/ready branches below) — the not-configured/expired/
 * invalid branches above have no account to brand with yet, and correctly
 * keep the default teal glow. Re-normalised here rather than trusted from
 * the caller, same defence-in-depth posture `ConnectLinkClient.tsx` and
 * `ConnectBrandHeader.tsx` both already take with this exact value.
 */
function ConnectShell({
  children,
  wide = false,
  accentColor = null,
}: {
  children: React.ReactNode;
  wide?: boolean;
  accentColor?: string | null;
}) {
  const normalisedAccent = normaliseHex(accentColor);
  return (
    <main
      className="relative flex min-h-screen flex-col items-center gap-10 overflow-hidden bg-bg px-4 py-16"
      style={normalisedAccent ? ({ "--color-accent": normalisedAccent } as React.CSSProperties) : undefined}
    >
      <div className="relative flex flex-col items-center gap-2">
        <Wordmark size="lg" />
      </div>
      <div className={`relative w-full ${wide ? "max-w-lg" : "max-w-sm"}`}>{children}</div>
    </main>
  );
}

function StateCard({ title, description }: { title: string; description: string }) {
  return (
    <Card>
      <div className="flex flex-col items-center gap-3 text-center">
        <span className="flex h-12 w-12 items-center justify-center rounded-full border border-border bg-raised text-xl">
          🔗
        </span>
        <h1 className="font-display text-xl font-bold text-ink">{title}</h1>
        <p className="text-sm text-ink-faint">{description}</p>
      </div>
    </Card>
  );
}

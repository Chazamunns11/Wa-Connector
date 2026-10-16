import type { NextConfig } from "next";
import { parseGhlEmbedFrameAncestors } from "./src/lib/csp";

const nextConfig: NextConfig = {
  // Copied from PortalHub next.config.ts: `serverActions.bodySizeLimit` — the
  // GHL logo upload goes through a Server Action (saveGhlAccountBrandingAction,
  // src/app/admin/actions.ts), and "Action requests are capped at 1MB by
  // default" (node_modules/next/dist/docs/01-app/02-guides/server-actions.md).
  // The app's own cap is `MAX_LOGO_BYTES` = 2 MiB (src/lib/brand.ts), so the
  // framework cap must sit ABOVE it — 3mb covers the multipart overhead —
  // or `storeGhlAccountLogo`'s friendly size message is unreachable.
  experimental: {
    serverActions: {
      bodySizeLimit: "3mb",
    },
  },

  // Framing/referrer headers for the two pages GHL renders inside its own
  // iframe. Copied from PortalHub next.config.ts; the Hub-only `/book/:path*`
  // entry is not copied.
  async headers() {
    return [
      {
        // GHL Custom Page embed (src/app/embed/crm) — the exact opposite
        // framing posture from /book/:path* above. That route WANTS to be
        // embeddable anywhere (a public booking widget). This one renders a
        // WhatsApp QR — a device-link grant, same severity as a password
        // (see src/lib/ghl-embed.ts's header) — so clickjacking it (loading
        // it in an attacker's own invisible/disguised iframe to trick a
        // click) is exactly the attack a restrictive `frame-ancestors` list
        // exists to close. Deliberately NEVER `frame-ancestors *`: an
        // unpinned wildcard would let ANY origin frame this page, defeating
        // the point entirely.
        //
        // The three GHL hosts below are that org's own documented app/API
        // domains. `GHL_EMBED_FRAME_ANCESTORS` is an optional, additional,
        // space-separated list of extra origins — needed because GHL is
        // white-labelled: an agency can serve their own Custom Page iframe
        // from a domain of their choosing (e.g. app.theiragencyname.com),
        // which cannot be enumerated ahead of time. An operator adds that
        // agency's domain here once a client on a whitelabel domain reports
        // the page refusing to load.
        //
        // VALIDATED, NOT INTERPOLATED RAW (adversarial review lens 4,
        // finding 11 — MINOR, fixed). This used to splice
        // `GHL_EMBED_FRAME_ANCESTORS` straight into the header string — a
        // value containing `;` could append arbitrary CSP directives (CSP is
        // semicolon-delimited), and a bare `*` would silently defeat this
        // entire allowlist. `parseGhlEmbedFrameAncestors` (src/lib/csp.ts)
        // validates every space-separated entry against a strict
        // https-origin-with-at-most-one-wildcard-label pattern and silently
        // drops anything that fails it, so a typo'd or hostile env var
        // narrows or no-ops this line rather than ever widening it.
        //
        // DEPLOY-TIME, NOT RUNTIME: next.config.ts env reads are baked in at
        // build time on Vercel (node_modules/next/dist/docs/01-app —
        // environment variables are inlined during `next build`), so adding
        // a whitelabel domain to this env var requires a redeploy before it
        // takes effect — it is not a hot-reloadable runtime setting.
        source: "/embed/crm",
        headers: [
          {
            key: "Content-Security-Policy",
            value: (() => {
              const extra = parseGhlEmbedFrameAncestors(process.env.GHL_EMBED_FRAME_ANCESTORS);
              return `frame-ancestors https://app.gohighlevel.com https://*.gohighlevel.com https://*.leadconnectorhq.com${
                extra.length ? ` ${extra.join(" ")}` : ""
              }`;
            })(),
          },
        ],
      },
      {
        // Per-client connect links (docs/GHL-PROVIDER-CLIENT-MIGRATION.md,
        // src/lib/ghl-connect-link.ts) — `/connect/[token]` renders a
        // WhatsApp QR to an UNAUTHENTICATED visitor holding nothing but a
        // URL (see that file's header: a connect link is a bearer credential
        // with password-reset-link severity).
        //
        // adversarial review lens 5, finding 2 — MAJOR, fixed. This used to
        // be `frame-ancestors 'none'`, on the reasoning "possession of the
        // link IS the entire authorization, so there is no legitimate frame
        // this should ever render inside". That reasoning was wrong about how
        // this page is actually deployed: Charlie installs a client's minted
        // URL as a CUSTOM MENU LINK in that client's own GHL sidebar (see
        // docs/GHL-PROVIDER-CLIENT-MIGRATION.md's install step), and GHL
        // renders every custom menu link inside its own iframe unless the
        // operator explicitly ticks "open in new tab" when adding it.
        // `'none'` therefore broke this page in its OWN PRIMARY DEPLOYMENT —
        // a client clicking the menu item Charlie set up for them would see
        // an empty pane and a console-only CSP error, with nothing on screen
        // telling either of them why.
        //
        // NOW MIRRORS `/embed/crm` ABOVE: the same GHL host allowlist plus
        // the same validated, operator-extensible `GHL_EMBED_FRAME_ANCESTORS`
        // list (`parseGhlEmbedFrameAncestors`, src/lib/csp.ts — silently
        // drops anything that isn't a clean `https://` origin with at most
        // one leading `*.` wildcard, so a typo'd or hostile env var can only
        // narrow or no-op this line, never widen it past the allowlist
        // shape). Reusing the SAME env var as the embed rather than a
        // connect-specific one is deliberate: both surfaces need exactly the
        // same thing from an operator ("my agency serves GHL from our own
        // whitelabel domain"), and a client on a whitelabel domain not yet in
        // the allowlist affects both surfaces identically, so one list to
        // maintain is more honest than two that could drift apart.
        // Deliberately NEVER `frame-ancestors *` — see the embed header's
        // identical note just above.
        //
        // WHY THIS IS SAFE, NOT JUST CONVENIENT: this page's own security
        // property was never "cannot be framed" — it was always "possession
        // of the link IS the authorization" (this file's own header,
        // restated above). An attacker who can frame this page already HOLDS
        // the link, which is already full access to everything the page can
        // do; framing it adds no capability that having the URL didn't
        // already grant. Scoping `frame-ancestors` to GHL's own hosts (plus
        // an operator-vetted whitelabel list) closes clickjacking from an
        // ARBITRARY third-party page while accommodating the one frame this
        // feature actually needs to render inside for Charlie's real
        // install method to work at all.
        //
        // `Referrer-Policy: no-referrer` — the URL itself carries a
        // bearer-credential token in its path; a `Referer` header on any
        // outbound request this page makes (an image, a font, an analytics
        // beacon this app or a browser extension might add) would otherwise
        // leak that token to a third party's server logs. `no-referrer`
        // means this page never sends ANY `Referer` header, to anyone.
        //
        // `X-Robots-Tag: noindex, nofollow` — a search engine that somehow
        // crawled a leaked link (a public paste, a forwarded screenshot's
        // OCR'd URL, a misconfigured link preview bot) must never index it or
        // follow it into a crawl queue that could itself constitute
        // "someone other than the intended client opened this link".
        source: "/connect/:path*",
        headers: [
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Robots-Tag", value: "noindex, nofollow" },
          {
            key: "Content-Security-Policy",
            value: (() => {
              const extra = parseGhlEmbedFrameAncestors(process.env.GHL_EMBED_FRAME_ANCESTORS);
              return `frame-ancestors https://app.gohighlevel.com https://*.gohighlevel.com https://*.leadconnectorhq.com${
                extra.length ? ` ${extra.join(" ")}` : ""
              }`;
            })(),
          },
        ],
      },
    ];
  },
};

export default nextConfig;

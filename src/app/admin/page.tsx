import { redirect } from "next/navigation";
import { AccountsPanel } from "@/components/owner/AccountsPanel";
import { GhlAccountsPanel } from "@/components/owner/GhlAccountsPanel";
import { GhlHealthPanel } from "@/components/owner/GhlHealthPanel";
import { Wordmark } from "@/components/shell/Wordmark";
import { getSession } from "@/lib/auth";
import { repo, nowMs } from "@/lib/data";
import { safeGetGhlHealthSnapshot } from "@/lib/ghl-health";
import { getWhatsappBridgeHealth, isWhatsappBridgeConfigured } from "@/lib/whatsapp-bridge";

export const dynamic = "force-dynamic";

/**
 * `/admin` — the owner console. The GHL section of PortalHub
 * `src/app/owner/setup-links/page.tsx`, copied: the same `?ghl=` result
 * parsing, the same Promise.all reads, and the same two panels
 * (`GhlAccountsPanel`, `GhlHealthPanel`). Everything else on that page (coach
 * booking links, integration health, the coach WhatsApp panel, the AppShell
 * sidebar) is Hub-only.
 *
 * GHL OAuth round-trip result — `ghl` is the reason code
 * `.../api/crm/oauth/callback/route.ts` and `.../api/crm/oauth/start/route.ts`
 * redirect back with (their own `back()` helpers); `installed`/`failed`/
 * `capped` are ONLY ever plain counts that the bulk-install path adds
 * alongside its own reason codes. `GhlAccountsPanel`'s own result-banner map
 * is the full list of what `ghl` can be.
 */
export default async function AdminPage({
  searchParams,
}: {
  searchParams: Promise<{ ghl?: string; installed?: string; failed?: string; capped?: string }>;
}) {
  const { ghl, installed, failed, capped } = await searchParams;
  // User-controlled query params, however plain-looking — parsed
  // defensively rather than trusted: a tampered/garbage count
  // (`installed=abc`, a negative number, `NaN`) must degrade to "not shown"
  // rather than render nonsense in the banner below.
  const parseCount = (raw: string | undefined): number | undefined => {
    if (raw === undefined) return undefined;
    const n = Number(raw);
    return Number.isInteger(n) && n >= 0 ? n : undefined;
  };
  const ghlInstalledCount = parseCount(installed);
  const ghlFailedCount = parseCount(failed);
  const ghlCappedCount = parseCount(capped);

  // The proxy already bounced non-owners; every owner-only page re-checks its
  // own session so a future change to the proxy can never silently leave this
  // route unprotected.
  const session = await getSession();
  if (!session || session.role !== "owner") redirect("/login");

  // ONE bridge health probe for the whole page (never per-row), only attempted
  // when the bridge is configured at all.
  const whatsappBridgeConfigured = isWhatsappBridgeConfigured();
  const [whatsappSummaries, whatsappHealth, ghlAccounts, ghlHealth, accountRows] = await Promise.all([
    repo.getWhatsappSessionSummaries({ role: "owner" }),
    whatsappBridgeConfigured ? getWhatsappBridgeHealth() : Promise.resolve(null),
    repo.getGhlAccounts(),
    // Wrapped in `safeGetGhlHealthSnapshot` so a health-query failure renders
    // `GhlHealthPanel`'s own "health unavailable right now" card instead of
    // taking the whole page down.
    safeGetGhlHealthSnapshot(() => repo.getGhlHealthSnapshot()),
    repo.listAccountsForAdmin(),
  ]);
  const whatsappBridgeReachable = whatsappHealth === null ? null : whatsappHealth.ok;

  return (
    <main className="min-h-screen bg-bg px-4 py-8 sm:px-8">
      <div className="mx-auto flex max-w-5xl flex-col gap-6">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <Wordmark size="md" />
          <p className="text-sm text-ink-faint">Signed in as {session.email}</p>
        </header>

        <AccountsPanel rows={accountRows} />

        <GhlAccountsPanel
          accounts={ghlAccounts}
          summaries={whatsappSummaries}
          bridgeConfigured={whatsappBridgeConfigured}
          bridgeReachable={whatsappBridgeReachable}
          nowMs={nowMs()}
          result={ghl}
          installedCount={ghlInstalledCount}
          failedCount={ghlFailedCount}
          cappedCount={ghlCappedCount}
        />

        <GhlHealthPanel snapshot={ghlHealth} nowMs={nowMs()} />
      </div>
    </main>
  );
}

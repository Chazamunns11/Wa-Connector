import { unstable_cache } from "next/cache";
import { Wordmark } from "@/components/shell/Wordmark";
import { Card } from "@/components/ui/Card";
import { Chip, type ChipTone } from "@/components/ui/Chip";
import { brandConfig } from "@/lib/brand-config";
import { repo } from "@/lib/data";
import { safeGetGhlHealthSnapshot } from "@/lib/ghl-health";
import { buildPublicStatus, OVERALL_HEADLINE, type PublicServiceState, type PublicStatus } from "@/lib/public-status";
import { getWhatsappBridgeHealth, isWhatsappBridgeConfigured } from "@/lib/whatsapp-bridge";

/**
 * Public status page — unauthenticated, linked from the marketing site and
 * support replies. Shows one state per service and nothing about any
 * customer (see src/lib/public-status.ts for what may and may not appear).
 *
 * Rendered per request (no build-time prerender, which would bake in the
 * build machine's view), but the two reads behind it are cached for 60
 * seconds with `unstable_cache`
 * (node_modules/next/dist/docs/01-app/02-guides/caching-without-cache-components.md),
 * so an unauthenticated visitor refreshing the page can't turn it into a
 * stream of database queries and bridge probes.
 */
export const dynamic = "force-dynamic";

const STATUS_CACHE_SECONDS = 60;

const loadPublicStatus = unstable_cache(
  async (): Promise<PublicStatus & { checkedAt: string }> => {
    const [probe, snapshot] = await Promise.all([
      isWhatsappBridgeConfigured() ? getWhatsappBridgeHealth() : Promise.resolve(null),
      safeGetGhlHealthSnapshot(() => repo.getGhlHealthSnapshot()),
    ]);
    const status = buildPublicStatus(probe === null ? null : { ok: probe.ok === true }, snapshot);
    return { ...status, checkedAt: new Date().toISOString() };
  },
  ["public-status"],
  { revalidate: STATUS_CACHE_SECONDS }
);

const TONE: Record<PublicServiceState, ChipTone> = {
  operational: "win",
  degraded: "warn",
  down: "loss",
  unknown: "muted",
};

const LABEL: Record<PublicServiceState, string> = {
  operational: "Working",
  degraded: "Delayed",
  down: "Down",
  unknown: "Unknown",
};

export default async function StatusPage() {
  const status = await loadPublicStatus();
  const { name, supportEmail } = brandConfig();
  const checked = new Date(status.checkedAt).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" });

  return (
    <main className="flex min-h-screen flex-col items-center gap-8 bg-bg px-4 py-16">
      <Wordmark size="md" />

      <div className="flex flex-col items-center gap-2 text-center">
        <h1 className="font-display text-2xl font-bold text-ink">{OVERALL_HEADLINE[status.overall]}</h1>
        <p className="text-sm text-ink-faint">
          {name} status · checked at {checked} UTC · refreshes every minute
        </p>
      </div>

      <Card className="flex w-full max-w-lg flex-col divide-y divide-divider" padded={false}>
        {status.services.map((service) => (
          <div key={service.name} className="flex items-start justify-between gap-4 p-5">
            <div className="flex min-w-0 flex-col gap-1">
              <p className="text-sm font-semibold text-ink">{service.name}</p>
              <p className="text-sm text-ink-dim">{service.detail}</p>
            </div>
            <Chip tone={TONE[service.state]}>{LABEL[service.state]}</Chip>
          </div>
        ))}
      </Card>

      {supportEmail ? (
        <p className="max-w-lg text-center text-sm text-ink-faint">
          Something not working that this page doesn&apos;t show? Email <span className="text-ink-dim select-all">{supportEmail}</span>.
        </p>
      ) : null}
    </main>
  );
}

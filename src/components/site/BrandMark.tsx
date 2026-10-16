import { brandConfig } from "@/lib/brand-config";

/** Logo image when BRAND_LOGO_PATH is set, otherwise the name as a wordmark. */
export function BrandMark({ size = 24 }: { size?: number }) {
  const { name, logoPath } = brandConfig();
  if (logoPath) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- logoPath may be an arbitrary absolute URL, so next/image's remote allow-list does not apply
      <img src={logoPath} alt={name} height={size} style={{ height: size, width: "auto" }} />
    );
  }
  return (
    <span
      className="whitespace-nowrap font-display font-bold leading-none text-ink"
      style={{ fontSize: Math.max(16, Math.round(size * 0.75)) }}
    >
      {name}
    </span>
  );
}

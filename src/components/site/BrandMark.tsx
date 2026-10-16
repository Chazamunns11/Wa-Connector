import { brandConfig } from "@/lib/brand-config";

/**
 * The kit's horizontal logo is 473 x 148. The artwork is cropped to the mark,
 * so it carries NO clear space of its own: BrandMark adds it above and below as a
 * margin of 20% of the logo height (at least the wren head's height); the page
 * gutter already gives horizontal clear space, so the logo stays on the content edge.
 */
const LOGO_RATIO = 473 / 148;
const CLEAR_SPACE = 0.2;

/**
 * The PingWren logo, untouched: the standard artwork on light surfaces, the
 * reverse artwork on dark ones. Never recoloured, stretched or outlined; width
 * follows height. Pass the surface the mark sits on.
 */
export function BrandMark({
  size = 40,
  surface = "light",
}: {
  size?: number;
  surface?: "light" | "dark";
}) {
  const { name, logoPath, logoReversePath } = brandConfig();
  const src = surface === "dark" ? logoReversePath : logoPath;
  if (src) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- BRAND_LOGO_PATH may be an arbitrary absolute URL, so next/image's remote allow-list does not apply
      <img
        src={src}
        alt={name}
        width={Math.round(size * LOGO_RATIO)}
        height={size}
        style={{ height: size, width: "auto", marginBlock: Math.round(size * CLEAR_SPACE) }}
      />
    );
  }
  return (
    <span
      className="whitespace-nowrap font-display font-extrabold leading-none text-ink"
      style={{ fontSize: Math.max(16, Math.round(size * 0.6)) }}
    >
      {name}
    </span>
  );
}

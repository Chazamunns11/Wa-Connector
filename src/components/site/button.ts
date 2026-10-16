export type SiteButtonVariant = "ink" | "line" | "coral";

/** Direction B pill buttons (globals.css .btn-*). Anchors and buttons share it; the app keeps ui/Button. */
export function siteButton(variant: SiteButtonVariant, className = ""): string {
  return `btn btn-${variant} ${className}`.trim();
}

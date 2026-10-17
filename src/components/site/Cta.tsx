import Link from "next/link";
import { siteButton } from "@/components/site/button";
import { SITE_ROUTES } from "@/lib/site/routes";

/**
 * Primary trial link, plus an optional secondary link. One primary CTA per view.
 * The primary follows the ground it sits on: an Ink pill on Coral, a Coral pill with
 * Ink text on White or Ink (white on Coral never passes AA).
 */
export function Cta({
  label,
  secondary,
  note,
  ground = "white",
}: {
  label: string;
  secondary?: { href: string; label: string };
  note?: string;
  ground?: "white" | "coral" | "dark";
}) {
  return (
    <div>
      <div className="btn-stack">
        <Link href={SITE_ROUTES.signup} className={siteButton(ground === "coral" ? "ink" : "coral")}>
          {label}
        </Link>
        {secondary ? (
          <Link href={secondary.href} className={siteButton("line")}>
            {secondary.label}
          </Link>
        ) : null}
      </div>
      {note ? <p className="small mt-4 max-w-[52ch]">{note}</p> : null}
    </div>
  );
}

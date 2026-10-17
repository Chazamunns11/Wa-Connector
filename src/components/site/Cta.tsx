import Link from "next/link";
import { siteButton } from "@/components/site/button";
import { SITE_ROUTES } from "@/lib/site/routes";

/**
 * Primary trial link, plus an optional secondary link. One primary CTA per view.
 * On a coral ground the primary is an Ink pill (`onCoral`); elsewhere it is Coral with Ink text.
 */
export function Cta({
  label,
  secondary,
  note,
  onCoral = false,
}: {
  label: string;
  secondary?: { href: string; label: string };
  note?: string;
  onCoral?: boolean;
}) {
  return (
    <div>
      <div className="btn-stack">
        <Link href={SITE_ROUTES.signup} className={siteButton(onCoral ? "ink" : "coral")}>
          {label}
        </Link>
        {secondary ? (
          <Link href={secondary.href} className={siteButton("line")}>
            {secondary.label}
          </Link>
        ) : null}
      </div>
      {note ? <p className="mt-4 max-w-[52ch] text-[.95rem]">{note}</p> : null}
    </div>
  );
}

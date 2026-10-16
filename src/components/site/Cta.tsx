import Link from "next/link";
import { buttonClasses } from "@/components/ui/Button";
import { SITE_ROUTES } from "@/lib/site/routes";

/** Primary trial link, plus an optional secondary link. One primary CTA per view. */
export function Cta({
  label,
  secondary,
  note,
}: {
  label: string;
  secondary?: { href: string; label: string };
  note?: string;
}) {
  return (
    <div>
      <div className="flex flex-wrap gap-3">
        <Link href={SITE_ROUTES.signup} className={buttonClasses("primary", "md", "min-h-11 px-5 text-base")}>
          {label}
        </Link>
        {secondary ? (
          <Link href={secondary.href} className={buttonClasses("secondary", "md", "min-h-11 px-5 text-base")}>
            {secondary.label}
          </Link>
        ) : null}
      </div>
      {note ? <p className="mt-3 text-sm text-ink-dim">{note}</p> : null}
    </div>
  );
}

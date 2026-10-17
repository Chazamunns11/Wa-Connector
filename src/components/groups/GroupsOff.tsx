import Link from "next/link";
import { EmptyState } from "@/components/ui/EmptyState";
import { buttonClasses } from "@/components/ui/Button";
import { SITE_ROUTES } from "@/lib/site/routes";

export function GroupsOff() {
  return (
    <EmptyState
      title="Groups aren't switched on yet"
      description="WhatsApp groups aren't available on this account yet. Your numbers and messages are unaffected."
      action={
        <Link href={SITE_ROUTES.dashboard} className={buttonClasses("secondary", "md", "min-h-11 px-5")}>
          Back to dashboard
        </Link>
      }
    />
  );
}

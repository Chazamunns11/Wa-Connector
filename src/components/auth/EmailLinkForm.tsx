import { siteButton } from "@/components/site/button";
import { INPUT_CLASSES } from "@/components/auth/field";

/** One labelled email input and a submit button, posted to a server action. */
export function EmailLinkForm({
  action,
  buttonLabel,
}: {
  action: (formData: FormData) => void | Promise<void>;
  buttonLabel: string;
}) {
  return (
    <form action={action} className="flex flex-col gap-4">
      <label className="flex flex-col gap-1.5 text-sm font-semibold text-ink">
        Email
        <input
          type="email"
          name="email"
          required
          autoComplete="email"
          placeholder="you@example.com"
          className={INPUT_CLASSES}
        />
      </label>
      <button type="submit" className={siteButton("coral", "mt-2 w-full")}>
        {buttonLabel}
      </button>
    </form>
  );
}

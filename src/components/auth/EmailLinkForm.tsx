import { Button } from "@/components/ui/Button";
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
      <label className="flex flex-col gap-1.5 text-sm text-ink-dim">
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
      <Button type="submit" className="mt-2 min-h-11 text-base">
        {buttonLabel}
      </Button>
    </form>
  );
}

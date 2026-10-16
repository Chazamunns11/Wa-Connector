import { Button } from "@/components/ui/Button";
import { INPUT_CLASSES } from "@/components/auth/field";
import type { SignupErrors, SignupInput } from "@/lib/site/signup";

const KIND_OPTIONS = [
  { value: "agency", label: "An agency", hint: "I manage WhatsApp for several client accounts." },
  { value: "business", label: "A single business", hint: "I manage WhatsApp for my own business." },
] as const;

function FieldError({ id, message }: { id: string; message?: string }) {
  if (!message) return null;
  return (
    <p id={id} className="text-sm font-medium text-loss">
      {message}
    </p>
  );
}

export function SignupForm({
  action,
  errors = {},
  values = {},
  claim,
}: {
  action: (formData: FormData) => void | Promise<void>;
  errors?: SignupErrors;
  values?: Partial<SignupInput>;
  claim?: string;
}) {
  const hasErrors = Object.keys(errors).length > 0;
  return (
    <form action={action} noValidate className="flex flex-col gap-5">
      {hasErrors ? (
        <div
          id="signup-errors"
          tabIndex={-1}
          role="alert"
          className="rounded border border-loss/40 bg-loss-soft p-3 text-sm text-ink"
        >
          <p className="font-semibold">Some details need another look. Nothing has been saved.</p>
          <ul className="mt-2 grid gap-1">
            {errors.accountName ? (
              <li><a href="#accountName" className="underline underline-offset-2">{errors.accountName}</a></li>
            ) : null}
            {errors.kind ? (
              <li><a href="#kind-agency" className="underline underline-offset-2">{errors.kind}</a></li>
            ) : null}
            {errors.email ? (
              <li><a href="#email" className="underline underline-offset-2">{errors.email}</a></li>
            ) : null}
          </ul>
        </div>
      ) : null}
      {claim ? <input type="hidden" name="claim" value={claim} /> : null}

      <div className="flex flex-col gap-1.5">
        <label htmlFor="accountName" className="text-sm text-ink-dim">
          Account name
        </label>
        <input
          id="accountName"
          name="accountName"
          type="text"
          required
          minLength={2}
          maxLength={80}
          autoComplete="organization"
          defaultValue={values.accountName ?? ""}
          aria-invalid={errors.accountName ? true : undefined}
          aria-describedby={errors.accountName ? "accountName-error" : "accountName-hint"}
          className={INPUT_CLASSES}
        />
        <p id="accountName-hint" className="text-sm text-ink-faint">
          Your business or agency name. You can change it later.
        </p>
        <FieldError id="accountName-error" message={errors.accountName} />
      </div>

      <fieldset
        className="flex flex-col gap-2"
        aria-describedby={errors.kind ? "kind-error" : undefined}
      >
        <legend className="mb-1 text-sm text-ink-dim">Are you an agency or a single business?</legend>
        {KIND_OPTIONS.map((o) => (
          <label
            key={o.value}
            className="flex min-h-11 cursor-pointer items-start gap-3 rounded border border-border-strong bg-well p-3 has-[:checked]:border-accent"
          >
            <input
              id={`kind-${o.value}`}
              type="radio"
              name="kind"
              value={o.value}
              required
              defaultChecked={values.kind === o.value}
              className="mt-1 h-4 w-4 accent-[var(--color-accent)]"
            />
            <span>
              <span className="block font-medium text-ink">{o.label}</span>
              <span className="block text-sm text-ink-dim">{o.hint}</span>
            </span>
          </label>
        ))}
        <FieldError id="kind-error" message={errors.kind} />
      </fieldset>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="email" className="text-sm text-ink-dim">
          Email
        </label>
        <input
          id="email"
          name="email"
          type="email"
          required
          autoComplete="email"
          placeholder="you@example.com"
          defaultValue={values.email ?? ""}
          aria-invalid={errors.email ? true : undefined}
          aria-describedby={errors.email ? "email-error" : "email-hint"}
          className={INPUT_CLASSES}
        />
        <p id="email-hint" className="text-sm text-ink-faint">
          We sign you in with a link sent here. There is no password.
        </p>
        <FieldError id="email-error" message={errors.email} />
      </div>

      <Button type="submit" className="min-h-11 text-base">
        Continue to checkout
      </Button>
    </form>
  );
}

import type { Metadata } from "next";
import { AuthShell } from "@/components/auth/AuthShell";
import { SignupForm } from "@/components/auth/SignupForm";
import { brandConfig } from "@/lib/brand-config";
import { TRIAL_DAYS, TRIAL_MAX_NUMBERS } from "@/lib/pricing";
import { signupStateFromParams } from "@/lib/site/signup";
import { previewSignupAction } from "./actions";

export function generateMetadata(): Metadata {
  return {
    title: `Start your free trial — ${brandConfig().name}`,
    robots: { index: false },
  };
}

export default async function SignupPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const { errors, values } = signupStateFromParams(params);
  const claim = typeof params.claim === "string" && params.claim ? params.claim.slice(0, 200) : undefined;
  return (
    <AuthShell
      preview
      title={`Start your ${TRIAL_DAYS}-day free trial`}
      intro={
        <>
          <p>
            Tell us who the account is for. Next comes checkout: a card is needed to start, and nothing is charged
            until the trial ends. The trial covers up to {TRIAL_MAX_NUMBERS} numbers.
          </p>
          {claim ? (
            <p className="mt-3">You arrived from GoHighLevel. Create your account here to carry on.</p>
          ) : null}
        </>
      }
    >
      <SignupForm action={previewSignupAction} errors={errors} values={values} claim={claim} />
    </AuthShell>
  );
}

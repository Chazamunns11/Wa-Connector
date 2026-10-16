import type { Metadata } from "next";
import { AuthShell } from "@/components/auth/AuthShell";
import { SignupForm } from "@/components/auth/SignupForm";
import { brandConfig } from "@/lib/brand-config";
import { TRIAL_DAYS, TRIAL_MAX_NUMBERS } from "@/lib/pricing";
import { signupStateFromParams } from "@/lib/site/signup";
import { startSignupAction } from "./actions";

const PAGE_ERRORS: Record<string, string> = {
  unavailable: "Signups aren't open yet.",
  link_expired: "That sign-in link has expired or was opened in a different browser. Start again below.",
  failed: "We couldn't send your email. Check the address and try again, or contact support.",
};

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
  const pageError = typeof params.error === "string" ? PAGE_ERRORS[params.error] : undefined;
  const claim = typeof params.claim === "string" && params.claim ? params.claim.slice(0, 200) : undefined;
  return (
    <AuthShell
      title={`Start your ${TRIAL_DAYS}-day free trial`}
      intro={
        <>
          <p>
            Tell us who the account is for. We&apos;ll email you a link to confirm your address, then take you to
            checkout: a card is needed to start, and nothing is charged until the trial ends. The trial covers up to{" "}
            {TRIAL_MAX_NUMBERS} numbers.
          </p>
          {claim ? (
            <p className="mt-3">You arrived from GoHighLevel. Create your account here to carry on.</p>
          ) : null}
        </>
      }
    >
      {pageError ? (
        <p role="alert" className="mb-5 rounded-[12px] border-2 border-loss bg-loss-soft p-3 text-sm font-semibold text-ink">
          {pageError}
        </p>
      ) : null}
      <SignupForm action={startSignupAction} errors={errors} values={values} claim={claim} />
    </AuthShell>
  );
}

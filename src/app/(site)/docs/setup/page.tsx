import type { Metadata } from "next";
import Link from "next/link";
import { AudienceTabs } from "@/components/site/AudienceTabs";
import { Container } from "@/components/site/Container";
import { SetupStep } from "@/components/site/SetupStep";
import { brandConfig } from "@/lib/brand-config";
import { SITE_ROUTES } from "@/lib/site/routes";
import { AUDIENCES, AUDIENCE_LABELS, setupSteps, troubleshooting, type Audience } from "@/lib/site/setup-steps";

export function generateMetadata(): Metadata {
  const { name } = brandConfig();
  return {
    title: `Set up ${name} in GoHighLevel`,
    description: `Step-by-step setup for ${name}: install, set the Telephony Provider, scan the QR code and send a test message. About ten minutes.`,
  };
}

function parseAudience(value: string | string[] | undefined): Audience {
  const v = Array.isArray(value) ? value[0] : value;
  return v === "business" ? "business" : "agency";
}

export default async function SetupPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const brand = brandConfig();
  const initial = parseAudience((await searchParams).audience);
  const steps = setupSteps(brand);
  const trouble = troubleshooting(brand);

  const panels = Object.fromEntries(
    AUDIENCES.map((a) => [
      a,
      <div key={a}>
        <h2 className="font-display text-[clamp(24px,4vw,32px)] font-bold leading-tight">{AUDIENCE_LABELS[a]}</h2>
        <ol className="mt-4 list-none p-0 [counter-reset:step] [&>li]:[counter-increment:step]">
          {steps.map((s) => (
            <SetupStep key={s.id} step={s} audience={a} brandName={brand.name} />
          ))}
        </ol>
      </div>,
    ]),
  ) as Record<Audience, React.ReactNode>;

  return (
    <>
      <section className="pb-12 pt-12 md:pb-20">
        <Container>
          <div className="max-w-[760px]">
            <h1 className="font-display text-[clamp(32px,6vw,48px)] font-bold leading-[1.15]">
              Set up {brand.name} in GoHighLevel
            </h1>
            <p className="mt-4 max-w-[60ch] text-lg text-ink-dim">
              About ten minutes, start to finish. Pick the guide that matches your account, and you will be sending
              WhatsApp messages from your existing workflows.
            </p>
            <div className="mt-6 rounded-lg border bg-raised p-4">
              <h2 className="font-display text-lg font-semibold">Before you start</h2>
              <ul className="mt-2 grid list-disc gap-1 pl-5 text-ink-dim marker:text-ink-faint">
                <li>A HighLevel account with at least one sub-account.</li>
                <li>The phone that has the WhatsApp number you want to send from, with you.</li>
                <li>A second phone to receive the test message.</li>
              </ul>
            </div>
            <div className="mt-8">
              <AudienceTabs panels={panels} initial={initial} />
            </div>

            <h2 id="troubleshooting" className="mt-16 scroll-mt-4 font-display text-[clamp(24px,4vw,32px)] font-bold">
              Troubleshooting
            </h2>
            <div className="mt-4">
              {trouble.map((t) => (
                <details key={t.id} id={t.id} className="group scroll-mt-4 border-b border-divider">
                  <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-4 py-3 font-semibold [&::-webkit-details-marker]:hidden">
                    <span>{t.title}</span>
                    <span aria-hidden="true" className="text-accent-text group-open:hidden">
                      +
                    </span>
                    <span aria-hidden="true" className="hidden text-accent-text group-open:inline">
                      &minus;
                    </span>
                  </summary>
                  <div className="grid max-w-[62ch] gap-3 pb-4 text-ink-dim">
                    {t.body.map((p) => (
                      <p key={p}>{p}</p>
                    ))}
                  </div>
                </details>
              ))}
            </div>

            <h2 className="mt-16 font-display text-[clamp(24px,4vw,32px)] font-bold">Once you are sending</h2>
            <ul className="mt-4 grid max-w-[62ch] list-disc gap-2 pl-5 text-ink-dim marker:text-ink-faint">
              <li>Each number has a daily cap, and messages go out at a steady pace rather than all at once.</li>
              <li>If someone replies STOP, that number stops messaging them. Other numbers are not affected.</li>
              <li>The phone needs to stay switched on and online.</li>
            </ul>
            <p className="mt-4 max-w-[62ch] text-ink-dim">
              More answers are in the{" "}
              <Link href={SITE_ROUTES.faq} className="underline underline-offset-2">
                FAQ
              </Link>
              .
            </p>
          </div>
        </Container>
      </section>
    </>
  );
}

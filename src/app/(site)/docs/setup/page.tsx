import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import { AudienceTabs } from "@/components/site/AudienceTabs";
import { Container } from "@/components/site/Container";
import { PageTop } from "@/components/site/PageTop";
import { ConnectPanelSample } from "@/components/site/samples/ConnectPanelSample";
import { SetupStep } from "@/components/site/SetupStep";
import { brandConfig } from "@/lib/brand-config";
import { SITE_ROUTES } from "@/lib/site/routes";
import { AUDIENCES, AUDIENCE_LABELS, setupSteps, troubleshooting, type Audience } from "@/lib/site/setup-steps";

export function generateMetadata(): Metadata {
  const { name } = brandConfig();
  return {
    title: `Setting up ${name} in GoHighLevel`,
    description: `Step-by-step setup for ${name}: install, set the Telephony Provider, scan the QR code and send a test message. About ten minutes.`,
  };
}

function withSupportLink(text: string, email: string | null): ReactNode {
  const marker = "get in touch";
  const i = text.indexOf(marker);
  if (!email || i < 0) return text;
  return (
    <>
      {text.slice(0, i)}
      <a href={`mailto:${email}`} className="underline underline-offset-2">
        {marker}
      </a>
      {text.slice(i + marker.length)}
    </>
  );
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
        <h2 className="font-display text-[clamp(1.5rem,3vw,2.2rem)] font-extrabold leading-[1.05] tracking-[-0.02em]">{AUDIENCE_LABELS[a]}</h2>
        <ol role="list" className="mt-4 list-none p-0">
          {steps.map((s, i) => (
            <SetupStep key={s.id} index={i} step={s} audience={a} brandName={brand.name} />
          ))}
        </ol>
      </div>,
    ]),
  ) as Record<Audience, ReactNode>;

  return (
    <>
      <PageTop title={<>Setting up {brand.name} in GoHighLevel</>}>
        <p>
          About ten minutes, start to finish. Pick the guide that matches your account, and by the end the workflows
          you already have will be sending on WhatsApp.
        </p>
        <p className="mt-3 text-[1.05rem] font-medium">
          Handing the scan to a client? Send them the{" "}
          <Link href={SITE_ROUTES.connect} className="underline underline-offset-2">
            two-page how-to-connect sheet
          </Link>
          .
        </p>
      </PageTop>
      <section className="pb-12 pt-12 md:pb-20">
        <Container>
          <div className="grid items-start gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,26rem)] lg:gap-16">
            <div>
              <div className="section-rule max-w-[52ch]">
                <h2 className="font-display text-[clamp(1.5rem,3vw,2.2rem)] font-extrabold leading-[1.05] tracking-[-0.02em]">Before you start</h2>
                <ul className="mt-3 grid list-disc gap-2 pl-5 marker:text-ink-faint">
                  <li>A GoHighLevel account with at least one sub-account.</li>
                  <li>A {brand.name} account. The free trial is fine.</li>
                  <li>The phone with the WhatsApp number you&apos;ll send from. You need it in your hand for the scan.</li>
                  <li>A second phone to receive the test message.</li>
                </ul>
              </div>
            </div>
            <figure>
              <ConnectPanelSample connectedStrip />
              <figcaption className="mt-3 text-[0.95rem] text-ink-dim">
                Sample screen: the connect page you&apos;ll see in step 4, before and after the scan.
              </figcaption>
            </figure>
          </div>
          <div className="max-w-[760px]">
            <div className="mt-8">
              <AudienceTabs key={initial} panels={panels} initial={initial} />
            </div>

            <h2 id="troubleshooting" className="mt-16 scroll-mt-4 font-display text-[clamp(1.5rem,3vw,2.2rem)] font-extrabold leading-[1.05] tracking-[-0.02em]">
              Troubleshooting
            </h2>
            <div className="mt-4">
              {trouble.map((t) => (
                <details key={t.id} id={t.id} className="disclosure scroll-mt-4">
                  <summary>
                    <span>{t.title}</span>
                  </summary>
                  <div className="grid max-w-[62ch] gap-3 pb-5 text-ink-dim">
                    {t.body.map((p) => (
                      <p key={p}>{withSupportLink(p, brand.supportEmail)}</p>
                    ))}
                  </div>
                </details>
              ))}
            </div>

            <h2 className="mt-16 font-display text-[clamp(1.5rem,3vw,2.2rem)] font-extrabold leading-[1.05] tracking-[-0.02em]">Once you are sending</h2>
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

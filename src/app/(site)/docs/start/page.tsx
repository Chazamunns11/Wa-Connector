import type { Metadata } from "next";
import Link from "next/link";
import { Container } from "@/components/site/Container";
import { PageTop } from "@/components/site/PageTop";
import { siteButton } from "@/components/site/button";
import { brandConfig } from "@/lib/brand-config";
import { SITE_ROUTES } from "@/lib/site/routes";
import { ALT_PATH_NOTE, TELEPHONY_PROVIDER_PATH } from "@/lib/site/setup-steps";
import { trialSentence } from "@/lib/pricing";
import { InstallDiagram } from "@/components/site/diagrams/InstallDiagram";
import { TelephonyProviderDiagram } from "@/components/site/diagrams/TelephonyProviderDiagram";
import { QrLinkDiagram } from "@/components/site/diagrams/QrLinkDiagram";
import { ConnectedDiagram } from "@/components/site/diagrams/ConnectedDiagram";
import { DashboardSample } from "@/components/site/samples/DashboardSample";

export function generateMetadata(): Metadata {
  const { name } = brandConfig();
  return {
    title: `Get started in 3 steps | ${name}`,
    description: `For agency owners: pay, connect GoHighLevel, send your client a link. WhatsApp is live in about five minutes per sub-account.`,
  };
}

const H2 = "h-section font-display";

/** One illustration in the setup guide's framed style. */
function Pic({ caption, children }: { caption: string; children: React.ReactNode }) {
  return (
    <figure className="m-0 rounded-[20px] border-[3px] border-outline bg-well p-4">
      {children}
      <figcaption className="mt-2 text-sm text-ink-dim">{caption}</figcaption>
    </figure>
  );
}

function Step({ n, title, children, pics }: { n: number; title: string; children: React.ReactNode; pics?: React.ReactNode }) {
  return (
    <li className="grid grid-cols-[2.5rem_1fr] gap-3">
      <span aria-hidden="true" className="grid size-10 place-items-center rounded-full border-2 border-outline font-display text-lg font-extrabold">
        {n}
      </span>
      <div>
        <h3 className="h-item font-display">{title}</h3>
        <div className="mt-1 grid max-w-[60ch] gap-2 text-ink-dim">{children}</div>
        {pics ? <div className="mt-4 grid gap-4 md:grid-cols-2">{pics}</div> : null}
      </div>
    </li>
  );
}

export default function GetStartedPage() {
  const { name } = brandConfig();
  const providerPath = `${TELEPHONY_PROVIDER_PATH.join(" → ")} → ${name} → Save`;
  return (
    <>
      <PageTop title={<>Get started in 3 steps</>}>
        <p>For agency owners. About five minutes per sub-account.</p>
        <div className="mt-6 flex flex-wrap items-center gap-3">
          <Link href={SITE_ROUTES.signup} className={siteButton("coral")}>
            Start free trial
          </Link>
          <Link href={SITE_ROUTES.login} className={siteButton("line")}>
            Log in
          </Link>
        </div>
      </PageTop>

      <section className="band">
        <Container>
          <ol role="list" className="grid list-none gap-8 p-0">
            <Step n={1} title="Pay">
              <p>Create your account. {trialSentence()}</p>
            </Step>
            <Step
              n={2}
              title="Connect GoHighLevel"
              pics={
                <>
                  <Pic caption="Add sub-accounts opens GoHighLevel: tick the ones you want.">
                    <InstallDiagram brandName={name} />
                  </Pic>
                  <Pic caption={`Then, in each sub-account, choose ${name} as the Telephony Provider.`}>
                    <TelephonyProviderDiagram brandName={name} />
                  </Pic>
                </>
              }
            >
              <p>
                On your dashboard, click <strong>Add sub-accounts</strong> and tick the sub-accounts you want. Then click{" "}
                <strong>Activate</strong> next to each one.
              </p>
              <p>
                In each sub-account in GoHighLevel, go to {providerPath}. Do this once per sub-account; until it is set, nothing
                sends.
              </p>
              <p className="text-sm">{ALT_PATH_NOTE}</p>
            </Step>
            <Step
              n={3}
              title="Paste the link and go"
              pics={
                <>
                  <Pic caption="Your client opens the link and scans the QR code with WhatsApp.">
                    <QrLinkDiagram />
                  </Pic>
                  <Pic caption="Connected. Messages from GoHighLevel now go out on WhatsApp.">
                    <ConnectedDiagram />
                  </Pic>
                </>
              }
            >
              <p>
                Click <strong>Send connect link</strong> next to the sub-account, copy the link and paste it to your client (WhatsApp,
                email, anything). They open it on a computer and scan the QR code with their phone: WhatsApp → Settings → Linked
                devices → Link a device.
              </p>
              <p>
                That&rsquo;s it. Texts sent from GoHighLevel now go out on their WhatsApp, and replies land in Conversations. Holding
                the phone yourself? Click <strong>Show QR</strong> and scan it there instead.
              </p>
            </Step>
          </ol>

          <h2 className={`${H2} mt-14`}>Your dashboard shows what&rsquo;s left</h2>
          <p className="mt-3 max-w-[60ch] text-ink-dim">
            Each sub-account shows its next step until it&rsquo;s live, and ticks off the last one by itself when the first
            message comes through from GoHighLevel.
          </p>
          <figure className="mt-6">
            <DashboardSample />
            <figcaption className="mt-3 small text-ink-dim">Sample screen with made-up sub-accounts.</figcaption>
          </figure>

          <h2 className={`${H2} mt-14`}>Add another number</h2>
          <p className="mt-3 max-w-[60ch] text-ink-dim">
            Up to 3 per sub-account, for example one for the coach and one for a setter. Click <strong>Show QR</strong> on the
            sub-account, then <strong>Add a number</strong>, give it a name, click <strong>Get link</strong> and send that link to
            whoever has that phone.
          </p>

          <h2 className={`${H2} mt-10`}>Which number sends?</h2>
          <ul className="mt-3 grid max-w-[60ch] list-disc gap-2 pl-5 text-ink-dim marker:text-ink">
            <li>
              A team member who picked their own number sends from it. They open the {name} page inside GoHighLevel and click{" "}
              <strong>Send my replies from this number</strong>.
            </li>
            <li>Otherwise, the number the contact last messaged.</li>
            <li>Otherwise, the default number. Change it with <strong>Make default</strong>.</li>
          </ul>
          <p className="mt-3 max-w-[60ch] text-sm text-ink-dim">
            Workflows and the AI bot follow the last two rules. Messages from every number appear in the contact&rsquo;s one
            conversation, labelled with the number&rsquo;s name.
          </p>

          <p className="mt-10 text-ink-dim">
            Stuck? The full <Link href={SITE_ROUTES.setup} className="underline underline-offset-2">setup guide</Link> has screenshots
            and fixes for the common problems.
          </p>
        </Container>
      </section>
    </>
  );
}

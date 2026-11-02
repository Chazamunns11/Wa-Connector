import type { Metadata } from "next";
import Link from "next/link";
import { Container } from "@/components/site/Container";
import { PageTop } from "@/components/site/PageTop";
import { siteButton } from "@/components/site/button";
import { brandConfig } from "@/lib/brand-config";
import { SITE_ROUTES } from "@/lib/site/routes";
import { ALT_PATH_NOTE, TELEPHONY_PROVIDER_PATH } from "@/lib/site/setup-steps";

export function generateMetadata(): Metadata {
  const { name } = brandConfig();
  return {
    title: `Get started in 3 steps | ${name}`,
    description: `For agency owners: pay, connect GoHighLevel, send your client a link. WhatsApp is live in about five minutes per sub-account.`,
  };
}

const H2 = "h-section font-display";

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <li className="grid grid-cols-[2.5rem_1fr] gap-3">
      <span aria-hidden="true" className="grid size-10 place-items-center rounded-full border-2 border-outline font-display text-lg font-extrabold">
        {n}
      </span>
      <div>
        <h3 className="h-item font-display">{title}</h3>
        <div className="mt-1 grid max-w-[60ch] gap-2 text-ink-dim">{children}</div>
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
              <p>Create your account and start the free trial.</p>
            </Step>
            <Step n={2} title="Connect GoHighLevel">
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
            <Step n={3} title="Paste the link and go">
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

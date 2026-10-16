import type { Metadata } from "next";
import Link from "next/link";
import { Container } from "@/components/site/Container";
import { brandConfig } from "@/lib/brand-config";
import { SITE_ROUTES } from "@/lib/site/routes";

export function generateMetadata(): Metadata {
  const { name } = brandConfig();
  return {
    title: `Privacy and data | ${name}`,
    description: `A plain summary of what ${name} stores, for how long, and what it does not keep.`,
  };
}

export default function PrivacyAndDataPage() {
  const { name } = brandConfig();
  const h2 = "mt-10 font-display text-[clamp(20px,3vw,24px)] font-bold";
  const ul = "mt-3 grid max-w-[62ch] list-disc gap-2 pl-5 text-ink-dim marker:text-ink-faint";
  return (
    <section className="pb-12 pt-12 md:pb-20">
      <Container>
        <div className="max-w-[760px]">
          <h1 className="font-display text-[clamp(32px,6vw,48px)] font-bold leading-[1.15]">Privacy and data</h1>
          <p className="mt-4 max-w-[60ch] text-lg text-ink-dim">
            A plain summary of what {name} keeps. It is not the privacy policy, which is still a{" "}
            <Link href={SITE_ROUTES.privacy} className="underline underline-offset-2">
              draft
            </Link>
            .
          </p>

          <h2 className={h2}>What we store</h2>
          <ul className={ul}>
            <li>
              The WhatsApp session credentials for each linked number. They are encrypted, and the key is kept
              separately from the database.
            </li>
            <li>
              For each message we send: the recipient&apos;s number, its status and WhatsApp&apos;s message ID. The
              message text is not kept in that record.
            </li>
            <li>The access tokens GoHighLevel gives us for the sub-accounts you install {name} on.</li>
          </ul>

          <h2 className={h2}>Message text while it waits</h2>
          <p className="mt-3 max-w-[62ch] text-ink-dim">
            Text passes through on its way to WhatsApp. If a message cannot go out straight away, for example because
            the phone is disconnected, the text is held so it can be sent later, and it is cleared as soon as the
            message is no longer waiting.
          </p>

          <h2 className={h2}>Replies</h2>
          <p className="mt-3 max-w-[62ch] text-ink-dim">
            When someone replies, we keep the first 500 characters of a text reply, their number and the message type,
            and any photo or voice note, just long enough to pass it on to the conversation in GoHighLevel. We delete
            the whole record 90 days after it arrives.
          </p>

          <h2 className={h2}>When you leave</h2>
          <ul className={ul}>
            <li>Unlink the device from your phone and the stored credentials for that number are wiped.</li>
            <li>
              Cancel your subscription and, 14 days later, we log out your numbers and delete their stored WhatsApp
              credentials.
            </li>
          </ul>

          <p className="mt-10 max-w-[62ch] text-ink-dim">
            The full policy will be on the{" "}
            <Link href={SITE_ROUTES.privacy} className="underline underline-offset-2">
              privacy policy
            </Link>{" "}
            page.
          </p>
        </div>
      </Container>
    </section>
  );
}

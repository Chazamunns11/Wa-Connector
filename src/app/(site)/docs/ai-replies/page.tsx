import type { Metadata } from "next";
import Link from "next/link";
import { Container } from "@/components/site/Container";
import { PageTop } from "@/components/site/PageTop";
import { brandConfig } from "@/lib/brand-config";
import { SITE_ROUTES } from "@/lib/site/routes";

export function generateMetadata(): Metadata {
  const { name } = brandConfig();
  return {
    title: `AI replies on WhatsApp with GHL's Conversation AI | ${name}`,
    description: `How to let GoHighLevel's Conversation AI answer on WhatsApp through ${name}, and how to keep it out of your groups.`,
  };
}

export default function AiRepliesPage() {
  const { name } = brandConfig();
  const h2 = "mt-12 h-section font-display first:mt-0";
  const p = "mt-3 max-w-[62ch] text-ink-dim";
  return (
    <>
    <PageTop title="AI replies on WhatsApp with GHL's Conversation AI">
      <p>{name} does not have its own bot. GoHighLevel&apos;s AI answers in the conversation, and {name} sends the answer.</p>
    </PageTop>
    <section className="band">
      <Container>
        <div className="max-w-[760px]">
          <h2 className={h2}>What this is</h2>
          <p className={p}>
            Conversation AI is GoHighLevel&apos;s own AI agent. It reads a message in a contact&apos;s conversation and
            writes a reply. {name} is the conversation provider for your WhatsApp number, so an AI reply is sent the
            same way any other message from GHL is sent.
          </p>
          <p className={p}>
            We don&apos;t run a second AI and we don&apos;t see your prompts. What the AI says is set up and billed in
            GHL.
          </p>

          <h2 className={h2}>Turn it on for WhatsApp</h2>
          <ol className="mt-3 grid max-w-[62ch] list-decimal gap-2 pl-5 text-ink-dim marker:text-ink-faint">
            <li>Finish the <Link href={SITE_ROUTES.setup} className="underline underline-offset-2">setup guide</Link> first, so a normal workflow message already goes out on WhatsApp.</li>
            <li>In the sub-account, open Conversation AI and create or open your bot.</li>
            <li>Under the channels the bot answers on, include the channel that {name} provides. This is the channel your workflows already use to send on WhatsApp.</li>
            <li>Save, then message your number from a second phone and wait for the reply.</li>
          </ol>
          <p className={p}>
            Menu names in GHL change from time to time. If a step does not match what you see, look for the Conversation
            AI settings for the sub-account&apos;s conversations.
          </p>

          <h2 className={h2}>The AI follows the same sending rules</h2>
          <p className={p}>
            An AI reply goes through {name}&apos;s normal sending. That means everything that protects your number still
            applies:
          </p>
          <ul className="mt-3 grid max-w-[62ch] list-disc gap-2 pl-5 text-ink-dim marker:text-ink-faint">
            <li>Pacing. Replies are spaced out like any other message, so a burst of AI replies is not sent in one go.</li>
            <li>Typing. The contact sees the typing indicator before the message arrives.</li>
            <li>Held messages. If the number is offline, the reply waits and goes out when it is back.</li>
            <li>STOP. A contact who has sent STOP gets nothing, from the AI or from anything else.</li>
          </ul>

          <h2 className={h2}>Keep the AI out of your groups</h2>
          <p className={p}>
            Messages from a WhatsApp group appear in GHL under a contact for that group. You don&apos;t want a bot
            answering a whole group. Every group contact carries the tag <code>whatsapp-group</code>, so exclude that tag
            in the bot&apos;s settings (for example, a rule that the bot does not run for contacts with that tag).
          </p>

          <h2 className={h2}>Not checked live yet</h2>
          <p className={p}>
            We have not yet confirmed in a live GHL sub-account that Conversation AI replies through a custom conversation
            provider, or that the group exclusion behaves as described. Treat this page as the plan until we have, and
            test on a spare number before you switch a bot on for real clients. We will update this page with what we
            find.
          </p>
        </div>
      </Container>
    </section>
    </>
  );
}

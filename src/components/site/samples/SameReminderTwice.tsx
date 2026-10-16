import { PhoneFrame } from "./PhoneFrame";

/**
 * The signature figure: the same reminder as a text message nobody answered,
 * and in a chat app where Sam did. Pure markup and CSS (.hero-* in globals.css),
 * no client JS. Nothing here claims a rate; both phones are made-up samples.
 */
const REMINDER = "Hi Sam, your appointment is at 2pm tomorrow. Reply YES to confirm.";
const REPLY = "Yes, see you at 2";

const LABEL = `Two phones showing the same appointment reminder, "${REMINDER}" On the left it is a text message sent yesterday at 14:02 with no reply. On the right it is a WhatsApp message marked Delivered, and Sam has replied "${REPLY}", which appears back in Conversations.`;

export function SameReminderTwice() {
  return (
    <figure role="img" aria-label={LABEL} className="phones">
      <PhoneFrame title="Messages" variant="sms" composer="Text Message">
        <p className="phone-meta">Text Message</p>
        <div className="flex flex-col items-end">
          <p className="bubble bubble-out text-[13px] md:text-[15px]">{REMINDER}</p>
          <p className="mt-1.5 text-[12px] text-ink-faint md:text-sm">Yesterday 14:02</p>
        </div>
      </PhoneFrame>

      <PhoneFrame title="Sam" variant="whatsapp" composer="Message">
        <div className="flex flex-col items-end">
          <p className="hero-bubble bubble bubble-out text-[13px] md:text-[15px]">
            {REMINDER}
            <span className="hero-ping absolute -bottom-1 -right-1 block h-3 w-3 rounded-full border-2 border-well bg-accent" />
          </p>
          <p className="hero-delivered mt-1.5 text-[12px] text-ink-dim md:text-sm">Delivered</p>
        </div>
        <div className="hero-late mt-5 flex flex-col items-start">
          <p className="bubble bubble-in text-[13px] md:text-[15px]">{REPLY}</p>
          <p className="mt-1.5 text-[12px] text-ink-dim md:text-sm">Back in Conversations</p>
        </div>
      </PhoneFrame>
      <figcaption className="phones-cap">Sample messages. Sam is made up.</figcaption>
    </figure>
  );
}

import { PhoneFrame } from "./PhoneFrame";
import { Ticks } from "./Ticks";

/**
 * The signature figure: the same reminder as a text message nobody answered,
 * and in a chat app where Sam did. Pure markup and CSS (.hero-* and .wa-* in
 * globals.css), no client JS. Nothing here claims a rate; both phones are
 * made-up samples, so Sam is a made-up name and nothing is captioned.
 */
const REMINDER = "Hi Sam, your appointment is at 2pm tomorrow. Reply YES to confirm.";
const REPLY = "Yes, see you at 2";
// Earlier history on the chat phone only: the booking Sam made on Monday.
const BOOKING_ASK = "Hi, could I book a check-up for Wednesday at 2pm?";
const BOOKING_CONFIRM = "Yes, you're booked in for Wednesday at 2pm. See you then.";
const BOOKING_THANKS = "Perfect, thank you";

const LABEL = `Two phones showing the same appointment reminder, "${REMINDER}" On the left it is a text message sent yesterday at 14:02 with no reply. On the right it is a WhatsApp-style chat where the message shows two grey ticks, Delivered, and Sam has replied "${REPLY}", which appears back in Conversations. Earlier in the chat, on Monday, Sam booked the appointment and the business confirmed it.`;

export function SameReminderTwice() {
  return (
    <figure role="img" aria-label={LABEL} className="phones">
      <PhoneFrame title="Sam" variant="sms" composer="Text Message">
        <p className="phone-meta">Text Message · Yesterday 14:02</p>
        <div className="wa-row wa-row-out">
          <p className="wa-msg wa-sms">{REMINDER}</p>
          <p className="no-reply">No reply</p>
        </div>
      </PhoneFrame>

      <PhoneFrame title="Sam" variant="whatsapp" subline="+44 7700 900103" composer="Message">
        <p className="day-chip">Monday</p>
        <div className="wa-row wa-row-in">
          <p className="wa-msg wa-in bubble-tail">
            {BOOKING_ASK}
            <span className="wa-meta">10:41</span>
          </p>
        </div>
        <div className="wa-row wa-row-out">
          <p className="wa-msg wa-out bubble-tail">
            {BOOKING_CONFIRM}
            <span className="wa-meta">
              10:44 <Ticks />
            </span>
          </p>
        </div>
        <div className="wa-row wa-row-in">
          <p className="wa-msg wa-in">
            {BOOKING_THANKS}
            <span className="wa-meta">10:45</span>
          </p>
        </div>
        <p className="day-chip">Yesterday</p>
        <div className="wa-row wa-row-out">
          <p className="hero-bubble wa-msg wa-out bubble-tail">
            {REMINDER}
            <span className="wa-meta">
              14:02{" "}
              <span className="hero-delivered">
                <Ticks />
              </span>
            </span>
          </p>
        </div>
        <div className="hero-late wa-row wa-row-in">
          <p className="wa-msg wa-in bubble-tail">
            {REPLY}
            <span className="wa-meta">14:09</span>
          </p>
          <p className="phone-system">Back in Conversations</p>
        </div>
      </PhoneFrame>
    </figure>
  );
}

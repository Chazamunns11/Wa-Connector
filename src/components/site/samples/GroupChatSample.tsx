import { PhoneFrame } from "./PhoneFrame";
import { Ticks } from "./Ticks";

/**
 * The group-chat phone for the groups feature (rendered only when
 * FEATURES.groupsLive is on). Ruling W47: group replies stay on the phone and
 * are not pushed to the CRM, so nothing here says otherwise. Made-up names, grey ticks, no WhatsApp green or logo.
 */
const LABEL =
  "A WhatsApp-style group chat called Spring challenge with eight members: two members report finishing day three, and the business replies that tomorrow's session is at 7am.";

export function GroupChatSample() {
  return (
    <figure role="img" aria-label={LABEL} className="phones phones-single">
      <PhoneFrame title="Spring challenge" variant="group" subline="You, Sam, Priya, Dev, +4" composer="Message">
        <p className="day-chip">Today</p>
        <div className="wa-row wa-row-in">
          <p className="wa-msg wa-in bubble-tail">
            <span className="wa-sender wa-sender-1">Priya</span>
            Day 3 done
            <span className="wa-meta">09:12</span>
          </p>
        </div>
        <div className="wa-row wa-row-in">
          <p className="wa-msg wa-in bubble-tail">
            <span className="wa-sender wa-sender-2">Sam</span>
            Same here
            <span className="wa-meta">09:15</span>
          </p>
        </div>
        <div className="wa-row wa-row-out">
          <p className="wa-msg wa-out bubble-tail">
            Nice work both. Tomorrow&rsquo;s session is at 7am.
            <span className="wa-meta">
              09:20 <Ticks />
            </span>
          </p>
        </div>
      </PhoneFrame>
    </figure>
  );
}

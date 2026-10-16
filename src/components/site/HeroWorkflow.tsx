/**
 * Home hero visual: a schematic workflow step hands a message to a thread.
 * Pure markup + CSS (see .hero-* in globals.css); no client JS. The whole
 * figure is one labelled image, so the sample text is not read twice.
 */
const OUT = "Hi Sam, your call is booked for 2pm tomorrow.";
const IN = "Thanks, see you then.";

const LABEL = `Example: a Send SMS step in a workflow called Appointment reminder sends "${OUT}" on WhatsApp. It shows as Delivered, and Sam replies "${IN}", which appears back in Conversations.`;

export function HeroWorkflow() {
  return (
    <div role="img" aria-label={LABEL} className="w-full max-w-md justify-self-center lg:justify-self-end">
      <div className="relative z-10 rounded-lg border bg-card px-4 py-3">
        <p className="font-display text-xl font-medium leading-tight">Send SMS</p>
        <p className="text-ink-dim">Appointment reminder</p>
        <div className="mt-3 hidden border-t pt-3 sm:block">
          <p className="text-[0.8rem] text-ink-dim">Message</p>
          <p>{OUT}</p>
        </div>
      </div>

      <div className="px-2 pt-5">
        <div className="flex flex-col items-end">
          <p className="hero-bubble bubble bubble-out">
            {OUT}
            <span className="hero-ping absolute -bottom-1 -right-1 block h-3 w-3 rounded-full border-2 border-bg bg-accent" />
          </p>
          <p className="hero-late mt-1.5 text-[0.8rem] text-ink-dim">Delivered</p>
        </div>
        <div className="hero-late mt-3 flex flex-col items-start">
          <p className="bubble bubble-in">{IN}</p>
          <p className="mt-1.5 text-[0.8rem] text-ink-dim">Back in Conversations</p>
        </div>
      </div>
    </div>
  );
}

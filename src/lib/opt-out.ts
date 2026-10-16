/**
 * Pure STOP/START keyword classifier. Whole-message match only, so "please
 * stop" or "cancel my appointment" never opts anyone out. CANCEL is
 * deliberately not a keyword: this product sends appointment reminders and
 * "Cancel" is how people cancel an appointment.
 */

export const OPT_OUT_KEYWORDS = ["STOP", "STOPALL", "STOP ALL", "UNSUBSCRIBE", "END", "QUIT", "OPT OUT", "OPTOUT"] as const;
export const OPT_IN_KEYWORDS = ["START", "UNSTOP", "SUBSCRIBE", "OPT IN", "OPTIN"] as const;
export const MAX_KEYWORD_BODY_LENGTH = 32;

export type OptOutDecision =
  | { kind: "opt_out"; keyword: string }
  | { kind: "opt_in"; keyword: string }
  | null;

export function classifyOptOutMessage(body: string | null): OptOutDecision {
  if (body === null || body.length > MAX_KEYWORD_BODY_LENGTH) return null;
  const normalised = body
    .trim()
    .replace(/[\s ]+/g, " ")
    .replace(/[.!?,;:]+$/, "")
    .trim()
    .toUpperCase();
  if ((OPT_OUT_KEYWORDS as readonly string[]).includes(normalised)) return { kind: "opt_out", keyword: normalised };
  if ((OPT_IN_KEYWORDS as readonly string[]).includes(normalised)) return { kind: "opt_in", keyword: normalised };
  return null;
}

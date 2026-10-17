/**
 * Social proof for the home page. Two rules (Ruling W25):
 *  - Every figure is real and honestly framed. We make no claims about messages being
 *    opened or read: there is no primary source, and PingWren cannot see reads.
 *  - No customer appears here without their written permission.
 */

export interface AverageResult {
  before: string;
  after: string;
  measure: string;
  claim: string;
  note: string;
  /** The percentage-free parts of the home headline; `after` is the big number. */
  headingLead: string;
  headingTail: string;
  /** The one-line label under the "50% to 85%+" figure in the hero result block. */
  resultLabel: string;
}

/**
 * The owner's own average across businesses we have run WhatsApp appointment
 * reminders for (Ruling W27). General on purpose: no names, counts or period.
 * It predates this product, so it never says "with <Brand>".
 */
export const OWN_RESULTS_AVERAGE: AverageResult = {
  before: "50%",
  after: "85%+",
  measure: "Show rate: about 50% before WhatsApp reminders, 85% or more with them",
  claim:
    "Across the businesses we've run WhatsApp appointment reminders for, the average show rate went from about half to 85% or more.",
  note: "That's our own average across the businesses we've run WhatsApp appointment reminders for, and it's from before this product existed. It is not an independent study, and your numbers will vary.",
  headingLead: "About half of booked clients used to turn up.",
  headingTail: "With WhatsApp reminders, it's",
  resultLabel: "of booked clients turned up, before and after WhatsApp reminders",
};

export interface CustomerResult {
  business: string;
  businessType: string;
  /** Show rates are percentages from 0 to 100. */
  showRateBefore: number;
  showRateAfter: number;
  /** When the after figure was measured, e.g. "March to May 2027". */
  period: string;
  quote?: string;
  /** Literal `true`: an entry cannot be added without asserting written consent. */
  permission: true;
}

/**
 * Add real client results here with the client's written permission.
 * Ships empty on purpose; the home page shows nothing until this has entries.
 */
export const CUSTOMER_RESULTS: CustomerResult[] = [];

/** The entries to render, or null when there is nothing to show. */
export function resultsToShow(results: readonly CustomerResult[]): CustomerResult[] | null {
  return results.length > 0 ? [...results] : null;
}

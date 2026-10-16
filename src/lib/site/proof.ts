/**
 * Social proof for the home page. Two rules (Ruling W25):
 *  - Every figure is real and cited. We make no claims about messages being
 *    opened or read: there is no primary source, and PingWren cannot see reads.
 *  - No customer appears here without their written permission.
 */

export interface ResearchFinding {
  /** The figure as it appears large, rounded honestly from the paper's own numbers. */
  from: string;
  to: string;
  /** What the figure measures. */
  measure: string;
  /** The finding in one plain sentence. */
  claim: string;
  /** An honest limit on the finding. */
  caveat: string;
  /** Title of the paper, as published. */
  sourceTitle: string;
  sourceId: string;
  href: string;
}

export const RESEARCH_FINDINGS: ResearchFinding[] = [
  {
    from: "38%",
    to: "24%",
    measure: "of appointments missed",
    claim:
      "In a randomised trial at a children's clinic, patients who also got a text-message reminder missed fewer appointments than patients who only got the usual voice-message reminder.",
    caveat: "A small study, about 170 patients. The paper reports 38.1% falling to 23.5%.",
    sourceTitle: "Text Message Reminders Increase Appointment Adherence in a Pediatric Clinic: A Randomized Controlled Trial",
    sourceId: "PMC5227159",
    href: "https://pmc.ncbi.nlm.nih.gov/articles/PMC5227159/",
  },
  {
    from: "21%",
    to: "14%",
    measure: "of appointments ended in a no-show",
    claim: "In a trial covering about 160,000 appointments, rewording the reminder cut no-shows against the usual text.",
    caveat: "Every patient got a reminder; only the wording changed, and the best of the eight (a message framed around letting others down) is shown. The paper reports 21.1% falling to 14.2%.",
    sourceTitle: "It's how you say it: Systematic A/B testing of digital messaging cut hospital no-show rates",
    sourceId: "PMC7310733",
    href: "https://pmc.ncbi.nlm.nih.gov/articles/PMC7310733/",
  },
];

export interface AverageResult {
  before: string;
  after: string;
  measure: string;
  claim: string;
  note: string;
  /** The percentage-free parts of the home headline; `after` is the big number. */
  headingLead: string;
  headingTail: string;
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

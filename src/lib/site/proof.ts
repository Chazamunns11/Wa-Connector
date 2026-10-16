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
      "In a randomised trial at a children's clinic, adding a text-message reminder cut missed appointments from 38% to 24%.",
    caveat: "A small study, 170 patients. The paper reports 38.1% falling to 23.5%.",
    sourceTitle: "Text Message Reminders Increase Appointment Adherence in a Pediatric Clinic: A Randomized Controlled Trial",
    sourceId: "PMC5227159",
    href: "https://pmc.ncbi.nlm.nih.gov/articles/PMC5227159/",
  },
  {
    from: "21%",
    to: "14%",
    measure: "of patients who did not show",
    claim: "In a trial with about 160,000 patients, the best-worded reminder cut no-shows from 21% to 14%.",
    caveat: "The comparison was the health fund's usual reminder, so the gain came from the wording. The paper reports 21.1% falling to 14.2%.",
    sourceTitle: "It's how you say it: Systematic A/B testing of digital messaging cut hospital no-show rates",
    sourceId: "PMC7310733",
    href: "https://www.ncbi.nlm.nih.gov/pmc/articles/PMC7310733/",
  },
];

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

"use client";

import { siteButton } from "@/components/site/button";

/** Opens the browser's print dialog, where "Save as PDF" is also an option. */
export function PrintButton() {
  return (
    <button type="button" onClick={() => window.print()} className={siteButton("coral")}>
      Print or save as PDF
    </button>
  );
}

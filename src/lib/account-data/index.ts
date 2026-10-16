import { PreviewAccountDataSource, type PreviewScenario } from "./preview";
import type { AccountDataSource } from "./types";

export type { PreviewScenario } from "./preview";
export type * from "./types";

const SCENARIOS: readonly PreviewScenario[] = ["trial", "active", "past_due"];

/**
 * The one place the data source is chosen. Returns the preview source until
 * the accounts-and-billing stage replaces this function.
 */
export function getAccountDataSource(opts?: { scenario?: PreviewScenario; now?: Date }): AccountDataSource {
  return new PreviewAccountDataSource(opts?.scenario ?? "trial", opts?.now);
}

/** Reads a ?scenario= search param; anything unknown falls back to "trial". */
export function parseScenario(value: string | string[] | undefined): PreviewScenario {
  const v = Array.isArray(value) ? value[0] : value;
  return SCENARIOS.find((s) => s === v) ?? "trial";
}

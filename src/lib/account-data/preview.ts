import { monthlyCost, pricingConfig } from "@/lib/pricing";
import { activeCount } from "./derive";
import type {
  AccountDataSource,
  AccountSummary,
  BillingSummary,
  LocationRow,
} from "./types";

export type PreviewScenario = "trial" | "active" | "past_due";

const DAY_MS = 86_400_000;
const NONE = { count: 0, reasons: [] as string[] };

/** Fixed, clearly fictional sample data. Nothing here is real or persisted. */
export class PreviewAccountDataSource implements AccountDataSource {
  readonly preview = true;

  private readonly scenario: PreviewScenario;
  private readonly now: Date;

  constructor(scenario: PreviewScenario = "trial", now: Date = new Date()) {
    this.scenario = scenario;
    this.now = now;
  }

  async getAccount(): Promise<AccountSummary> {
    const base = {
      id: "preview-account",
      name: "Sample Wellness Group",
      kind: "agency" as const,
      email: "owner@example.com",
    };
    if (this.scenario === "trial") {
      return {
        ...base,
        billingStatus: "trialing",
        trialEndsAt: new Date(this.now.getTime() + 4 * DAY_MS).toISOString(),
      };
    }
    return {
      ...base,
      billingStatus: this.scenario === "past_due" ? "past_due" : "active",
      trialEndsAt: null,
    };
  }

  async listLocations(): Promise<LocationRow[]> {
    const row = (over: Partial<LocationRow> & Pick<LocationRow, "id" | "name" | "state">): LocationRow => ({
      activated: true,
      sentToday: 0,
      dailyCap: 150,
      heldMessages: 0,
      failedLast7Days: NONE,
      optOuts: 0,
      providerNudge: false,
      ...over,
    });
    const rows = [
      row({
        id: "loc-1", name: "Harbour Street Physio",
        state: { kind: "connected", number: "+44 7700 900101" },
        sentToday: 42, optOuts: 2,
      }),
      row({
        id: "loc-2", name: "Fernbank Dental",
        state: { kind: "connected", number: "+44 7700 900102" },
        sentToday: 0, providerNudge: true,
      }),
      row({ id: "loc-3", name: "Oakline Pilates", state: { kind: "waiting_qr" } }),
      row({
        id: "loc-4", name: "Millbrook Vets",
        state: { kind: "disconnected", waiting: 4 },
        sentToday: 18, heldMessages: 4,
        failedLast7Days: { count: 1, reasons: ["Number not on WhatsApp"] },
      }),
      row({
        id: "loc-5", name: "Juniper Hair Studio",
        activated: false, state: { kind: "not_active" },
      }),
      row({
        id: "loc-6", name: "Tidewater Fitness",
        state: { kind: "connected", number: "+44 7700 900106" },
        sentToday: 150, dailyCap: 150, optOuts: 5,
        failedLast7Days: { count: 3, reasons: ["Daily cap reached"] },
      }),
    ];
    // The trial includes TRIAL_MAX_NUMBERS numbers: keep the sample within it.
    if (this.scenario !== "trial") return rows;
    const idle = new Set(["loc-3", "loc-6"]);
    return rows.map((r) =>
      idle.has(r.id)
        ? { ...r, activated: false, state: { kind: "not_active" as const }, sentToday: 0, optOuts: 0, failedLast7Days: NONE }
        : r,
    );
  }

  async getBilling(): Promise<BillingSummary> {
    // Preview never talks to a billing provider, so there is no portal.
    return {
      cardLast4: "4242",
      nextInvoiceAt: new Date(this.now.getTime() + (this.scenario === "trial" ? 4 : 12) * DAY_MS).toISOString(),
      nextInvoiceAmount: monthlyCost(activeCount(await this.listLocations())),
      currency: pricingConfig().currency,
      portalAvailable: false,
    };
  }
}

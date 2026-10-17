/**
 * The GHL Custom Page embed's numbers management (several WhatsApp numbers
 * per location, Task 4): add, remove, make default, relabel — plus the
 * redacted per-number list the session route and every numbers response
 * return. Split out of `route.ts` so `scripts/test/embed-numbers.test.ts` can
 * drive it with a fake repo and a fake bridge logout, the same "decision
 * logic deps-injected, route a thin adapter" split as
 * `src/app/api/connect/session/logic.ts`.
 *
 * DELIBERATELY ZERO NEXT IMPORTS, same discipline as
 * `src/lib/bridge-panel-guard.ts` (see that file's header).
 *
 * EMBED-ONLY. These functions are called only from
 * `src/app/api/crm/embed/numbers/route.ts`, behind
 * `authorizeGhlEmbedLocationRequest` (a verified GHL SSO embed token for an
 * active location). A connect link is a bearer credential for ONE number's QR
 * (`src/lib/ghl-connect-link.ts`'s header) and must never be able to add or
 * remove numbers, so nothing under `src/app/api/connect/` calls these.
 *
 * THE TENANT ID IS NEVER CLIENT-SUPPLIED AND NEVER RETURNED. The client names
 * a SLOT; every lookup below runs inside the `locationId` the route's guard
 * resolved from the verified token. `LocationNumber` (which carries the
 * tenant id) is server-only, and every response here is built by
 * ENUMERATING `slot`/`key`/`label`/`isDefault`/`summary` (`toEmbedNumberView`),
 * never by spreading a `LocationNumber`, so a tenant id can never ride along.
 * Bridge failure messages are never forwarded to the client either: a failed
 * logout answers with a fixed sentence.
 *
 * REMOVE LOGS OUT FIRST. Removing a number logs its bridge session out (the
 * existing logout path, which wipes its credentials) BEFORE the database rows
 * go, so a number can never be left linked to a phone with no row pointing at
 * it. `removeLocationNumber` then deletes the number and its sticky rows and
 * moves the default if needed (Task 2). Removing the location's last number
 * is refused before anything is touched (deactivate the location instead).
 */
import { createHash } from "node:crypto";
import type { GhlRepository } from "@/lib/data";
import type { GhlEmbedWhatsappSummary, LocationNumber, WhatsappSessionSummary } from "@/lib/types";
import type { BridgeOkResult } from "@/lib/whatsapp-bridge";
import type { GuardFailureBody } from "@/lib/bridge-panel-guard";
import { parseLabelInput, parseSlotParam, type LocationSlot } from "@/lib/location-numbers";
import { toEmbedWhatsappSummary } from "@/lib/embed-summary";
import { embedStateFor } from "@/app/api/crm/embed/session/logic";

/** The narrow repo slice this module touches — `repo` in production, a fake in tests. */
export type EmbedNumbersRepo = Pick<
  GhlRepository,
  | "listLocationNumbers"
  | "getLocationNumberBySlot"
  | "addLocationNumber"
  | "removeLocationNumber"
  | "setDefaultLocationNumber"
  | "setLocationNumberLabel"
  | "getWhatsappSessionSummary"
  // Accounts and billing (merge ruling) — adding a number re-checks the
  // location's activation and billing, the same gate the embed session
  // applies before it mints a token (`embedStateFor`).
  | "getGhlAccountByLocationId"
  | "getAccountById"
>;

/** What the browser sees for one number. Structurally unable to carry a tenant id. */
export interface EmbedNumberView {
  slot: LocationSlot;
  /** Opaque per-number id for the browser (a React key): changes when the number in a slot changes, never reveals the tenant id (`embedNumberKey`). */
  key: string;
  label: string | null;
  isDefault: boolean;
  summary: GhlEmbedWhatsappSummary | null;
}

/**
 * Strips `coachId` off a session summary before it is ever handed to
 * `NextResponse.json` — moved here from `src/app/api/crm/embed/session/route.ts`
 * (see that file's header, "NEVER THE TENANT ID EITHER", adversarial review
 * lens 4, finding 2) so the per-number list shares the one redaction.
 * Enumerates fields, never spreads. `null` in, `null` out (no
 * `whatsapp_sessions` row yet).
 */
export function toEmbedSummary(summary: WhatsappSessionSummary | null): GhlEmbedWhatsappSummary | null {
  // One redaction for every browser surface (merge): `toEmbedWhatsappSummary`
  // (src/lib/embed-summary.ts) enumerates the same fields plus the held
  // message count, and never the tenant id.
  return toEmbedWhatsappSummary(summary);
}

/**
 * A short, domain-separated sha256 prefix of the tenant id: stable for a
 * number, different for a number removed and re-added in the same slot, and
 * not the tenant id (nor the group contact key's hash of it).
 */
export function embedNumberKey(tenantId: string): string {
  return createHash("sha256").update(`embed-number:${tenantId}`).digest("hex").slice(0, 12);
}

async function toEmbedNumberView(repo: Pick<EmbedNumbersRepo, "getWhatsappSessionSummary">, number: LocationNumber): Promise<EmbedNumberView> {
  const summary = await repo.getWhatsappSessionSummary(number.tenantId);
  return {
    slot: number.slot,
    key: embedNumberKey(number.tenantId),
    label: number.label,
    isDefault: number.isDefault,
    summary: toEmbedSummary(summary),
  };
}

/** The location's numbers, by slot, each with its redacted session summary (one summary read per number). */
export async function listEmbedNumbers(
  repo: Pick<EmbedNumbersRepo, "listLocationNumbers" | "getWhatsappSessionSummary">,
  locationId: string
): Promise<EmbedNumberView[]> {
  const numbers = await repo.listLocationNumbers(locationId);
  return Promise.all(numbers.map((n) => toEmbedNumberView(repo, n)));
}

export type NumbersRouteResult =
  | { status: 200; body: { ok: true; numbers: EmbedNumberView[]; slot?: LocationSlot } }
  | { status: 400 | 404 | 409 | 502; body: GuardFailureBody };

function failure(status: 400 | 404 | 409 | 502, code: string, message: string): NumbersRouteResult {
  return { status, body: { ok: false, code, message } };
}

// Fixed strings, shown in GHL verbatim.
const INVALID_BODY = () => failure(400, "invalid_body", "Malformed request.");
const INVALID_SLOT = () => failure(400, "invalid_slot", "That WhatsApp number isn't valid.");
const INVALID_LABEL = () => failure(400, "invalid_label", "Labels can be up to 40 characters.");
const UNKNOWN_NUMBER = () => failure(404, "unknown_number", "That WhatsApp number isn't set up on this sub-account.");
const LAST_NUMBER = () =>
  failure(409, "last_number", "This is the only WhatsApp number on this sub-account, so it can't be removed.");
const LIMIT = () => failure(409, "limit", "This sub-account already has 3 WhatsApp numbers.");
/**
 * Accounts and billing (merge ruling): one billed unit per activated
 * LOCATION, whatever its number count — so numbers 2-3 never consume an
 * activation slot, but they can only be added to a location that may send.
 */
const NOT_SENDABLE = (state: string) =>
  failure(409, state, "Activate WhatsApp for this sub-account, with billing up to date, before adding another number.");
const LOGOUT_FAILED = () => failure(502, "logout_failed", "Couldn't disconnect that WhatsApp number. Please try again.");

async function okList(repo: EmbedNumbersRepo, locationId: string, slot?: LocationSlot): Promise<NumbersRouteResult> {
  const numbers = await listEmbedNumbers(repo, locationId);
  return { status: 200, body: slot === undefined ? { ok: true, numbers } : { ok: true, numbers, slot } };
}

/**
 * POST — add a number at the lowest free slot, `{ label?: string }`.
 * `body === null` is a malformed body (`readSmallJsonBody`).
 */
export async function decideAddNumber(
  repo: EmbedNumbersRepo,
  locationId: string,
  body: Record<string, unknown> | null
): Promise<NumbersRouteResult> {
  if (body === null) return INVALID_BODY();
  const label = parseLabelInput(body.label);
  if (!label.ok) return INVALID_LABEL();
  // Same gate as the embed session's token mint (`embedStateFor`), re-checked
  // here because an embed token outlives a cancellation or deactivation.
  // Activation is per location (`ghl_accounts.activated_at`), so nothing here
  // touches the activation count or the Stripe quantity.
  const account = await repo.getGhlAccountByLocationId(locationId);
  if (!account) return UNKNOWN_NUMBER();
  const owner = account.accountId ? await repo.getAccountById(account.accountId) : null;
  const state = embedStateFor(account, owner?.billingStatus ?? null, null);
  if (state.state !== "ok") return NOT_SENDABLE(state.state);
  const added = await repo.addLocationNumber(locationId, label.label);
  if (!added.ok) return LIMIT();
  return okList(repo, locationId, added.number.slot);
}

/** The bridge call `decideRemoveNumber` makes — `logoutWhatsappSession` in production. */
export interface RemoveNumberDeps {
  logout: (tenantId: string) => Promise<BridgeOkResult>;
}

/**
 * Bridge failures that must NOT block a removal: no bridge on this
 * deployment, the bridge unreachable (per the controller's ruling: logged,
 * then the removal goes ahead), or the bridge never having heard of this
 * tenant (nothing to log out). Any other failure leaves the number in place,
 * so a live linked device is never orphaned by a transient bridge error.
 */
const LOGOUT_FAILURES_THAT_ALLOW_REMOVAL = new Set(["unconfigured", "unreachable", "not_found"]);

/** DELETE — remove one number, `{ slot }` (required: never defaults to 1). See this file's header, "REMOVE LOGS OUT FIRST". */
export async function decideRemoveNumber(
  repo: EmbedNumbersRepo,
  deps: RemoveNumberDeps,
  locationId: string,
  body: Record<string, unknown> | null
): Promise<NumbersRouteResult> {
  if (body === null) return INVALID_BODY();
  const slot = parseSlotParam(body.slot, { required: true });
  if (!slot.ok) return INVALID_SLOT();

  // Resolve and refuse up front, before the bridge is touched: the slot must
  // exist and must not be the last number.
  const numbers = await repo.listLocationNumbers(locationId);
  const target = numbers.find((n) => n.slot === slot.slot);
  if (!target) return UNKNOWN_NUMBER();
  if (numbers.length <= 1) return LAST_NUMBER();

  const logout = await deps.logout(target.tenantId);
  if (!logout.ok) {
    // Never logs the tenant id or the bridge's own message — the code and slot are enough to act on.
    console.warn(`[api/crm/embed/numbers] remove: bridge logout for slot ${slot.slot} failed with code ${logout.code}`);
    if (!LOGOUT_FAILURES_THAT_ALLOW_REMOVAL.has(logout.code)) return LOGOUT_FAILED();
  }

  const removed = await repo.removeLocationNumber(locationId, slot.slot);
  if (!removed.ok) {
    // A concurrent change since the read above.
    return removed.reason === "last_number" ? LAST_NUMBER() : UNKNOWN_NUMBER();
  }
  return okList(repo, locationId);
}

/**
 * PATCH — `{ slot, makeDefault?: true, label?: string | null }`. Slot is
 * required. `label` present (even `null` or `""`) sets or clears it; absent
 * leaves it alone. At least one change must be asked for.
 */
export async function decideUpdateNumber(
  repo: EmbedNumbersRepo,
  locationId: string,
  body: Record<string, unknown> | null
): Promise<NumbersRouteResult> {
  if (body === null) return INVALID_BODY();
  const slot = parseSlotParam(body.slot, { required: true });
  if (!slot.ok) return INVALID_SLOT();

  const hasMakeDefault = body.makeDefault !== undefined;
  if (hasMakeDefault && body.makeDefault !== true) return INVALID_BODY();
  const hasLabel = Object.prototype.hasOwnProperty.call(body, "label");
  const label = hasLabel ? parseLabelInput(body.label) : null;
  if (label && !label.ok) return INVALID_LABEL();
  if (!hasMakeDefault && !hasLabel) return INVALID_BODY();

  const target = await repo.getLocationNumberBySlot(locationId, slot.slot);
  if (!target) return UNKNOWN_NUMBER();

  if (label && label.ok) {
    if (!(await repo.setLocationNumberLabel(locationId, slot.slot, label.label))) return UNKNOWN_NUMBER();
  }
  if (hasMakeDefault) {
    if (!(await repo.setDefaultLocationNumber(locationId, slot.slot))) return UNKNOWN_NUMBER();
  }
  return okList(repo, locationId);
}

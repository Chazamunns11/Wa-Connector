/**
 * Which of a GHL location's WhatsApp numbers (`ghl_location_numbers`, 0003 —
 * up to three, one `whatsapp_tenants` row each) a message belongs to.
 *
 *   - OUTBOUND (`resolveSendingTenant`, called by
 *     `src/lib/ghl-provider.ts`'s `handleProviderOutboundMessage`): the
 *     contact's STICKY number — the one they last wrote to
 *     (`ghl_contact_numbers`, written by the inbound drain) — when that
 *     number is still one of the location's numbers, else the location's
 *     DEFAULT number. Never "whichever number happens to be connected": a
 *     reply arriving from a number the contact has never seen is worse than a
 *     visible failure, so the provider refuses a disconnected sticky number
 *     rather than falling back (see that module's `refuseIfSendingNumberDisconnected`).
 *   - INBOUND (`inboundNumberPrefix`, called by `src/lib/ghl-inbound.ts`):
 *     the `[label] ` / `[Number N] ` tag that tells the GHL user which number
 *     a reply came in on — only when the location has more than one number,
 *     so a single-number location's conversation reads exactly as before.
 *
 * SERVER-ONLY, like `LocationNumber` itself: every value here carries a
 * tenant id.
 */
import type { GhlRepository } from "@/lib/data";
import type { LocationNumber } from "@/lib/types";

/** The two repository reads `resolveSendingTenant` needs — both on `GhlRepository` (Task 2). */
export type SendingNumberRepo = Pick<GhlRepository, "getStickyTenant" | "listLocationNumbers">;

export interface SendingNumber {
  tenantId: string;
  slot: number;
  label: string | null;
  /** `true` only when the location has more than one number. */
  multi: boolean;
  /** Whether this is the location's default number — the provider keeps its pre-multiple-numbers refusal strings for the default, and uses the sticky-specific one otherwise. */
  isDefault: boolean;
}

/**
 * Sticky if the sticky tenant is still one of the location's numbers, else
 * the default. A sticky tenant that is no longer a number (removed — Task 2
 * deletes its sticky rows, but a row could race the removal) falls back to
 * the default rather than sending from a number the location no longer owns.
 *
 * `fallbackDefaultTenantId` (the account's own `tenantId`) covers a location
 * with NO number rows at all — structurally impossible after Task 2's
 * install/adopt fixes, but if it ever happens this resolves to exactly the
 * pre-multiple-numbers behaviour (the account's tenant, the only number)
 * rather than refusing every outbound for the location.
 *
 * With a single number the sticky read is skipped: whatever it returned, the
 * answer would be that one number.
 */
export async function resolveSendingTenant(
  repo: SendingNumberRepo,
  locationId: string,
  ghlContactId: string,
  fallbackDefaultTenantId: string
): Promise<SendingNumber> {
  const numbers = await repo.listLocationNumbers(locationId);
  if (numbers.length === 0) {
    return { tenantId: fallbackDefaultTenantId, slot: 1, label: null, multi: false, isDefault: true };
  }
  const multi = numbers.length > 1;
  // `listLocationNumbers` is ordered by slot, so `numbers[0]` (the lowest
  // slot) is the defensive pick if no row is flagged default — the same
  // "lowest remaining slot" rule `promoteAfterRemoval` uses.
  const defaultNumber = numbers.find((n) => n.isDefault) ?? numbers[0];
  let chosen = defaultNumber;
  if (multi) {
    const stickyTenantId = await repo.getStickyTenant(locationId, ghlContactId);
    chosen = numbers.find((n) => n.tenantId === stickyTenantId) ?? defaultNumber;
  }
  return { tenantId: chosen.tenantId, slot: chosen.slot, label: chosen.label, multi, isDefault: chosen === defaultNumber };
}

/**
 * The tag prefixed to an inbound's GHL body: `[<label>] ` or, unlabelled,
 * `[Number <slot>] `. Empty when the location has one number (nothing to
 * disambiguate) or when `tenantId` is not one of `numbers` (defensive — no
 * guessing which number it was).
 */
export function inboundNumberPrefix(numbers: LocationNumber[], tenantId: string): string {
  if (numbers.length <= 1) return "";
  const number = numbers.find((n) => n.tenantId === tenantId);
  if (!number) return "";
  // A blank label (empty or whitespace) counts as no label — "[] " would tell
  // the GHL user nothing.
  const label = number.label?.trim();
  return `[${label ? label : `Number ${number.slot}`}] `;
}

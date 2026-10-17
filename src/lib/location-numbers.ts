/**
 * Pure helpers for a GHL location's WhatsApp numbers (`ghl_location_numbers`,
 * migration 0003) and per-contact stickiness (`ghl_contact_numbers`). No I/O:
 * the repository (src/lib/data/supabase.ts) does the queries and uses these
 * for the decisions, so the decisions are unit-testable without Supabase.
 */

export type LocationSlot = 1 | 2 | 3;

const SLOTS: readonly LocationSlot[] = [1, 2, 3];

/** The lowest unused slot (1 to 3), or `null` when the location already has three numbers. */
export function nextFreeSlot(usedSlots: number[]): LocationSlot | null {
  for (const slot of SLOTS) {
    if (!usedSlots.includes(slot)) return slot;
  }
  return null;
}

/**
 * After removing `removedSlot`, which slot (if any) must become the default?
 * Returns the lowest remaining slot when the removed number was the default,
 * else `null`. Throws when the slot is unknown or is the location's only
 * number (a location can never have zero numbers; callers map this to
 * `last_number` / `not_found` before calling).
 */
export function promoteAfterRemoval(
  numbers: { slot: number; isDefault: boolean }[],
  removedSlot: number
): number | null {
  const removed = numbers.find((n) => n.slot === removedSlot);
  if (!removed) throw new Error(`promoteAfterRemoval: slot ${removedSlot} not found`);
  const remaining = numbers.filter((n) => n.slot !== removedSlot);
  if (remaining.length === 0) throw new Error("promoteAfterRemoval: cannot remove the last number");
  if (!removed.isDefault) return null;
  return Math.min(...remaining.map((n) => n.slot));
}

/**
 * Sticky routing only moves forward in time: an incoming inbound replaces the
 * stored row only when it is STRICTLY newer (out-of-order or replayed drain
 * rows must never overwrite a newer one). Compares instants, not strings, as
 * Postgres returns `+00:00` offsets where JS emits `Z`.
 */
export function shouldReplaceSticky(existingIso: string | null, incomingIso: string): boolean {
  if (existingIso === null) return true;
  return Date.parse(incomingIso) > Date.parse(existingIso);
}

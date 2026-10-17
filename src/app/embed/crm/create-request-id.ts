/**
 * Which create `requestId` the form keeps after one attempt. Kept in its own
 * file (no React, no "use client") so `scripts/test/create-request-id.test.ts`
 * can import it.
 *
 * Any answer from the route, ok or not, means the request arrived and the
 * bridge has settled it: a success or a may-exist failure is now in the
 * bridge's replay cache (the next deliberate attempt must not replay it), and
 * a refusal made no group (the coach fixes the cause and tries again). So the
 * id is dropped and the next press mints a fresh one.
 *
 * Only a thrown call (network failure, no answer) keeps the id: the request
 * may or may not have reached the bridge, and a second press with the same id
 * replays the first outcome instead of making a second group.
 */
export function requestIdAfterCreateAttempt(current: string | null, attempt: "answered" | "threw"): string | null {
  return attempt === "threw" ? current : null;
}

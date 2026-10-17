/**
 * WhatsApp group helpers — pure logic, no I/O of its own. The bridge stays
 * policy-free: it creates groups, runs paced "add participants" jobs and
 * records what WhatsApp answered. Every decision needing business context
 * (consent, STOP, billing, invite fallback) lives in the portal.
 *
 * Phone numbers are NEVER logged here; this module does not log at all.
 */

export const GROUP_JID_RE = /^[0-9]{5,20}(-[0-9]{5,20})?@g\.us$/;

export function isGroupJid(value: string): boolean {
  return GROUP_JID_RE.test(value);
}

export type ParticipantOutcome = "added" | "invite_needed" | "recently_left" | "already_member" | "not_on_whatsapp" | "group_full" | "failed";

const OUTCOME_BY_STATUS: Record<string, ParticipantOutcome> = {
  "200": "added",
  "403": "invite_needed",
  "408": "recently_left",
  "409": "already_member",
  "404": "not_on_whatsapp",
  "419": "group_full",
};

/** Observed (not documented) groupParticipantsUpdate per-participant status codes; anything unknown is `failed`. */
export function outcomeForParticipantStatus(status: string): ParticipantOutcome {
  return Object.hasOwn(OUTCOME_BY_STATUS, status) ? OUTCOME_BY_STATUS[status]! : "failed";
}

export function inviteLinkFor(code: string): string {
  return `https://chat.whatsapp.com/${code}`;
}

export interface GroupLimiterConfig {
  addBatch: number;
  addGapMs: number;
  addJitterMs: number;
  addsDailyCap: number;
  createsDailyCap: number;
}

/** Per-session budget for group adds and creates, per UTC day. Group posts use the send pacer instead. */
export class GroupLimiter {
  private dayKey: string;
  private adds: number;
  private creates: number;

  constructor(
    private readonly config: GroupLimiterConfig,
    seed: { addsToday: number; createsToday: number },
    private readonly now: () => number = Date.now,
    private readonly random: () => number = Math.random
  ) {
    this.dayKey = this.utcDayKey();
    this.adds = seed.addsToday;
    this.creates = seed.createsToday;
  }

  private utcDayKey(): string {
    return new Date(this.now()).toISOString().slice(0, 10);
  }

  private roll(): void {
    const key = this.utcDayKey();
    if (key !== this.dayKey) {
      this.dayKey = key;
      this.adds = 0;
      this.creates = 0;
    }
  }

  remainingAddsToday(): number {
    this.roll();
    return Math.max(0, this.config.addsDailyCap - this.adds);
  }

  /** Reserves n adds; false (and nothing reserved) when n exceeds what is left today. */
  reserveAdds(n: number): boolean {
    if (n > this.remainingAddsToday()) return false;
    this.adds += n;
    return true;
  }

  remainingCreatesToday(): number {
    this.roll();
    return Math.max(0, this.config.createsDailyCap - this.creates);
  }

  reserveCreate(): boolean {
    if (this.remainingCreatesToday() < 1) return false;
    this.creates += 1;
    return true;
  }

  batchGapMs(): number {
    return this.config.addGapMs + Math.floor(this.random() * (this.config.addJitterMs + 1));
  }

  batches<T>(items: T[]): T[][] {
    const out: T[][] = [];
    for (let i = 0; i < items.length; i += this.config.addBatch) out.push(items.slice(i, i + this.config.addBatch));
    return out;
  }
}

export interface AddJobSocket {
  onWhatsApp(...phones: string[]): Promise<{ jid: string; exists: boolean }[] | undefined>;
  groupParticipantsUpdate(jid: string, participants: string[], action: "add"): Promise<{ status: string; jid: string | undefined }[]>;
}

export interface AddJobResult {
  phone: string;
  code: string;
  outcome: ParticipantOutcome;
}

/**
 * Adds `phones` to a group in paced batches. Results come back in request
 * order. Stops (interrupted) as soon as the session is no longer connected;
 * phones not yet attempted are simply absent from `results` (the portal
 * reports them as interrupted). Throws from the socket propagate to the caller.
 */
export async function runAddJob(
  sock: AddJobSocket,
  limiter: GroupLimiter,
  groupJid: string,
  phones: string[],
  sleep: (ms: number) => Promise<void>,
  isConnected: () => boolean
): Promise<{ results: AddJobResult[]; interrupted: boolean }> {
  // Resolve every phone up front (one lookup; the portal caps a job at 50), then
  // batch only the phones WhatsApp says exist. Pairing is by position in the
  // lookup, never by building a jid from the phone string.
  const resolved = (await sock.onWhatsApp(...phones)) ?? [];
  const outcome = new Map<string, AddJobResult>();
  const sendable: { phone: string; jid: string }[] = [];
  phones.forEach((phone, i) => {
    const hit = resolved[i];
    if (!hit || hit.exists === false || !hit.jid) outcome.set(phone, { phone, code: "404", outcome: "not_on_whatsapp" });
    else sendable.push({ phone, jid: hit.jid });
  });
  // Results in request order; a phone is emitted once every sendable phone before it has been attempted.
  const results: AddJobResult[] = [];
  let emitted = 0;
  const flush = (): void => {
    while (emitted < phones.length && outcome.has(phones[emitted]!)) results.push(outcome.get(phones[emitted++]!)!);
  };
  flush();
  const batches = limiter.batches(sendable);
  for (let b = 0; b < batches.length; b++) {
    if (!isConnected()) return { results, interrupted: true };
    if (b > 0) await sleep(limiter.batchGapMs());
    const batch = batches[b]!;
    const response = await sock.groupParticipantsUpdate(groupJid, batch.map((x) => x.jid), "add");
    const byJid = new Map<string, string>();
    for (const row of response) if (row.jid) byJid.set(row.jid, row.status);
    for (const { phone, jid } of batch) {
      const code = byJid.get(jid);
      outcome.set(phone, code === undefined ? { phone, code: "missing", outcome: "failed" } : { phone, code, outcome: outcomeForParticipantStatus(code) });
    }
    flush();
  }
  return { results, interrupted: false };
}

import type { AccountSession } from "@/lib/account-session";
import { repo } from "@/lib/data";
import { retrieveSubscription } from "@/lib/stripe/billing";
import { SupabaseAccountDataSource } from "./supabase";
import type { AccountDataSource } from "./types";

export type * from "./types";

/** The one place the data source is chosen: the signed-in account's real data. */
export function getAccountDataSource(session: Pick<AccountSession, "accountId">, now: Date = new Date()): AccountDataSource {
  return new SupabaseAccountDataSource(repo, { retrieveSubscription }, session.accountId, now);
}

import { SupabaseGhlRepository } from "./supabase";
import type { GhlRepository } from "./repository";

export type { GhlRepository } from "./repository";

/**
 * The one data-access instance: service-role Supabase. PortalHub's `repo` and
 * `webhookRepo` both map to this export — there are no user-session repos in
 * this codebase, and no demo mode.
 */
export const repo: GhlRepository = new SupabaseGhlRepository();

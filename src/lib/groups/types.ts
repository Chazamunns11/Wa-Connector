import type { BillingStatus, GroupMemberState, WhatsappSessionStatus } from "@/lib/types";

export type GateInput = {
  groupsEnabled: boolean;
  location: { accountId: string | null; activatedAt: string | null } | null;
  billingStatus: BillingStatus | null;
  sessionStatus: WhatsappSessionStatus | null;
  brandName: string;
};

export interface CandidateMember {
  phone: string;
  ghlContactId: string | null;
  displayName: string | null;
}

export interface AddPlan {
  toAdd: CandidateMember[];
  skippedExisting: number;
  optedOut: CandidateMember[];
  refusal: string | null;
}

export interface ReconcilePlan {
  updates: { memberId: string; state: GroupMemberState; reason: string | null }[];
  invites: { memberId: string; phone: string }[];
}

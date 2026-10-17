import "server-only";
import { brandConfig } from "@/lib/brand-config";
import { listGhlContacts, refreshGhlToken } from "@/lib/ghl";
import type { GroupsDeps } from "@/lib/groups/service";
import {
  addWhatsappGroupParticipants,
  createWhatsappGroup,
  getWhatsappGroup,
  getWhatsappGroupJob,
  postToWhatsappGroup,
  revokeWhatsappGroupInvite,
  sendWhatsappMessage,
} from "@/lib/whatsapp-bridge";

/** Exactly the word "true" switches groups on, like the other server-side switches. */
export function groupsEnabled(): boolean {
  return process.env.GROUPS_ENABLED === "true";
}

export function groupsDeps(): GroupsDeps {
  return {
    groupsEnabled: groupsEnabled(),
    brandName: brandConfig().name,
    now: () => new Date(),
    bridge: {
      createGroup: createWhatsappGroup,
      addParticipants: addWhatsappGroupParticipants,
      getJob: getWhatsappGroupJob,
      post: postToWhatsappGroup,
      getGroup: getWhatsappGroup,
      revokeInvite: revokeWhatsappGroupInvite,
      sendText: sendWhatsappMessage,
    },
    ghl: {
      listContacts: listGhlContacts,
      token: {
        refreshToken: refreshGhlToken,
        refreshWaitMs: 1000,
        notify: (text) => {
          void import("@/lib/slack").then((m) => m.notifyText(text));
        },
      },
    },
    notify: (text) => {
      void import("@/lib/slack").then((m) => m.notifyText(text));
    },
  };
}

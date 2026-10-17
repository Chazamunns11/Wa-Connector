import type { AccountKind } from "@/lib/account-data/types";

export interface SignupInput {
  accountName: string;
  kind: AccountKind;
  email: string;
}

export type SignupField = keyof SignupInput;
/** Codes travel in the URL; only the messages below are ever rendered. */
export type SignupErrorCode = "name_length" | "kind_required" | "email_invalid";
export type SignupErrorCodes = Partial<Record<SignupField, SignupErrorCode>>;
export type SignupErrors = Partial<Record<SignupField, string>>;

export const SIGNUP_ERROR_MESSAGES: Record<SignupErrorCode, string> = {
  name_length: "Enter a name between 2 and 80 characters.",
  kind_required: "Choose agency or single business.",
  email_invalid: "Enter an email address like name@example.com.",
};

export type SignupResult =
  | { ok: true; value: SignupInput }
  | { ok: false; errors: SignupErrorCodes; values: Partial<SignupInput> };

const FIELDS = ["accountName", "kind", "email"] as const;
const KINDS: readonly AccountKind[] = ["agency", "business"];

function asString(v: FormDataEntryValue | string | string[] | null | undefined): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function isKind(v: string | undefined): v is AccountKind {
  return KINDS.includes(v as AccountKind);
}

/** One "@", something either side, and a dot after it that is neither first nor last. */
function validEmail(email: string): boolean {
  if (email.length > 320 || /\s/.test(email)) return false;
  const parts = email.split("@");
  if (parts.length !== 2 || !parts[0]) return false;
  const domain = parts[1];
  const dot = domain.lastIndexOf(".");
  return dot > 0 && dot < domain.length - 1;
}

export function validateSignup(form: Record<string, FormDataEntryValue | null>): SignupResult {
  const accountName = (asString(form.accountName) ?? "").trim();
  const kindRaw = asString(form.kind);
  const email = (asString(form.email) ?? "").trim().toLowerCase();
  const errors: SignupErrorCodes = {};

  if (accountName.length < 2 || accountName.length > 80) {
    errors.accountName = "name_length";
  }
  if (!isKind(kindRaw)) errors.kind = "kind_required";
  if (!validEmail(email)) errors.email = "email_invalid";

  if (Object.keys(errors).length === 0 && isKind(kindRaw)) {
    return { ok: true, value: { accountName, kind: kindRaw, email } };
  }
  const values: Partial<SignupInput> = {};
  if (accountName) values.accountName = accountName;
  if (isKind(kindRaw)) values.kind = kindRaw;
  if (email) values.email = email;
  return { ok: false, errors, values };
}

/** Query string for the redirect back to /signup: error.<field> and v.<field>. */
export function signupRedirectQuery(result: Extract<SignupResult, { ok: false }>): string {
  const q = new URLSearchParams();
  for (const f of FIELDS) {
    const e = result.errors[f];
    if (e) q.set(`error.${f}`, e);
  }
  for (const f of FIELDS) {
    const v = result.values[f];
    if (v) q.set(`v.${f}`, v);
  }
  return q.toString();
}

type Params = Record<string, string | string[] | undefined>;

/** Reads errors and kept values back from /signup search params; anything unexpected is dropped. */
export function signupStateFromParams(params: Params): { errors: SignupErrors; values: Partial<SignupInput> } {
  const errors: SignupErrors = {};
  const values: Partial<SignupInput> = {};
  for (const f of FIELDS) {
    const code = asString(params[`error.${f}`]);
    if (code && Object.hasOwn(SIGNUP_ERROR_MESSAGES, code)) {
      errors[f] = SIGNUP_ERROR_MESSAGES[code as SignupErrorCode];
    }
    const v = asString(params[`v.${f}`]);
    if (!v) continue;
    if (f === "kind") {
      if (isKind(v)) values.kind = v;
    } else {
      values[f] = v.slice(0, f === "email" ? 320 : 80);
    }
  }
  return { errors, values };
}

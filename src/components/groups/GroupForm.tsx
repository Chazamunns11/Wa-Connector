"use client";

import { useState } from "react";
import { createGroupAction } from "@/app/(app)/dashboard/groups/actions";
import { INPUT_CLASSES } from "@/components/auth/field";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { DESCRIPTION_MAX, SUBJECT_MAX } from "@/lib/groups/rules";
import { MemberPicker } from "./MemberPicker";

export type NumberOption = { locationId: string; label: string; usable: boolean; note: string | null };

export function GroupForm({ numbers, disabled }: { numbers: NumberOption[]; disabled: boolean }) {
  const firstUsable = numbers.find((n) => n.usable)?.locationId ?? "";
  const [location, setLocation] = useState(firstUsable);
  const [submitting, setSubmitting] = useState(false);

  return (
    <form action={createGroupAction} onSubmit={() => setSubmitting(true)} className="space-y-6">
      <Card className="space-y-5">
        <div>
          <label htmlFor="location" className="text-sm font-medium text-ink">
            WhatsApp number
          </label>
          <select id="location" name="location" required value={location} onChange={(e) => setLocation(e.target.value)} className={`${INPUT_CLASSES} mt-1`}>
            {numbers.map((n) => (
              <option key={n.locationId} value={n.locationId} disabled={!n.usable}>
                {n.label}
                {n.note ? ` (${n.note})` : ""}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="subject" className="text-sm font-medium text-ink">
            Group name
          </label>
          <input id="subject" name="subject" required maxLength={SUBJECT_MAX} className={`${INPUT_CLASSES} mt-1`} />
        </div>
        <div>
          <label htmlFor="description" className="text-sm font-medium text-ink">
            Description <span className="font-normal text-ink-dim">(optional)</span>
          </label>
          <textarea id="description" name="description" rows={2} maxLength={DESCRIPTION_MAX} className={`${INPUT_CLASSES} mt-1 py-2`} />
        </div>
        <fieldset className="space-y-3">
          <legend className="text-sm font-medium text-ink">Who can do what</legend>
          <label className="flex items-start gap-3">
            <input type="checkbox" name="adminAddOnly" defaultChecked className="mt-0.5 size-4 accent-[var(--accent)]" />
            <span className="text-sm text-ink">Only admins can add members</span>
          </label>
          <label className="flex items-start gap-3">
            <input type="checkbox" name="announceOnly" className="mt-0.5 size-4 accent-[var(--accent)]" />
            <span className="text-sm text-ink">Only admins can post</span>
          </label>
        </fieldset>
      </Card>
      <Card>
        <h2 className="font-display text-lg">First members</h2>
        <p className="mb-4 mt-1 text-sm text-ink-faint">WhatsApp needs at least one person to create a group. You can add more afterwards.</p>
        <MemberPicker locationId={location} required />
      </Card>
      <Button type="submit" disabled={disabled || submitting || !location} className="min-h-11 px-5">
        {submitting ? "Creating…" : "Create group"}
      </Button>
    </form>
  );
}

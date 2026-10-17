import { GROUP_RESULT_COPY, isSuccessResult, type GroupResult } from "@/lib/groups/forms";

export function ResultNotice({ result }: { result: GroupResult | null }) {
  if (!result) return null;
  const ok = isSuccessResult(result);
  return (
    <p
      role={ok ? "status" : "alert"}
      className={`mt-4 rounded-lg border p-3 font-medium text-ink ${ok ? "border-info/30 bg-info-soft" : "border-loss/30 bg-loss-soft"}`}
    >
      {GROUP_RESULT_COPY[result]}
    </p>
  );
}

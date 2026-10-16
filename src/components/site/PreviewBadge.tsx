import { Chip } from "@/components/ui/Chip";

/** Shown on every preview screen: nothing is saved, sent or charged. */
export function PreviewBadge() {
  return (
    <span role="status">
      <Chip tone="warn">Preview — sample data, nothing is saved or charged</Chip>
    </span>
  );
}

"use client";

import { useState } from "react";
import { Button } from "@/components/ui/Button";

/** Small copy-to-clipboard button; swaps its label to "Copied" briefly. */
export function CopyButton({
  value,
  label = "Copy",
  copiedLabel = "Copied",
  size = "sm",
}: {
  value: string;
  label?: string;
  copiedLabel?: string;
  size?: "sm" | "md";
}) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard API can fail without a secure context; fail silently.
    }
  }

  return (
    <Button type="button" variant="secondary" size={size} onClick={handleCopy}>
      {copied ? copiedLabel : label}
    </Button>
  );
}

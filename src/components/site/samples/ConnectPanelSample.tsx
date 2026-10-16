import { QrMark } from "@/components/site/diagram-parts";
import { buttonClasses } from "@/components/ui/Button";
import { Chip } from "@/components/ui/Chip";
import { brandConfig } from "@/lib/brand-config";
import { QR_WARNING } from "@/lib/site/setup-steps";

/**
 * The connect panel as the app draws it (WhatsappConnectionPanel): a built
 * mock, not a screenshot, so the strings stay crisp and follow the app. Nothing
 * inside is interactive. `connectedStrip` adds the state after the scan.
 */
const INSTRUCTION = "On your phone: WhatsApp → Settings → Linked devices → Link a device, then scan this code.";

export function ConnectPanelSample({ connectedStrip = false }: { connectedStrip?: boolean }) {
  const { name } = brandConfig();
  const label = connectedStrip
    ? `The ${name} connect page in two states: Waiting for QR scan with a QR code, and Connected as +44 7700 900101.`
    : `The ${name} connect page: a WhatsApp panel with the status Waiting for QR scan, a QR code, the instruction to open WhatsApp, Settings, Linked devices, Link a device and scan it, a warning that whoever scans can send as your business, and a button to get a new QR code.`;

  return (
    <div role="img" aria-label={label} className="w-full max-w-md">
      <div aria-hidden="true" className="sample-chrome">
        <div className="flex items-center justify-between gap-3 border-b px-5 py-4">
          <p className="font-display text-xl font-medium">WhatsApp</p>
          <Chip tone="warn">Waiting for QR scan</Chip>
        </div>
        <div className="px-5 py-5">
          <svg viewBox="0 0 160 160" width="160" height="160" className="mx-auto block">
            <QrMark x={0} y={0} size={160} />
          </svg>
          <p className="mt-5 text-[15px] leading-snug text-ink">{INSTRUCTION}</p>
          <p className="mt-3 text-[15px] leading-snug text-loss">{QR_WARNING}</p>
          <span className={`${buttonClasses("secondary")} mt-5`}>Get a new QR code</span>
        </div>
        {connectedStrip ? (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t bg-raised px-5 py-3 text-[15px]">
            <Chip tone="win">Connected</Chip>
            <span>
              Connected as <span className="font-mono-nums">+44 7700 900101</span>
            </span>
          </div>
        ) : null}
      </div>
    </div>
  );
}

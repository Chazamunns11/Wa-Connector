import { Arrow, NARROW, Plain, QrMark, WIDE } from "@/components/site/diagram-parts";

function Phone({ x, y, w, h }: { x: number; y: number; w: number; h: number }) {
  const cx = x + w / 2;
  return (
    <g>
      <Plain x={x} y={y} w={w} h={h} rx={14} accent />
      <text x={cx} y={y + h / 2 - 2} textAnchor="middle" fontSize={14} fontWeight={600} className="fill-ink">
        Your phone
      </text>
      <text x={cx} y={y + h / 2 + 16} textAnchor="middle" fontSize={12} className="fill-ink-dim">
        Link a Device
      </text>
    </g>
  );
}

export function QrLinkDiagram() {
  const label =
    "Diagram: the connect page shows a QR code. On your phone, WhatsApp's Link a Device screen scans it to link the number";
  return (
    <>
      <svg viewBox="0 0 560 170" role="img" aria-label={label} className={WIDE}>
        <title>{label}</title>
        <Plain x={0} y={5} w={310} h={160} />
        <QrMark x={24} y={25} size={120} />
        <text x={164} y={80} fontSize={14} fontWeight={600} className="fill-ink">
          Connect page
        </text>
        <text x={164} y={100} fontSize={12} className="fill-ink-dim">
          Shows the QR code
        </text>
        <Arrow x={310} y={85} len={120} dir="right" dashed />
        <text x={370} y={74} textAnchor="middle" fontSize={12} className="fill-ink-dim">
          Scan
        </text>
        <Phone x={430} y={5} w={130} h={160} />
      </svg>
      <svg viewBox="0 0 300 340" role="img" aria-label={label} className={NARROW}>
        <title>{label}</title>
        <Plain x={20} y={0} w={260} h={150} />
        <QrMark x={36} y={15} size={120} />
        <text x={168} y={74} fontSize={14} fontWeight={600} className="fill-ink">
          Connect
        </text>
        <text x={168} y={92} fontSize={14} fontWeight={600} className="fill-ink">
          page
        </text>
        <text x={168} y={112} fontSize={12} className="fill-ink-dim">
          QR code
        </text>
        <Arrow x={150} y={150} len={50} dir="down" dashed />
        <text x={162} y={180} fontSize={12} className="fill-ink-dim">
          Scan
        </text>
        <Plain x={20} y={200} w={260} h={130} rx={14} accent />
        <text x={150} y={262} textAnchor="middle" fontSize={14} fontWeight={600} className="fill-ink">
          Your phone
        </text>
        <text x={150} y={282} textAnchor="middle" fontSize={12} className="fill-ink-dim">
          Link a Device
        </text>
      </svg>
    </>
  );
}

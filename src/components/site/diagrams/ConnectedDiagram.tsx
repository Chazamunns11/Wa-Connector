import { NARROW, Plain, WIDE } from "@/components/site/diagram-parts";

function Row({ x, y, w }: { x: number; y: number; w: number }) {
  return (
    <g>
      <Plain x={x} y={y} w={w} h={90} />
      <text x={x + 16} y={y + 34} fontSize={14} fontWeight={600} className="fill-ink">
        WhatsApp
      </text>
      <text x={x + 16} y={y + 62} fontSize={12} className="fill-ink-dim">
        Your linked number
      </text>
      <rect x={x + w - 136} y={y + 16} width={120} height={30} rx={4} className="fill-win-soft stroke-win" strokeWidth={1.5} />
      <circle cx={x + w - 120} cy={y + 31} r={5} className="fill-win" />
      <text x={x + w - 106} y={y + 36} fontSize={14} fontWeight={600} className="fill-ink">
        Connected
      </text>
    </g>
  );
}

export function ConnectedDiagram() {
  const label =
    "Diagram: the WhatsApp card on the connect page, with a green Connected status in its top corner and your linked number underneath";
  return (
    <>
      <svg viewBox="0 0 560 110" role="img" aria-label={label} className={WIDE}>
        <title>{label}</title>
        <Row x={0} y={10} w={560} />
      </svg>
      <svg viewBox="0 0 300 110" role="img" aria-label={label} className={NARROW}>
        <title>{label}</title>
        <Row x={10} y={10} w={280} />
      </svg>
    </>
  );
}

import { Arrow, NARROW, Node, Plain, WIDE, clip } from "@/components/site/diagram-parts";

function Chooser({ brandName, x, y, w, stack }: { brandName: string; x: number; y: number; w: number; stack: boolean }) {
  const h = stack ? 140 : 105;
  const fieldY = y + (stack ? 46 : 48);
  const fieldW = stack ? w - 32 : 300;
  const saveX = stack ? x + 16 : x + w - 140;
  const saveY = stack ? fieldY + 48 : fieldY;
  return (
    <g>
      <Plain x={x} y={y} w={w} h={h} />
      <text x={x + 16} y={y + 30} fontSize={14} fontWeight={600} className="fill-ink">
        Telephony Provider
      </text>
      <Plain x={x + 16} y={fieldY} w={fieldW} h={38} accent rx={4} />
      <text x={x + 30} y={fieldY + 24} fontSize={14} fontWeight={600} className="fill-ink">
        {clip(brandName, 22)}
      </text>
      <polygon
        points={`${x + 16 + fieldW - 28},${fieldY + 15} ${x + 16 + fieldW - 14},${fieldY + 15} ${x + 16 + fieldW - 21},${fieldY + 24}`}
        className="fill-ink"
      />
      <rect x={saveX} y={saveY} width={124} height={38} rx={4} className="fill-accent-text" />
      <text x={saveX + 62} y={saveY + 24} textAnchor="middle" fontSize={14} fontWeight={600} className="fill-white">
        Save
      </text>
    </g>
  );
}

export function TelephonyProviderDiagram({ brandName }: { brandName: string }) {
  const label = `Diagram: go to Settings, then Phone System, then Advanced Settings. Under Telephony Provider, pick ${brandName} from the dropdown and click Save`;
  const crumbs = ["Settings", "Phone System", "Advanced Settings"];
  return (
    <>
      <svg viewBox="0 0 560 176" role="img" aria-label={label} className={WIDE}>
        <title>{label}</title>
        {crumbs.map((c, i) => (
          <Node key={c} x={i * 200} y={0} w={160} h={44} title={c} />
        ))}
        <Arrow x={160} y={22} len={40} dir="right" />
        <Arrow x={360} y={22} len={40} dir="right" />
        <Arrow x={480} y={44} len={26} dir="down" />
        <Chooser brandName={brandName} x={0} y={71} w={560} stack={false} />
      </svg>
      <svg viewBox="0 0 300 330" role="img" aria-label={label} className={NARROW}>
        <title>{label}</title>
        {crumbs.map((c, i) => (
          <Node key={c} x={20} y={i * 62} w={260} h={44} title={c} />
        ))}
        <Arrow x={150} y={44} len={18} dir="down" />
        <Arrow x={150} y={106} len={18} dir="down" />
        <Arrow x={150} y={168} len={22} dir="down" />
        <Chooser brandName={brandName} x={20} y={190} w={260} stack />
      </svg>
    </>
  );
}

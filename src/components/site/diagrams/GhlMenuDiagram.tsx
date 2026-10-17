import { Arrow, NARROW, Node, Plain, WIDE, clip } from "@/components/site/diagram-parts";

const ITEMS = ["Contacts", "Conversations", null, "Settings"] as const;

function Menu({ brandName, x, y, w }: { brandName: string; x: number; y: number; w: number }) {
  return (
    <g>
      <Plain x={x} y={y} w={w} h={134} />
      {ITEMS.map((item, i) => {
        const ry = y + 10 + i * 31;
        return item ? (
          <text key={item} x={x + 20} y={ry + 18} fontSize={14} className="fill-ink-dim">
            {item}
          </text>
        ) : (
          <g key="brand">
            <Plain x={x + 8} y={ry} w={w - 16} h={26} accent rx={4} />
            <text x={x + 20} y={ry + 18} fontSize={14} fontWeight={600} className="fill-ink">
              {clip(brandName, 18)}
            </text>
          </g>
        );
      })}
    </g>
  );
}

export function GhlMenuDiagram({ brandName }: { brandName: string }) {
  const label = `Diagram: in the left menu of a sub-account, the highlighted ${brandName} item opens the ${brandName} page with your WhatsApp status and QR code`;
  return (
    <>
      <svg viewBox="0 0 560 154" role="img" aria-label={label} className={WIDE}>
        <title>{label}</title>
        <Menu brandName={brandName} x={0} y={10} w={210} />
        <Arrow x={210} y={77} len={60} dir="right" />
        <Node x={270} y={10} w={290} h={134} title={`${clip(brandName)} page`} sub="Status and QR code" accent />
      </svg>
      <svg viewBox="0 0 300 244" role="img" aria-label={label} className={NARROW}>
        <title>{label}</title>
        <Menu brandName={brandName} x={20} y={0} w={260} />
        <Arrow x={150} y={134} len={30} dir="down" />
        <Node x={20} y={164} w={260} h={64} title={`${clip(brandName)} page`} sub="Status and QR code" accent />
      </svg>
    </>
  );
}

import { H_FLOW_HEIGHT, HFlow, NARROW, VFlow, WIDE, clip, vFlowHeight } from "@/components/site/diagram-parts";

export function InstallDiagram({ brandName }: { brandName: string }) {
  const label = `Diagram: the install link or the Marketplace, then approving the permissions, adds ${brandName} to your HighLevel account`;
  const nodes = [
    { title: "Install link", sub: "or Marketplace" },
    { title: "Approve", sub: "Permissions screen" },
    { title: "Your account", sub: `${clip(brandName)} added`, accent: true },
  ];
  return (
    <>
      <svg viewBox={`0 0 560 ${H_FLOW_HEIGHT}`} role="img" aria-label={label} className={WIDE}>
        <title>{label}</title>
        <HFlow nodes={nodes} />
      </svg>
      <svg viewBox={`0 0 300 ${vFlowHeight(3)}`} role="img" aria-label={label} className={NARROW}>
        <title>{label}</title>
        <VFlow nodes={nodes} />
      </svg>
    </>
  );
}

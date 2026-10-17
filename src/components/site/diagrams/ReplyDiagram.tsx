import { H_FLOW_HEIGHT, HFlow, NARROW, VFlow, WIDE, clip, vFlowHeight } from "@/components/site/diagram-parts";

export function ReplyDiagram({ brandName }: { brandName: string }) {
  const label = `Diagram: your reply on WhatsApp goes through ${brandName} and appears in the contact's thread in Conversations`;
  const nodes = [
    { title: "Your mobile", sub: "Reply on WhatsApp" },
    { title: clip(brandName), sub: "Passes it on" },
    { title: "Conversations", sub: "Reply appears", accent: true },
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

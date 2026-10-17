import { H_FLOW_HEIGHT, HFlow, NARROW, VFlow, WIDE, clip, vFlowHeight } from "@/components/site/diagram-parts";

export function TestSendDiagram({ brandName }: { brandName: string }) {
  const label = `Diagram: a workflow with a Send SMS step hands the message to ${brandName}, which sends it to your own mobile on WhatsApp`;
  const nodes = [
    { title: "Workflow", sub: "Send SMS step" },
    { title: clip(brandName), sub: "Sends on WhatsApp", accent: true },
    { title: "Your mobile", sub: "Test message" },
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

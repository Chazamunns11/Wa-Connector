import type { ReactNode } from "react";
import type { Audience, DiagramId, SetupStep as Step } from "@/lib/site/setup-steps";
import { ConnectedDiagram } from "@/components/site/diagrams/ConnectedDiagram";
import { GhlMenuDiagram } from "@/components/site/diagrams/GhlMenuDiagram";
import { InstallDiagram } from "@/components/site/diagrams/InstallDiagram";
import { QrLinkDiagram } from "@/components/site/diagrams/QrLinkDiagram";
import { ReplyDiagram } from "@/components/site/diagrams/ReplyDiagram";
import { TelephonyProviderDiagram } from "@/components/site/diagrams/TelephonyProviderDiagram";
import { TestSendDiagram } from "@/components/site/diagrams/TestSendDiagram";

function diagramFor(id: DiagramId, brandName: string): ReactNode {
  switch (id) {
    case "install":
      return <InstallDiagram brandName={brandName} />;
    case "menu":
      return <GhlMenuDiagram brandName={brandName} />;
    case "telephony":
      return <TelephonyProviderDiagram brandName={brandName} />;
    case "qr":
      return <QrLinkDiagram />;
    case "connected":
      return <ConnectedDiagram />;
    case "test-send":
      return <TestSendDiagram brandName={brandName} />;
    case "reply":
      return <ReplyDiagram brandName={brandName} />;
  }
}

/** One numbered step: heading, summary, detail lines and its schematic. */
export function SetupStep({
  step,
  audience,
  brandName,
  index,
}: {
  index: number;
  step: Step;
  audience: Audience;
  brandName: string;
}) {
  const headingId = `${audience}-${step.id}`;
  return (
    <li className="grid gap-4 border-t-2 border-rule py-6">
      <div>
        <h3 id={headingId} className="h-item font-display">
          <span className="mr-2 text-ink">{index + 1}.</span>
          {step.title}
        </h3>
        <p className="mt-2 text-ink-dim">{step.summary}</p>
        <ul className="mt-3 grid max-w-[62ch] list-disc gap-2 pl-5 text-ink-dim marker:text-ink-faint">
          {step.detail[audience].map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </div>
      <figure className="m-0 rounded-[20px] border-[3px] border-outline bg-well p-4">
        {diagramFor(step.diagram, brandName)}
        <figcaption className="mt-2 text-sm text-ink-dim">Schematic, not a screenshot.</figcaption>
      </figure>
    </li>
  );
}

import type { Metadata } from "next";
import { Container } from "@/components/site/Container";
import { PageTop } from "@/components/site/PageTop";
import { PrintButton } from "@/components/site/PrintButton";
import { siteButton } from "@/components/site/button";
import { ConnectPanelSample } from "@/components/site/samples/ConnectPanelSample";
import { brandConfig } from "@/lib/brand-config";
import { CONNECT_SHEET_PDF, connectSheet } from "@/lib/site/connect-sheet";

export function generateMetadata(): Metadata {
  const { name } = brandConfig();
  return {
    title: `How to connect your WhatsApp number | ${name}`,
    description: `A two-page help sheet for linking a WhatsApp number to ${name}: what you need, the steps, and what to do if something goes wrong. Print it or download the PDF.`,
  };
}

const H2 = "h-section font-display";

export default function ConnectSheetPage() {
  const brand = brandConfig();
  const s = connectSheet(brand);
  return (
    <div className="connect-sheet">
      <PageTop title={<>How to connect your WhatsApp number</>}>
        <p>Two minutes and one phone. Keep this open on a computer while you do it, or print it.</p>
        <div className="no-print mt-6 flex flex-wrap items-center gap-3">
          <PrintButton />
          <a href={CONNECT_SHEET_PDF} download className={siteButton("line")}>
            Download the PDF
          </a>
        </div>
      </PageTop>
      <section className="band">
        <Container>
          <div className="sheet-top grid items-start gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,26rem)] lg:gap-16">
            <div className="grid gap-10">
              <div className="sheet-block">
                <h2 className={H2}>What you need</h2>
                <ul className="mt-3 grid list-disc gap-2 pl-5 marker:text-ink">
                  {s.need.map((n) => (
                    <li key={n}>{n}</li>
                  ))}
                </ul>
              </div>

              <div className="sheet-block">
                <h2 className={H2}>Connect, step by step</h2>
                <ol role="list" className="mt-4 grid list-none gap-4 p-0">
                  {s.steps.map((st, i) => (
                    <li key={st.title} className="sheet-step grid grid-cols-[2.5rem_1fr] gap-3">
                      <span
                        aria-hidden="true"
                        className="grid size-10 place-items-center rounded-full border-2 border-outline font-display text-lg font-extrabold"
                      >
                        {i + 1}
                      </span>
                      <div>
                        <h3 className="h-item font-display">{st.title}</h3>
                        <p className="mt-1 max-w-[56ch] text-ink-dim">{st.body}</p>
                      </div>
                    </li>
                  ))}
                </ol>
              </div>
            </div>

            <figure className="sheet-block sheet-figure">
              <ConnectPanelSample connectedStrip />
              <figcaption className="mt-3 small text-ink-dim">
                Sample screen: what you see at steps 2 to 5, before and after the scan.
              </figcaption>
            </figure>
          </div>

          <div className="mt-12 grid items-start gap-10 md:grid-cols-2">
            <div className="sheet-block">
              <h2 className={H2}>After you connect</h2>
              <ul className="mt-3 grid list-disc gap-2 pl-5 marker:text-ink">
                {s.after.map((a) => (
                  <li key={a}>{a}</li>
                ))}
              </ul>
            </div>
            <div className="sheet-block">
              <h2 className={H2}>Stay safe</h2>
              <div className="mt-3 grid gap-2">
                {s.safety.map((a) => (
                  <p key={a}>{a}</p>
                ))}
              </div>
            </div>
          </div>

          <div className="sheet-block mt-12">
            <h2 className={H2}>If something goes wrong</h2>
            <dl className="mt-4 grid gap-x-10 gap-y-5 md:grid-cols-2">
              {s.problems.map((p) => (
                <div key={p.title} className="sheet-step border-t-2 border-rule pt-3">
                  <dt className="h-item font-display">{p.title}</dt>
                  <dd className="mt-1 text-ink-dim">{p.body}</dd>
                </div>
              ))}
            </dl>
          </div>

          <div className="sheet-block mt-12 max-w-[62ch] small text-ink-dim">
            <p>{s.disclosure}</p>
            <p className="mt-2">{s.notAffiliated}</p>
          </div>
        </Container>
      </section>
    </div>
  );
}

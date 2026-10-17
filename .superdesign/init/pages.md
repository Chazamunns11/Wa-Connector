# Pages: dependency trees
Candidate context sets (local files only; node_modules skipped). All pages are wrapped by `src/app/layout.tsx` > `src/app/(site)/layout.tsx`, which pull in the shared shell below; every tree also depends on `src/app/globals.css`.

Shared shell (every page):
- `src/app/layout.tsx`
- `src/app/(site)/layout.tsx`
  - `src/components/site/SiteHeader.tsx` -> `ui/Button.tsx`, `site/BrandMark.tsx`, `site/Container.tsx`, `lib/brand-config.ts` (-> `lib/brand.ts`), `lib/site/routes.ts`
  - `src/components/site/SiteFooter.tsx` -> `site/BrandMark.tsx`, `site/Container.tsx`, `lib/brand-config.ts`, `lib/site/routes.ts`

## / (Home)
Entry: `src/app/(site)/page.tsx`
- `src/components/site/Container.tsx`
- `src/components/site/CustomerResults.tsx`
  - `src/components/site/Container.tsx`
  - `src/lib/site/proof.ts`
- `src/components/site/Cta.tsx`
  - `src/components/ui/Button.tsx`
  - `src/lib/site/routes.ts`
- `src/components/site/FaqList.tsx`
  - `src/lib/site/faq.ts` (-> `lib/brand-config.ts`, `lib/pricing.ts`)
- `src/components/site/HowItWorks.tsx`
- `src/components/site/PricingSummary.tsx`
  - `src/components/site/Cta.tsx`
  - `src/lib/pricing.ts`
  - `src/lib/site/routes.ts`
- `src/components/site/ReminderResearch.tsx`
  - `src/lib/site/proof.ts`
  - `src/lib/brand-config.ts`
- `src/components/site/SafetyThread.tsx`
- `src/components/site/samples/ConnectPanelSample.tsx`
  - `src/components/ui/Button.tsx`
  - `src/components/ui/Chip.tsx`
  - `src/lib/brand-config.ts`
  - `src/lib/site/setup-steps.ts`
- `src/components/site/samples/DashboardSample.tsx`
  - `src/components/ui/Chip.tsx`
  - `src/components/ui/Button.tsx`
  - `src/lib/brand-config.ts`
- `src/components/site/samples/SameReminderTwice.tsx`
  - `src/components/site/samples/PhoneFrame.tsx`
- `src/lib/brand-config.ts`, `src/lib/site/faq.ts`, `src/lib/site/proof.ts`, `src/lib/site/routes.ts`, `src/lib/site/sales-copy.ts` (-> `lib/brand-config.ts`)

## /pricing
Entry: `src/app/(site)/pricing/page.tsx`
- `src/components/site/Container.tsx`
- `src/components/site/Cta.tsx`
  - `src/components/ui/Button.tsx`
  - `src/lib/site/routes.ts`
- `src/components/site/FaqList.tsx`
  - `src/lib/site/faq.ts`
- `src/components/site/PricingCalculator.tsx`
  - `src/lib/pricing.ts`
  - `src/lib/site/calculator.ts` (-> `lib/pricing.ts`)
- `src/components/site/PricingTable.tsx`
  - `src/lib/pricing.ts`
- `src/lib/brand-config.ts`, `src/lib/pricing.ts`, `src/lib/site/comparison.ts`, `src/lib/site/faq.ts`, `src/lib/site/pricing-copy.ts` (-> `lib/pricing.ts`)

## /docs/setup
Entry: `src/app/(site)/docs/setup/page.tsx` (also wrapped by `src/app/(site)/docs/layout.tsx`)
- `src/components/site/AudienceTabs.tsx`
  - `src/lib/site/setup-steps.ts` (-> `lib/brand-config.ts`)
- `src/components/site/Container.tsx`
- `src/components/site/samples/ConnectPanelSample.tsx`
  - `src/components/ui/Button.tsx`, `src/components/ui/Chip.tsx`, `src/lib/brand-config.ts`, `src/lib/site/setup-steps.ts`
- `src/components/site/SetupStep.tsx`
  - `src/lib/site/setup-steps.ts`
  - `src/components/site/diagrams/ConnectedDiagram.tsx` -> `site/diagram-parts.tsx`
  - `src/components/site/diagrams/GhlMenuDiagram.tsx` -> `site/diagram-parts.tsx`
  - `src/components/site/diagrams/InstallDiagram.tsx` -> `site/diagram-parts.tsx`
  - `src/components/site/diagrams/QrLinkDiagram.tsx` -> `site/diagram-parts.tsx`
  - `src/components/site/diagrams/ReplyDiagram.tsx` -> `site/diagram-parts.tsx`
  - `src/components/site/diagrams/TelephonyProviderDiagram.tsx` -> `site/diagram-parts.tsx`
  - `src/components/site/diagrams/TestSendDiagram.tsx` -> `site/diagram-parts.tsx`
- `src/lib/brand-config.ts`, `src/lib/site/routes.ts`, `src/lib/site/setup-steps.ts`

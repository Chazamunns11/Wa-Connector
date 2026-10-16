# Website visual drafts

## How these were made (and why not Superdesign)

Task 1 asked for Superdesign drafts. They could not be produced here: the CLI (`@superdesign/cli` v0.14.0) runs, but reports `auth: not authenticated`, and `superdesign login` needs an interactive browser sign-in that this headless environment cannot complete (it hung until killed). Per controller ruling W1, the drafts are hand-written static HTML, guided by `frontend-design` and `ui-ux-pro-max`. They are not on the Superdesign canvas, so there are no draft ids and no canvas PNGs. No headless browser was available either, so no screenshots were taken; open the `.html` files directly. Fonts load from Google Fonts (Chakra Petch, Barlow, as in the app).

Two variants per page. A keeps the app's dark ground; B uses the light surface (the `.surface-light` token set). Each file is standalone and copies the token values from `src/app/globals.css`; no new hex values. Illustrations are schematic only, not copies of GoHighLevel's UI. All copy is placeholder British English with `<Brand>` and `£X`.

## Files and chosen direction

| Page | Variants | Chosen | Reason |
|---|---|---|---|
| Sales `/` | `sales-a.html`, `sales-b.html` | **A** (dark) | Matches the app and checkout, so the product feels like one thing; the workflow-to-WhatsApp schematic explains the product in the hero without any invented proof. |
| Pricing `/pricing` | `pricing-a.html`, `pricing-b.html` | **A** | Calculator and terms sit side by side on desktop, so the trial terms are visible without scrolling; the fallback table is kept below the calculator. |
| Setup guide `/docs/setup` | `setup-a.html`, `setup-b.html` | **B** (light) | A long reading page: dark-on-light, one column and a diagram per step reads better; the tabs are CSS-only radios, so both audiences are in the HTML with no JavaScript. |
| Dashboard `/dashboard` | `dashboard-a.html`, `dashboard-b.html` | **A** | A table with a Needs attention filter scales to many sub-accounts, and it floats on the existing light data panel over the dark ground, as the app already does. |

## Decisions for the build tasks

- **Colour:** the dark ground from `globals.css` is the default for sales, pricing and dashboard. The setup guide (and `/docs`, legal) use the existing `.surface-light` scope on the page wrapper. No new hex values; accent teal is for the primary CTA, active states and one data series only. Status uses win/warn/loss chips with text, never colour alone.
- **Type scale:** 12 / 14 / 16 / 18 / 24 / 32 / 48 px. h1 is `clamp(32px, 6vw, 48px)`, h2 24 to 32, h3 18. Display: Chakra Petch 600/700. Body: Barlow 400/500/600 at 16px, line-height 1.6. Numbers use tabular figures. Lines stay under about 62ch.
- **Spacing rhythm:** 4/8 grid. Gutter 16px on mobile, 32px from 768px; max width 1120px. Section padding 48px mobile, 80px desktop. Card padding 24px (16px for dense cards), card radius 8px, control radius 4px, gaps 16/24/32.
- **Touch and focus:** every control is at least 44px high; focus is the global 2px teal outline; a skip link goes to `#main`; reduced motion switches animation off. There is no entrance animation.
- **Shared pieces across pages:** site header (logo, Main nav, Log in, Start free trial), footer with the "not the official Business API" line, FAQ as `<details>`, schematic figure panel with caption, preview badge on dashboard.

## Components to reuse from `src/components/ui/`

- `Button` / `buttonClasses()`: primary for the single CTA per view, secondary for the rest; use `buttonClasses` for links.
- `Card` (and `CardHeader`): all panels, pricing calculator, trial/terms rail, KPI tiles, mobile sub-account cards.
- `Chip`: WhatsApp status (win Connected, loss Disconnected, warn Waiting for scan), "Preview".
- `EmptyState`: dashboard with no sub-accounts, and the Needs attention filter with no matches.

New (site-only, not in `ui/`): header/footer, FAQ accordion, schematic figure, tab group, number calculator, status bar for sends against cap.

## Concerns

- `--color-ink-faint` on `.surface-light` (`#6E757A`) is about 4.6:1 on white but nearer 4.3:1 on `#F6F7F8`. Avoid it for small text on the raised light surface in the build, or use `ink-dim`.
- The calculator in the drafts is static; the build needs the server-rendered fallback table (kept in the drafts) plus a small island.

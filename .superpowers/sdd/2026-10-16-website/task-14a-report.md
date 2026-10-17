# Task 14A report: Direction B tokens and chrome

Status: DONE_WITH_CONCERNS (see Concerns).

## Built
- `src/app/globals.css`: Cream (#F6F1EA), sand (#EFE8DD) and Wren (#7A4E2D) removed from every declaration (earlier blocks edited in place because the pinned test forbids them anywhere; values swapped to White/Mist/Ink). Appended "Task 14: Direction B" block: third `:root`, `.surface-dark` override, new `.surface-coral` (all text tokens Ink, accent Ink, accent-ink white = Ink pill only), `html, body { overflow-x: clip }`, `.btn/.btn-ink/.btn-line/.btn-coral/.btn-sm/.btn-stack`, `.slab/.slab-2/.slab-lift`, `.rules`, `.disclosure` (CSS chevron), `.board/.board-top/.pill-sample/.dot/.dot-off/.meter/.attn`, `.path-chip`, `.step-num`, `.band`, restyled `.phone` (class names kept), `.phones` with tilt and hang.
- `src/components/site/button.ts` (`siteButton`), `SiteHeader` (coral, Ink pill, outlined menu), `SiteFooter` (Ink), `Cta` (new `onCoral` prop), `FaqList` (`.disclosure`), `AuthShell` (`.slab`), `DraftNotice` (Mist box), `(site)/not-found.tsx`, docs index tiles (`.slab .slab-2`).
- Tests: new `scripts/test/site-direction-b.test.ts` (6 tests); `site-samples.test.ts` Paper-ground test updated to read the last `:root` / last `.surface-dark` block.

## TDD
- RED: `node --import ./scripts/test/alias-hook.mjs --test scripts/test/site-direction-b.test.ts` failed with ERR_MODULE_NOT_FOUND (`button.ts` missing).
- GREEN: `npm run check`: tsc and eslint clean, 469 tests, 469 pass, 0 fail (only the pre-existing MODULE_TYPELESS warning noise).
- Build: `BRAND_PRICE_PER_NUMBER=29 NEXT_PUBLIC_APP_URL=http://localhost:3000 npm run build` passes.

## Browser check (port 3111, scratchpad/14a/check.cjs)
Routes `/ /pricing /docs /docs/faq /signup /login` at 375x812 and 1280x900: no horizontal scroll (scrollWidth == innerWidth), one h1 each, axe wcag2a/aa/21aa 0 serious/critical, coral sweep 9 text elements per page all rgb(27,31,42) (excluding `.btn-ink` and `.phone`). Screenshots in `/tmp/claude-0/-home-user/2204e08a-38df-5300-ba1d-ed7e2b3f76d0/scratchpad/14a/` (e.g. `375_.png`, `1280_docs_faq.png`). Server killed by PID (2084, 2083, 2071), confirmed gone.

## Self-review
No `text-white` or cream in touched files. Header logo is the standard artwork on coral (the "wren" half reads brown, per plan, logo untouched).

## Concerns
- Earlier CSS blocks were edited in place (not append-only) to satisfy the "no Cream/Wren anywhere" test; later blocks still override as before.
- The old SMS-crop rules (`.phone-sms` 260px, composer hidden) are overridden in the new block but not deleted; 14B should delete them with the `site-polish` test.
- Pages other than header/footer/FAQ/buttons look half-converted until 14B and 14C (home hero still on Ink).

Chanel test: left out the `.surface-light` alias cleanup and any hover colour change on the docs tiles beyond the Coral outline.

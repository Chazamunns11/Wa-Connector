# Extractable components
Source code is in components.md / layouts.md. Props listed are only per-page state; everything else is hardcoded.

## Layout
## SiteHeader
- Source: `src/components/site/SiteHeader.tsx`
- Category: layout
- Description: Dark top bar with logo, nav links (Pricing, Setup guide, Docs), login/signup buttons
- Extractable props: activeItem (string, default: none; matches a NAV_LINKS href)
- Hardcoded: nav labels/hrefs, logo, button classes, `.surface-dark`
## SiteFooter
- Source: `src/components/site/SiteFooter.tsx`
- Category: layout
- Description: Dark footer with reverse logo and link columns
- Extractable props: none
- Hardcoded: link labels, logo, all CSS
## Container
- Source: `src/components/site/Container.tsx`
- Category: layout
- Description: Max-width, padded page column
- Extractable props: none
- Hardcoded: widths and padding
## Cta
- Source: `src/components/site/Cta.tsx`
- Category: layout
- Description: Closing call-to-action band used at the end of home and pricing
- Extractable props: none
- Hardcoded: heading, button label/href, CSS

## Basic
## Button (buttonClasses)
- Source: `src/components/ui/Button.tsx`
- Category: basic
- Description: Coral/secondary button class helper + Button
- Extractable props: variant, size (as used per page)
- Hardcoded: colours, radius, focus ring
## Chip
- Source: `src/components/ui/Chip.tsx`
- Category: basic
- Description: Status tone pill
- Extractable props: tone (ChipTone)
- Hardcoded: tone colours
## Card
- Source: `src/components/ui/Card.tsx`
- Category: basic
- Description: Bordered white panel
- Extractable props: none
- Hardcoded: surface classes
## FaqList
- Source: `src/components/site/FaqList.tsx`
- Category: basic
- Description: Accordion FAQ
- Extractable props: entries (content data)
- Hardcoded: markup and CSS
## PhoneFrame
- Source: `src/components/site/samples/PhoneFrame.tsx`
- Category: basic
- Description: Phone bezel for SMS/WhatsApp mock threads
- Extractable props: variant (sms | chat)
- Hardcoded: bezel, island, status bar, composer
## PricingTable
- Source: `src/components/site/PricingTable.tsx`
- Category: basic
- Description: Tier/price table
- Extractable props: none (data from lib/pricing)
- Hardcoded: layout/CSS
## SetupStep
- Source: `src/components/site/SetupStep.tsx`
- Category: basic
- Description: Numbered docs step with coral rule and diagram
- Extractable props: audience (string), step (content)
- Hardcoded: numbering, rule, diagram mapping

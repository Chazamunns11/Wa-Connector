export const SITE_ROUTES = {
  home: "/",
  pricing: "/pricing",
  docs: "/docs",
  setup: "/docs/setup",
  connect: "/docs/connect",
  faq: "/docs/faq",
  billingHelp: "/docs/billing",
  privacySummary: "/docs/privacy-and-data",
  terms: "/legal/terms",
  privacy: "/legal/privacy",
  signup: "/signup",
  login: "/login",
  dashboard: "/dashboard",
  billing: "/dashboard/billing",
} as const;

/** The sitemap set: pages a search engine should index. */
export const PUBLIC_ROUTES: readonly string[] = [
  SITE_ROUTES.home,
  SITE_ROUTES.pricing,
  SITE_ROUTES.docs,
  SITE_ROUTES.setup,
  SITE_ROUTES.connect,
  SITE_ROUTES.faq,
  SITE_ROUTES.billingHelp,
  SITE_ROUTES.privacySummary,
  SITE_ROUTES.terms,
  SITE_ROUTES.privacy,
];

/** Account and auth screens: disallowed in robots.txt, never in the sitemap. */
export const NOINDEX_ROUTES: readonly string[] = [
  SITE_ROUTES.signup,
  SITE_ROUTES.login,
  SITE_ROUTES.dashboard,
  SITE_ROUTES.billing,
];

export const NAV_LINKS: readonly { href: string; label: string }[] = [
  { href: SITE_ROUTES.pricing, label: "Pricing" },
  { href: SITE_ROUTES.setup, label: "Setup guide" },
  { href: SITE_ROUTES.docs, label: "Docs" },
];

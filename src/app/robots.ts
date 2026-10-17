import type { MetadataRoute } from "next";
import { brandConfig } from "@/lib/brand-config";
import { NOINDEX_ROUTES } from "@/lib/site/routes";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: [...NOINDEX_ROUTES, "/admin", "/embed", "/connect", "/api"],
    },
    sitemap: `${brandConfig().appUrl}/sitemap.xml`,
  };
}

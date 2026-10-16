import type { MetadataRoute } from "next";
import { brandConfig } from "@/lib/brand-config";
import { PUBLIC_ROUTES } from "@/lib/site/routes";

export default function sitemap(): MetadataRoute.Sitemap {
  const { appUrl } = brandConfig();
  return PUBLIC_ROUTES.map((path) => ({ url: path === "/" ? appUrl : `${appUrl}${path}` }));
}

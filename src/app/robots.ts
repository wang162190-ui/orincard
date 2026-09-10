import type { MetadataRoute } from "next";
import { PRIVATE_ROUTE_PREFIXES, siteOrigin } from "@/server/metadata";

export default function robots(): MetadataRoute.Robots {
  if (process.env.VERCEL_ENV === "preview") return { rules: { userAgent: "*", disallow: "/" } };
  return {
    rules: { userAgent: "*", allow: "/", disallow: PRIVATE_ROUTE_PREFIXES.map((path) => `${path}/`) },
    sitemap: `${siteOrigin()}/sitemap.xml`,
  };
}

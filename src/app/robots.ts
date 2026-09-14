import type { MetadataRoute } from "next";
import { privateRouteDisallowList, siteOrigin } from "@/server/metadata";

export default function robots(): MetadataRoute.Robots {
  if (process.env.VERCEL_ENV === "preview") return { rules: { userAgent: "*", disallow: "/" } };
  return {
    rules: { userAgent: "*", allow: "/", disallow: privateRouteDisallowList() },
    sitemap: `${siteOrigin()}/sitemap.xml`,
  };
}

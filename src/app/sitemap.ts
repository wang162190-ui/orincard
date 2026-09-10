import type { MetadataRoute } from "next";
import templates from "../../content/templates.json";
import { listContent } from "@/server/content";
import { siteOrigin } from "@/server/metadata";

export default function sitemap(): MetadataRoute.Sitemap {
  const origin = siteOrigin();
  const paths = [
    "/", "/pricing", "/templates",
    ...templates.map((template) => `/templates/${template.slug}`),
    ...listContent("help").map((slug) => `/help/${slug}`),
    ...listContent("guide").map((slug) => `/guides/${slug}`),
  ];
  return paths.map((path) => ({ url: new URL(path, origin).toString(), changeFrequency: path === "/" ? "weekly" : "monthly" }));
}

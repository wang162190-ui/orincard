import type { MetadataRoute } from "next";
import templates from "../../content/templates.json";
import { listContent } from "@/server/content";
import { localizedPath, routing } from "@/i18n/routing";
import { localeAlternates, siteOrigin } from "@/server/metadata";

export default function sitemap(): MetadataRoute.Sitemap {
  const origin = siteOrigin();
  const paths = [
    "/", "/pricing", "/templates",
    ...templates.map((template) => `/templates/${template.slug}`),
    ...listContent("help").map((slug) => `/help/${slug}`),
    ...listContent("guide").map((slug) => `/guides/${slug}`),
    "/blog",
    ...listContent("blog").map((slug) => `/blog/${slug}`),
  ];
  // 每条路径按语言各出一行，并互相声明 hreflang。只列英文版会让中文页永远进不了索引。
  return routing.locales.flatMap((locale) =>
    paths.map((path) => ({
      url: new URL(localizedPath(path, locale), origin).toString(),
      changeFrequency: path === "/" ? ("weekly" as const) : ("monthly" as const),
      alternates: { languages: localeAlternates(path) },
    })),
  );
}

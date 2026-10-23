import type { MetadataRoute } from "next";
import { DEMO_NOTES } from "@/lib/demo-vault";
import { SITE_URL } from "@/lib/site-url";

/** /sitemap.xml: the public pages, including every note in the demo vault. */
export default function sitemap(): MetadataRoute.Sitemap {
  const pages: MetadataRoute.Sitemap = [
    { url: `${SITE_URL}/`, changeFrequency: "weekly", priority: 1 },
    { url: `${SITE_URL}/docs`, changeFrequency: "weekly", priority: 0.8 },
    { url: `${SITE_URL}/signup`, changeFrequency: "monthly", priority: 0.6 },
    { url: `${SITE_URL}/login`, changeFrequency: "monthly", priority: 0.3 },
  ];
  const demo: MetadataRoute.Sitemap = DEMO_NOTES.map((note) => ({
    url: `${SITE_URL}/demo/${note.id}`,
    changeFrequency: "monthly",
    priority: 0.5,
  }));
  return [...pages, ...demo];
}

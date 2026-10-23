import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/site-url";

/** /robots.txt: crawl the public pages, keep out of the signed-in app and the API. */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: ["/", "/docs", "/demo", "/d/"],
      disallow: ["/vault", "/admin", "/api/", "/auth/", "/r/", "/reset-password"],
    },
    sitemap: `${SITE_URL}/sitemap.xml`,
  };
}

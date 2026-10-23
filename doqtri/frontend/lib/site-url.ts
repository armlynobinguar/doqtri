/**
 * The site's public origin, for absolute URLs in robots.txt and the sitemap.
 * Vercel sets VERCEL_PROJECT_PRODUCTION_URL (e.g. www.doqtri.xyz) on every
 * deployment; NEXT_PUBLIC_SITE_URL overrides it.
 */
export const SITE_URL = (
  process.env.NEXT_PUBLIC_SITE_URL ??
  (process.env.VERCEL_PROJECT_PRODUCTION_URL
    ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
    : "https://www.doqtri.xyz")
).replace(/\/$/, "");

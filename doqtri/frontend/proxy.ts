import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { safeNextPath } from "@/lib/email-auth";
import { MINDMAP_PROMO, PROMO_PATH } from "@/lib/promo";

/**
 * Next 16 renamed `middleware` to `proxy`; the behavior is unchanged.
 *
 * Two jobs: refresh the Supabase auth cookies on every request so server
 * components see a live session, and do a coarse signed-in/signed-out
 * redirect. This is an optimistic check only — the real authorization is RLS
 * plus the per-route session lookups.
 */
/** Signed-out pages; signed-in users are sent on to the vault instead. */
const PUBLIC_ROUTES = new Set(["/", "/login", "/signup", "/forgot-password"]);

/**
 * Where an ended promo's portal is rewritten to. No route can match it (an
 * underscore folder is private in the app router), so Next answers its 404
 * with a real 404 status, before the root loading.tsx can stream a 200.
 */
export const ENDED_PROMO_REWRITE = "/_promo-ended";

export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          for (const { name, value } of cookiesToSet) {
            request.cookies.set(name, value);
          }
          response = NextResponse.next({ request });
          for (const { name, value, options } of cookiesToSet) {
            response.cookies.set(name, value, options);
          }
        },
      },
    },
  );

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { pathname } = request.nextUrl;
  const isPublicRoute = PUBLIC_ROUTES.has(pathname);
  // Public audit pages and the docs must open for anyone, signed in or not.
  const isAuditRoute = pathname.startsWith("/d/");
  const isDocsRoute = pathname === "/docs" || pathname.startsWith("/docs/");
  // So must the legal pages, which sign-up links to. Each is a 404 until the
  // gate in lib/legal.ts is on.
  const isLegalRoute = pathname === "/privacy" || pathname === "/terms";
  // So must the promo portal, which the landing links to while the promo runs;
  // it shows sign-in when needed. Once it ends it is a 404 for everyone,
  // signed in or not (the page's notFound() is the second guard).
  const isPromoRoute = pathname === PROMO_PATH;
  if (isPromoRoute && !MINDMAP_PROMO.active) {
    const url = request.nextUrl.clone();
    url.pathname = ENDED_PROMO_REWRITE;
    const rewrite = NextResponse.rewrite(url, { request });
    // Keep any refreshed auth cookies.
    for (const cookie of response.cookies.getAll()) rewrite.cookies.set(cookie);
    return rewrite;
  }
  // The read-only demo vault is for visitors, and signed-in users may open it too.
  const isDemoRoute = pathname === "/demo" || pathname.startsWith("/demo/");
  // Emailed links land on /auth/confirm signed out and leave signed in.
  const isAuthCallback = pathname.startsWith("/auth/");
  // Shared referral links remember the code, then send the visitor to sign up.
  const isReferralLink = pathname.startsWith("/r/");
  if (isAuditRoute || isDocsRoute || isLegalRoute || isPromoRoute || isDemoRoute || isAuthCallback || isReferralLink) {
    return response;
  }

  // Unauthenticated users may view the landing and the sign-in screens.
  // Everything else (including /reset-password, which the emailed link reaches
  // already signed in) goes to the landing.
  if (!user && !isPublicRoute) {
    const url = request.nextUrl.clone();
    url.pathname = "/";
    return NextResponse.redirect(url);
  }

  // Signed-in users skip marketing and sign-in screens and land in the vault,
  // or on the page that sent them to sign in (`?next=`, e.g. /vault/mindmap).
  if (user && isPublicRoute) {
    const next = safeNextPath(request.nextUrl.searchParams.get("next"));
    const target = PUBLIC_ROUTES.has(new URL(next, request.url).pathname) ? "/vault" : next;
    return NextResponse.redirect(new URL(target, request.url));
  }

  return response;
}

export const config = {
  // Everything except static assets, the generated link-preview image and
  // robots.txt / sitemap.xml (crawlers fetch them signed out), and the API
  // routes, which verify the session themselves and must be able to return 401
  // rather than a redirect.
  matcher: [
    "/((?!_next/static|_next/image|api/|favicon.ico|opengraph-image|robots.txt|sitemap.xml|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};

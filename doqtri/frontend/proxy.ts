import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";

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
  // Emailed links land on /auth/confirm signed out and leave signed in.
  const isAuthCallback = pathname.startsWith("/auth/");
  if (isAuditRoute || isDocsRoute || isAuthCallback) return response;

  // Unauthenticated users may view the landing and the sign-in screens.
  // Everything else (including /reset-password, which the emailed link reaches
  // already signed in) goes to the landing.
  if (!user && !isPublicRoute) {
    const url = request.nextUrl.clone();
    url.pathname = "/";
    return NextResponse.redirect(url);
  }

  // Signed-in users skip marketing and sign-in screens and land in the vault.
  if (user && isPublicRoute) {
    const url = request.nextUrl.clone();
    url.pathname = "/vault";
    return NextResponse.redirect(url);
  }

  return response;
}

export const config = {
  // Everything except static assets, the generated link-preview image (crawlers
  // fetch it signed out), and the API routes, which verify the session
  // themselves and must be able to return 401 rather than a redirect.
  matcher: [
    "/((?!_next/static|_next/image|api/|favicon.ico|opengraph-image|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};

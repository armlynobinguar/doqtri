import { createHash } from "node:crypto";
import { expect, type APIRequestContext, type Browser, type BrowserContext } from "@playwright/test";
import { createServerClient } from "@supabase/ssr";
import { Keypair } from "@stellar/stellar-sdk";
import { E2E_DOQTRI_ORIGIN } from "./qdit-stub/config";

/**
 * A test-only wallet from a public seed. It never holds funds and exists only
 * for the e2e Supabase project. Each label gives a different account.
 */
export function e2eKeypair(label: string): Keypair {
  return Keypair.fromRawEd25519Seed(createHash("sha256").update(label).digest());
}

/**
 * Signs `keypair` in through the same challenge -> signature ->
 * /api/auth/wallet exchange the app uses, signing where a browser wallet
 * would (no Freighter in CI), and returns the session as cookies.
 *
 * The session has to be *cookies*, not localStorage: proxy.ts and every
 * server component read it through `@supabase/ssr`, which is cookie-based.
 * Rather than hand-roll that cookie format — it is base64-prefixed and
 * chunked once a session exceeds the size limit — this drives a real
 * `createServerClient` against an in-memory jar.
 *
 * The first sign-in of a wallet creates its account, its wallet_accounts row
 * and its personal workspace.
 */
export async function walletSessionCookies(
  request: APIRequestContext,
  keypair: Keypair,
): Promise<{ name: string; value: string; domain: string; path: string }[]> {
  const address = keypair.publicKey();
  const challengeRes = await request.post("/api/auth/wallet/challenge", { data: { address } });
  expect(challengeRes.ok(), await challengeRes.text()).toBeTruthy();
  const challenge = (await challengeRes.json()) as { message: string; token: string };
  const signature = Buffer.from(keypair.signMessage(challenge.message)).toString("base64");

  const res = await request.post("/api/auth/wallet", {
    data: { address, token: challenge.token, signature },
  });
  expect(res.ok(), await res.text()).toBeTruthy();
  const tokens = (await res.json()) as { access_token: string; refresh_token: string };

  const jar = new Map<string, string>();
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => [...jar].map(([name, value]) => ({ name, value })),
        setAll: (cookies) => {
          for (const { name, value } of cookies) jar.set(name, value);
        },
      },
    },
  );
  const { error } = await supabase.auth.setSession({
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
  });
  expect(error, error?.message).toBeNull();
  expect(jar.size, "setSession wrote no auth cookies").toBeGreaterThan(0);

  return [...jar].map(([name, value]) => ({ name, value, domain: "localhost", path: "/" }));
}

/**
 * A fresh browser context signed in as `keypair`: a second person at a second
 * computer. Its active workspace is its own (the doqtri_ws cookie is keyed by
 * user), so it never disturbs the default session's.
 */
export async function signedInContext(browser: Browser, keypair: Keypair): Promise<BrowserContext> {
  // A context from `browser` does not inherit the project's `use`, so the
  // base URL and viewport are set here to match the desktop project.
  const context = await browser.newContext({
    baseURL: E2E_DOQTRI_ORIGIN,
    viewport: { width: 1440, height: 900 },
  });
  const cookies = await walletSessionCookies(context.request, keypair);
  await context.addCookies(cookies);
  return context;
}

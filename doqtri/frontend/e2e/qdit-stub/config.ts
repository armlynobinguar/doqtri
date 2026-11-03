/**
 * Where the stand-in qdit listens and the test-only identity doqtri has there
 * (DOQ-16). playwright.config.ts hands these to both servers, and the specs
 * read them, so the three never disagree.
 *
 * None of these is a secret. They exist only for the e2e run and they only
 * open the stub, which keeps its state in memory.
 */

export const QDIT_STUB_PORT = Number(process.env.E2E_QDIT_STUB_PORT ?? 4010);

/** "localhost" rather than 127.0.0.1: doqtri's RPC and fetch helpers only relax http for localhost. */
export const QDIT_STUB_ORIGIN = `http://localhost:${QDIT_STUB_PORT}`;

/** The base of every /api/v1 call (CONTRACT.md section 1: QDIT_API_BASE_URL includes /api/v1). */
export const QDIT_STUB_API_BASE = `${QDIT_STUB_ORIGIN}/api/v1`;

/** Supabase Auth's URL on a real qdit; authorize and token hang off it (section 5). */
export const QDIT_STUB_ISSUER = `${QDIT_STUB_ORIGIN}/auth/v1`;

/** A UUID, because qdit refuses a token whose client_id is not one (D-77). */
export const QDIT_STUB_CLIENT_ID = "0d0c7e16-2e2e-4c5e-9d16-000000000e2e";
export const QDIT_STUB_CLIENT_SECRET = "e2e-only-client-secret";

/** The webhook HMAC key both sides share (section 9). */
export const QDIT_STUB_WEBHOOK_SECRET = "whsec_e2e_only_do_not_use";

/**
 * The key doqtri seals OAuth tokens with (INTEGRATION_TOKEN_KEY, 64 hex). It
 * replaces any real key for the e2e dev server, so the suite never reads or
 * writes a connection sealed with a deployment's key.
 */
export const E2E_INTEGRATION_TOKEN_KEY = "e2e0".repeat(16);

/** The doqtri origin the stub accepts in doc_url (qdit's DOQTRI_ORIGIN, section 8). */
export const E2E_DOQTRI_ORIGIN = "http://localhost:3000";

/** The environment the e2e dev server needs to talk to the stub. */
export function qditStubEnv(): Record<string, string> {
  return {
    NEXT_PUBLIC_QDIT_INTEGRATION: "1",
    QDIT_API_BASE_URL: QDIT_STUB_API_BASE,
    QDIT_OAUTH_ISSUER: QDIT_STUB_ISSUER,
    QDIT_OAUTH_CLIENT_ID: QDIT_STUB_CLIENT_ID,
    QDIT_CLIENT_SECRET: QDIT_STUB_CLIENT_SECRET,
    QDIT_OAUTH_REDIRECT_URI: `${E2E_DOQTRI_ORIGIN}/api/integrations/qdit/callback`,
    QDIT_WEBHOOK_SECRET: QDIT_STUB_WEBHOOK_SECRET,
    INTEGRATION_TOKEN_KEY: E2E_INTEGRATION_TOKEN_KEY,
    NEXT_PUBLIC_SITE_URL: E2E_DOQTRI_ORIGIN,
  };
}

/**
 * Where qdit lives and who doqtri is to it (WP-2.3, D-02). Server-only, except
 * qditIntegrationEnabled(), which the profile also reads to decide whether to
 * show Connected apps.
 *
 * Names follow docs/integration/CONTRACT.md section 1: QDIT_API_BASE_URL is
 * qdit's `/api/v1` base, QDIT_OAUTH_ISSUER its Supabase Auth URL (authorize
 * and token endpoints hang off it), and doqtri is registered there as a
 * confidential client with QDIT_OAUTH_CLIENT_ID and QDIT_CLIENT_SECRET.
 * There are no defaults: a deployment that has not set them is simply not
 * connected to any qdit, rather than to production by accident.
 */

/** The integration's UI and routes are off unless NEXT_PUBLIC_QDIT_INTEGRATION is "1" (live app unchanged). */
export function qditIntegrationEnabled(): boolean {
  return process.env.NEXT_PUBLIC_QDIT_INTEGRATION === "1";
}

/**
 * What doqtri asks qdit for. Supabase Auth's scopes are identity claims, not
 * data access: what a token may read and write in qdit is decided by qdit's
 * client_id guards (D-03), whatever the scope. doqtri needs no identity claim
 * beyond `sub` (it reads the account through GET /api/v1/me), so it asks for
 * the least there is.
 */
export const QDIT_SCOPES = "openid";

/** The path qdit sends the browser back to, relative to doqtri's origin. */
export const QDIT_CALLBACK_PATH = "/api/integrations/qdit/callback";

export type QditConfig = {
  apiBaseUrl: string;
  issuer: string;
  clientId: string;
  clientSecret: string;
  /** Fixed by QDIT_OAUTH_REDIRECT_URI, or null to derive it from the request's origin. */
  redirectUri: string | null;
  /** INTEGRATION_TOKEN_KEY, still encoded; token-crypto.ts parses it. */
  tokenKey: string;
  /**
   * INTEGRATION_TOKEN_KEY_PREVIOUS, still encoded, or null: the key the
   * current one replaced, kept only to read what it sealed (D-67).
   */
  tokenKeyPrevious: string | null;
};

function trimSlash(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

/**
 * The configuration, or null when the integration is off or any required
 * value is missing. Read per call so tests can stub the environment.
 */
export function qditConfig(env: NodeJS.ProcessEnv = process.env): QditConfig | null {
  if (env.NEXT_PUBLIC_QDIT_INTEGRATION !== "1") return null;
  const apiBaseUrl = env.QDIT_API_BASE_URL?.trim();
  const issuer = env.QDIT_OAUTH_ISSUER?.trim();
  const clientId = env.QDIT_OAUTH_CLIENT_ID?.trim();
  const clientSecret = env.QDIT_CLIENT_SECRET;
  const tokenKey = env.INTEGRATION_TOKEN_KEY?.trim();
  if (!apiBaseUrl || !issuer || !clientId || !clientSecret || !tokenKey) return null;
  return {
    apiBaseUrl: trimSlash(apiBaseUrl),
    issuer: trimSlash(issuer),
    clientId,
    clientSecret,
    redirectUri: env.QDIT_OAUTH_REDIRECT_URI?.trim() || null,
    tokenKey,
    tokenKeyPrevious: env.INTEGRATION_TOKEN_KEY_PREVIOUS?.trim() || null,
  };
}

/** The redirect URI for a request arriving at `origin` (e.g. https://www.doqtri.xyz). */
export function redirectUriFor(config: QditConfig, origin: string): string {
  return config.redirectUri ?? `${trimSlash(origin)}${QDIT_CALLBACK_PATH}`;
}

/**
 * The secret qdit signs its status webhook with (section 9; WP-2.8), the same
 * value qdit keeps encrypted in its integration_webhooks row. Null when the
 * integration is off or it is not set. Read per call, untrimmed apart from a
 * trailing newline a dashboard may add: every other byte is part of the key.
 */
export function qditWebhookSecret(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.NEXT_PUBLIC_QDIT_INTEGRATION !== "1") return null;
  const secret = env.QDIT_WEBHOOK_SECRET?.replace(/\r?\n$/, "");
  return secret ? secret : null;
}

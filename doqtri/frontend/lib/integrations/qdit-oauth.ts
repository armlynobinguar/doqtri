import { createHash, randomBytes, timingSafeEqual } from "crypto";
import { QDIT_SCOPES, type QditConfig } from "@/lib/integrations/qdit-config";
import { asKeyRing, decryptSecret, deriveKey, encryptSecret, type TokenKeyRing } from "@/lib/integrations/token-crypto";

/**
 * The OAuth 2.1 side of connecting qdit (WP-2.3, D-02; server-only).
 *
 * doqtri is a confidential client of qdit's Supabase OAuth 2.1 server, which
 * offers the authorization code grant with PKCE (S256) and refresh, nothing
 * else (CONTRACT.md section 5):
 *
 *   1. /api/integrations/qdit/connect makes a state and a PKCE verifier,
 *      seals both in a short-lived httpOnly cookie bound to the signed-in
 *      user, and sends the browser to `<issuer>/oauth/authorize`.
 *   2. qdit asks the user for consent and sends the browser back to
 *      /api/integrations/qdit/callback with a code and the state.
 *   3. The callback opens the cookie, checks the state and that the same
 *      doqtri user is still signed in, and exchanges the code at
 *      `<issuer>/oauth/token` with the verifier and the client secret.
 *
 * The cookie is sealed with AES-256-GCM (token-crypto.ts), not just signed:
 * the verifier is a secret until the exchange, and sealing keeps it out of
 * anything that logs cookies.
 *
 * Nothing here logs or returns a token or the provider's error text: errors
 * carry only the OAuth `error` code.
 */

export const OAUTH_STATE_COOKIE = "doqtri_qdit_oauth";
/** Long enough to read a consent screen and sign in to qdit first. */
export const OAUTH_STATE_TTL_MS = 10 * 60_000;
/** The cookie is only sent to the integration's own routes. */
export const OAUTH_STATE_COOKIE_PATH = "/api/integrations/qdit";

const OAUTH_TIMEOUT_MS = 10_000;
const STATE_CONTEXT = "qdit-oauth-state";

export type OAuthDeps = { fetch?: typeof fetch; timeoutMs?: number };

// ---------------------------------------------------------------------------
// PKCE and state
// ---------------------------------------------------------------------------

/** A PKCE code verifier: 32 random bytes, 43 base64url characters (RFC 7636). */
export function createCodeVerifier(): string {
  return randomBytes(32).toString("base64url");
}

/** The S256 challenge for `verifier`. */
export function codeChallengeS256(verifier: string): string {
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

export type OAuthState = {
  /** The doqtri user who started the flow. */
  userId: string;
  /** The `state` sent to qdit, compared on the way back. */
  state: string;
  verifier: string;
  /** Exactly the redirect_uri sent to authorize; the exchange must repeat it. */
  redirectUri: string;
  expiresAt: number;
};

type SealedState = { u: string; s: string; c: string; r: string; e: number };

function stateKey(tokenKey: Buffer): Buffer {
  return deriveKey(tokenKey, STATE_CONTEXT);
}

/** A fresh flow for `userId`: the state to send and the cookie value to set. */
export function startOAuthState(
  userId: string,
  redirectUri: string,
  tokenKey: Buffer,
  now = Date.now(),
): { state: OAuthState; cookie: string } {
  const state: OAuthState = {
    userId,
    state: randomBytes(32).toString("base64url"),
    verifier: createCodeVerifier(),
    redirectUri,
    expiresAt: now + OAUTH_STATE_TTL_MS,
  };
  const sealed: SealedState = { u: userId, s: state.state, c: state.verifier, r: redirectUri, e: state.expiresAt };
  return { state, cookie: encryptSecret(JSON.stringify(sealed), stateKey(tokenKey), STATE_CONTEXT) };
}

export type StateCheck =
  | { ok: true; state: OAuthState }
  | { ok: false; reason: "missing" | "invalid" | "expired" | "state_mismatch" | "other_user" };

function sameString(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Checks a callback against the cookie the connect route set: it must open
 * with this deployment's key (or, during a key rotation, the previous one:
 * a flow started just before the switch still finishes), be unexpired, carry the `state` qdit sent back,
 * and belong to `userId`, the doqtri user signed in now. A cookie from
 * another user's flow (a shared browser, or a planted cookie) is refused, so
 * a code can never be stored against the wrong account.
 */
export function checkOAuthState(
  cookie: string | null | undefined,
  returnedState: string | null | undefined,
  userId: string,
  keys: Buffer | TokenKeyRing,
  now = Date.now(),
): StateCheck {
  if (!cookie) return { ok: false, reason: "missing" };
  const ring = asKeyRing(keys);
  const opened =
    decryptSecret(cookie, stateKey(ring.current), STATE_CONTEXT) ??
    (ring.previous ? decryptSecret(cookie, stateKey(ring.previous), STATE_CONTEXT) : null);
  if (!opened) return { ok: false, reason: "invalid" };
  let sealed: SealedState;
  try {
    sealed = JSON.parse(opened) as SealedState;
  } catch {
    return { ok: false, reason: "invalid" };
  }
  if (
    typeof sealed.u !== "string" ||
    typeof sealed.s !== "string" ||
    typeof sealed.c !== "string" ||
    typeof sealed.r !== "string" ||
    typeof sealed.e !== "number"
  ) {
    return { ok: false, reason: "invalid" };
  }
  if (now > sealed.e) return { ok: false, reason: "expired" };
  if (!returnedState || !sameString(sealed.s, returnedState)) return { ok: false, reason: "state_mismatch" };
  if (!sameString(sealed.u, userId)) return { ok: false, reason: "other_user" };
  return {
    ok: true,
    state: { userId: sealed.u, state: sealed.s, verifier: sealed.c, redirectUri: sealed.r, expiresAt: sealed.e },
  };
}

/** Where to send the browser to ask the user for consent. */
export function authorizeUrl(config: QditConfig, state: OAuthState): string {
  const url = new URL(`${config.issuer}/oauth/authorize`);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", state.redirectUri);
  url.searchParams.set("scope", QDIT_SCOPES);
  url.searchParams.set("state", state.state);
  url.searchParams.set("code_challenge", codeChallengeS256(state.verifier));
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

// ---------------------------------------------------------------------------
// Token endpoint
// ---------------------------------------------------------------------------

export type TokenSet = {
  accessToken: string;
  /** Null if qdit issued none; the connection then lasts as long as the access token. */
  refreshToken: string | null;
  /** Epoch ms, or null if qdit did not say. */
  expiresAt: number | null;
  scopes: string[];
};

/**
 * The token endpoint said no. `error` is the OAuth error code
 * (`invalid_grant` when a code or refresh token is used up, expired or
 * revoked; `invalid_client` when doqtri's own credentials are wrong).
 */
export class OAuthGrantError extends Error {
  constructor(
    readonly error: string,
    readonly status: number,
  ) {
    super(`qdit's token endpoint refused the request (${error})`);
    this.name = "OAuthGrantError";
  }
}

/** qdit's auth server could not be reached, timed out, or failed on its side. */
export class OAuthUnavailableError extends Error {
  constructor(readonly status: number | null) {
    super(status ? `qdit's auth server answered ${status}` : "qdit's auth server could not be reached");
    this.name = "OAuthUnavailableError";
  }
}

/**
 * HTTP Basic client authentication (RFC 6749 section 2.3.1): the id and
 * secret are form-encoded before they are joined and base64'd.
 */
function basicAuth(config: QditConfig): string {
  const encode = (value: string) => encodeURIComponent(value).replace(/%20/g, "+");
  return `Basic ${Buffer.from(`${encode(config.clientId)}:${encode(config.clientSecret)}`).toString("base64")}`;
}

async function postForm(
  config: QditConfig,
  url: string,
  form: Record<string, string>,
  deps: OAuthDeps,
): Promise<Response> {
  const doFetch = deps.fetch ?? fetch;
  try {
    return await doFetch(url, {
      method: "POST",
      headers: {
        Authorization: basicAuth(config),
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams(form).toString(),
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(deps.timeoutMs ?? OAUTH_TIMEOUT_MS),
    });
  } catch {
    throw new OAuthUnavailableError(null);
  }
}

function parseTokenSet(body: unknown, now: number): TokenSet | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  if (typeof b.access_token !== "string" || !b.access_token) return null;
  if (typeof b.token_type !== "string" || b.token_type.toLowerCase() !== "bearer") return null;
  const expiresIn = typeof b.expires_in === "number" && b.expires_in > 0 ? b.expires_in : null;
  return {
    accessToken: b.access_token,
    refreshToken: typeof b.refresh_token === "string" && b.refresh_token ? b.refresh_token : null,
    expiresAt: expiresIn === null ? null : now + expiresIn * 1000,
    scopes: typeof b.scope === "string" ? b.scope.split(" ").filter(Boolean) : [],
  };
}

async function tokenRequest(
  config: QditConfig,
  form: Record<string, string>,
  deps: OAuthDeps,
  now: number,
): Promise<TokenSet> {
  const res = await postForm(config, `${config.issuer}/oauth/token`, form, deps);
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (res.ok) {
    const tokens = parseTokenSet(body, now);
    if (!tokens) throw new OAuthUnavailableError(res.status);
    return tokens;
  }
  const code = body && typeof (body as { error?: unknown }).error === "string" ? (body as { error: string }).error : null;
  // 4xx with an OAuth error is a definite answer; anything else is qdit's trouble.
  if (res.status >= 400 && res.status < 500 && code) throw new OAuthGrantError(code, res.status);
  throw new OAuthUnavailableError(res.status);
}

/** Exchanges the code from the callback for tokens. */
export function exchangeCode(
  config: QditConfig,
  code: string,
  state: OAuthState,
  deps: OAuthDeps = {},
  now = Date.now(),
): Promise<TokenSet> {
  return tokenRequest(
    config,
    { grant_type: "authorization_code", code, redirect_uri: state.redirectUri, code_verifier: state.verifier },
    deps,
    now,
  );
}

/** Trades a refresh token for a new token set; qdit rotates the refresh token. */
export function refreshTokens(
  config: QditConfig,
  refreshToken: string,
  deps: OAuthDeps = {},
  now = Date.now(),
): Promise<TokenSet> {
  return tokenRequest(config, { grant_type: "refresh_token", refresh_token: refreshToken }, deps, now);
}

// ---------------------------------------------------------------------------
// Revocation (best effort)
// ---------------------------------------------------------------------------

const METADATA_TTL_MS = 60 * 60_000;
let metadataCache: { issuer: string; at: number; revocationEndpoint: string | null } | null = null;

/** For tests: forget the cached server metadata. */
export function resetOAuthMetadataCache() {
  metadataCache = null;
}

/**
 * The server's RFC 7009 revocation endpoint from its RFC 8414 metadata, or
 * null if it advertises none. Only an endpoint on the issuer's own origin is
 * used, since doqtri's client secret goes with the request.
 */
async function revocationEndpoint(config: QditConfig, deps: OAuthDeps, now: number): Promise<string | null> {
  if (metadataCache && metadataCache.issuer === config.issuer && now - metadataCache.at < METADATA_TTL_MS) {
    return metadataCache.revocationEndpoint;
  }
  const doFetch = deps.fetch ?? fetch;
  const res = await doFetch(`${config.issuer}/.well-known/oauth-authorization-server`, {
    headers: { Accept: "application/json" },
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(deps.timeoutMs ?? OAUTH_TIMEOUT_MS),
  });
  if (!res.ok) throw new OAuthUnavailableError(res.status);
  const meta = (await res.json()) as { revocation_endpoint?: unknown };
  let endpoint: string | null = null;
  if (typeof meta.revocation_endpoint === "string") {
    try {
      const url = new URL(meta.revocation_endpoint);
      if (url.origin === new URL(config.issuer).origin && url.protocol === "https:") endpoint = url.toString();
    } catch {
      endpoint = null;
    }
  }
  metadataCache = { issuer: config.issuer, at: now, revocationEndpoint: endpoint };
  return endpoint;
}

/**
 * Asks qdit to revoke a token, best effort. The contract defines no
 * revocation call (the grant is the user's to revoke in qdit, section 2), and
 * Supabase's OAuth server may not offer one, so this uses the endpoint the
 * server advertises if there is one and otherwise reports "unsupported".
 * Never throws: disconnecting in doqtri does not depend on it.
 */
export async function revokeToken(
  config: QditConfig,
  token: string,
  hint: "refresh_token" | "access_token",
  deps: OAuthDeps = {},
  now = Date.now(),
): Promise<"revoked" | "unsupported" | "failed"> {
  try {
    const endpoint = await revocationEndpoint(config, deps, now);
    if (!endpoint) return "unsupported";
    const res = await postForm(config, endpoint, { token, token_type_hint: hint }, deps);
    return res.ok ? "revoked" : "failed";
  } catch {
    return "failed";
  }
}

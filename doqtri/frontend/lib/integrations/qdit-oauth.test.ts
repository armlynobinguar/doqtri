import { createHash, randomBytes } from "crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { QditConfig } from "./qdit-config";
import {
  authorizeUrl,
  checkOAuthState,
  codeChallengeS256,
  createCodeVerifier,
  exchangeCode,
  OAUTH_STATE_TTL_MS,
  OAuthGrantError,
  OAuthUnavailableError,
  refreshTokens,
  resetOAuthMetadataCache,
  revokeToken,
  startOAuthState,
} from "./qdit-oauth";

const ANA = "11111111-1111-4111-8111-111111111111";
const BEN = "22222222-2222-4222-8222-222222222222";
const key = randomBytes(32);
const config: QditConfig = {
  apiBaseUrl: "https://qdit.test/api/v1",
  issuer: "https://auth.qdit.test/auth/v1",
  clientId: "9b8a7c6d-5e4f-4a3b-2c1d-0e9f8a7b6c5d",
  clientSecret: "s3cret:with&odd chars",
  redirectUri: null,
  tokenKey: key.toString("base64"),
  tokenKeyPrevious: null,
};
const REDIRECT = "https://doqtri.test/api/integrations/qdit/callback";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("PKCE", () => {
  it("makes a 43-character base64url verifier", () => {
    const v = createCodeVerifier();
    expect(v).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(createCodeVerifier()).not.toBe(v);
  });

  it("derives the S256 challenge (RFC 7636 appendix B)", () => {
    expect(codeChallengeS256("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });
});

describe("OAuth state round trip", () => {
  it("authorizes with S256, the state and the redirect, and the callback opens the cookie", () => {
    const now = 1_800_000_000_000;
    const { state, cookie } = startOAuthState(ANA, REDIRECT, key, now);
    expect(cookie).not.toContain(state.verifier);
    expect(cookie).not.toContain(ANA);

    const url = new URL(authorizeUrl(config, state));
    expect(url.origin + url.pathname).toBe("https://auth.qdit.test/auth/v1/oauth/authorize");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe(config.clientId);
    expect(url.searchParams.get("redirect_uri")).toBe(REDIRECT);
    expect(url.searchParams.get("state")).toBe(state.state);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBe(
      createHash("sha256").update(state.verifier).digest("base64url"),
    );
    expect(url.searchParams.get("scope")).toBe("openid");

    const checked = checkOAuthState(cookie, url.searchParams.get("state"), ANA, key, now + 1000);
    expect(checked).toEqual({ ok: true, state });
  });

  it("refuses a state that does not match", () => {
    const { cookie } = startOAuthState(ANA, REDIRECT, key);
    expect(checkOAuthState(cookie, "forged", ANA, key)).toEqual({ ok: false, reason: "state_mismatch" });
    expect(checkOAuthState(cookie, null, ANA, key)).toEqual({ ok: false, reason: "state_mismatch" });
  });

  it("refuses another user's cookie, even with its own state", () => {
    const { state, cookie } = startOAuthState(BEN, REDIRECT, key);
    expect(checkOAuthState(cookie, state.state, ANA, key)).toEqual({ ok: false, reason: "other_user" });
  });

  it("refuses an expired, missing, foreign-key or tampered cookie", () => {
    const now = 1_800_000_000_000;
    const { state, cookie } = startOAuthState(ANA, REDIRECT, key, now);
    expect(checkOAuthState(cookie, state.state, ANA, key, now + OAUTH_STATE_TTL_MS + 1)).toEqual({
      ok: false,
      reason: "expired",
    });
    expect(checkOAuthState(undefined, state.state, ANA, key)).toEqual({ ok: false, reason: "missing" });
    expect(checkOAuthState(cookie, state.state, ANA, randomBytes(32), now)).toEqual({ ok: false, reason: "invalid" });
    expect(checkOAuthState(`${cookie}x`, state.state, ANA, key, now)).toEqual({ ok: false, reason: "invalid" });
  });

  it("finishes a flow started just before a key rotation (D-67)", () => {
    const now = 1_800_000_000_000;
    const next = randomBytes(32);
    const { state, cookie } = startOAuthState(ANA, REDIRECT, key, now);
    expect(checkOAuthState(cookie, state.state, ANA, { current: next, previous: key }, now).ok).toBe(true);
    expect(checkOAuthState(cookie, state.state, ANA, { current: next, previous: null }, now)).toEqual({
      ok: false,
      reason: "invalid",
    });
  });

  it("does not open as a token sealed under the same key", async () => {
    const { encryptSecret } = await import("./token-crypto");
    const forged = encryptSecret(JSON.stringify({ u: ANA, s: "s", c: "c", r: REDIRECT, e: Date.now() + 1e6 }), key, "qdit-oauth-state");
    expect(checkOAuthState(forged, "s", ANA, key)).toEqual({ ok: false, reason: "invalid" });
  });
});

describe("token endpoint", () => {
  it("exchanges the code as a confidential client with the verifier", async () => {
    const { state } = startOAuthState(ANA, REDIRECT, key);
    const fetch = vi.fn(async () =>
      json(200, { access_token: "at", token_type: "bearer", expires_in: 3600, refresh_token: "rt", scope: "openid email" }),
    );
    const tokens = await exchangeCode(config, "the-code", state, { fetch }, 1000);
    expect(tokens).toEqual({ accessToken: "at", refreshToken: "rt", expiresAt: 1000 + 3600_000, scopes: ["openid", "email"] });

    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://auth.qdit.test/auth/v1/oauth/token");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    const basic = Buffer.from(headers.Authorization.replace(/^Basic /, ""), "base64").toString();
    expect(basic).toBe(`${config.clientId}:s3cret%3Awith%26odd+chars`);
    const form = new URLSearchParams(String(init.body));
    expect(Object.fromEntries(form)).toEqual({
      grant_type: "authorization_code",
      code: "the-code",
      redirect_uri: REDIRECT,
      code_verifier: state.verifier,
    });
  });

  it("refreshes with the refresh token grant", async () => {
    const fetch = vi.fn(async () => json(200, { access_token: "at2", token_type: "Bearer", refresh_token: "rt2" }));
    expect(await refreshTokens(config, "rt", { fetch })).toMatchObject({ accessToken: "at2", refreshToken: "rt2", expiresAt: null });
    const form = new URLSearchParams(String((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(Object.fromEntries(form)).toEqual({ grant_type: "refresh_token", refresh_token: "rt" });
  });

  it("reports invalid_grant as a grant error with the code only", async () => {
    const fetch = vi.fn(async () => json(400, { error: "invalid_grant", error_description: "Refresh token revoked: rt-secret" }));
    const error = await refreshTokens(config, "rt-secret", { fetch }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OAuthGrantError);
    expect((error as OAuthGrantError).error).toBe("invalid_grant");
    expect((error as Error).message).not.toContain("rt-secret");
  });

  it("treats a 5xx, a network failure or a malformed success as unavailable", async () => {
    await expect(refreshTokens(config, "rt", { fetch: async () => json(502, {}) })).rejects.toBeInstanceOf(OAuthUnavailableError);
    await expect(
      refreshTokens(config, "rt", {
        fetch: async () => {
          throw new TypeError("fetch failed");
        },
      }),
    ).rejects.toBeInstanceOf(OAuthUnavailableError);
    await expect(refreshTokens(config, "rt", { fetch: async () => json(200, { token_type: "bearer" }) })).rejects.toBeInstanceOf(
      OAuthUnavailableError,
    );
    await expect(
      refreshTokens(config, "rt", { fetch: async () => json(200, { access_token: "x", token_type: "mac" }) }),
    ).rejects.toBeInstanceOf(OAuthUnavailableError);
  });
});

describe("revokeToken", () => {
  beforeEach(() => resetOAuthMetadataCache());

  it("uses the advertised revocation endpoint", async () => {
    const fetch = vi.fn(async (url: RequestInfo | URL) =>
      String(url).endsWith("/.well-known/oauth-authorization-server")
        ? json(200, { revocation_endpoint: "https://auth.qdit.test/auth/v1/oauth/revoke" })
        : new Response(null, { status: 200 }),
    );
    expect(await revokeToken(config, "rt", "refresh_token", { fetch })).toBe("revoked");
    const [url, init] = fetch.mock.calls[1] as unknown as [string, RequestInit];
    expect(url).toBe("https://auth.qdit.test/auth/v1/oauth/revoke");
    expect(Object.fromEntries(new URLSearchParams(String(init.body)))).toEqual({ token: "rt", token_type_hint: "refresh_token" });
  });

  it("says unsupported when none is advertised, or one on another origin", async () => {
    expect(await revokeToken(config, "rt", "refresh_token", { fetch: async () => json(200, {}) })).toBe("unsupported");
    resetOAuthMetadataCache();
    const fetch = vi.fn(async () => json(200, { revocation_endpoint: "https://evil.test/revoke" }));
    expect(await revokeToken(config, "rt", "refresh_token", { fetch })).toBe("unsupported");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("never throws", async () => {
    const fetch = async () => {
      throw new TypeError("fetch failed");
    };
    expect(await revokeToken(config, "rt", "refresh_token", { fetch })).toBe("failed");
  });
});

import { randomBytes } from "crypto";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectedAccount, ConnectionStore, StoredConnection } from "@/lib/integrations/connection-store";
import type { TokenSet } from "@/lib/integrations/qdit-oauth";

const ANA = "11111111-1111-4111-8111-111111111111";
const BEN = "22222222-2222-4222-8222-222222222222";
const CLIENT_ID = "9b8a7c6d-5e4f-4a3b-2c1d-0e9f8a7b6c5d";
const ORIGIN = "https://doqtri.test";
const ISSUER = "https://auth.qdit.test/auth/v1";

let signedIn: string | null = ANA;
let row: StoredConnection | null = null;

const store: ConnectionStore = {
  // One row, Ana's or nobody's: another user's load finds nothing.
  load: async (userId: string) => (row && row.userId === userId ? { ...row } : null),
  saveConnected: vi.fn(async (userId: string, account: ConnectedAccount, tokens: TokenSet) => {
    row = {
      userId,
      ...account,
      scopes: tokens.scopes,
      status: "connected",
      generation: (row?.generation ?? 0) + 1,
      expiresAt: tokens.expiresAt,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
    };
  }),
  saveRefreshed: async () => true,
  markStatus: vi.fn(async (userId: string, generation: number, status: "needs_reconnect" | "revoked") => {
    if (!row || row.userId !== userId || row.generation !== generation) return false;
    row = { ...row, status, generation: generation + 1, accessToken: null, refreshToken: null, expiresAt: null };
    return true;
  }),
};

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({
    auth: { getUser: async () => ({ data: { user: signedIn ? { id: signedIn } : null } }) },
  }),
  createSupabaseAdminClient: () => ({}),
}));
vi.mock("@/lib/integrations/connection-store", () => ({ supabaseConnectionStore: () => store }));

import { GET as connect } from "./connect/route";
import { GET as callback } from "./callback/route";
import { POST as disconnect } from "./disconnect/route";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

let fetchMock: ReturnType<typeof vi.fn>;
let qdit: { token: () => Response; me: () => Response; revokeEndpoint: string | null };

function setEnv(enabled = true) {
  vi.stubEnv("NEXT_PUBLIC_QDIT_INTEGRATION", enabled ? "1" : "");
  vi.stubEnv("QDIT_API_BASE_URL", "https://qdit.test/api/v1");
  vi.stubEnv("QDIT_OAUTH_ISSUER", ISSUER);
  vi.stubEnv("QDIT_OAUTH_CLIENT_ID", CLIENT_ID);
  vi.stubEnv("QDIT_CLIENT_SECRET", "secret");
  vi.stubEnv("QDIT_OAUTH_REDIRECT_URI", "");
  vi.stubEnv("INTEGRATION_TOKEN_KEY", randomBytes(32).toString("base64"));
}

beforeEach(async () => {
  vi.clearAllMocks();
  signedIn = ANA;
  row = null;
  setEnv();
  qdit = {
    token: () => json(200, { access_token: "at1", token_type: "bearer", expires_in: 3600, refresh_token: "rt1", scope: "openid" }),
    me: () => json(200, { data: { user: { id: "qdit-ana", username: "ana", display_name: "Ana" }, client_id: CLIENT_ID } }),
    revokeEndpoint: null,
  };
  fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === `${ISSUER}/oauth/token`) return qdit.token();
    if (url === "https://qdit.test/api/v1/me") return qdit.me();
    if (url === `${ISSUER}/.well-known/oauth-authorization-server`) {
      return json(200, qdit.revokeEndpoint ? { revocation_endpoint: qdit.revokeEndpoint } : {});
    }
    if (url === qdit.revokeEndpoint) return new Response(null, { status: 200 });
    throw new Error(`unexpected fetch ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  const { resetOAuthMetadataCache } = await import("@/lib/integrations/qdit-oauth");
  resetOAuthMetadataCache();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function startConnect() {
  const res = await connect(new NextRequest(`${ORIGIN}/api/integrations/qdit/connect`));
  const location = new URL(res.headers.get("location")!);
  return { res, location, cookie: res.cookies.get("doqtri_qdit_oauth")!, state: location.searchParams.get("state")! };
}

function callbackRequest(query: string, cookie?: string) {
  return new NextRequest(`${ORIGIN}/api/integrations/qdit/callback?${query}`, {
    headers: cookie ? { cookie: `doqtri_qdit_oauth=${cookie}` } : {},
  });
}

const outcome = (res: Response) => {
  const url = new URL(res.headers.get("location")!);
  return { path: url.pathname, qdit: url.searchParams.get("qdit"), reason: url.searchParams.get("reason") };
};

describe("connect", () => {
  it("sends the user to qdit's authorize endpoint with PKCE, and sets a scoped httpOnly cookie", async () => {
    const { res, location, cookie } = await startConnect();
    expect(res.status).toBe(303);
    expect(location.origin + location.pathname).toBe(`${ISSUER}/oauth/authorize`);
    expect(location.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(location.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/api/integrations/qdit/callback`);
    expect(location.searchParams.get("code_challenge_method")).toBe("S256");
    expect(location.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(cookie).toMatchObject({ httpOnly: true, sameSite: "lax", secure: true, path: "/api/integrations/qdit", maxAge: 600 });
    expect(cookie.value).not.toContain(ANA);
  });

  it("is not there with the flag off, and needs a session", async () => {
    setEnv(false);
    expect((await connect(new NextRequest(`${ORIGIN}/api/integrations/qdit/connect`))).status).toBe(404);
    setEnv(true);
    signedIn = null;
    const res = await connect(new NextRequest(`${ORIGIN}/api/integrations/qdit/connect`));
    expect(new URL(res.headers.get("location")!).pathname).toBe("/login");
  });

  it("says when qdit is not configured", async () => {
    vi.stubEnv("QDIT_CLIENT_SECRET", "");
    const res = await connect(new NextRequest(`${ORIGIN}/api/integrations/qdit/connect`));
    expect(outcome(res)).toEqual({ path: "/vault/profile", qdit: "error", reason: "not_configured" });
  });
});

describe("callback", () => {
  it("exchanges the code, checks the account and stores the connection", async () => {
    const { cookie, state } = await startConnect();
    const res = await callback(callbackRequest(`code=c1&state=${state}`, cookie.value));
    expect(outcome(res)).toEqual({ path: "/vault/profile", qdit: "connected", reason: null });
    expect(res.cookies.get("doqtri_qdit_oauth")?.maxAge).toBe(0);
    expect(row).toMatchObject({ userId: ANA, subject: "qdit-ana", accountLabel: "ana", status: "connected", accessToken: "at1" });

    const tokenCall = fetchMock.mock.calls.find(([u]) => String(u).endsWith("/oauth/token"))!;
    const form = new URLSearchParams(String((tokenCall[1] as RequestInit).body));
    expect(form.get("code")).toBe("c1");
    expect(form.get("code_verifier")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(res.headers.get("location")).not.toContain("at1");
  });

  it("refuses a state that does not match the cookie", async () => {
    const { cookie } = await startConnect();
    const res = await callback(callbackRequest("code=c1&state=forged", cookie.value));
    expect(outcome(res)).toMatchObject({ qdit: "error", reason: "state" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(row).toBeNull();
  });

  it("refuses a cookie from another doqtri user's flow", async () => {
    signedIn = BEN;
    const { cookie, state } = await startConnect();
    signedIn = ANA;
    const res = await callback(callbackRequest(`code=c1&state=${state}`, cookie.value));
    expect(outcome(res)).toMatchObject({ qdit: "error", reason: "other_user" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(row).toBeNull();
  });

  it("refuses a callback with no cookie", async () => {
    const { state } = await startConnect();
    expect(outcome(await callback(callbackRequest(`code=c1&state=${state}`)))).toMatchObject({ qdit: "error", reason: "state" });
  });

  it("reports a denial without exchanging anything", async () => {
    const { cookie, state } = await startConnect();
    const res = await callback(callbackRequest(`error=access_denied&error_description=nope&state=${state}`, cookie.value));
    expect(outcome(res)).toMatchObject({ qdit: "denied" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports a refused exchange with a fixed reason, never qdit's text", async () => {
    qdit.token = () => json(400, { error: "invalid_grant", error_description: "code expired <script>" });
    const { cookie, state } = await startConnect();
    const res = await callback(callbackRequest(`code=c1&state=${state}`, cookie.value));
    expect(outcome(res)).toMatchObject({ qdit: "error", reason: "exchange" });
    expect(res.headers.get("location")).not.toContain("script");
    expect(row).toBeNull();
  });

  it("refuses a token issued to another client", async () => {
    qdit.me = () => json(200, { data: { user: { id: "qdit-ana", username: "ana" }, client_id: "someone-else" } });
    const { cookie, state } = await startConnect();
    expect(outcome(await callback(callbackRequest(`code=c1&state=${state}`, cookie.value)))).toMatchObject({
      qdit: "error",
      reason: "account",
    });
    expect(row).toBeNull();
  });

  it("reconnects a connection that needed it", async () => {
    row = {
      userId: ANA,
      subject: "qdit-ana",
      accountLabel: "ana",
      scopes: [],
      status: "needs_reconnect",
      generation: 4,
      expiresAt: null,
      accessToken: null,
      refreshToken: null,
    };
    const { cookie, state } = await startConnect();
    await callback(callbackRequest(`code=c1&state=${state}`, cookie.value));
    expect(row).toMatchObject({ status: "connected", generation: 5, accessToken: "at1" });
  });
});

describe("disconnect", () => {
  const post = (headers: Record<string, string> = { origin: ORIGIN }) =>
    disconnect(new NextRequest(`${ORIGIN}/api/integrations/qdit/disconnect`, { method: "POST", headers }));

  async function connected() {
    const { cookie, state } = await startConnect();
    await callback(callbackRequest(`code=c1&state=${state}`, cookie.value));
    fetchMock.mockClear();
  }

  it("drops the tokens and revokes the refresh token where qdit offers it", async () => {
    await connected();
    qdit.revokeEndpoint = `${ISSUER}/oauth/revoke`;
    const res = await post();
    expect(await res.json()).toEqual({ disconnected: true, revoked_in_qdit: true });
    expect(row).toMatchObject({ status: "revoked", accessToken: null, refreshToken: null });
    const revokeCall = fetchMock.mock.calls.find(([u]) => String(u) === `${ISSUER}/oauth/revoke`)!;
    expect(new URLSearchParams(String((revokeCall[1] as RequestInit).body)).get("token")).toBe("rt1");
  });

  it("still disconnects when qdit has no revocation endpoint", async () => {
    await connected();
    expect(await (await post()).json()).toEqual({ disconnected: true, revoked_in_qdit: false });
    expect(row?.status).toBe("revoked");
  });

  it("disconnects only the signed-in user's own connection", async () => {
    await connected();
    signedIn = BEN;
    await post();
    expect(store.markStatus).not.toHaveBeenCalled();
    expect(row?.status).toBe("connected");
  });

  it("refuses a cross-origin request and a signed-out one", async () => {
    await connected();
    expect((await post({ origin: "https://evil.test" })).status).toBe(403);
    signedIn = null;
    expect((await post()).status).toBe(401);
    expect(row?.status).toBe("connected");
  });
});

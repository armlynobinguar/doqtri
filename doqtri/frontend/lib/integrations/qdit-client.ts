import { createSupabaseAdminClient } from "@/lib/supabase/server";
import { qditConfig, type QditConfig } from "@/lib/integrations/qdit-config";
import { OAuthGrantError, refreshTokens } from "@/lib/integrations/qdit-oauth";
import {
  supabaseConnectionStore,
  type ConnectionStatus,
  type ConnectionStore,
  type StoredConnection,
} from "@/lib/integrations/connection-store";
import { parseTokenKey, type TokenKeyRing } from "@/lib/integrations/token-crypto";

/**
 * Typed client for qdit's `/api/v1`, as one doqtri user (WP-2.3; server-only).
 * docs/integration/CONTRACT.md is the reference for every shape and rule
 * here; section numbers below point into it.
 *
 * Tokens. Each call reads the user's connection, refreshes the access token
 * if it expires within a minute, and sends it as a Bearer token (section 5).
 * A 401 refreshes once and retries once. Refreshes are single-flight per user
 * within a server instance, and across instances the connection's
 * generation check (connection-store.ts) keeps one refresh from overwriting
 * another's rotated refresh token. When qdit refuses the refresh token
 * (`invalid_grant`: the user revoked doqtri in qdit, or the grant expired),
 * the connection becomes `needs_reconnect`, its tokens are dropped, and the
 * call fails with QditNotConnectedError. The same happens when qdit refuses
 * a freshly refreshed token with a second 401, and when a connected row's
 * tokens no longer decrypt.
 *
 * Errors. Every failure is a QditError whose `kind` the caller branches on,
 * with qdit's `code`, `details.reason` and `X-Request-Id` when qdit sent them
 * (section 6). A 429 or 503 carries `retryAfterSeconds`. Nothing retries a
 * rate limit automatically: the caller decides whether to wait. Each request
 * times out after ten seconds.
 *
 * Never put a token, or qdit's raw body, into a log or a response.
 */

// ---------------------------------------------------------------------------
// Resources (section 7)
// ---------------------------------------------------------------------------

export type QditRole = "viewer" | "member" | "admin" | "owner";
export type QditProjectStatus = "active" | "paused" | "completed" | "archived";
export type QditMilestoneStatus = "proposed" | "submitted" | "approved" | "rejected";
export type QditNetwork = "testnet" | "mainnet";

export type QditUser = {
  id: string;
  username: string | null;
  display_name: string | null;
  avatar_url: string | null;
  wallet_address: string | null;
};

export type QditMe = { user: QditUser; client_id: string };

export type QditProject = {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  status: QditProjectStatus;
  role: QditRole;
  chain: { network: QditNetwork; contract_id: string } | null;
  url: string;
  created_at: string;
  updated_at: string;
};

export type QditMilestoneLink = {
  id: string;
  doc_id: string;
  node_id: string;
  node_label: string;
  doc_version: number | null;
  created_at: string;
  updated_at: string;
};

/** The newest `milestone_anchors` record, a pointer and not proof (D-04, D-32). */
export type QditMilestoneAnchor = {
  network: QditNetwork;
  contract_id: string;
  version: number;
  proof_hash: string | null;
  last_action: "submit" | "approve" | "reject";
  last_tx_hash: string;
  anchored_at: string;
};

export type QditMilestone = {
  id: string;
  project: { id: string; name: string; slug: string };
  title: string;
  description: string | null;
  status: QditMilestoneStatus;
  due_date: string | null;
  order_index: number;
  url: string;
  link: QditMilestoneLink | null;
  anchor: QditMilestoneAnchor | null;
  created_at: string;
  updated_at: string;
};

export type QditDocLink = {
  id: string;
  project_id: string;
  doc_id: string;
  doc_title: string;
  doc_url: string;
  created_at: string;
  updated_at: string;
};

export type QditPage<T> = { data: T[]; nextCursor: string | null };

export type CreateMilestoneInput = {
  project_id: string;
  title: string;
  description?: string | null;
  due_date?: string | null;
  link: { doc_id: string; node_id: string; doc_version: number | null };
};

export type UpdateLinkInput = { node_id?: string; doc_version?: number | null };

// ---------------------------------------------------------------------------
// Errors (section 6)
// ---------------------------------------------------------------------------

export type QditErrorKind =
  /** The user has no usable connection: connect or reconnect. */
  | "not_connected"
  /** This deployment has no qdit configured, or its client credentials are refused. */
  | "not_configured"
  | "invalid_request"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "rate_limited"
  /** 500, or another 5xx: safe to retry with backoff. */
  | "server"
  /** 503, or qdit's auth server failing: safe to retry. */
  | "unavailable"
  | "timeout"
  | "network"
  /** qdit answered with something the contract does not describe. */
  | "bad_response";

export class QditError extends Error {
  readonly kind: QditErrorKind;
  readonly status: number | null;
  /** qdit's `error.code`, or the OAuth error code for token failures. */
  readonly code: string | null;
  /** `error.details.reason` (e.g. `node_already_linked`), the field to branch on with `code`. */
  readonly reason: string | null;
  readonly details: Record<string, unknown> | null;
  readonly requestId: string | null;
  readonly retryAfterSeconds: number | null;

  constructor(
    kind: QditErrorKind,
    message: string,
    extra: {
      status?: number | null;
      code?: string | null;
      reason?: string | null;
      details?: Record<string, unknown> | null;
      requestId?: string | null;
      retryAfterSeconds?: number | null;
    } = {},
  ) {
    super(message);
    this.name = "QditError";
    this.kind = kind;
    this.status = extra.status ?? null;
    this.code = extra.code ?? null;
    this.reason = extra.reason ?? null;
    this.details = extra.details ?? null;
    this.requestId = extra.requestId ?? null;
    this.retryAfterSeconds = extra.retryAfterSeconds ?? null;
  }
}

/** The user must connect (`none`) or reconnect (`needs_reconnect`, `revoked`) qdit first. */
export class QditNotConnectedError extends QditError {
  constructor(readonly connection: "none" | Exclude<ConnectionStatus, "connected">) {
    super(
      "not_connected",
      connection === "needs_reconnect"
        ? "Your qdit connection has expired or was revoked. Reconnect qdit in your profile."
        : "Connect your qdit account in your profile first.",
    );
    this.name = "QditNotConnectedError";
  }
}

const KIND_BY_STATUS: Record<number, QditErrorKind> = {
  400: "invalid_request",
  401: "unauthorized",
  403: "forbidden",
  404: "not_found",
  409: "conflict",
  429: "rate_limited",
  500: "server",
  503: "unavailable",
};

/** Seconds from a Retry-After header: delta-seconds or an HTTP date. */
export function parseRetryAfter(value: string | null, now = Date.now()): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  const at = Date.parse(trimmed);
  return Number.isNaN(at) ? null : Math.max(0, Math.ceil((at - now) / 1000));
}

/** The QditError for a non-2xx answer. Reads the body; never keeps it beyond the contract's fields. */
export async function errorFromResponse(res: Response, now = Date.now()): Promise<QditError> {
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  const error =
    body && typeof body === "object" && (body as { error?: unknown }).error && typeof (body as { error: unknown }).error === "object"
      ? ((body as { error: Record<string, unknown> }).error)
      : null;
  const code = typeof error?.code === "string" ? error.code : null;
  const details =
    error?.details && typeof error.details === "object" && !Array.isArray(error.details)
      ? (error.details as Record<string, unknown>)
      : null;
  const reason = typeof details?.reason === "string" ? details.reason : null;
  const message = typeof error?.message === "string" && error.message ? error.message : `qdit answered ${res.status}`;
  const kind: QditErrorKind =
    KIND_BY_STATUS[res.status] ?? (res.status >= 500 ? "server" : "bad_response");
  return new QditError(kind, message, {
    status: res.status,
    code,
    reason,
    details,
    requestId: res.headers.get("x-request-id"),
    retryAfterSeconds:
      res.status === 429 || res.status === 503 ? parseRetryAfter(res.headers.get("retry-after"), now) : null,
  });
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

/** Refresh this long before the access token expires. */
const EXPIRY_SKEW_MS = 60_000;
const REQUEST_TIMEOUT_MS = 10_000;

/** One refresh at a time per user, per issuer, in this server instance. */
const refreshing = new Map<string, Promise<string>>();

export type QditClientDeps = {
  config: QditConfig;
  store: ConnectionStore;
  fetch?: typeof fetch;
  timeoutMs?: number;
  now?: () => number;
};

function notConnected(conn: StoredConnection | null): QditNotConnectedError {
  return new QditNotConnectedError(!conn ? "none" : conn.status === "connected" ? "needs_reconnect" : conn.status);
}

function usable(conn: StoredConnection | null): conn is StoredConnection & { accessToken: string } {
  return !!conn && conn.status === "connected" && !!conn.accessToken;
}

export type QditClient = {
  me(): Promise<QditMe>;
  listProjects(options?: { limit?: number; cursor?: string | null }): Promise<QditPage<QditProject>>;
  /** Every project the user is a member of, following next_cursor up to `maxPages`. */
  listAllProjects(maxPages?: number): Promise<QditProject[]>;
  linkDoc(projectId: string, doc: { doc_id: string; doc_title: string; doc_url: string }): Promise<QditDocLink>;
  unlinkDoc(projectId: string, docId: string): Promise<{ removed_link_ids: string[] }>;
  createMilestone(input: CreateMilestoneInput): Promise<QditMilestone>;
  getMilestone(milestoneId: string): Promise<QditMilestone>;
  renameMilestone(milestoneId: string, title: string): Promise<QditMilestone>;
  updateLink(linkId: string, input: UpdateLinkInput): Promise<QditMilestone>;
  deleteLink(linkId: string): Promise<void>;
};

export function createQditClient(userId: string, deps: QditClientDeps): QditClient {
  const { config, store } = deps;
  const doFetch = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  const timeoutMs = deps.timeoutMs ?? REQUEST_TIMEOUT_MS;

  /** Refreshes `conn`'s tokens and returns the new access token. */
  async function refresh(conn: StoredConnection): Promise<string> {
    if (!conn.refreshToken) {
      // Nothing to refresh with (none issued, or it no longer decrypts).
      if (!(await store.markStatus(userId, conn.generation, "needs_reconnect"))) {
        const latest = await store.load(userId);
        if (usable(latest)) return latest.accessToken;
      }
      throw new QditNotConnectedError("needs_reconnect");
    }

    let tokens;
    try {
      tokens = await refreshTokens(config, conn.refreshToken, { fetch: doFetch, timeoutMs }, now());
    } catch (error) {
      if (error instanceof OAuthGrantError && error.error === "invalid_grant") {
        // Another instance may have rotated the refresh token under us: then
        // its tokens are current and this one is merely stale.
        const latest = await store.load(userId);
        if (latest && latest.generation !== conn.generation) {
          if (usable(latest)) return latest.accessToken;
          throw notConnected(latest);
        }
        await store.markStatus(userId, conn.generation, "needs_reconnect");
        throw new QditNotConnectedError("needs_reconnect");
      }
      if (error instanceof OAuthGrantError) {
        // invalid_client and the like: doqtri's own credentials, not the user's grant.
        throw new QditError("not_configured", "qdit refused doqtri's client credentials.", {
          status: error.status,
          code: error.error,
        });
      }
      throw new QditError("unavailable", "qdit's sign-in service is unavailable. Try again shortly.");
    }

    // qdit may not rotate the refresh token: then the one just used is
    // written back with the rest, which also seals it under the current key
    // if it was opened with the previous one (D-67).
    const next = { ...tokens, refreshToken: tokens.refreshToken ?? conn.refreshToken };
    // False means another write landed first. These tokens are still valid
    // for this call; the stored ones are the other writer's.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await store.saveRefreshed(userId, conn.generation, next);
        break;
      } catch (error) {
        // qdit has already rotated the refresh token, so the stored one is
        // spent. The access token still works for this call, so use it; if
        // the write keeps failing, the next refresh is refused and the
        // connection is marked needs_reconnect then.
        console.error(
          `[qdit] storing refreshed tokens failed${attempt === 0 ? ", retrying" : ""}: ${(error as Error).message}`,
        );
      }
    }
    return tokens.accessToken;
  }

  /**
   * A token to send. `stale` is the token qdit just refused with 401: unless
   * the stored one has changed since, it is refreshed whatever its expiry.
   */
  async function accessToken(stale?: string): Promise<string> {
    let conn = await store.load(userId);
    if (conn?.status === "connected" && !conn.accessToken) {
      // Stored as connected, but the token no longer decrypts under either
      // key (INTEGRATION_TOKEN_KEY changed, or the ciphertext is damaged).
      // Say so in the row too, so the profile offers Reconnect.
      if (await store.markStatus(userId, conn.generation, "needs_reconnect")) {
        throw new QditNotConnectedError("needs_reconnect");
      }
      conn = await store.load(userId);
    }
    if (!usable(conn)) throw notConnected(conn);
    if (stale !== undefined ? conn.accessToken !== stale : conn.expiresAt === null || conn.expiresAt - now() > EXPIRY_SKEW_MS) {
      return conn.accessToken;
    }

    const key = `${config.issuer}|${userId}`;
    const pending = refreshing.get(key);
    if (pending) return pending;
    const run = refresh(conn).finally(() => refreshing.delete(key));
    refreshing.set(key, run);
    return run;
  }

  /**
   * qdit refused a token it was just handed after a refresh (section 5): the
   * grant is no longer good, whatever the refresh said. Unless another
   * write has replaced that token since, the connection is marked
   * needs_reconnect, so later calls fail fast without asking qdit and the
   * profile and ship panel offer Reconnect. Otherwise the 401 is reported
   * as is.
   */
  async function refusedAgain(token: string, res: Response): Promise<never> {
    const latest = await store.load(userId);
    if (
      latest?.status === "connected" &&
      latest.accessToken === token &&
      (await store.markStatus(userId, latest.generation, "needs_reconnect"))
    ) {
      throw new QditNotConnectedError("needs_reconnect");
    }
    throw await errorFromResponse(res, now());
  }

  async function send(method: string, path: string, token: string, body?: unknown): Promise<Response> {
    try {
      return await doFetch(`${config.apiBaseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          ...(body === undefined ? {} : { "Content-Type": "application/json; charset=utf-8" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const name = (error as { name?: string } | null)?.name;
      if (name === "TimeoutError" || name === "AbortError") {
        throw new QditError("timeout", "qdit did not answer in time. Try again.");
      }
      throw new QditError("network", "qdit could not be reached. Try again.");
    }
  }

  async function call<T>(method: string, path: string, body?: unknown): Promise<{ status: number; json: T | null }> {
    const token = await accessToken();
    let res = await send(method, path, token, body);
    if (res.status === 401) {
      // Section 5: refresh once, retry once.
      const fresh = await accessToken(token);
      res = await send(method, path, fresh, body);
      if (res.status === 401) await refusedAgain(fresh, res);
    }
    if (!res.ok) throw await errorFromResponse(res, now());
    if (res.status === 204) return { status: 204, json: null };
    try {
      return { status: res.status, json: (await res.json()) as T };
    } catch {
      throw new QditError("bad_response", "qdit sent a response doqtri could not read.", {
        status: res.status,
        requestId: res.headers.get("x-request-id"),
      });
    }
  }

  async function data<T>(method: string, path: string, body?: unknown): Promise<T> {
    const { json } = await call<{ data?: T }>(method, path, body);
    if (!json || json.data === undefined) {
      throw new QditError("bad_response", "qdit sent a response without data.");
    }
    return json.data;
  }

  const id = (value: string) => encodeURIComponent(value);

  const client: QditClient = {
    me: () => data<QditMe>("GET", "/me"),

    async listProjects(options = {}) {
      const query = new URLSearchParams();
      if (options.limit !== undefined) query.set("limit", String(options.limit));
      if (options.cursor) query.set("cursor", options.cursor);
      const qs = query.toString();
      const suffix = qs ? `?${qs}` : "";
      const { json } = await call<{ data?: QditProject[]; next_cursor?: string | null }>("GET", `/projects${suffix}`);
      if (!json || !Array.isArray(json.data)) throw new QditError("bad_response", "qdit sent a project list doqtri could not read.");
      return { data: json.data, nextCursor: json.next_cursor ?? null };
    },

    async listAllProjects(maxPages = 20) {
      const all: QditProject[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < maxPages; page++) {
        const result: QditPage<QditProject> = await client.listProjects({ limit: 100, cursor });
        all.push(...result.data);
        cursor = result.nextCursor;
        if (!cursor) return all;
      }
      return all;
    },

    linkDoc: (projectId, doc) => data<QditDocLink>("POST", `/projects/${id(projectId)}/docs`, doc),
    unlinkDoc: (projectId, docId) =>
      data<{ removed_link_ids: string[] }>("DELETE", `/projects/${id(projectId)}/docs/${id(docId)}`),
    createMilestone: (input) => data<QditMilestone>("POST", "/milestones", input),
    getMilestone: (milestoneId) => data<QditMilestone>("GET", `/milestones/${id(milestoneId)}`),
    renameMilestone: (milestoneId, title) => data<QditMilestone>("PATCH", `/milestones/${id(milestoneId)}`, { title }),
    updateLink: (linkId, input) => data<QditMilestone>("PATCH", `/links/${id(linkId)}`, input),
    async deleteLink(linkId) {
      await call<never>("DELETE", `/links/${id(linkId)}`);
    },
  };
  return client;
}

export type QditServerSetup = {
  config: QditConfig;
  /** The current token key: everything new is sealed with it. */
  tokenKey: Buffer;
  /** The current key and, during a rotation, the previous one: what sealed values are opened with (D-67). */
  tokenKeys: TokenKeyRing;
  store: ConnectionStore;
};

/**
 * This deployment's qdit configuration, its token keys and the service-role
 * connection store, or null when the integration is off, a value is missing,
 * or INTEGRATION_TOKEN_KEY (or INTEGRATION_TOKEN_KEY_PREVIOUS, when set) is
 * not a valid key. A bad previous key turns the integration off rather than
 * being skipped: skipped, every token it sealed would read as unreadable and
 * its connection would be marked needs_reconnect.
 */
export function qditServerSetup(): QditServerSetup | null {
  const config = qditConfig();
  if (!config) return null;
  let tokenKeys: TokenKeyRing;
  try {
    tokenKeys = {
      current: parseTokenKey(config.tokenKey),
      previous: config.tokenKeyPrevious ? parseTokenKey(config.tokenKeyPrevious, "INTEGRATION_TOKEN_KEY_PREVIOUS") : null,
    };
  } catch (error) {
    console.error(`[qdit] ${(error as Error).message}`);
    return null;
  }
  return {
    config,
    tokenKey: tokenKeys.current,
    tokenKeys,
    store: supabaseConnectionStore(createSupabaseAdminClient(), tokenKeys),
  };
}

/**
 * The client for `userId` with this deployment's configuration and the
 * service-role store. `userId` must come from the verified session.
 */
export function qditClientForUser(userId: string): QditClient {
  const setup = qditServerSetup();
  if (!setup) throw new QditError("not_configured", "qdit is not set up on this deployment.");
  return createQditClient(userId, { config: setup.config, store: setup.store });
}

/**
 * GET /api/v1/me with a token that is not stored yet: the callback's check
 * of whose tokens it just received, before it keeps them.
 */
export async function qditMeWithToken(
  config: QditConfig,
  accessToken: string,
  deps: { fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<QditMe> {
  let res: Response;
  try {
    res = await (deps.fetch ?? fetch)(`${config.apiBaseUrl}/me`, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(deps.timeoutMs ?? REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new QditError("network", "qdit could not be reached. Try again.");
  }
  if (!res.ok) throw await errorFromResponse(res);
  const body = (await res.json().catch(() => null)) as { data?: QditMe } | null;
  if (!body?.data?.user || typeof body.data.user.id !== "string") {
    throw new QditError("bad_response", "qdit sent an account doqtri could not read.");
  }
  return body.data;
}

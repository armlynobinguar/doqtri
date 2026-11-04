/**
 * A stand-in qdit for doqtri's e2e suite (DOQ-16).
 *
 * qdit is a separate repository with its own owner, so doqtri's tests do not
 * run it. This server answers what docs/integration/CONTRACT.md says qdit
 * answers, and nothing else: OAuth authorize and token (section 5), the
 * /api/v1 endpoints (sections 6 to 8) with their minimum roles, and the
 * error envelope. Where this file and the contract disagree, the contract
 * wins and this file is the bug.
 *
 * Deliberate simplifications, none of which doqtri can observe:
 * - Tokens are opaque random strings, not JWTs. doqtri never decodes them.
 * - One page of projects; next_cursor is always null, so any cursor sent
 *   back is one the stub never issued and is refused like a bad one.
 * - Projects carry `chain: null`, so doqtri never calls Stellar RPC for them.
 * - doc_url must start with E2E_DOQTRI_ORIGIN + "/". qdit requires https;
 *   the e2e app runs on http://localhost, which qdit's local setup allows.
 *
 * Tests steer it through /__stub/* (users, projects, roles, the next consent
 * answer, revocations, deletions) and read back what doqtri sent.
 *
 * Run with `node e2e/qdit-stub/server.mts`; Node strips the types. It imports
 * only node: built-ins so it needs no build step.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

const PORT = Number(process.env.QDIT_STUB_PORT ?? 4010);
const ORIGIN = `http://localhost:${PORT}`;
const CLIENT_ID = required("QDIT_STUB_CLIENT_ID");
const CLIENT_SECRET = required("QDIT_STUB_CLIENT_SECRET");
const DOQTRI_ORIGIN = required("QDIT_STUB_DOQTRI_ORIGIN").replace(/\/+$/, "");

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`qdit stub: ${name} is required`);
  return value;
}

type Role = "viewer" | "member" | "admin" | "owner";
const RANK: Record<Role, number> = { viewer: 1, member: 2, admin: 3, owner: 4 };
type MilestoneStatus = "proposed" | "submitted" | "approved" | "rejected";

type User = {
  id: string;
  username: string | null;
  display_name: string | null;
  avatar_url: string | null;
  wallet_address: string | null;
};
type Project = { id: string; name: string; slug: string; status: "active"; created_at: string; updated_at: string };
type DocLink = {
  id: string;
  project_id: string;
  doc_id: string;
  doc_title: string;
  doc_url: string;
  created_at: string;
  updated_at: string;
};
type Link = {
  id: string;
  doc_id: string;
  node_id: string;
  node_label: string;
  doc_version: number | null;
  created_at: string;
  updated_at: string;
};
type Milestone = {
  id: string;
  project_id: string;
  title: string;
  description: string | null;
  status: MilestoneStatus;
  due_date: string | null;
  order_index: number;
  link: Link | null;
  created_at: string;
  updated_at: string;
};
type Code = { user: string; redirect_uri: string; challenge: string; scope: string };
type Token = { user: string; exp: number };
type AuthorizeAnswer = { as: string } | { deny: true };

const state = fresh();

function fresh() {
  return {
    users: new Map<string, User>(),
    projects: new Map<string, Project>(),
    /** project id -> user id -> role */
    members: new Map<string, Map<string, Role>>(),
    /** doc id -> its one doc link (a doc is linked to at most one project) */
    docLinks: new Map<string, DocLink>(),
    milestones: new Map<string, Milestone>(),
    codes: new Map<string, Code>(),
    access: new Map<string, Token>(),
    refresh: new Map<string, { user: string }>(),
    /** What the next /oauth/authorize answers, oldest first. */
    authorize: [] as AuthorizeAnswer[],
    tokenTtlSeconds: 3600,
    /** Every /api/v1 call, for tests that check what doqtri sent. */
    log: [] as { method: string; path: string; user: string | null; status: number; body: unknown }[],
  };
}

const now = () => new Date().toISOString();

// ---------------------------------------------------------------------------
// HTTP plumbing

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function send(res: ServerResponse, status: number, body?: unknown, headers: Record<string, string> = {}) {
  const requestId = randomUUID();
  if (body === undefined) {
    res.writeHead(status, { "X-Request-Id": requestId, ...headers });
    res.end();
    return;
  }
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "X-Request-Id": requestId,
    ...headers,
  });
  res.end(JSON.stringify(body));
}

type ApiError = { status: number; code: string; message: string; details?: Record<string, unknown> | null; headers?: Record<string, string> };

function apiError(status: number, code: string, message: string, details: Record<string, unknown> | null = null): ApiError {
  return { status, code, message, details };
}

const NOT_FOUND = () => apiError(404, "not_found", "Not found.");
const FORBIDDEN = () => apiError(403, "forbidden", "Your role in this project does not allow that.");
const INVALID = (fields: Record<string, string>) =>
  apiError(400, "invalid_request", "The request is invalid.", { fields });
const CONFLICT = (reason: string, extra: Record<string, unknown> = {}) =>
  apiError(409, "conflict", `Conflict: ${reason}.`, { reason, ...extra });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NODE_ID = /^(root|h\d+)$/;

// ---------------------------------------------------------------------------
// Views (CONTRACT.md section 7)

function projectView(project: Project, role: Role) {
  return {
    id: project.id,
    name: project.name,
    slug: project.slug,
    description: null,
    status: project.status,
    role,
    chain: null,
    url: `${ORIGIN}/projects/${project.slug}`,
    created_at: project.created_at,
    updated_at: project.updated_at,
  };
}

function milestoneView(m: Milestone) {
  const project = state.projects.get(m.project_id)!;
  return {
    id: m.id,
    project: { id: project.id, name: project.name, slug: project.slug },
    title: m.title,
    description: m.description,
    status: m.status,
    due_date: m.due_date,
    order_index: m.order_index,
    url: `${ORIGIN}/projects/${project.slug}/milestones`,
    link: m.link,
    anchor: null,
    created_at: m.created_at,
    updated_at: m.updated_at,
  };
}

/** The caller's role in a project, or null when they cannot see it. */
function roleIn(projectId: string, user: string): Role | null {
  if (!state.projects.has(projectId)) return null;
  return state.members.get(projectId)?.get(user) ?? null;
}

/** 404 when the project is invisible, 403 when visible but below `min` (section 8). */
function need(projectId: string, user: string, min: Role): ApiError | null {
  const role = roleIn(projectId, user);
  if (!role) return NOT_FOUND();
  if (RANK[role] < RANK[min]) return FORBIDDEN();
  return null;
}

// ---------------------------------------------------------------------------
// OAuth (section 5)

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function issueTokens(user: string) {
  const access = b64url(randomBytes(24));
  const refresh = b64url(randomBytes(24));
  state.access.set(access, { user, exp: Date.now() + state.tokenTtlSeconds * 1000 });
  state.refresh.set(refresh, { user });
  return {
    access_token: access,
    token_type: "bearer",
    expires_in: state.tokenTtlSeconds,
    refresh_token: refresh,
    scope: "openid",
  };
}

function authorize(url: URL, res: ServerResponse) {
  const q = url.searchParams;
  const redirectUri = q.get("redirect_uri");
  if (q.get("client_id") !== CLIENT_ID || !redirectUri) {
    send(res, 400, { error: "invalid_client" });
    return;
  }
  if (q.get("response_type") !== "code" || q.get("code_challenge_method") !== "S256" || !q.get("code_challenge")) {
    send(res, 400, { error: "invalid_request" });
    return;
  }
  const answer = state.authorize.shift();
  if (!answer) {
    // A test forgot to say who consents. Fail loudly on the page.
    send(res, 500, { error: "qdit stub: no authorize answer queued; call stub.consentAs() first" });
    return;
  }
  const back = new URL(redirectUri);
  back.searchParams.set("state", q.get("state") ?? "");
  if ("deny" in answer) {
    back.searchParams.set("error", "access_denied");
  } else {
    const code = b64url(randomBytes(18));
    state.codes.set(code, {
      user: answer.as,
      redirect_uri: redirectUri,
      challenge: q.get("code_challenge")!,
      scope: q.get("scope") ?? "",
    });
    back.searchParams.set("code", code);
  }
  res.writeHead(302, { Location: back.toString() });
  res.end();
}

function token(req: IncomingMessage, raw: string, res: ServerResponse) {
  const basic = /^Basic (.+)$/.exec(req.headers.authorization ?? "");
  const [id, secret] = basic
    ? Buffer.from(basic[1], "base64").toString("utf8").split(":").map((part) => decodeURIComponent(part))
    : [];
  if (id !== CLIENT_ID || secret !== CLIENT_SECRET) {
    send(res, 401, { error: "invalid_client" });
    return;
  }
  const form = new URLSearchParams(raw);
  const grant = form.get("grant_type");
  if (grant === "authorization_code") {
    const code = state.codes.get(form.get("code") ?? "");
    state.codes.delete(form.get("code") ?? "");
    const verifier = form.get("code_verifier") ?? "";
    const challenge = b64url(createHash("sha256").update(verifier).digest());
    if (!code || code.redirect_uri !== form.get("redirect_uri") || code.challenge !== challenge) {
      send(res, 400, { error: "invalid_grant" });
      return;
    }
    send(res, 200, issueTokens(code.user));
    return;
  }
  if (grant === "refresh_token") {
    const presented = form.get("refresh_token") ?? "";
    const held = state.refresh.get(presented);
    if (!held) {
      // Supabase Auth's own shape, not RFC 6749's {"error":"invalid_grant"}:
      // what real qdit answers for a revoked or spent refresh token (DOQ-20).
      send(res, 400, { code: 400, error_code: "refresh_token_not_found", msg: "Invalid Refresh Token: Refresh Token Not Found" });
      return;
    }
    state.refresh.delete(presented);
    send(res, 200, issueTokens(held.user));
    return;
  }
  send(res, 400, { error: "unsupported_grant_type" });
}

/** Revokes every token a user holds for doqtri, as qdit's Authorized apps does (D-59). */
function revoke(user: string) {
  for (const [key, t] of state.access) if (t.user === user) state.access.delete(key);
  for (const [key, t] of state.refresh) if (t.user === user) state.refresh.delete(key);
}

// ---------------------------------------------------------------------------
// /api/v1 (section 8)

function bearer(req: IncomingMessage): string | null {
  const match = /^Bearer (.+)$/.exec(req.headers.authorization ?? "");
  const held = match ? state.access.get(match[1]) : undefined;
  if (!held || held.exp <= Date.now()) return null;
  return held.user;
}

function parseJson(raw: string): Record<string, unknown> | ApiError {
  try {
    const value = JSON.parse(raw);
    if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch {
    // fall through
  }
  return apiError(400, "invalid_request", "Body must be a JSON object.", { fields: {} });
}

function isError(value: unknown): value is ApiError {
  return typeof value === "object" && value !== null && "code" in value && "status" in value && "message" in value;
}

type Ok = { status: number; body?: unknown };

function api(method: string, path: string, query: URLSearchParams, user: string, raw: string): Ok | ApiError {
  const parts = path.split("/").filter(Boolean); // after /api/v1

  if (method === "GET" && path === "/me") {
    const u = state.users.get(user)!;
    return { status: 200, body: { data: { user: u, client_id: CLIENT_ID } } };
  }

  if (method === "GET" && path === "/projects") {
    const limit = query.get("limit");
    if (limit !== null && !(/^\d+$/.test(limit) && Number(limit) >= 1 && Number(limit) <= 100)) {
      return INVALID({ limit: "1 to 100" });
    }
    if (query.get("cursor") !== null) return INVALID({ cursor: "unknown cursor" });
    const list = [...state.projects.values()]
      .filter((p) => roleIn(p.id, user))
      .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
      .map((p) => projectView(p, roleIn(p.id, user)!));
    return { status: 200, body: { data: list, next_cursor: null } };
  }

  // POST /projects/{id}/docs
  if (parts[0] === "projects" && parts[2] === "docs" && parts.length === 3 && method === "POST") {
    const projectId = parts[1];
    const denied = need(projectId, user, "admin");
    if (denied) return denied;
    const body = parseJson(raw);
    if (isError(body)) return body;
    const docId = String(body.doc_id ?? "");
    const title = typeof body.doc_title === "string" ? body.doc_title.trim() : "";
    const docUrl = typeof body.doc_url === "string" ? body.doc_url : "";
    const fields: Record<string, string> = {};
    if (!UUID.test(docId)) fields.doc_id = "must be a UUID";
    if (title.length < 1 || title.length > 300) fields.doc_title = "1 to 300 characters";
    if (!docUrl.startsWith(`${DOQTRI_ORIGIN}/`)) fields.doc_url = `must start with ${DOQTRI_ORIGIN}/`;
    if (Object.keys(fields).length) return INVALID(fields);

    const existing = state.docLinks.get(docId);
    if (existing && existing.project_id !== projectId) return CONFLICT("doc_linked_elsewhere");
    if (existing) {
      Object.assign(existing, { doc_title: title, doc_url: docUrl, updated_at: now() });
      return { status: 200, body: { data: existing } };
    }
    const link: DocLink = {
      id: randomUUID(),
      project_id: projectId,
      doc_id: docId,
      doc_title: title,
      doc_url: docUrl,
      created_at: now(),
      updated_at: now(),
    };
    state.docLinks.set(docId, link);
    return { status: 201, body: { data: link } };
  }

  // DELETE /projects/{id}/docs/{doc_id}
  if (parts[0] === "projects" && parts[2] === "docs" && parts.length === 4 && method === "DELETE") {
    const [, projectId, , docId] = parts;
    const denied = need(projectId, user, "admin");
    if (denied) return denied;
    const link = state.docLinks.get(docId);
    if (!link || link.project_id !== projectId) return NOT_FOUND();
    state.docLinks.delete(docId);
    const removed: string[] = [];
    for (const m of state.milestones.values()) {
      if (m.project_id === projectId && m.link?.doc_id === docId) {
        removed.push(m.link.id);
        m.link = null;
      }
    }
    return { status: 200, body: { data: { removed_link_ids: removed } } };
  }

  // POST /milestones
  if (method === "POST" && path === "/milestones") {
    const body = parseJson(raw);
    if (isError(body)) return body;
    const projectId = String(body.project_id ?? "");
    const denied = need(projectId, user, "member");
    if (denied) return denied;
    const title = typeof body.title === "string" ? body.title.trim() : "";
    const linkIn = (body.link ?? {}) as Record<string, unknown>;
    const docId = String(linkIn.doc_id ?? "");
    const nodeId = String(linkIn.node_id ?? "");
    const fields: Record<string, string> = {};
    if (title.length < 1 || title.length > 300) fields.title = "1 to 300 characters";
    if (!UUID.test(docId)) fields["link.doc_id"] = "must be a UUID";
    if (!NODE_ID.test(nodeId)) fields["link.node_id"] = "must be a node id";
    if (Object.keys(fields).length) return INVALID(fields);

    const docLink = state.docLinks.get(docId);
    if (!docLink || docLink.project_id !== projectId) return CONFLICT("doc_not_linked");
    const taken = [...state.milestones.values()].find((m) => m.link?.doc_id === docId && m.link.node_id === nodeId);
    if (taken) return CONFLICT("node_already_linked", { milestone_id: taken.id });

    const order = [...state.milestones.values()].filter((m) => m.project_id === projectId).length;
    const m: Milestone = {
      id: randomUUID(),
      project_id: projectId,
      title,
      description: (body.description as string | null) ?? null,
      status: "proposed",
      due_date: (body.due_date as string | null) ?? null,
      order_index: order,
      link: {
        id: randomUUID(),
        doc_id: docId,
        node_id: nodeId,
        node_label: title,
        doc_version: typeof linkIn.doc_version === "number" ? linkIn.doc_version : null,
        created_at: now(),
        updated_at: now(),
      },
      created_at: now(),
      updated_at: now(),
    };
    state.milestones.set(m.id, m);
    return { status: 201, body: { data: milestoneView(m) } };
  }

  // GET or PATCH /milestones/{id}
  if (parts[0] === "milestones" && parts.length === 2 && (method === "GET" || method === "PATCH")) {
    const m = state.milestones.get(parts[1]);
    if (!m || !roleIn(m.project_id, user)) return NOT_FOUND();
    if (method === "GET") return { status: 200, body: { data: milestoneView(m) } };
    const denied = need(m.project_id, user, "member");
    if (denied) return denied;
    const body = parseJson(raw);
    if (isError(body)) return body;
    const keys = Object.keys(body);
    const title = typeof body.title === "string" ? body.title.trim() : "";
    if (keys.length !== 1 || keys[0] !== "title" || title.length < 1 || title.length > 300) {
      return INVALID({ title: "the body must be exactly {\"title\": \"...\"}" });
    }
    if (!m.link) return CONFLICT("milestone_not_linked");
    m.title = title;
    m.link.node_label = title;
    m.updated_at = m.link.updated_at = now();
    return { status: 200, body: { data: milestoneView(m) } };
  }

  // PATCH or DELETE /links/{id}
  if (parts[0] === "links" && parts.length === 2 && (method === "PATCH" || method === "DELETE")) {
    const m = [...state.milestones.values()].find((x) => x.link?.id === parts[1]);
    if (!m || !roleIn(m.project_id, user)) return NOT_FOUND();
    const denied = need(m.project_id, user, "member");
    if (denied) return denied;
    if (method === "DELETE") {
      m.link = null;
      m.updated_at = now();
      return { status: 204 };
    }
    const body = parseJson(raw);
    if (isError(body)) return body;
    const extra = Object.keys(body).filter((k) => k !== "node_id" && k !== "doc_version");
    if (extra.length || Object.keys(body).length === 0) return INVALID({ body: "node_id and/or doc_version only" });
    if (body.node_id !== undefined) {
      const nodeId = String(body.node_id);
      if (!NODE_ID.test(nodeId)) return INVALID({ node_id: "must be a node id" });
      const other = [...state.milestones.values()].find(
        (x) => x !== m && x.link?.doc_id === m.link!.doc_id && x.link.node_id === nodeId,
      );
      if (other) return CONFLICT("node_already_linked", { milestone_id: other.id });
      m.link!.node_id = nodeId;
    }
    if (body.doc_version !== undefined) m.link!.doc_version = body.doc_version as number | null;
    m.updated_at = m.link!.updated_at = now();
    return { status: 200, body: { data: milestoneView(m) } };
  }

  // Unknown path, or a method a known path does not support: 404, never 405 (D-27).
  return NOT_FOUND();
}

// ---------------------------------------------------------------------------
// /__stub control surface (tests only)

function control(method: string, path: string, raw: string): Ok {
  const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  const parts = path.split("/").filter(Boolean); // after /__stub

  if (method === "POST" && path === "/reset") {
    Object.assign(state, fresh());
    return { status: 204 };
  }
  if (method === "GET" && path === "/health") return { status: 200, body: { ok: true, client_id: CLIENT_ID } };
  if (method === "GET" && path === "/log") return { status: 200, body: state.log };

  if (method === "POST" && path === "/users") {
    const user = body as unknown as User;
    state.users.set(user.id, {
      id: user.id,
      username: user.username ?? null,
      display_name: user.display_name ?? null,
      avatar_url: user.avatar_url ?? null,
      wallet_address: user.wallet_address ?? null,
    });
    return { status: 204 };
  }

  if (method === "POST" && path === "/projects") {
    const id = String(body.id);
    state.projects.set(id, {
      id,
      name: String(body.name),
      slug: String(body.slug),
      status: "active",
      created_at: now(),
      updated_at: now(),
    });
    state.members.set(id, new Map(Object.entries((body.members ?? {}) as Record<string, Role>)));
    return { status: 204 };
  }

  // POST /projects/{id}/role {user, role|null}
  if (method === "POST" && parts[0] === "projects" && parts[2] === "role") {
    const members = state.members.get(parts[1]);
    if (!members) return { status: 404, body: { error: "no such project" } };
    if (body.role) members.set(String(body.user), body.role as Role);
    else members.delete(String(body.user));
    return { status: 204 };
  }

  // POST /projects/{id}/delete: the project, its doc links and milestones go (section 8, D-68)
  if (method === "POST" && parts[0] === "projects" && parts[2] === "delete") {
    const id = parts[1];
    state.projects.delete(id);
    state.members.delete(id);
    for (const [doc, link] of state.docLinks) if (link.project_id === id) state.docLinks.delete(doc);
    for (const [mid, m] of state.milestones) if (m.project_id === id) state.milestones.delete(mid);
    return { status: 204 };
  }

  // POST /doc-links {project_id, doc_id}: a doc link some other app made
  if (method === "POST" && path === "/doc-links") {
    const docId = String(body.doc_id);
    state.docLinks.set(docId, {
      id: randomUUID(),
      project_id: String(body.project_id),
      doc_id: docId,
      doc_title: "Linked by someone else",
      doc_url: `${DOQTRI_ORIGIN}/d/${docId}`,
      created_at: now(),
      updated_at: now(),
    });
    return { status: 204 };
  }

  // POST /milestones/{id}/delete: a qdit admin deletes a milestone doqtri still links
  if (method === "POST" && parts[0] === "milestones" && parts[2] === "delete") {
    state.milestones.delete(parts[1]);
    return { status: 204 };
  }

  // POST /milestones/{id}/status {status}
  if (method === "POST" && parts[0] === "milestones" && parts[2] === "status") {
    const m = state.milestones.get(parts[1]);
    if (!m) return { status: 404, body: { error: "no such milestone" } };
    m.status = body.status as MilestoneStatus;
    m.updated_at = now();
    return { status: 200, body: milestoneView(m) };
  }

  // GET /milestones/{id}: the stub's own view, whoever may see it
  if (method === "GET" && parts[0] === "milestones" && parts.length === 2) {
    const m = state.milestones.get(parts[1]);
    return m ? { status: 200, body: milestoneView(m) } : { status: 404, body: { error: "no such milestone" } };
  }

  // GET /doc-links/{doc_id}
  if (method === "GET" && parts[0] === "doc-links" && parts.length === 2) {
    const link = state.docLinks.get(parts[1]);
    return link ? { status: 200, body: link } : { status: 404, body: { error: "no such doc link" } };
  }

  if (method === "POST" && path === "/authorize") {
    state.authorize.push(body.deny ? { deny: true } : { as: String(body.as) });
    return { status: 204 };
  }

  if (method === "POST" && path === "/revoke") {
    revoke(String(body.user));
    return { status: 204 };
  }

  if (method === "POST" && path === "/token-ttl") {
    state.tokenTtlSeconds = Number(body.seconds);
    return { status: 204 };
  }

  return { status: 404, body: { error: `qdit stub: no control ${method} ${path}` } };
}

// ---------------------------------------------------------------------------

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", ORIGIN);
  const method = req.method ?? "GET";
  const raw = await readBody(req);

  try {
    if (url.pathname.startsWith("/__stub/")) {
      const out = control(method, url.pathname.slice("/__stub".length), raw);
      send(res, out.status, out.body);
      return;
    }
    if (url.pathname === "/auth/v1/oauth/authorize" && method === "GET") return authorize(url, res);
    if (url.pathname === "/auth/v1/oauth/token" && method === "POST") return token(req, raw, res);
    if (url.pathname === "/auth/v1/.well-known/oauth-authorization-server" && method === "GET") {
      // No revocation_endpoint: Supabase's OAuth server does not document one (section 5).
      send(res, 200, {
        issuer: `${ORIGIN}/auth/v1`,
        authorization_endpoint: `${ORIGIN}/auth/v1/oauth/authorize`,
        token_endpoint: `${ORIGIN}/auth/v1/oauth/token`,
      });
      return;
    }

    if (url.pathname.startsWith("/api/v1/") || url.pathname === "/api/v1") {
      const path = url.pathname.slice("/api/v1".length) || "/";
      const user = bearer(req);
      let out: Ok | ApiError;
      if (!user) {
        out = {
          ...apiError(401, "unauthorized", "Missing, expired or revoked token."),
          headers: { "WWW-Authenticate": 'Bearer error="invalid_token"' },
        };
      } else {
        out = api(method, path, url.searchParams, user, raw);
      }
      state.log.push({ method, path, user, status: out.status, body: raw ? safeJson(raw) : null });
      if (isError(out)) {
        send(res, out.status, { error: { code: out.code, message: out.message, details: out.details ?? null } }, out.headers);
      } else {
        send(res, out.status, out.body);
      }
      return;
    }

    send(res, 404, { error: { code: "not_found", message: "Not found.", details: null } });
  } catch (error) {
    send(res, 500, { error: { code: "internal_error", message: String(error), details: null } });
  }
});

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

// Both loopbacks: "localhost" resolves to ::1 or 127.0.0.1 depending on the
// caller, and the stub must answer either. Never any other interface.
server.listen(PORT, "127.0.0.1", () => {
  console.log(`qdit stub listening on ${ORIGIN}`);
});
const v6 = createServer((req, res) => server.emit("request", req, res));
v6.on("error", () => {
  // No IPv6 loopback on this machine; 127.0.0.1 is enough.
});
v6.listen(PORT, "::1");

import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { QditConfig } from "@/lib/integrations/qdit-config";
import { authorizeUrl, exchangeCode, startOAuthState } from "@/lib/integrations/qdit-oauth";
import { createQditClient, QditError, qditMeWithToken } from "@/lib/integrations/qdit-client";
import type { ConnectionStore, StoredConnection } from "@/lib/integrations/connection-store";
import { parseTokenKey } from "@/lib/integrations/token-crypto";

/**
 * The e2e qdit stub, spoken to by doqtri's real OAuth and API client
 * (DOQ-16). If the stub drifts from what doqtri sends or parses, this fails
 * in `npm test` rather than as a confusing Playwright timeout. The contract
 * itself is still the reference: this only proves the two agree.
 */

const PORT = 4000 + Math.floor(Math.random() * 900) + 50;
const ORIGIN = `http://localhost:${PORT}`;
const CLIENT_ID = "0d0c7e16-2e2e-4c5e-9d16-000000000e2e";
const SECRET = "vitest-secret";
const DOQTRI = "http://localhost:3000";
const USER = "aaaaaaaa-0000-4000-8000-000000000001";

const config: QditConfig = {
  apiBaseUrl: `${ORIGIN}/api/v1`,
  issuer: `${ORIGIN}/auth/v1`,
  clientId: CLIENT_ID,
  clientSecret: SECRET,
  redirectUri: `${DOQTRI}/api/integrations/qdit/callback`,
  tokenKey: "e2e0".repeat(16),
  tokenKeyPrevious: null,
};

let server: ChildProcess;

async function control(path: string, body: unknown) {
  const res = await fetch(`${ORIGIN}/__stub${path}`, { method: "POST", body: JSON.stringify(body) });
  expect(res.ok).toBe(true);
}

/** A connection kept in memory, the shape the real store keeps in Postgres. */
function memoryStore(): ConnectionStore & { row: StoredConnection | null } {
  const store = {
    row: null as StoredConnection | null,
    async load() {
      return store.row ? { ...store.row } : null;
    },
    async saveConnected(userId: string, account: { subject: string; accountLabel: string | null }, t: Parameters<ConnectionStore["saveConnected"]>[2]) {
      store.row = {
        userId,
        subject: account.subject,
        accountLabel: account.accountLabel,
        scopes: t.scopes,
        status: "connected",
        generation: (store.row?.generation ?? 0) + 1,
        expiresAt: t.expiresAt,
        accessToken: t.accessToken,
        refreshToken: t.refreshToken,
      };
      return { replaced: null };
    },
    async saveRefreshed(_userId: string, generation: number, t: Parameters<ConnectionStore["saveRefreshed"]>[2]) {
      if (!store.row || store.row.generation !== generation) return false;
      store.row = {
        ...store.row,
        generation: generation + 1,
        accessToken: t.accessToken,
        refreshToken: t.refreshToken ?? store.row.refreshToken,
        expiresAt: t.expiresAt,
      };
      return true;
    },
    async markStatus(_userId: string, generation: number, status: "needs_reconnect" | "revoked") {
      if (!store.row || store.row.generation !== generation) return false;
      store.row = { ...store.row, status, generation: generation + 1, accessToken: null, refreshToken: null };
      return true;
    },
  };
  return store;
}

beforeAll(async () => {
  server = spawn(process.execPath, [fileURLToPath(new URL("./server.mts", import.meta.url))], {
    env: {
      ...process.env,
      QDIT_STUB_PORT: String(PORT),
      QDIT_STUB_CLIENT_ID: CLIENT_ID,
      QDIT_STUB_CLIENT_SECRET: SECRET,
      QDIT_STUB_DOQTRI_ORIGIN: DOQTRI,
    },
    stdio: "ignore",
  });
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`${ORIGIN}/__stub/health`)).ok) return;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("qdit stub did not start");
});

afterAll(() => {
  server?.kill();
});

describe("the e2e qdit stub, as doqtri's client sees it", () => {
  it("runs the OAuth code flow with PKCE and answers /me", async () => {
    const qdit = "11111111-1111-4111-8111-111111111111";
    await control("/users", { id: qdit, username: "qa" });
    await control("/authorize", { as: qdit });

    const { state } = startOAuthState(USER, config.redirectUri!, parseTokenKey(config.tokenKey));
    const res = await fetch(authorizeUrl(config, state), { redirect: "manual" });
    expect(res.status).toBe(302);
    const back = new URL(res.headers.get("location")!);
    expect(back.searchParams.get("state")).toBe(state.state);

    const tokens = await exchangeCode(config, back.searchParams.get("code")!, state);
    expect(tokens.accessToken).toBeTruthy();
    const me = await qditMeWithToken(config, tokens.accessToken);
    expect(me).toMatchObject({ user: { id: qdit, username: "qa" }, client_id: CLIENT_ID });
  });

  it("links, makes, renames, moves and unlinks through the client, with qdit's roles", async () => {
    const qdit = "22222222-2222-4222-8222-222222222222";
    const project = "33333333-3333-4333-8333-333333333333";
    const viewerProject = "44444444-4444-4444-8444-444444444444";
    const doc = "55555555-5555-4555-8555-555555555555";
    await control("/users", { id: qdit, username: "qb" });
    await control("/projects", { id: project, name: "Payroll", slug: "payroll", members: { [qdit]: "admin" } });
    await control("/projects", { id: viewerProject, name: "Read only", slug: "ro", members: { [qdit]: "viewer" } });
    await control("/authorize", { as: qdit });

    // Connect the way the callback does, then hand the store to the client.
    const { state } = startOAuthState(USER, config.redirectUri!, parseTokenKey(config.tokenKey));
    const back = new URL((await fetch(authorizeUrl(config, state), { redirect: "manual" })).headers.get("location")!);
    const tokens = await exchangeCode(config, back.searchParams.get("code")!, state);
    const store = memoryStore();
    await store.saveConnected(USER, { subject: qdit, accountLabel: "qb" }, tokens);
    const client = createQditClient(USER, { config, store });

    const projects = await client.listAllProjects();
    expect(projects.map((p) => [p.id, p.role]).sort()).toEqual([
      [project, "admin"],
      [viewerProject, "viewer"],
    ]);

    const link = await client.linkDoc(project, { doc_id: doc, doc_title: "Plan", doc_url: `${DOQTRI}/d/${doc}` });
    expect(link).toMatchObject({ project_id: project, doc_id: doc });

    const milestone = await client.createMilestone({
      project_id: project,
      title: "Build",
      description: null,
      due_date: null,
      link: { doc_id: doc, node_id: "h1", doc_version: null },
    });
    expect(milestone).toMatchObject({ status: "proposed", link: { node_id: "h1", node_label: "Build" } });
    expect((await client.getMilestone(milestone.id)).project.id).toBe(project);
    expect((await client.renameMilestone(milestone.id, "Build it")).link?.node_label).toBe("Build it");
    expect((await client.updateLink(milestone.link!.id, { node_id: "h2" })).link?.node_id).toBe("h2");

    await expect(
      client.createMilestone({ project_id: project, title: "Again", description: null, due_date: null, link: { doc_id: doc, node_id: "h2", doc_version: null } }),
    ).rejects.toMatchObject({ kind: "conflict" });
    await expect(client.linkDoc(viewerProject, { doc_id: doc, doc_title: "Plan", doc_url: `${DOQTRI}/d/${doc}` })).rejects.toMatchObject({
      kind: "forbidden",
    });

    await client.deleteLink(milestone.link!.id);
    expect((await client.unlinkDoc(project, doc)).removed_link_ids).toEqual([]);
    await expect(client.getMilestone("66666666-6666-4666-8666-666666666666")).rejects.toBeInstanceOf(QditError);
  });

  it("lists hackathons as section 8 says (D-122), and plays a qdit without the list as its JSON 404", async () => {
    const qdit = "88888888-8888-4888-8888-888888888888";
    await control("/users", { id: qdit, username: "qd" });
    await control("/authorize", { as: qdit });
    const { state } = startOAuthState(USER, config.redirectUri!, parseTokenKey(config.tokenKey));
    const back = new URL((await fetch(authorizeUrl(config, state), { redirect: "manual" })).headers.get("location")!);
    const tokens = await exchangeCode(config, back.searchParams.get("code")!, state);
    const store = memoryStore();
    await store.saveConnected(USER, { subject: qdit, accountLabel: "qd" }, tokens);
    const client = createQditClient(USER, { config, store });

    const day = 24 * 60 * 60 * 1000;
    // One base time, so equal offsets are equal times and the slug breaks the tie.
    const base = Date.now();
    const at = (days: number) => new Date(base + days * day).toISOString();
    const hackathon = (slug: string, opens: number, closes: number, extra: Record<string, unknown> = {}) =>
      control("/hackathons", { slug, name: slug.toUpperCase(), opens_at: at(opens), closes_at: at(closes), ...extra });
    await hackathon("soon-b", 3, 10);
    await hackathon("soon-a", 3, 10);
    await hackathon("running", -1, 5);
    await hackathon("over", -10, -1);
    await hackathon("secret", -1, 5, { hidden: true });
    await hackathon("test-rehearsal", -1, 5);

    const listed = await client.listHackathons();
    expect(listed.map((h) => [h.slug, h.state])).toEqual([
      ["running", "open"],
      ["soon-a", "upcoming"],
      ["soon-b", "upcoming"],
    ]);

    await control("/hackathon-list", { enabled: false });
    try {
      // What the doqtri route turns into list_unavailable: qdit's own JSON 404.
      await expect(client.listHackathons()).rejects.toMatchObject({ kind: "not_found", status: 404, code: "not_found" });
    } finally {
      await control("/hackathon-list", { enabled: true });
    }
  });

  it("a revoked grant fails the refresh, and the client marks the connection needs_reconnect", async () => {
    const qdit = "77777777-7777-4777-8777-777777777777";
    await control("/users", { id: qdit, username: "qc" });
    await control("/authorize", { as: qdit });
    const { state } = startOAuthState(USER, config.redirectUri!, parseTokenKey(config.tokenKey));
    const back = new URL((await fetch(authorizeUrl(config, state), { redirect: "manual" })).headers.get("location")!);
    const tokens = await exchangeCode(config, back.searchParams.get("code")!, state);
    const store = memoryStore();
    await store.saveConnected(USER, { subject: qdit, accountLabel: "qc" }, tokens);

    await control("/revoke", { user: qdit });
    await expect(createQditClient(USER, { config, store }).me()).rejects.toMatchObject({ kind: "not_connected" });
    expect(store.row).toMatchObject({ status: "needs_reconnect", accessToken: null });
  });
});

import { readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * NEXT_PUBLIC_QDIT_INTEGRATION off (G2.7): every qdit route, found on disk
 * so a new one cannot be forgotten, answers 404 before it reads a session,
 * the database, its configuration or its body, whatever it is sent.
 */

const touched: string[] = [];
const record = (what: string) => () => {
  touched.push(what);
  throw new Error(`${what} read with the integration off`);
};

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: record("session"),
  createSupabaseAdminClient: record("admin client"),
}));
vi.mock("@/lib/integrations/qdit-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/integrations/qdit-client")>()),
  qditServerSetup: record("qdit setup"),
}));
vi.mock("@/lib/workspace-docs", () => ({ loadMemberDocument: record("note") }));

const HERE = fileURLToPath(new URL(".", import.meta.url));
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
const ID = "40000000-0000-4000-8000-000000000002";

function routeFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? routeFiles(join(dir, entry.name)) : entry.name === "route.ts" ? [join(dir, entry.name)] : [],
  );
}

/** Bodies a client could send: none, malformed, missing fields, and a valid-looking one. */
const BODIES: (string | undefined)[] = [undefined, "not json", "{}", JSON.stringify({ nodeId: "h0", projectId: ID })];

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_QDIT_INTEGRATION", "");
  vi.stubEnv("QDIT_WEBHOOK_SECRET", "set, but the flag is off");
  touched.length = 0;
});

describe("every qdit route with the integration off", () => {
  const files = routeFiles(HERE);

  it("finds the routes", () => {
    expect(files.length).toBeGreaterThanOrEqual(11);
  });

  it.each(files.map((f) => [relative(HERE, f), f]))("%s is 404 for any body, reading nothing", async (_name, file) => {
    const mod = (await import(file)) as Partial<Record<(typeof METHODS)[number], (...args: unknown[]) => Promise<Response>>>;
    const handlers = METHODS.filter((m) => typeof mod[m] === "function");
    expect(handlers.length).toBeGreaterThan(0);
    const context = { params: Promise.resolve({ id: ID, docId: ID }) };
    for (const method of handlers) {
      for (const body of BODIES) {
        const request = new NextRequest(`http://localhost/api/integrations/qdit/x?forget=1&code=c&state=s`, {
          method,
          headers: body === undefined ? {} : { "Content-Type": "application/json" },
          body: method === "GET" ? undefined : body,
        });
        const res = await mod[method]!(request, context);
        expect(res.status, `${method} with ${body ?? "no body"}`).toBe(404);
      }
    }
    expect(touched).toEqual([]);
  });
});

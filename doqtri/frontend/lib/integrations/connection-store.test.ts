import { randomBytes } from "crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { supabaseConnectionStore } from "./connection-store";

const ANA = "11111111-1111-4111-8111-111111111111";
const BEN = "22222222-2222-4222-8222-222222222222";
const key = randomBytes(32);
const tokens = { accessToken: "at-secret", refreshToken: "rt-secret", expiresAt: 1_800_000_000_000, scopes: ["openid"] };

type Row = Record<string, unknown>;

/**
 * Just enough of supabase-js's query builder for the store: one table, eq
 * filters, maybeSingle, insert, and update ... select.
 */
function fakeAdmin(rows: Row[]) {
  const from = () => {
    const filters: [string, unknown][] = [];
    let update: Row | null = null;
    const matches = (r: Row) => filters.every(([k, v]) => r[k] === v);
    const builder = {
      select: () => builder,
      eq: (k: string, v: unknown) => {
        filters.push([k, v]);
        return builder;
      },
      update: (values: Row) => {
        update = values;
        return builder;
      },
      insert: async (row: Row) => {
        if (rows.some((r) => r.user_id === row.user_id && r.provider === row.provider)) {
          return { error: { code: "23505", message: "duplicate" } };
        }
        rows.push({ generation: 1, ...row });
        return { error: null };
      },
      maybeSingle: async () => ({ data: rows.find(matches) ?? null, error: null }),
      then: (resolve: (r: unknown) => unknown) => {
        const hit = rows.filter(matches);
        for (const r of hit) Object.assign(r, JSON.parse(JSON.stringify(update)));
        return resolve({ data: hit.map((r) => ({ generation: r.generation })), error: null });
      },
    };
    return builder;
  };
  return { from } as unknown as SupabaseClient;
}

describe("supabaseConnectionStore", () => {
  it("stores ciphertext only, and reads the tokens back", async () => {
    const rows: Row[] = [];
    const store = supabaseConnectionStore(fakeAdmin(rows), key);
    await store.saveConnected(ANA, { subject: "qdit-ana", accountLabel: "ana" }, tokens);

    expect(JSON.stringify(rows)).not.toContain("at-secret");
    expect(JSON.stringify(rows)).not.toContain("rt-secret");
    expect(rows[0]).toMatchObject({ user_id: ANA, provider: "qdit", subject: "qdit-ana", status: "connected" });

    expect(await store.load(ANA)).toMatchObject({
      subject: "qdit-ana",
      accountLabel: "ana",
      status: "connected",
      generation: 1,
      accessToken: "at-secret",
      refreshToken: "rt-secret",
      expiresAt: tokens.expiresAt,
    });
  });

  it("does not decrypt a token copied into another user's row", async () => {
    const rows: Row[] = [];
    const store = supabaseConnectionStore(fakeAdmin(rows), key);
    await store.saveConnected(ANA, { subject: "qdit-ana", accountLabel: null }, tokens);
    rows.push({ ...rows[0], user_id: BEN });
    expect(await store.load(BEN)).toMatchObject({ accessToken: null, refreshToken: null });
  });

  it("writes a refresh only under the generation it read", async () => {
    const rows: Row[] = [];
    const store = supabaseConnectionStore(fakeAdmin(rows), key);
    await store.saveConnected(ANA, { subject: "qdit-ana", accountLabel: null }, tokens);

    expect(await store.saveRefreshed(ANA, 1, { ...tokens, accessToken: "at2", refreshToken: null })).toBe(true);
    const after = await store.load(ANA);
    expect(after).toMatchObject({ generation: 2, accessToken: "at2", refreshToken: "rt-secret" });

    expect(await store.saveRefreshed(ANA, 1, { ...tokens, accessToken: "late" })).toBe(false);
    expect((await store.load(ANA))?.accessToken).toBe("at2");
  });

  it("drops the tokens when the connection needs a reconnect, and reconnecting replaces it", async () => {
    const rows: Row[] = [];
    const store = supabaseConnectionStore(fakeAdmin(rows), key);
    await store.saveConnected(ANA, { subject: "qdit-ana", accountLabel: null }, tokens);
    expect(await store.markStatus(ANA, 1, "needs_reconnect")).toBe(true);
    expect(rows[0]).toMatchObject({ status: "needs_reconnect", access_token_ciphertext: null, refresh_token_ciphertext: null });

    await store.saveConnected(ANA, { subject: "qdit-ana", accountLabel: "ana" }, { ...tokens, accessToken: "at3" });
    expect(await store.load(ANA)).toMatchObject({ status: "connected", generation: 3, accessToken: "at3" });
  });

  it("reads tokens sealed under the previous key, and a refresh reseals them under the current one (D-67)", async () => {
    const rows: Row[] = [];
    const previous = randomBytes(32);
    await supabaseConnectionStore(fakeAdmin(rows), previous).saveConnected(ANA, { subject: "qdit-ana", accountLabel: null }, tokens);
    const sealedBefore = rows[0].refresh_token_ciphertext;

    // The key rotated: INTEGRATION_TOKEN_KEY is new, the old one is INTEGRATION_TOKEN_KEY_PREVIOUS.
    const store = supabaseConnectionStore(fakeAdmin(rows), { current: key, previous });
    const conn = await store.load(ANA);
    expect(conn).toMatchObject({ accessToken: "at-secret", refreshToken: "rt-secret" });

    // qdit did not rotate the refresh token; the client hands the old one back.
    expect(await store.saveRefreshed(ANA, conn!.generation, { ...tokens, accessToken: "at2" })).toBe(true);
    expect(rows[0].refresh_token_ciphertext).not.toBe(sealedBefore);
    // Readable with the current key alone: the previous key can now go.
    expect(await supabaseConnectionStore(fakeAdmin(rows), key).load(ANA)).toMatchObject({
      accessToken: "at2",
      refreshToken: "rt-secret",
    });
  });

  it("reads a row sealed under a key that is neither current nor previous as tokenless", async () => {
    const rows: Row[] = [];
    await supabaseConnectionStore(fakeAdmin(rows), randomBytes(32)).saveConnected(ANA, { subject: "qdit-ana", accountLabel: null }, tokens);
    const store = supabaseConnectionStore(fakeAdmin(rows), { current: key, previous: randomBytes(32) });
    expect(await store.load(ANA)).toMatchObject({ status: "connected", accessToken: null, refreshToken: null });
  });
});

import type { SupabaseClient } from "@supabase/supabase-js";
import { asKeyRing, encryptSecret, openSecret, type TokenKeyRing } from "@/lib/integrations/token-crypto";
import type { TokenSet } from "@/lib/integrations/qdit-oauth";

/**
 * Reads and writes `integration_connections` (WP-2.3; server-only).
 *
 * Tokens are encrypted on the way in and decrypted on the way out, each bound
 * to its user and its column (see token-crypto.ts), so the database and
 * everything above this file deal in plaintext only inside the server.
 * Writes always use the current key; reads also try the previous one while
 * a key rotation is under way (D-67), so a refresh moves a token onto the
 * current key.
 *
 * Every token write names the `generation` it read and bumps it; a write
 * whose generation is no longer current changes nothing and reports false.
 * That is how refreshes on two server instances at once settle: the one that
 * lands second sees false and re-reads the tokens the first one stored.
 *
 * The store is handed the service-role client: the table is closed to every
 * client role. Callers pass only a user id taken from the verified session.
 */

export type ConnectionStatus = "connected" | "needs_reconnect" | "revoked";

export type StoredConnection = {
  userId: string;
  subject: string;
  accountLabel: string | null;
  scopes: string[];
  status: ConnectionStatus;
  generation: number;
  /** Epoch ms, or null if unknown. */
  expiresAt: number | null;
  /** Null when not connected, or when the stored value no longer decrypts under either key (key changed). */
  accessToken: string | null;
  refreshToken: string | null;
};

export type ConnectedAccount = { subject: string; accountLabel: string | null };

/** account_label's limit in the database (20261025100000_integration_connections.sql). */
export const ACCOUNT_LABEL_MAX = 200;

/**
 * A label that fits account_label: trimmed, cut to ACCOUNT_LABEL_MAX
 * characters (code points, as Postgres counts them), or null when empty.
 * qdit limits usernames but not display names, and a label too long for
 * the column would make the connect fail with the wrong reason (WP-2.3).
 */
export function fitAccountLabel(label: string | null | undefined): string | null {
  const trimmed = label?.trim() ?? "";
  if (!trimmed) return null;
  const chars = Array.from(trimmed);
  return chars.length <= ACCOUNT_LABEL_MAX ? trimmed : chars.slice(0, ACCOUNT_LABEL_MAX).join("").trimEnd();
}

export interface ConnectionStore {
  load(userId: string): Promise<StoredConnection | null>;
  /**
   * After a successful callback: stores the tokens and marks the row
   * connected. `replaced` is the qdit account the row belonged to before,
   * when this connect landed on another one (D-66), else null.
   */
  saveConnected(userId: string, account: ConnectedAccount, tokens: TokenSet): Promise<{ replaced: ConnectedAccount | null }>;
  /** After a refresh; false if another write got there first. */
  saveRefreshed(userId: string, generation: number, tokens: TokenSet): Promise<boolean>;
  /** Drops the tokens; false if another write got there first. */
  markStatus(userId: string, generation: number, status: Exclude<ConnectionStatus, "connected">): Promise<boolean>;
}

const PROVIDER = "qdit";
const TABLE = "integration_connections";

type Row = {
  user_id: string;
  subject: string;
  account_label: string | null;
  scopes: string[] | null;
  status: ConnectionStatus;
  generation: number | string;
  expires_at: string | null;
  access_token_ciphertext: string | null;
  refresh_token_ciphertext: string | null;
};

const accessContext = (userId: string) => `${PROVIDER}:access:${userId}`;
const refreshContext = (userId: string) => `${PROVIDER}:refresh:${userId}`;

function iso(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString();
}

export function supabaseConnectionStore(admin: SupabaseClient, keys: Buffer | TokenKeyRing): ConnectionStore {
  const ring = asKeyRing(keys);
  const tokenKey = ring.current;
  function tokenColumns(userId: string, tokens: TokenSet) {
    return {
      access_token_ciphertext: encryptSecret(tokens.accessToken, tokenKey, accessContext(userId)),
      refresh_token_ciphertext: tokens.refreshToken
        ? encryptSecret(tokens.refreshToken, tokenKey, refreshContext(userId))
        : null,
      expires_at: iso(tokens.expiresAt),
      scopes: tokens.scopes,
    };
  }

  async function casUpdate(userId: string, generation: number, values: Record<string, unknown>): Promise<boolean> {
    const { data, error } = await admin
      .from(TABLE)
      .update({ ...values, generation: generation + 1 })
      .eq("user_id", userId)
      .eq("provider", PROVIDER)
      .eq("generation", generation)
      .select("generation");
    if (error) throw new Error(`integration_connections update failed: ${error.message}`);
    return (data ?? []).length === 1;
  }

  const store: ConnectionStore = {
    async load(userId) {
      const { data, error } = await admin
        .from(TABLE)
        .select(
          "user_id, subject, account_label, scopes, status, generation, expires_at, access_token_ciphertext, refresh_token_ciphertext",
        )
        .eq("user_id", userId)
        .eq("provider", PROVIDER)
        .maybeSingle<Row>();
      if (error) throw new Error(`integration_connections read failed: ${error.message}`);
      if (!data) return null;
      return {
        userId: data.user_id,
        subject: data.subject,
        accountLabel: data.account_label,
        scopes: data.scopes ?? [],
        status: data.status,
        generation: Number(data.generation),
        expiresAt: data.expires_at ? Date.parse(data.expires_at) : null,
        accessToken: openSecret(data.access_token_ciphertext, ring, accessContext(userId))?.plaintext ?? null,
        refreshToken: openSecret(data.refresh_token_ciphertext, ring, refreshContext(userId))?.plaintext ?? null,
      };
    },

    async saveConnected(userId, account, tokens) {
      const values = {
        ...tokenColumns(userId, tokens),
        subject: account.subject,
        account_label: fitAccountLabel(account.accountLabel),
        status: "connected" as const,
        connected_at: new Date().toISOString(),
        refreshed_at: null,
      };
      // Two tries: a refresh or a second callback may land between the read
      // and the write, and the newest consent wins either way.
      for (let attempt = 0; attempt < 2; attempt++) {
        const existing = await store.load(userId);
        if (!existing) {
          const { error } = await admin.from(TABLE).insert({ user_id: userId, provider: PROVIDER, ...values });
          if (!error) return { replaced: null };
          if (error.code !== "23505") throw new Error(`integration_connections insert failed: ${error.message}`);
          continue;
        }
        // Reconnecting as another qdit account is allowed (D-66); the row
        // remembers which one it replaced, for the profile to say so.
        const replaced =
          existing.subject !== account.subject
            ? { subject: existing.subject, accountLabel: existing.accountLabel }
            : null;
        const previous = {
          previous_subject: replaced?.subject ?? null,
          previous_account_label: fitAccountLabel(replaced?.accountLabel),
        };
        if (await casUpdate(userId, existing.generation, { ...values, ...previous })) return { replaced };
      }
      throw new Error("integration_connections changed while connecting; try again");
    },

    saveRefreshed(userId, generation, tokens) {
      const { refresh_token_ciphertext, ...columns } = tokenColumns(userId, tokens);
      return casUpdate(userId, generation, {
        ...columns,
        // qdit may not rotate the refresh token; then keep the one that still works.
        ...(refresh_token_ciphertext ? { refresh_token_ciphertext } : {}),
        status: "connected",
        refreshed_at: new Date().toISOString(),
      });
    },

    markStatus(userId, generation, status) {
      return casUpdate(userId, generation, {
        status,
        access_token_ciphertext: null,
        refresh_token_ciphertext: null,
        expires_at: null,
      });
    },
  };
  return store;
}

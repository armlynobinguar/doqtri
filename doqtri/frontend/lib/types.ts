import type { DocMindmap } from "@/lib/mindmap-types";

/** A row of public.documents. */
export type DocumentRow = {
  id: string;
  user_id: string;
  title: string;
  markdown: string;
  updated_at: string;
  mindmap: DocMindmap | null;
  mindmap_hash: string | null;
};

/**
 * An import that did not produce a note. `pending` rows only show up once
 * they are old enough that the request must have died without reporting.
 */
export type FailedImport = {
  id: string;
  filename: string;
  error_code: string | null;
};

/**
 * Who owns the vault. Wallet accounts sign in with a Stellar wallet; email
 * accounts sign in with a password and have no wallet until passkey wallets
 * land (progress/002).
 */
export type VaultIdentity =
  | { kind: "wallet"; address: string }
  | {
      kind: "email";
      email: string;
      /** The user's passkey wallet on this network, with the passkey to sign as. */
      smartWallet: { address: string; credentialId: string } | null;
    };

/** What the explorer, tabs, and quick switcher need to list a note. */
export type NoteSummary = {
  id: string;
  title: string;
  updated_at: string;
};

/**
 * The graph input shape. The vault graph still derives entirely from
 * `markdown` — the two mindmap fields are for the mindmap views only.
 *
 * `mindmap` is null when extraction has not run or failed; `mindmapStale` says
 * the stored map was built from different markdown than the note now holds.
 * Staleness is decided on the server, since hashing lives there.
 */
export type Doc = {
  id: string;
  title: string;
  markdown: string;
  mindmap?: DocMindmap | null;
  mindmapStale?: boolean;
};

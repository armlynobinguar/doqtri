import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { loadNoteSigner, noteSigningRefusal, type NoteSigner } from "@/lib/stellar/note-signing";
import { authorizeRegistryWrite, type RegistryAccess, type RegistryWrite } from "@/lib/stellar/relay-validation";
import type { WorkspaceRole } from "@/lib/workspace-roles";

const ROLES: (WorkspaceRole | null)[] = [null, "viewer", "editor", "admin", "owner"];
const workspaceId = "7a000000-0000-4000-8000-0000000000e1";
const docId = "3f1c2a9e-0000-4000-8000-0000000000e1";
const me = "u-me";

/** Every signer the matrix covers: each role, in a personal or team workspace, as the note's author or not. */
const signers: NoteSigner[] = ROLES.flatMap((role) =>
  [true, false].flatMap((personal) => [true, false].map((isAuthor) => ({ role, personal, isAuthor }))),
);

/**
 * The calls the app sends for a note: the `*_as` calls for a team note once
 * REGISTRY_EDITORS is on, else the owner-only ones (writeMode in
 * contract-client.ts).
 */
function appWrites(personal: boolean, editors: boolean): RegistryWrite[] {
  return editors && !personal
    ? [
        { fn: "anchor_as", docId },
        { fn: "update_document_as", docId },
        { fn: "set_node_status_as", docId },
      ]
    : [
        { fn: "register_document", docId },
        { fn: "anchor", docId },
        { fn: "update_document", docId },
        { fn: "set_node_status", docId },
      ];
}

function accessFor(signer: NoteSigner): RegistryAccess {
  return {
    documentWorkspace: async () => ({ workspaceId, personal: signer.personal, creatorId: signer.isAuthor ? me : "u-other" }),
    workspace: async () => ({ personal: signer.personal }),
    memberRole: async () => signer.role,
    addressRole: async () => null,
  };
}

describe("noteSigningRefusal (what the panel shows)", () => {
  it("agrees with the relay for every role, workspace kind, authorship and registry", async () => {
    for (const editors of [true, false]) {
      for (const signer of signers) {
        const allowed = noteSigningRefusal(signer, editors) === null;
        for (const write of appWrites(signer.personal, editors)) {
          const relay = authorizeRegistryWrite(write, me, accessFor(signer), editors);
          if (allowed) await expect(relay, JSON.stringify({ signer, editors, write })).resolves.toBeUndefined();
          else await expect(relay, JSON.stringify({ signer, editors, write })).rejects.toThrow();
        }
      }
    }
  });

  it("hides anchoring from a team note's other editors and admins while REGISTRY_EDITORS is off (D-43)", () => {
    for (const role of ["editor", "admin"] as const) {
      expect(noteSigningRefusal({ role, personal: false, isAuthor: false }, false)).toBe("author-or-owner-only");
      expect(noteSigningRefusal({ role, personal: false, isAuthor: false }, true)).toBeNull();
      expect(noteSigningRefusal({ role, personal: false, isAuthor: true }, false)).toBeNull();
    }
    expect(noteSigningRefusal({ role: "owner", personal: false, isAuthor: false }, false)).toBeNull();
  });

  it("lets only the owner sign in a personal workspace, whoever wrote the note and whatever the flag (D-44)", () => {
    for (const editors of [true, false]) {
      for (const isAuthor of [true, false]) {
        expect(noteSigningRefusal({ role: "owner", personal: true, isAuthor }, editors)).toBeNull();
        for (const role of ["editor", "admin"] as const) {
          expect(noteSigningRefusal({ role, personal: true, isAuthor }, editors)).toBe("personal-owner-only");
        }
      }
    }
  });

  it("never lets a viewer or a non-member sign (D-14)", () => {
    for (const editors of [true, false]) {
      for (const personal of [true, false]) {
        expect(noteSigningRefusal({ role: "viewer", personal, isAuthor: true }, editors)).toBe("viewer");
        expect(noteSigningRefusal({ role: null, personal, isAuthor: true }, editors)).toBe("not-member");
      }
    }
  });
});

type Rows = Record<string, Record<string, unknown>[]>;

function stubClient(rows: Rows, o: { user?: string | null; failing?: string } = {}): SupabaseClient {
  return {
    auth: { getUser: async () => ({ data: { user: o.user === null ? null : { id: o.user ?? me } }, error: null }) },
    from(table: string) {
      const filters: Record<string, unknown> = {};
      const builder = {
        select: () => builder,
        eq(column: string, value: unknown) {
          filters[column] = value;
          return builder;
        },
        async maybeSingle() {
          if (table === o.failing) return { data: null, error: { message: "boom" } };
          const match = (rows[table] ?? []).filter((row) => Object.entries(filters).every(([k, v]) => row[k] === v));
          return { data: match[0] ?? null, error: null };
        },
      };
      return builder;
    },
  } as unknown as SupabaseClient;
}

describe("loadNoteSigner", () => {
  const rows: Rows = {
    documents: [{ id: docId, user_id: "u-author", workspace_id: workspaceId, workspaces: { is_personal: false } }],
    workspace_members: [
      { workspace_id: workspaceId, user_id: me, role: "editor" },
      { workspace_id: workspaceId, user_id: "u-author", role: "editor" },
    ],
  };

  it("reads the user's role, the workspace kind and whether they wrote the note", async () => {
    await expect(loadNoteSigner(stubClient(rows), docId)).resolves.toEqual({ role: "editor", personal: false, isAuthor: false });
    await expect(loadNoteSigner(stubClient(rows, { user: "u-author" }), docId)).resolves.toEqual({
      role: "editor",
      personal: false,
      isAuthor: true,
    });
    const personal = { ...rows, documents: [{ ...rows.documents[0], workspaces: [{ is_personal: true }] }] };
    await expect(loadNoteSigner(stubClient(personal), docId)).resolves.toMatchObject({ personal: true });
  });

  it("reports a non-member as having no role", async () => {
    await expect(loadNoteSigner(stubClient(rows, { user: "u-outsider" }), docId)).resolves.toEqual({
      role: null,
      personal: false,
      isAuthor: false,
    });
  });

  it("returns null when it can't tell, so the relay decides", async () => {
    await expect(loadNoteSigner(stubClient(rows, { user: null }), docId)).resolves.toBeNull();
    await expect(loadNoteSigner(stubClient(rows), "3f1c2a9e-0000-4000-8000-0000000000ff")).resolves.toBeNull();
    await expect(loadNoteSigner(stubClient(rows, { failing: "documents" }), docId)).resolves.toBeNull();
    await expect(loadNoteSigner(stubClient(rows, { failing: "workspace_members" }), docId)).resolves.toBeNull();
  });
});

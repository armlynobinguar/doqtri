/**
 * Auto-generated from doqtri_registry.wasm via `stellar contract bindings typescript`.
 * Regenerate: stellar contract build --package doqtri-registry, then
 * stellar contract bindings typescript --wasm target/wasm32v1-none/release/doqtri_registry.wasm --output-dir <tmp> --overwrite
 * and refresh this file: the spec entries verbatim, the types and the method
 * declarations trimmed to what the app calls.
 *
 * Registry v3 (WP-1.3): workspaces, members, the revoker and the `*_as`
 * writes, on top of v2's anchor, upgrade and admin imports. The calls only
 * the contract admin can make (upgrade, import_*, set_revoker,
 * admin_reassign_owner) stay in the spec but are left out of the client on
 * purpose. The functions v3 adds exist only once the deployed registry is
 * upgraded; the app calls them only with NEXT_PUBLIC_REGISTRY_EDITORS=1.
 */
import { Buffer } from "buffer";
import {
  AssembledTransaction,
  Client as ContractClient,
  ClientOptions as ContractClientOptions,
  MethodOptions,
  Result,
  Spec as ContractSpec,
} from "@stellar/stellar-sdk/contract";
import type { Option, u32, u64 } from "@stellar/stellar-sdk/contract";

export const Errors = {
  1: { message: "DocumentAlreadyExists" },
  2: { message: "DocumentNotFound" },
  3: { message: "NodeNotFound" },
  4: { message: "TooManyNodes" },
  5: { message: "NotOwner" },
  6: { message: "WorkspaceAlreadyExists" },
  7: { message: "WorkspaceNotFound" },
  8: { message: "NotWorkspaceOwner" },
  9: { message: "NotWorkspaceAdmin" },
  10: { message: "NotEditor" },
  11: { message: "TargetIsOwner" },
  12: { message: "TargetIsAdmin" },
  13: { message: "TooManyMembers" },
};

export type DataKey =
  | { tag: "Doc"; values: readonly [string] }
  | { tag: "Node"; values: readonly [string, string] }
  | { tag: "Admin"; values: void }
  | { tag: "Workspace"; values: readonly [string] }
  | { tag: "Revoker"; values: void }
  | { tag: "DocWorkspace"; values: readonly [string] };

/**
 * An anchored document. For one in a workspace, `owner` is the workspace's
 * current owner (D-28).
 */
export interface Document {
  content_hash: Buffer;
  node_count: u32;
  owner: string;
  updated_at: u64;
  version: u32;
}

export interface NodeRecord {
  artifact_ref: string;
  status: ContractNodeStatus;
  tool: string;
  updated_at: u64;
}

/** One node's new status, for `anchor`'s batch of node updates. */
export interface NodeUpdate {
  artifact_ref: string;
  node_id: string;
  status: ContractNodeStatus;
  tool: string;
}

/** Most node updates one `anchor` call takes (MAX_NODES_PER_CALL in the contract). */
export const MAX_NODES_PER_CALL = 32;

/** Most members (admins and editors; the owner aside) one workspace holds (MAX_MEMBERS). */
export const MAX_MEMBERS = 100;

export type ContractNodeStatus =
  | { tag: "Planned"; values: void }
  | { tag: "Building"; values: void }
  | { tag: "Built"; values: void }
  | { tag: "Verified"; values: void };

/** A workspace member's role; the owner holds no role (D-15). */
export type Role = { tag: "Editor"; values: void } | { tag: "Admin"; values: void };

/** A workspace: its owner, creation time and every member with a role. */
export interface Workspace {
  created_at: u64;
  members: Map<string, Role>;
  owner: string;
}

type Tx<T> = Promise<AssembledTransaction<T>>;

export class Client extends ContractClient {
  declare anchor: (
    args: { owner: string; doc_id: string; content_hash: Buffer; nodes: NodeUpdate[] },
    options?: MethodOptions,
  ) => Tx<Result<u32>>;
  declare admin: (options?: MethodOptions) => Tx<string>;
  declare get_node: (args: { doc_id: string; node_id: string }, options?: MethodOptions) => Tx<Result<NodeRecord>>;
  declare get_document: (args: { doc_id: string }, options?: MethodOptions) => Tx<Result<Document>>;
  declare set_node_status: (
    args: {
      doc_id: string;
      node_id: string;
      status: ContractNodeStatus;
      tool: string;
      artifact_ref: string;
    },
    options?: MethodOptions,
  ) => Tx<Result<void>>;
  declare update_document: (args: { doc_id: string; new_hash: Buffer }, options?: MethodOptions) => Tx<Result<u32>>;
  declare register_document: (
    args: { owner: string; doc_id: string; content_hash: Buffer },
    options?: MethodOptions,
  ) => Tx<Result<u32>>;

  // ---- v3: workspace writes, signed by the named member ----
  declare anchor_as: (
    args: { signer: string; doc_id: string; content_hash: Buffer; nodes: NodeUpdate[] },
    options?: MethodOptions,
  ) => Tx<Result<u32>>;
  declare update_document_as: (
    args: { signer: string; doc_id: string; new_hash: Buffer },
    options?: MethodOptions,
  ) => Tx<Result<u32>>;
  declare set_node_status_as: (
    args: {
      signer: string;
      doc_id: string;
      node_id: string;
      status: ContractNodeStatus;
      tool: string;
      artifact_ref: string;
    },
    options?: MethodOptions,
  ) => Tx<Result<void>>;
  declare assign_document: (args: { doc_id: string; workspace_id: string }, options?: MethodOptions) => Tx<Result<void>>;
  declare unassign_document: (args: { doc_id: string }, options?: MethodOptions) => Tx<Result<boolean>>;

  // ---- v3: workspaces and members ----
  declare create_workspace: (args: { workspace_id: string; owner: string }, options?: MethodOptions) => Tx<Result<void>>;
  declare add_admin: (
    args: { workspace_id: string; owner: string; admin: string },
    options?: MethodOptions,
  ) => Tx<Result<void>>;
  declare remove_admin: (
    args: { workspace_id: string; caller: string; admin: string },
    options?: MethodOptions,
  ) => Tx<Result<boolean>>;
  declare add_editor: (
    args: { workspace_id: string; admin: string; editor: string },
    options?: MethodOptions,
  ) => Tx<Result<void>>;
  declare remove_editor: (
    args: { workspace_id: string; caller: string; editor: string },
    options?: MethodOptions,
  ) => Tx<Result<boolean>>;
  declare transfer_workspace: (
    args: { workspace_id: string; owner: string; new_owner: string },
    options?: MethodOptions,
  ) => Tx<Result<void>>;

  // ---- v3: reads ----
  declare get_workspace: (args: { workspace_id: string }, options?: MethodOptions) => Tx<Result<Workspace>>;
  declare get_members: (args: { workspace_id: string }, options?: MethodOptions) => Tx<Result<Map<string, Role>>>;
  declare get_role: (args: { workspace_id: string; who: string }, options?: MethodOptions) => Tx<Option<Role>>;
  declare get_revoker: (options?: MethodOptions) => Tx<Option<string>>;
  declare get_doc_workspace: (args: { doc_id: string }, options?: MethodOptions) => Tx<Option<string>>;
  declare is_editor: (args: { workspace_id: string; who: string }, options?: MethodOptions) => Tx<boolean>;

  constructor(public readonly options: ContractClientOptions) {
    super(
      new ContractSpec([
        "AAAAAAAAAG5UaGUgYWRkcmVzcyB0aGF0IG1heSB1cGdyYWRlIHRoZSBjb250cmFjdCwgaW1wb3J0IGRvY3VtZW50cywgc2V0IHRoZQpyZXZva2VyIGFuZCByZWFzc2lnbiBhIHdvcmtzcGFjZSdzIG93bmVyLgAAAAAABWFkbWluAAAAAAAAAAAAAAEAAAAT",
        "AAAAAAAAATlFdmVyeXRoaW5nIGEgZmluaXNoZWQgZWRpdCBuZWVkcywgaW4gb25lIGNhbGwgYW5kIHNvIG9uZSBzaWduYXR1cmU6CnJlZ2lzdGVycyB0aGUgZG9jdW1lbnQgaWYgaXQgaXMgbmV3LCBhbmNob3JzIGBjb250ZW50X2hhc2hgIGFzIGEgbmV3CnZlcnNpb24gaWYgaXQgY2hhbmdlZCAoYW4gdW5jaGFuZ2VkIGhhc2gga2VlcHMgdGhlIHZlcnNpb24pLCB0aGVuCndyaXRlcyBldmVyeSBub2RlIHVwZGF0ZS4gYG93bmVyYCBtdXN0IGJlIHRoZSBkb2N1bWVudCdzIG93bmVyLgpSZXR1cm5zIHRoZSBkb2N1bWVudCdzIHZlcnNpb24gYWZ0ZXIgdGhlIGNhbGwuAAAAAAAABmFuY2hvcgAAAAAABAAAAAAAAAAFb3duZXIAAAAAAAATAAAAAAAAAAZkb2NfaWQAAAAAABAAAAAAAAAADGNvbnRlbnRfaGFzaAAAA+4AAAAgAAAAAAAAAAVub2RlcwAAAAAAA+oAAAfQAAAACk5vZGVVcGRhdGUAAAAAAAEAAAPpAAAABAAAAAM=",
        "AAAAAgAAAG5BIHdvcmtzcGFjZSBtZW1iZXIncyByb2xlLiBCb3RoIG1heSB3cml0ZSB0aGUgd29ya3NwYWNlJ3MgZG9jdW1lbnRzOwphbiBhZG1pbiBtYXkgYWxzbyBhZGQgYW5kIHJlbW92ZSBlZGl0b3JzLgAAAAAAAAAAAARSb2xlAAAAAgAAAAAAAAAAAAAABkVkaXRvcgAAAAAAAAAAAAAAAAAFQWRtaW4AAAA=",
        "AAAAAAAAAG9SZXBsYWNlcyB0aGlzIGNvbnRyYWN0J3MgY29kZSB3aXRoIGFuIHVwbG9hZGVkIFdBU00sIGtlZXBpbmcgaXRzCmFkZHJlc3MgYW5kIGV2ZXJ5IHN0b3JlZCBkb2N1bWVudC4gQWRtaW4gb25seS4AAAAAB3VwZ3JhZGUAAAAAAQAAAAAAAAANbmV3X3dhc21faGFzaAAAAAAAA+4AAAAgAAAAAA==",
        "AAAABAAAAAAAAAAAAAAABUVycm9yAAAAAAAADQAAAAAAAAAVRG9jdW1lbnRBbHJlYWR5RXhpc3RzAAAAAAAAAQAAAAAAAAAQRG9jdW1lbnROb3RGb3VuZAAAAAIAAAAAAAAADE5vZGVOb3RGb3VuZAAAAAMAAAA/YGFuY2hvcmAgd2FzIGdpdmVuIG1vcmUgdGhhbiBgTUFYX05PREVTX1BFUl9DQUxMYCBub2RlIHVwZGF0ZXMuAAAAAAxUb29NYW55Tm9kZXMAAAAEAAAAOGBhbmNob3JgIG5hbWVkIGFuIG93bmVyIG90aGVyIHRoYW4gdGhlIGRvY3VtZW50J3Mgb3duZXIuAAAACE5vdE93bmVyAAAABQAAADlgY3JlYXRlX3dvcmtzcGFjZWAgd2FzIGdpdmVuIGFuIGlkIHRoYXQgaXMgYWxyZWFkeSB0YWtlbi4AAAAAAAAWV29ya3NwYWNlQWxyZWFkeUV4aXN0cwAAAAAABgAAAAAAAAARV29ya3NwYWNlTm90Rm91bmQAAAAAAAAHAAAAeVRoZSBjYWxsIG5lZWRzIHRoZSB3b3Jrc3BhY2UncyBvd25lciAoYGFkZF9hZG1pbmAsCmB0cmFuc2Zlcl93b3Jrc3BhY2VgKSwgb3IgZm9yIGByZW1vdmVfYWRtaW5gIHRoZSBvd25lciBvciB0aGUgcmV2b2tlci4AAAAAAAARTm90V29ya3NwYWNlT3duZXIAAAAAAAAIAAAAZlRoZSBjYWxsIG5lZWRzIGEgd29ya3NwYWNlIGFkbWluIG9yIGl0cyBvd25lciAoYGFkZF9lZGl0b3JgKSwgb3IgZm9yCmByZW1vdmVfZWRpdG9yYCBhbHNvIHRoZSByZXZva2VyLgAAAAAAEU5vdFdvcmtzcGFjZUFkbWluAAAAAAAACQAAAMZBbiBgKl9hc2Agc2lnbmVyIGlzIG5laXRoZXIgdGhlIGRvY3VtZW50J3Mgb3duZXIgbm9yIGEgbWVtYmVyIG9mIHRoZQp3b3Jrc3BhY2UgdGhlIGRvY3VtZW50IGlzIGFzc2lnbmVkIHRvOyBgYXNzaWduX2RvY3VtZW50YCB3YXMgYXNrZWQgdG8KcHV0IGEgZG9jdW1lbnQgaW4gYSB3b3Jrc3BhY2UgaXRzIG93bmVyIGlzIG5vdCBhIG1lbWJlciBvZi4AAAAAAAlOb3RFZGl0b3IAAAAAAAAKAAAAa1RoZSB3b3Jrc3BhY2Ugb3duZXIncyByaWdodHMgY29tZSBmcm9tIHRoZSB3b3Jrc3BhY2UgaXRzZWxmIGFuZCBjYW4ndApiZSBhZGRlZCBvciByZW1vdmVkIGFzIGEgbWVtYmVyIHJvbGUuAAAAAA1UYXJnZXRJc093bmVyAAAAAAAACwAAAF9gcmVtb3ZlX2VkaXRvcmAgbmV2ZXIgcmVtb3ZlcyBhbiBhZG1pbjsgdGhlIG93bmVyIG9yIHRoZSByZXZva2VyCmRvZXMgdGhhdCB3aXRoIGByZW1vdmVfYWRtaW5gLgAAAAANVGFyZ2V0SXNBZG1pbgAAAAAAAAwAAAAwVGhlIHdvcmtzcGFjZSBhbHJlYWR5IGhhcyBgTUFYX01FTUJFUlNgIG1lbWJlcnMuAAAADlRvb01hbnlNZW1iZXJzAAAAAAAN",
        "AAAAAAAAACNGZXRjaCBhIG5vZGUncyBidWlsZC1zdGF0dXMgcmVjb3JkLgAAAAAIZ2V0X25vZGUAAAACAAAAAAAAAAZkb2NfaWQAAAAAABAAAAAAAAAAB25vZGVfaWQAAAAAEAAAAAEAAAPpAAAH0AAAAApOb2RlUmVjb3JkAAAAAAAD",
        "AAAAAAAAAGdgd2hvYCdzIG1lbWJlciByb2xlIGluIHRoZSB3b3Jrc3BhY2U7IG5vbmUgZm9yIHRoZSBvd25lciwgZm9yCm5vbi1tZW1iZXJzIGFuZCBmb3IgYW4gdW5rbm93biB3b3Jrc3BhY2UuAAAAAAhnZXRfcm9sZQAAAAIAAAAAAAAADHdvcmtzcGFjZV9pZAAAABAAAAAAAAAAA3dobwAAAAATAAAAAQAAA+gAAAfQAAAABFJvbGU=",
        "AAAAAAAAAEJNYWtlcyBgYWRtaW5gIGEgd29ya3NwYWNlIGFkbWluIChwcm9tb3RpbmcgYW4gZWRpdG9yKS4gT3duZXIgb25seS4AAAAAAAlhZGRfYWRtaW4AAAAAAAADAAAAAAAAAAx3b3Jrc3BhY2VfaWQAAAAQAAAAAAAAAAVvd25lcgAAAAAAABMAAAAAAAAABWFkbWluAAAAAAAAEwAAAAEAAAPpAAAD7QAAAAAAAAAD",
        "AAAAAAAAANxgYW5jaG9yYCBmb3IgYW55IHdyaXRlciBvZiB0aGUgZG9jdW1lbnQuIEEgbmV3IGRvY3VtZW50IGlzIHJlZ2lzdGVyZWQKd2l0aCBgc2lnbmVyYCBhcyBpdHMgb3duZXIsIGFzIGBhbmNob3JgIGRvZXM7IGBhc3NpZ25fZG9jdW1lbnRgIHRoZW4KcHV0cyBpdCBpbiBhIHdvcmtzcGFjZSBhbmQgaGFuZHMgaXQgdG8gdGhlIHdvcmtzcGFjZSdzIG93bmVyLgpgc2lnbmVyYCBtdXN0IHNpZ24uAAAACWFuY2hvcl9hcwAAAAAAAAQAAAAAAAAABnNpZ25lcgAAAAAAEwAAAAAAAAAGZG9jX2lkAAAAAAAQAAAAAAAAAAxjb250ZW50X2hhc2gAAAPuAAAAIAAAAAAAAAAFbm9kZXMAAAAAAAPqAAAH0AAAAApOb2RlVXBkYXRlAAAAAAABAAAD6QAAAAQAAAAD",
        "AAAAAAAAAHZUcnVlIHdoZW4gYHdob2AgbWF5IHdyaXRlIHRoZSB3b3Jrc3BhY2UncyBkb2N1bWVudHM6IGl0cyBvd25lciwgYW4KYWRtaW4gb3IgYW4gZWRpdG9yLiBGYWxzZSBmb3IgYW4gdW5rbm93biB3b3Jrc3BhY2UuAAAAAAAJaXNfZWRpdG9yAAAAAAAAAgAAAAAAAAAMd29ya3NwYWNlX2lkAAAAEAAAAAAAAAADd2hvAAAAABMAAAABAAAAAQ==",
        "AAAAAgAAAAAAAAAAAAAAB0RhdGFLZXkAAAAABgAAAAEAAAAAAAAAA0RvYwAAAAABAAAAEAAAAAEAAAAAAAAABE5vZGUAAAACAAAAEAAAABAAAAAAAAAAdFdobyBtYXkgYHVwZ3JhZGVgIHRoZSBjb250cmFjdCwgYGltcG9ydF8qYCBkb2N1bWVudHMsIHNldCB0aGUgcmV2b2tlcgphbmQgYGFkbWluX3JlYXNzaWduX293bmVyYCAoaW5zdGFuY2Ugc3RvcmFnZSkuAAAABUFkbWluAAAAAAAAAQAAAC53b3Jrc3BhY2VfaWQgLT4gYFdvcmtzcGFjZWAsIG1lbWJlcnMgaW5jbHVkZWQuAAAAAAAJV29ya3NwYWNlAAAAAAAAAQAAABAAAAAAAAAAjFRoZSBhcHAncyByZXZva2Utb25seSBzZXJ2ZXIga2V5IChpbnN0YW5jZSBzdG9yYWdlLCBjb250cmFjdC13aWRlKToKaXQgbWF5IG9ubHkgcmVtb3ZlIG1lbWJlcnMsIGluIGFueSB3b3Jrc3BhY2UuIFNldCBieSB0aGUgY29udHJhY3QgYWRtaW4uAAAAB1Jldm9rZXIAAAAAAQAAADxkb2NfaWQgLT4gd29ya3NwYWNlX2lkIHdob3NlIG1lbWJlcnMgbWF5IHdyaXRlIHRoZSBkb2N1bWVudC4AAAAMRG9jV29ya3NwYWNlAAAAAQAAABA=",
        "AAAAAAAAAIZNYWtlcyBgZWRpdG9yYCBhIHdvcmtzcGFjZSBlZGl0b3IuIGBhZG1pbmAgbXVzdCBiZSBhIHdvcmtzcGFjZSBhZG1pbgpvciB0aGUgb3duZXIuIEFuIGFkZHJlc3MgdGhhdCBpcyBhbHJlYWR5IGEgbWVtYmVyIGtlZXBzIGl0cyByb2xlLgAAAAAACmFkZF9lZGl0b3IAAAAAAAMAAAAAAAAADHdvcmtzcGFjZV9pZAAAABAAAAAAAAAABWFkbWluAAAAAAAAEwAAAAAAAAAGZWRpdG9yAAAAAAATAAAAAQAAA+kAAAPtAAAAAAAAAAM=",
        "AAAAAQAAAEhBbiBhbmNob3JlZCBkb2N1bWVudDogd2hvIG93bnMgaXQsIGl0cyBsYXRlc3QgY29udGVudCBoYXNoLCBhbmQgdmVyc2lvbi4AAAAAAAAACERvY3VtZW50AAAABQAAAAAAAAAMY29udGVudF9oYXNoAAAD7gAAACAAAAAAAAAACm5vZGVfY291bnQAAAAAAAQAAAAAAAAABW93bmVyAAAAAAAAEwAAAAAAAAAKdXBkYXRlZF9hdAAAAAAABgAAAAAAAAAHdmVyc2lvbgAAAAAE",
        "AAAAAAAAAG9FdmVyeSBtZW1iZXIgb2YgdGhlIHdvcmtzcGFjZSBhbmQgdGhlaXIgcm9sZSwgdGhlIG93bmVyIGFzaWRlOiB0aGUKbGlzdCB0byByZWNvbmNpbGUgdGhlIGFwcCdzIG1lbWJlcnMgYWdhaW5zdC4AAAAAC2dldF9tZW1iZXJzAAAAAAEAAAAAAAAADHdvcmtzcGFjZV9pZAAAABAAAAABAAAD6QAAA+wAAAATAAAH0AAAAARSb2xlAAAAAw==",
        "AAAAAAAAAClUaGUgY29udHJhY3Qtd2lkZSByZXZva2VyLCBpZiBvbmUgaXMgc2V0LgAAAAAAAAtnZXRfcmV2b2tlcgAAAAAAAAAAAQAAA+gAAAAT",
        "AAAAAAAAAJBDb3BpZXMgb25lIG5vZGUgcmVjb3JkIG9mIGFuIGltcG9ydGVkIGRvY3VtZW50LiBBZG1pbiBvbmx5LiBUaGUKZG9jdW1lbnQncyBgbm9kZV9jb3VudGAgY29tZXMgZnJvbSBgaW1wb3J0X2RvY3VtZW50YCwgc28gaXQgaXMgbm90CmNoYW5nZWQgaGVyZS4AAAALaW1wb3J0X25vZGUAAAAAAwAAAAAAAAAGZG9jX2lkAAAAAAAQAAAAAAAAAAdub2RlX2lkAAAAABAAAAAAAAAABnJlY29yZAAAAAAH0AAAAApOb2RlUmVjb3JkAAAAAAABAAAD6QAAA+0AAAAAAAAAAw==",
        "AAAAAAAAAMlTZXRzIChvciByZXBsYWNlcykgdGhlIGNvbnRyYWN0LXdpZGUgcmV2b2tlcjogdGhlIGFwcCdzIHNlcnZlciBrZXksCndoaWNoIG1heSByZW1vdmUgZWRpdG9ycyBhbmQgYWRtaW5zIGZyb20gYW55IHdvcmtzcGFjZSwgYW5kIG5vdGhpbmcKZWxzZS4gQ29udHJhY3QgYWRtaW4gb25seSwgc28gbm8gd29ya3NwYWNlIGFkbWluIGNhbiBzd2FwIGl0IG91dC4AAAAAAAALc2V0X3Jldm9rZXIAAAAAAQAAAAAAAAAHcmV2b2tlcgAAAAATAAAAAA==",
        "AAAAAQAAAYxBIHNoYXJlZCBzcGFjZSB3aG9zZSBtZW1iZXJzIG1heSB3cml0ZSBpdHMgZG9jdW1lbnRzLiBJdHMgb3duZXIgaG9sZHMKZXZlcnkgcmlnaHQgaW4gaXQgYW5kIG93bnMgZXZlcnkgZG9jdW1lbnQgaW4gaXQgKEQtMjgpOyBvd25lcnNoaXAgbW92ZXMKb25seSBieSBgdHJhbnNmZXJfd29ya3NwYWNlYCBvciB0aGUgY29udHJhY3QgYWRtaW4ncwpgYWRtaW5fcmVhc3NpZ25fb3duZXJgLgpgbWVtYmVyc2AgaXMgdGhlIG9uLWNoYWluIG1lbWJlciBsaXN0IChELTE1KTogZXZlcnkgYWRkcmVzcyB3aXRoIGEgcm9sZSwKdGhlIG93bmVyIGFzaWRlLCBhdCBtb3N0IGBNQVhfTUVNQkVSU2Agb2YgdGhlbSwgc28gaXQgY2FuIGJlIHJlYWQgd2hvbGUKdG8gYXVkaXQgd2hvIGhvbGRzIHdyaXRlIGFjY2Vzcy4AAAAAAAAACVdvcmtzcGFjZQAAAAAAAAMAAAAAAAAACmNyZWF0ZWRfYXQAAAAAAAYAAAAAAAAAB21lbWJlcnMAAAAD7AAAABMAAAfQAAAABFJvbGUAAAAAAAAABW93bmVyAAAAAAAAEw==",
        "AAAAAAAAAK9GZXRjaCBhIGRvY3VtZW50J3MgYW5jaG9yZWQgc3RhdGUuIEZvciBhIGRvY3VtZW50IGluIGEgd29ya3NwYWNlLApgb3duZXJgIGlzIHRoZSB3b3Jrc3BhY2UncyBjdXJyZW50IG93bmVyIChELTI4KSwgZXZlbiBiZWZvcmUgdGhlCnN0b3JlZCByZWNvcmQgaGFzIGNhdWdodCB1cCB3aXRoIGEgdHJhbnNmZXIuAAAAAAxnZXRfZG9jdW1lbnQAAAABAAAAAAAAAAZkb2NfaWQAAAAAABAAAAABAAAD6QAAB9AAAAAIRG9jdW1lbnQAAAAD",
        "AAAAAAAAAPJSZW1vdmVzIGBhZG1pbmAgZnJvbSB0aGUgd29ya3NwYWNlIGFsdG9nZXRoZXIgKHRvIGtlZXAgdGhlbSBhcyBhbgplZGl0b3IsIGBhZGRfZWRpdG9yYCB0aGVtIGFmdGVyKS4gYGNhbGxlcmAgbXVzdCBiZSB0aGUgb3duZXIgb3IgdGhlCnJldm9rZXIuIFJldHVybnMgZmFsc2UsIGNoYW5naW5nIG5vdGhpbmcsIHdoZW4gYGFkbWluYCBpcyBub3QgYW4KYWRtaW4sIHNvIGEgcmV0cmllZCByZW1vdmFsIHN0aWxsIHN1Y2NlZWRzLgAAAAAADHJlbW92ZV9hZG1pbgAAAAMAAAAAAAAADHdvcmtzcGFjZV9pZAAAABAAAAAAAAAABmNhbGxlcgAAAAAAEwAAAAAAAAAFYWRtaW4AAAAAAAATAAAAAQAAA+kAAAABAAAAAw==",
        "AAAAAQAAAC5CdWlsZC1zdGF0dXMgcmVjb3JkIGZvciBhIHNpbmdsZSBtaW5kbWFwIG5vZGUuAAAAAAAAAAAACk5vZGVSZWNvcmQAAAAAAAQAAAAAAAAADGFydGlmYWN0X3JlZgAAABAAAAAAAAAABnN0YXR1cwAAAAAH0AAAAApOb2RlU3RhdHVzAAAAAAAAAAAABHRvb2wAAAAQAAAAAAAAAAp1cGRhdGVkX2F0AAAAAAAG",
        "AAAAAgAAAD5MaWZlY3ljbGUgb2YgYSBtaW5kbWFwIG5vZGUsIGZyb20gcGxhbiB0byB2ZXJpZmllZCBkZXBsb3ltZW50LgAAAAAAAAAAAApOb2RlU3RhdHVzAAAAAAAEAAAAAAAAAAAAAAAHUGxhbm5lZAAAAAAAAAAAAAAAAAhCdWlsZGluZwAAAAAAAAAAAAAABUJ1aWx0AAAAAAAAAAAAAAAAAAAIVmVyaWZpZWQ=",
        "AAAAAQAAADxPbmUgbm9kZSdzIG5ldyBzdGF0dXMsIGZvciBgYW5jaG9yYCdzIGJhdGNoIG9mIG5vZGUgdXBkYXRlcy4AAAAAAAAACk5vZGVVcGRhdGUAAAAAAAQAAAAAAAAADGFydGlmYWN0X3JlZgAAABAAAAAAAAAAB25vZGVfaWQAAAAAEAAAAAAAAAAGc3RhdHVzAAAAAAfQAAAACk5vZGVTdGF0dXMAAAAAAAAAAAAEdG9vbAAAABA=",
        "AAAAAAAAAC9BIHdvcmtzcGFjZSdzIG93bmVyLCBjcmVhdGlvbiB0aW1lIGFuZCBtZW1iZXJzLgAAAAANZ2V0X3dvcmtzcGFjZQAAAAAAAAEAAAAAAAAADHdvcmtzcGFjZV9pZAAAABAAAAABAAAD6QAAB9AAAAAJV29ya3NwYWNlAAAAAAAAAw==",
        "AAAAAAAAAO1SZW1vdmVzIGBlZGl0b3JgIGZyb20gdGhlIHdvcmtzcGFjZS4gYGNhbGxlcmAgbXVzdCBiZSBhIHdvcmtzcGFjZQphZG1pbiwgdGhlIG93bmVyLCBvciB0aGUgcmV2b2tlci4gTmV2ZXIgcmVtb3ZlcyBhbiBhZG1pbiBvciB0aGUKb3duZXIuIFJldHVybnMgZmFsc2UsIGNoYW5naW5nIG5vdGhpbmcsIHdoZW4gYGVkaXRvcmAgaXMgbm90IGEKbWVtYmVyLCBzbyBhIHJldHJpZWQgcmVtb3ZhbCBzdGlsbCBzdWNjZWVkcy4AAAAAAAANcmVtb3ZlX2VkaXRvcgAAAAAAAAMAAAAAAAAADHdvcmtzcGFjZV9pZAAAABAAAAAAAAAABmNhbGxlcgAAAAAAEwAAAAAAAAAGZWRpdG9yAAAAAAATAAAAAQAAA+kAAAABAAAAAw==",
        "AAAAAAAAAKxTZXRzIHRoZSBhZG1pbiwgd2hvIGFsb25lIG1heSBgdXBncmFkZWAgdGhlIGNvbnRyYWN0LCBgaW1wb3J0XypgCmRvY3VtZW50cyBmcm9tIGFuIGVhcmxpZXIgcmVnaXN0cnksIHNldCB0aGUgcmV2b2tlciBhbmQgcmVhc3NpZ24gYQp3b3Jrc3BhY2UncyBvd25lci4gUnVucyBvbmNlLCBhdCBkZXBsb3kuAAAADV9fY29uc3RydWN0b3IAAAAAAAABAAAAAAAAAAVhZG1pbgAAAAAAABMAAAAA",
        "AAAAAAAAAgZQdXRzIGEgZG9jdW1lbnQgaW4gYSB3b3Jrc3BhY2UsIHNvIHRoZSB3b3Jrc3BhY2UncyBtZW1iZXJzIG1heSB3cml0ZQppdCB0aHJvdWdoIHRoZSBgKl9hc2AgY2FsbHM7IGEgZG9jdW1lbnQgYWxyZWFkeSBpbiBvbmUgbW92ZXMuIFRoZQpkb2N1bWVudCdzIG93bmVyIHNpZ25zIGFuZCBtdXN0IGJlIGEgbWVtYmVyIChvciB0aGUgb3duZXIpIG9mIHRoZQp3b3Jrc3BhY2UuIFRoZSB3b3Jrc3BhY2UncyBvd25lciBiZWNvbWVzIHRoZSBkb2N1bWVudCdzIG93bmVyOiBpdHMKYXV0aG9yIHRoZW4gd3JpdGVzIGl0IGFzIGEgbWVtYmVyLCBzbyByZW1vdmluZyB0aGVtIGZyb20gdGhlCndvcmtzcGFjZSByZW1vdmVzIHRoZWlyIHdyaXRlIGFjY2VzcyB0byBpdCB0b28sIGFuZCBpdCBjYW4gbGVhdmUgdGhlCndvcmtzcGFjZSBvbmx5IHdpdGggaXRzIG93bmVyJ3Mgc2lnbmF0dXJlLiBBIGRvY3VtZW50IGFscmVhZHkgaW4gYQp3b3Jrc3BhY2UgaXMgbW92ZWQgYnkgdGhhdCB3b3Jrc3BhY2UncyBjdXJyZW50IG93bmVyLgAAAAAAD2Fzc2lnbl9kb2N1bWVudAAAAAACAAAAAAAAAAZkb2NfaWQAAAAAABAAAAAAAAAADHdvcmtzcGFjZV9pZAAAABAAAAABAAAD6QAAA+0AAAAAAAAAAw==",
        "AAAAAAAAAMRDb3BpZXMgYSBkb2N1bWVudCBmcm9tIGFuIGVhcmxpZXIgcmVnaXN0cnksIGFzIGl0IHN0YW5kcyB0aGVyZSwgc28gaXQKa2VlcHMgaXRzIG93bmVyLCBoYXNoLCB2ZXJzaW9uIGFuZCBoaXN0b3J5LiBBZG1pbiBvbmx5LCBmb3IgYSBvbmUtdGltZQptaWdyYXRpb247IHJlZnVzZXMgYSBkb2N1bWVudCB0aGF0IGFscmVhZHkgZXhpc3RzIGhlcmUuAAAAD2ltcG9ydF9kb2N1bWVudAAAAAACAAAAAAAAAAZkb2NfaWQAAAAAABAAAAAAAAAAA2RvYwAAAAfQAAAACERvY3VtZW50AAAAAQAAA+kAAAPtAAAAAAAAAAM=",
        "AAAAAAAAAOxSZWNvcmQgb3IgdXBkYXRlIHRoZSBidWlsZCBzdGF0dXMgb2YgYSBtaW5kbWFwIG5vZGUuCmB0b29sYCBpcyB0aGUgYnVpbGRlciB1c2VkIChlLmcuICJuOG4iKTsgYGFydGlmYWN0X3JlZmAgcG9pbnRzIHRvIHRoZQpidWlsdCBhcnRpZmFjdCAod29ya2Zsb3cgSUQsIFVSTCwgb3IgaGFzaCkuIE93bmVyLW9ubHkgKGZvciBhCndvcmtzcGFjZSBkb2N1bWVudCwgdGhlIHdvcmtzcGFjZSdzIGN1cnJlbnQgb3duZXIpLgAAAA9zZXRfbm9kZV9zdGF0dXMAAAAABQAAAAAAAAAGZG9jX2lkAAAAAAAQAAAAAAAAAAdub2RlX2lkAAAAABAAAAAAAAAABnN0YXR1cwAAAAAH0AAAAApOb2RlU3RhdHVzAAAAAAAAAAAABHRvb2wAAAAQAAAAAAAAAAxhcnRpZmFjdF9yZWYAAAAQAAAAAQAAA+kAAAPtAAAAAAAAAAM=",
        "AAAAAAAAAMBBbmNob3IgYSBuZXcgY29udGVudCBoYXNoIGFmdGVyIGEgc2VtYW50aWMgY2hhbmdlIGluIHRoZSBzb3VyY2UgZG9jLgpPbmx5IHRoZSBkb2N1bWVudCBvd25lciBtYXkgY2FsbCAoZm9yIGEgd29ya3NwYWNlIGRvY3VtZW50LCB0aGUKd29ya3NwYWNlJ3MgY3VycmVudCBvd25lcikuIFJldHVybnMgdGhlIG5ldyB2ZXJzaW9uIG51bWJlci4AAAAPdXBkYXRlX2RvY3VtZW50AAAAAAIAAAAAAAAABmRvY19pZAAAAAAAEAAAAAAAAAAIbmV3X2hhc2gAAAPuAAAAIAAAAAEAAAPpAAAABAAAAAM=",
        "AAAAAAAAALdDcmVhdGVzIGEgd29ya3NwYWNlIG93bmVkIGJ5IGBvd25lcmAsIHdpdGggbm8gbWVtYmVycy4gRmFpbHMgaWYgdGhlCmlkIGlzIHRha2VuLiBJZHMgYXJlIGZpcnN0IGNvbWUsIGZpcnN0IHNlcnZlZDogdGhlIGFwcCByZWFkcwpgZ2V0X3dvcmtzcGFjZWAgYWZ0ZXIgY3JlYXRpbmcgb25lIHRvIGNoZWNrIGl0IGdvdCBpdC4AAAAAEGNyZWF0ZV93b3Jrc3BhY2UAAAACAAAAAAAAAAx3b3Jrc3BhY2VfaWQAAAAQAAAAAAAAAAVvd25lcgAAAAAAABMAAAABAAAD6QAAA+0AAAAAAAAAAw==",
        "AAAAAAAAADBUaGUgd29ya3NwYWNlIGEgZG9jdW1lbnQgaXMgYXNzaWduZWQgdG8sIGlmIGFueS4AAAARZ2V0X2RvY193b3Jrc3BhY2UAAAAAAAABAAAAAAAAAAZkb2NfaWQAAAAAABAAAAABAAAD6AAAABA=",
        "AAAAAAAAAGdBbmNob3IgYSBuZXcgZG9jdW1lbnQuIEZhaWxzIGlmIGBkb2NfaWRgIGlzIGFscmVhZHkgcmVnaXN0ZXJlZC4KUmV0dXJucyB0aGUgaW5pdGlhbCB2ZXJzaW9uIChhbHdheXMgMSkuAAAAABFyZWdpc3Rlcl9kb2N1bWVudAAAAAAAAAMAAAAAAAAABW93bmVyAAAAAAAAEwAAAAAAAAAGZG9jX2lkAAAAAAAQAAAAAAAAAAxjb250ZW50X2hhc2gAAAPuAAAAIAAAAAEAAAPpAAAABAAAAAM=",
        "AAAAAAAAATdUYWtlcyBhIGRvY3VtZW50IG91dCBvZiBpdHMgd29ya3NwYWNlOyBpdHMgbWVtYmVycyBjYW4gbm8gbG9uZ2VyCndyaXRlIGl0LiBJdCBzdGF5cyB3aXRoIHRoZSB3b3Jrc3BhY2UncyBjdXJyZW50IG93bmVyLCB3aG8gc2lnbnMsIGFuZAppcyBzdG9yZWQgd2l0aCB0aGVtIGFzIGl0cyBvd25lciwgc2luY2Ugd2l0aCBubyB3b3Jrc3BhY2UgbGVmdCB0bwpyZXNvbHZlIGZyb20gdGhlIHN0b3JlZCBvd25lciBpcyB0aGUgb3duZXIgYWdhaW4uIFJldHVybnMgZmFsc2UsCmNoYW5naW5nIG5vdGhpbmcsIHdoZW4gaXQgaXMgaW4gbm8gd29ya3NwYWNlLgAAAAARdW5hc3NpZ25fZG9jdW1lbnQAAAAAAAABAAAAAAAAAAZkb2NfaWQAAAAAABAAAAABAAAD6QAAAAEAAAAD",
        "AAAAAAAAAEVgc2V0X25vZGVfc3RhdHVzYCBmb3IgYW55IHdyaXRlciBvZiB0aGUgZG9jdW1lbnQuIGBzaWduZXJgIG11c3Qgc2lnbi4AAAAAAAASc2V0X25vZGVfc3RhdHVzX2FzAAAAAAAGAAAAAAAAAAZzaWduZXIAAAAAABMAAAAAAAAABmRvY19pZAAAAAAAEAAAAAAAAAAHbm9kZV9pZAAAAAAQAAAAAAAAAAZzdGF0dXMAAAAAB9AAAAAKTm9kZVN0YXR1cwAAAAAAAAAAAAR0b29sAAAAEAAAAAAAAAAMYXJ0aWZhY3RfcmVmAAAAEAAAAAEAAAPpAAAD7QAAAAAAAAAD",
        "AAAAAAAAAfZIYW5kcyB0aGUgd29ya3NwYWNlLCBhbmQgd2l0aCBpdCBldmVyeSBkb2N1bWVudCBhc3NpZ25lZCB0byBpdCwgZnJvbQpgb3duZXJgIHRvIGBuZXdfb3duZXJgIChELTI5KS4gQm90aCBzaWduOiB0aGUgb3V0Z29pbmcgb3duZXIgdG8gZ2l2ZQppdCBhd2F5LCB0aGUgaW5jb21pbmcgb25lIHRvIHByb3ZlIHRoZSBkZXN0aW5hdGlvbiBpcyBhbiBhZGRyZXNzCnNvbWVvbmUgY29udHJvbHMsIHNvIGEgdHlwbyBjYW5ub3Qgc3RyYW5kIHRoZSB3b3Jrc3BhY2UuIGBvd25lcmAgbXVzdApiZSB0aGUgc3RvcmVkIG93bmVyLiBBIG1lbWJlciBiZWNvbWluZyBvd25lciBsZWF2ZXMgdGhlIG1lbWJlciBsaXN0Cih0aGUgb3duZXIgaG9sZHMgbm8gbWVtYmVyIHJvbGUpOyB0aGUgZm9ybWVyIG93bmVyIGtlZXBzIG5vIHJvbGUsIGFuZAp0aGUgbmV3IG93bmVyIG1heSBgYWRkX2FkbWluYCB0aGVtIGJhY2suIFRyYW5zZmVycmluZyB0byB0aGUgY3VycmVudApvd25lciBjaGFuZ2VzIG5vdGhpbmcuAAAAAAASdHJhbnNmZXJfd29ya3NwYWNlAAAAAAADAAAAAAAAAAx3b3Jrc3BhY2VfaWQAAAAQAAAAAAAAAAVvd25lcgAAAAAAABMAAAAAAAAACW5ld19vd25lcgAAAAAAABMAAAABAAAD6QAAA+0AAAAAAAAAAw==",
        "AAAAAAAAAHtgdXBkYXRlX2RvY3VtZW50YCBmb3IgYW55IHdyaXRlciBvZiB0aGUgZG9jdW1lbnQ6IGl0cyBvd25lciwgb3IgdGhlCm93bmVyIG9yIGEgbWVtYmVyIG9mIGl0cyB3b3Jrc3BhY2UuIGBzaWduZXJgIG11c3Qgc2lnbi4AAAAAEnVwZGF0ZV9kb2N1bWVudF9hcwAAAAAAAwAAAAAAAAAGc2lnbmVyAAAAAAATAAAAAAAAAAZkb2NfaWQAAAAAABAAAAAAAAAACG5ld19oYXNoAAAD7gAAACAAAAABAAAD6QAAAAQAAAAD",
        "AAAAAAAAAYJSZWNvdmVyeSAoRC0yOSk6IHRoZSBjb250cmFjdCBhZG1pbiBtYWtlcyBgbmV3X293bmVyYCB0aGUgb3duZXIgb2YgYQp3b3Jrc3BhY2Ugd2hvc2Ugb3duZXIgY2FuIG5vIGxvbmdlciBzaWduLCBlLmcuIGEgbG9zdCBrZXkgb3IgYQpkZWxldGVkIGFjY291bnQgd2hvc2UgbG9uZ2VzdC1zdGFuZGluZyBhZG1pbiB0aGUgYXBwIHByb21vdGVzCihELTMxKS4gQ29udHJhY3QgYWRtaW4gb25seTsgYG5ld19vd25lcmAgZG9lcyBub3Qgc2lnbiwgc28gdGhlCnNlcnZlciBjYW4gY2FycnkgaXQgb3V0LCBhbmQgYSB3cm9uZyBhZGRyZXNzIGlzIGZpeGVkIGJ5IGNhbGxpbmcKYWdhaW4uIE1lbWJlcnMgYW5kIGRvY3VtZW50cyBmb2xsb3cgYXMgZm9yIGB0cmFuc2Zlcl93b3Jrc3BhY2VgLgAAAAAAFGFkbWluX3JlYXNzaWduX293bmVyAAAAAgAAAAAAAAAMd29ya3NwYWNlX2lkAAAAEAAAAAAAAAAJbmV3X293bmVyAAAAAAAAEwAAAAEAAAPpAAAD7QAAAAAAAAAD",
      ]),
      options,
    );
  }
  public readonly fromJSON = {
    anchor: this.txFromJSON<Result<u32>>,
    admin: this.txFromJSON<string>,
    get_node: this.txFromJSON<Result<NodeRecord>>,
    get_document: this.txFromJSON<Result<Document>>,
    set_node_status: this.txFromJSON<Result<void>>,
    update_document: this.txFromJSON<Result<u32>>,
    register_document: this.txFromJSON<Result<u32>>,
    anchor_as: this.txFromJSON<Result<u32>>,
    update_document_as: this.txFromJSON<Result<u32>>,
    set_node_status_as: this.txFromJSON<Result<void>>,
    assign_document: this.txFromJSON<Result<void>>,
    unassign_document: this.txFromJSON<Result<boolean>>,
    create_workspace: this.txFromJSON<Result<void>>,
    add_admin: this.txFromJSON<Result<void>>,
    remove_admin: this.txFromJSON<Result<boolean>>,
    add_editor: this.txFromJSON<Result<void>>,
    remove_editor: this.txFromJSON<Result<boolean>>,
    transfer_workspace: this.txFromJSON<Result<void>>,
    get_workspace: this.txFromJSON<Result<Workspace>>,
    get_members: this.txFromJSON<Result<Map<string, Role>>>,
    get_role: this.txFromJSON<Option<Role>>,
    get_revoker: this.txFromJSON<Option<string>>,
    get_doc_workspace: this.txFromJSON<Option<string>>,
    is_editor: this.txFromJSON<boolean>,
  };
}

export { Buffer };

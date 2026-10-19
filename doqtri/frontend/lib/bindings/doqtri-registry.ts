/**
 * Auto-generated from doqtri_registry.wasm via `stellar contract bindings typescript`.
 * Regenerate: stellar contract bindings typescript --wasm target/wasm32v1-none/release/doqtri_registry.wasm --output-dir <tmp> --overwrite
 * then refresh this file. Registry v2 (anchor, upgrade, admin imports); the
 * admin-only calls are left out of the client on purpose.
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
import type { u32, u64 } from "@stellar/stellar-sdk/contract";

export const Errors = {
  1: { message: "DocumentAlreadyExists" },
  2: { message: "DocumentNotFound" },
  3: { message: "NodeNotFound" },
  4: { message: "TooManyNodes" },
  5: { message: "NotOwner" },
};

export type DataKey =
  | { tag: "Doc"; values: readonly [string] }
  | { tag: "Node"; values: readonly [string, string] }
  | { tag: "Admin"; values: void };

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

export type ContractNodeStatus =
  | { tag: "Planned"; values: void }
  | { tag: "Building"; values: void }
  | { tag: "Built"; values: void }
  | { tag: "Verified"; values: void };

export class Client extends ContractClient {
  declare anchor: (
    args: { owner: string; doc_id: string; content_hash: Buffer; nodes: NodeUpdate[] },
    options?: MethodOptions,
  ) => Promise<AssembledTransaction<Result<u32>>>;
  declare admin: (options?: MethodOptions) => Promise<AssembledTransaction<string>>;
  declare get_node: (
    args: { doc_id: string; node_id: string },
    options?: MethodOptions,
  ) => Promise<AssembledTransaction<Result<NodeRecord>>>;
  declare get_document: (
    args: { doc_id: string },
    options?: MethodOptions,
  ) => Promise<AssembledTransaction<Result<Document>>>;
  declare set_node_status: (
    args: {
      doc_id: string;
      node_id: string;
      status: ContractNodeStatus;
      tool: string;
      artifact_ref: string;
    },
    options?: MethodOptions,
  ) => Promise<AssembledTransaction<Result<void>>>;
  declare update_document: (
    args: { doc_id: string; new_hash: Buffer },
    options?: MethodOptions,
  ) => Promise<AssembledTransaction<Result<u32>>>;
  declare register_document: (
    args: { owner: string; doc_id: string; content_hash: Buffer },
    options?: MethodOptions,
  ) => Promise<AssembledTransaction<Result<u32>>>;
  constructor(public readonly options: ContractClientOptions) {
    super(
      new ContractSpec([
        "AAAAAAAAAD9UaGUgYWRkcmVzcyB0aGF0IG1heSB1cGdyYWRlIHRoZSBjb250cmFjdCBhbmQgaW1wb3J0IGRvY3VtZW50cy4AAAAABWFkbWluAAAAAAAAAAAAAAEAAAAT",
        "AAAAAAAAATlFdmVyeXRoaW5nIGEgZmluaXNoZWQgZWRpdCBuZWVkcywgaW4gb25lIGNhbGwgYW5kIHNvIG9uZSBzaWduYXR1cmU6CnJlZ2lzdGVycyB0aGUgZG9jdW1lbnQgaWYgaXQgaXMgbmV3LCBhbmNob3JzIGBjb250ZW50X2hhc2hgIGFzIGEgbmV3CnZlcnNpb24gaWYgaXQgY2hhbmdlZCAoYW4gdW5jaGFuZ2VkIGhhc2gga2VlcHMgdGhlIHZlcnNpb24pLCB0aGVuCndyaXRlcyBldmVyeSBub2RlIHVwZGF0ZS4gYG93bmVyYCBtdXN0IGJlIHRoZSBkb2N1bWVudCdzIG93bmVyLgpSZXR1cm5zIHRoZSBkb2N1bWVudCdzIHZlcnNpb24gYWZ0ZXIgdGhlIGNhbGwuAAAAAAAABmFuY2hvcgAAAAAABAAAAAAAAAAFb3duZXIAAAAAAAATAAAAAAAAAAZkb2NfaWQAAAAAABAAAAAAAAAADGNvbnRlbnRfaGFzaAAAA+4AAAAgAAAAAAAAAAVub2RlcwAAAAAAA+oAAAfQAAAACk5vZGVVcGRhdGUAAAAAAAEAAAPpAAAABAAAAAM=",
        "AAAAAAAAAG9SZXBsYWNlcyB0aGlzIGNvbnRyYWN0J3MgY29kZSB3aXRoIGFuIHVwbG9hZGVkIFdBU00sIGtlZXBpbmcgaXRzCmFkZHJlc3MgYW5kIGV2ZXJ5IHN0b3JlZCBkb2N1bWVudC4gQWRtaW4gb25seS4AAAAAB3VwZ3JhZGUAAAAAAQAAAAAAAAANbmV3X3dhc21faGFzaAAAAAAAA+4AAAAgAAAAAA==",
        "AAAABAAAAAAAAAAAAAAABUVycm9yAAAAAAAABQAAAAAAAAAVRG9jdW1lbnRBbHJlYWR5RXhpc3RzAAAAAAAAAQAAAAAAAAAQRG9jdW1lbnROb3RGb3VuZAAAAAIAAAAAAAAADE5vZGVOb3RGb3VuZAAAAAMAAAA/YGFuY2hvcmAgd2FzIGdpdmVuIG1vcmUgdGhhbiBgTUFYX05PREVTX1BFUl9DQUxMYCBub2RlIHVwZGF0ZXMuAAAAAAxUb29NYW55Tm9kZXMAAAAEAAAAOGBhbmNob3JgIG5hbWVkIGFuIG93bmVyIG90aGVyIHRoYW4gdGhlIGRvY3VtZW50J3Mgb3duZXIuAAAACE5vdE93bmVyAAAABQ==",
        "AAAAAAAAACNGZXRjaCBhIG5vZGUncyBidWlsZC1zdGF0dXMgcmVjb3JkLgAAAAAIZ2V0X25vZGUAAAACAAAAAAAAAAZkb2NfaWQAAAAAABAAAAAAAAAAB25vZGVfaWQAAAAAEAAAAAEAAAPpAAAH0AAAAApOb2RlUmVjb3JkAAAAAAAD",
        "AAAAAgAAAAAAAAAAAAAAB0RhdGFLZXkAAAAAAwAAAAEAAAAAAAAAA0RvYwAAAAABAAAAEAAAAAEAAAAAAAAABE5vZGUAAAACAAAAEAAAABAAAAAAAAAAS1dobyBtYXkgYHVwZ3JhZGVgIHRoZSBjb250cmFjdCBhbmQgYGltcG9ydF8qYCBkb2N1bWVudHMgKGluc3RhbmNlIHN0b3JhZ2UpLgAAAAAFQWRtaW4AAAA=",
        "AAAAAQAAAEhBbiBhbmNob3JlZCBkb2N1bWVudDogd2hvIG93bnMgaXQsIGl0cyBsYXRlc3QgY29udGVudCBoYXNoLCBhbmQgdmVyc2lvbi4AAAAAAAAACERvY3VtZW50AAAABQAAAAAAAAAMY29udGVudF9oYXNoAAAD7gAAACAAAAAAAAAACm5vZGVfY291bnQAAAAAAAQAAAAAAAAABW93bmVyAAAAAAAAEwAAAAAAAAAKdXBkYXRlZF9hdAAAAAAABgAAAAAAAAAHdmVyc2lvbgAAAAAE",
        "AAAAAAAAAJBDb3BpZXMgb25lIG5vZGUgcmVjb3JkIG9mIGFuIGltcG9ydGVkIGRvY3VtZW50LiBBZG1pbiBvbmx5LiBUaGUKZG9jdW1lbnQncyBgbm9kZV9jb3VudGAgY29tZXMgZnJvbSBgaW1wb3J0X2RvY3VtZW50YCwgc28gaXQgaXMgbm90CmNoYW5nZWQgaGVyZS4AAAALaW1wb3J0X25vZGUAAAAAAwAAAAAAAAAGZG9jX2lkAAAAAAAQAAAAAAAAAAdub2RlX2lkAAAAABAAAAAAAAAABnJlY29yZAAAAAAH0AAAAApOb2RlUmVjb3JkAAAAAAABAAAD6QAAA+0AAAAAAAAAAw==",
        "AAAAAAAAACJGZXRjaCBhIGRvY3VtZW50J3MgYW5jaG9yZWQgc3RhdGUuAAAAAAAMZ2V0X2RvY3VtZW50AAAAAQAAAAAAAAAGZG9jX2lkAAAAAAAQAAAAAQAAA+kAAAfQAAAACERvY3VtZW50AAAAAw==",
        "AAAAAQAAAC5CdWlsZC1zdGF0dXMgcmVjb3JkIGZvciBhIHNpbmdsZSBtaW5kbWFwIG5vZGUuAAAAAAAAAAAACk5vZGVSZWNvcmQAAAAAAAQAAAAAAAAADGFydGlmYWN0X3JlZgAAABAAAAAAAAAABnN0YXR1cwAAAAAH0AAAAApOb2RlU3RhdHVzAAAAAAAAAAAABHRvb2wAAAAQAAAAAAAAAAp1cGRhdGVkX2F0AAAAAAAG",
        "AAAAAgAAAD5MaWZlY3ljbGUgb2YgYSBtaW5kbWFwIG5vZGUsIGZyb20gcGxhbiB0byB2ZXJpZmllZCBkZXBsb3ltZW50LgAAAAAAAAAAAApOb2RlU3RhdHVzAAAAAAAEAAAAAAAAAAAAAAAHUGxhbm5lZAAAAAAAAAAAAAAAAAhCdWlsZGluZwAAAAAAAAAAAAAABUJ1aWx0AAAAAAAAAAAAAAAAAAAIVmVyaWZpZWQ=",
        "AAAAAQAAADxPbmUgbm9kZSdzIG5ldyBzdGF0dXMsIGZvciBgYW5jaG9yYCdzIGJhdGNoIG9mIG5vZGUgdXBkYXRlcy4AAAAAAAAACk5vZGVVcGRhdGUAAAAAAAQAAAAAAAAADGFydGlmYWN0X3JlZgAAABAAAAAAAAAAB25vZGVfaWQAAAAAEAAAAAAAAAAGc3RhdHVzAAAAAAfQAAAACk5vZGVTdGF0dXMAAAAAAAAAAAAEdG9vbAAAABA=",
        "AAAAAAAAAH1TZXRzIHRoZSBhZG1pbiwgd2hvIGFsb25lIG1heSBgdXBncmFkZWAgdGhlIGNvbnRyYWN0IGFuZCBgaW1wb3J0XypgCmRvY3VtZW50cyBmcm9tIGFuIGVhcmxpZXIgcmVnaXN0cnkuIFJ1bnMgb25jZSwgYXQgZGVwbG95LgAAAAAAAA1fX2NvbnN0cnVjdG9yAAAAAAAAAQAAAAAAAAAFYWRtaW4AAAAAAAATAAAAAA==",
        "AAAAAAAAAMRDb3BpZXMgYSBkb2N1bWVudCBmcm9tIGFuIGVhcmxpZXIgcmVnaXN0cnksIGFzIGl0IHN0YW5kcyB0aGVyZSwgc28gaXQKa2VlcHMgaXRzIG93bmVyLCBoYXNoLCB2ZXJzaW9uIGFuZCBoaXN0b3J5LiBBZG1pbiBvbmx5LCBmb3IgYSBvbmUtdGltZQptaWdyYXRpb247IHJlZnVzZXMgYSBkb2N1bWVudCB0aGF0IGFscmVhZHkgZXhpc3RzIGhlcmUuAAAAD2ltcG9ydF9kb2N1bWVudAAAAAACAAAAAAAAAAZkb2NfaWQAAAAAABAAAAAAAAAAA2RvYwAAAAfQAAAACERvY3VtZW50AAAAAQAAA+kAAAPtAAAAAAAAAAM=",
        "AAAAAAAAALJSZWNvcmQgb3IgdXBkYXRlIHRoZSBidWlsZCBzdGF0dXMgb2YgYSBtaW5kbWFwIG5vZGUuCmB0b29sYCBpcyB0aGUgYnVpbGRlciB1c2VkIChlLmcuICJuOG4iKTsgYGFydGlmYWN0X3JlZmAgcG9pbnRzIHRvIHRoZQpidWlsdCBhcnRpZmFjdCAod29ya2Zsb3cgSUQsIFVSTCwgb3IgaGFzaCkuIE93bmVyLW9ubHkuAAAAAAAPc2V0X25vZGVfc3RhdHVzAAAAAAUAAAAAAAAABmRvY19pZAAAAAAAEAAAAAAAAAAHbm9kZV9pZAAAAAAQAAAAAAAAAAZzdGF0dXMAAAAAB9AAAAAKTm9kZVN0YXR1cwAAAAAAAAAAAAR0b29sAAAAEAAAAAAAAAAMYXJ0aWZhY3RfcmVmAAAAEAAAAAEAAAPpAAAD7QAAAAAAAAAD",
        "AAAAAAAAAIZBbmNob3IgYSBuZXcgY29udGVudCBoYXNoIGFmdGVyIGEgc2VtYW50aWMgY2hhbmdlIGluIHRoZSBzb3VyY2UgZG9jLgpPbmx5IHRoZSBkb2N1bWVudCBvd25lciBtYXkgY2FsbC4gUmV0dXJucyB0aGUgbmV3IHZlcnNpb24gbnVtYmVyLgAAAAAAD3VwZGF0ZV9kb2N1bWVudAAAAAACAAAAAAAAAAZkb2NfaWQAAAAAABAAAAAAAAAACG5ld19oYXNoAAAD7gAAACAAAAABAAAD6QAAAAQAAAAD",
        "AAAAAAAAAGdBbmNob3IgYSBuZXcgZG9jdW1lbnQuIEZhaWxzIGlmIGBkb2NfaWRgIGlzIGFscmVhZHkgcmVnaXN0ZXJlZC4KUmV0dXJucyB0aGUgaW5pdGlhbCB2ZXJzaW9uIChhbHdheXMgMSkuAAAAABFyZWdpc3Rlcl9kb2N1bWVudAAAAAAAAAMAAAAAAAAABW93bmVyAAAAAAAAEwAAAAAAAAAGZG9jX2lkAAAAAAAQAAAAAAAAAAxjb250ZW50X2hhc2gAAAPuAAAAIAAAAAEAAAPpAAAABAAAAAM=",
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
  };
}

export { Buffer };

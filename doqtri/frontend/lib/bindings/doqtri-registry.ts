/**
 * Auto-generated from doqtri_registry.wasm via `stellar contract bindings typescript`.
 * Regenerate: stellar contract bindings typescript --wasm <wasm> --output-dir web/src/lib/generated/doqtri-registry --overwrite
 * then refresh this file.
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
};

export type DataKey =
  | { tag: "Doc"; values: readonly [string] }
  | { tag: "Node"; values: readonly [string, string] };

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

export type ContractNodeStatus =
  | { tag: "Planned"; values: void }
  | { tag: "Building"; values: void }
  | { tag: "Built"; values: void }
  | { tag: "Verified"; values: void };

export class Client extends ContractClient {
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
        "AAAABAAAAAAAAAAAAAAABUVycm9yAAAAAAAAAwAAAAAAAAAVRG9jdW1lbnRBbHJlYWR5RXhpc3RzAAAAAAAAAQAAAAAAAAAQRG9jdW1lbnROb3RGb3VuZAAAAAIAAAAAAAAADE5vZGVOb3RGb3VuZAAAAAM=",
        "AAAAAAAAACNGZXRjaCBhIG5vZGUncyBidWlsZC1zdGF0dXMgcmVjb3JkLgAAAAAIZ2V0X25vZGUAAAACAAAAAAAAAAZkb2NfaWQAAAAAABAAAAAAAAAAB25vZGVfaWQAAAAAEAAAAAEAAAPpAAAH0AAAAApOb2RlUmVjb3JkAAAAAAAD",
        "AAAAAgAAAAAAAAAAAAAAB0RhdGFLZXkAAAAAAgAAAAEAAAAAAAAAA0RvYwAAAAABAAAAEAAAAAEAAAAAAAAABE5vZGUAAAACAAAAEAAAABA=",
        "AAAAAQAAAEhBbiBhbmNob3JlZCBkb2N1bWVudDogd2hvIG93bnMgaXQsIGl0cyBsYXRlc3QgY29udGVudCBoYXNoLCBhbmQgdmVyc2lvbi4AAAAAAAAACERvY3VtZW50AAAABQAAAAAAAAAMY29udGVudF9oYXNoAAAD7gAAACAAAAAAAAAACm5vZGVfY291bnQAAAAAAAQAAAAAAAAABW93bmVyAAAAAAAAEwAAAAAAAAAKdXBkYXRlZF9hdAAAAAAABgAAAAAAAAAHdmVyc2lvbgAAAAAE",
        "AAAAAAAAACJGZXRjaCBhIGRvY3VtZW50J3MgYW5jaG9yZWQgc3RhdGUuAAAAAAAMZ2V0X2RvY3VtZW50AAAAAQAAAAAAAAAGZG9jX2lkAAAAAAAQAAAAAQAAA+kAAAfQAAAACERvY3VtZW50AAAAAw==",
        "AAAAAQAAAC5CdWlsZC1zdGF0dXMgcmVjb3JkIGZvciBhIHNpbmdsZSBtaW5kbWFwIG5vZGUuAAAAAAAAAAAACk5vZGVSZWNvcmQAAAAAAAQAAAAAAAAADGFydGlmYWN0X3JlZgAAABAAAAAAAAAABnN0YXR1cwAAAAAH0AAAAApOb2RlU3RhdHVzAAAAAAAAAAAABHRvb2wAAAAQAAAAAAAAAAp1cGRhdGVkX2F0AAAAAAAG",
        "AAAAAgAAAD5MaWZlY3ljbGUgb2YgYSBtaW5kbWFwIG5vZGUsIGZyb20gcGxhbiB0byB2ZXJpZmllZCBkZXBsb3ltZW50LgAAAAAAAAAAAApOb2RlU3RhdHVzAAAAAAAEAAAAAAAAAAAAAAAHUGxhbm5lZAAAAAAAAAAAAAAAAAhCdWlsZGluZwAAAAAAAAAAAAAABUJ1aWx0AAAAAAAAAAAAAAAAAAAIVmVyaWZpZWQ=",
        "AAAAAAAAALJSZWNvcmQgb3IgdXBkYXRlIHRoZSBidWlsZCBzdGF0dXMgb2YgYSBtaW5kbWFwIG5vZGUuCmB0b29sYCBpcyB0aGUgYnVpbGRlciB1c2VkIChlLmcuICJuOG4iKTsgYGFydGlmYWN0X3JlZmAgcG9pbnRzIHRvIHRoZQpidWlsdCBhcnRpZmFjdCAod29ya2Zsb3cgSUQsIFVSTCwgb3IgaGFzaCkuIE93bmVyLW9ubHkuAAAAAAAPc2V0X25vZGVfc3RhdHVzAAAAAAUAAAAAAAAABmRvY19pZAAAAAAAEAAAAAAAAAAHbm9kZV9pZAAAAAAQAAAAAAAAAAZzdGF0dXMAAAAAB9AAAAAKTm9kZVN0YXR1cwAAAAAAAAAAAAR0b29sAAAAEAAAAAAAAAAMYXJ0aWZhY3RfcmVmAAAAEAAAAAEAAAPpAAAD7QAAAAAAAAAD",
        "AAAAAAAAAIZBbmNob3IgYSBuZXcgY29udGVudCBoYXNoIGFmdGVyIGEgc2VtYW50aWMgY2hhbmdlIGluIHRoZSBzb3VyY2UgZG9jLgpPbmx5IHRoZSBkb2N1bWVudCBvd25lciBtYXkgY2FsbC4gUmV0dXJucyB0aGUgbmV3IHZlcnNpb24gbnVtYmVyLgAAAAAAD3VwZGF0ZV9kb2N1bWVudAAAAAACAAAAAAAAAAZkb2NfaWQAAAAAABAAAAAAAAAACG5ld19oYXNoAAAD7gAAACAAAAABAAAD6QAAAAQAAAAD",
        "AAAAAAAAAGdBbmNob3IgYSBuZXcgZG9jdW1lbnQuIEZhaWxzIGlmIGBkb2NfaWRgIGlzIGFscmVhZHkgcmVnaXN0ZXJlZC4KUmV0dXJucyB0aGUgaW5pdGlhbCB2ZXJzaW9uIChhbHdheXMgMSkuAAAAABFyZWdpc3Rlcl9kb2N1bWVudAAAAAAAAAMAAAAAAAAABW93bmVyAAAAAAAAEwAAAAAAAAAGZG9jX2lkAAAAAAAQAAAAAAAAAAxjb250ZW50X2hhc2gAAAPuAAAAIAAAAAEAAAPpAAAABAAAAAM=",
      ]),
      options,
    );
  }
  public readonly fromJSON = {
    get_node: this.txFromJSON<Result<NodeRecord>>,
    get_document: this.txFromJSON<Result<Document>>,
    set_node_status: this.txFromJSON<Result<void>>,
    update_document: this.txFromJSON<Result<u32>>,
    register_document: this.txFromJSON<Result<u32>>,
  };
}

export { Buffer };

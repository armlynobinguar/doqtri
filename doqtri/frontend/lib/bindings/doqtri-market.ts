/**
 * Auto-generated from doqtri_market.wasm via `stellar contract bindings typescript`.
 * Regenerate: stellar contract bindings typescript --wasm target/wasm32v1-none/release/doqtri_market.wasm --output-dir <tmp> --overwrite
 * then refresh this file (same shape as doqtri-registry.ts).
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
import type { i128, Option, u32, u64 } from "@stellar/stellar-sdk/contract";

export const Errors = {
  1: { message: "TemplateExists" },
  2: { message: "TemplateNotFound" },
  3: { message: "ParentNotFound" },
  4: { message: "NotListed" },
  5: { message: "AlreadyPurchased" },
  6: { message: "SelfPurchase" },
  7: { message: "PriceTooHigh" },
  8: { message: "InvalidPrice" },
  9: { message: "InvalidFees" },
  10: { message: "Paused" },
  11: { message: "TokenNotAllowed" },
  12: { message: "InvalidAmount" },
};

export interface Config {
  admin: string;
  creator_bps: u32;
  parent_bps: u32;
  paused: boolean;
  treasury: string;
  treasury_bps: u32;
}

export interface Template {
  content_hash: Buffer;
  created_at: u64;
  creator: string;
  earned: i128;
  listed: boolean;
  parent: Option<string>;
  parent_creator: Option<string>;
  price: i128;
  sales: u32;
  tips: i128;
  token: string;
  updated_at: u64;
}

export class Client extends ContractClient {
  declare buy: (
    args: { buyer: string; template_id: string; max_price: i128 },
    options?: MethodOptions,
  ) => Promise<AssembledTransaction<Result<void>>>;
  declare tip: (
    args: { from: string; template_id: string; amount: i128 },
    options?: MethodOptions,
  ) => Promise<AssembledTransaction<Result<void>>>;
  declare get_config: (options?: MethodOptions) => Promise<AssembledTransaction<Config>>;
  declare set_listed: (
    args: { template_id: string; listed: boolean },
    options?: MethodOptions,
  ) => Promise<AssembledTransaction<Result<void>>>;
  declare get_template: (
    args: { template_id: string },
    options?: MethodOptions,
  ) => Promise<AssembledTransaction<Result<Template>>>;
  declare update_price: (
    args: { template_id: string; price: i128 },
    options?: MethodOptions,
  ) => Promise<AssembledTransaction<Result<void>>>;
  declare has_purchased: (
    args: { template_id: string; buyer: string },
    options?: MethodOptions,
  ) => Promise<AssembledTransaction<boolean>>;
  declare list_template: (
    args: {
      creator: string;
      template_id: string;
      content_hash: Buffer;
      token: string;
      price: i128;
      parent: Option<string>;
    },
    options?: MethodOptions,
  ) => Promise<AssembledTransaction<Result<void>>>;
  declare is_token_allowed: (
    args: { token: string },
    options?: MethodOptions,
  ) => Promise<AssembledTransaction<boolean>>;
  constructor(public readonly options: ContractClientOptions) {
    super(
      new ContractSpec([
        "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",
        "AAAAAQAAAExBIGxpc3RlZCB0ZW1wbGF0ZS4gYGNvbnRlbnRfaGFzaGAgYW5kIGBjcmVhdGVkX2F0YCBhcmUgdGhlIGF1dGhvcnNoaXAgcHJvb2YuAAAAAAAAAAhUZW1wbGF0ZQAAAAwAAAAAAAAADGNvbnRlbnRfaGFzaAAAA+4AAAAgAAAAAAAAAApjcmVhdGVkX2F0AAAAAAAGAAAAAAAAAAdjcmVhdG9yAAAAABMAAAA1VG90YWwgcGFpZCB0byB0aGUgY3JlYXRvciBmcm9tIHNhbGVzICh0aXBzIGV4Y2x1ZGVkKS4AAAAAAAAGZWFybmVkAAAAAAALAAAAAAAAAAZsaXN0ZWQAAAAAAAEAAAAkUGFyZW50IHRlbXBsYXRlIGlkLCBmb3IgZGVyaXZhdGl2ZXMuAAAABnBhcmVudAAAAAAD6AAAABAAAABEUGFyZW50J3MgY3JlYXRvciwgY29waWVkIGF0IGxpc3Rpbmcgc28gYGJ1eWAgbmV2ZXIgcmVhZHMgdGhlIHBhcmVudC4AAAAOcGFyZW50X2NyZWF0b3IAAAAAA+gAAAATAAAAJ0luIHRoZSB0b2tlbidzIHNtYWxsZXN0IHVuaXQuIDAgPSBmcmVlLgAAAAAFcHJpY2UAAAAAAAALAAAAAAAAAAVzYWxlcwAAAAAAAAQAAAAAAAAABHRpcHMAAAALAAAAPlN0ZWxsYXIgQXNzZXQgQ29udHJhY3QgdGhlIHByaWNlIGlzIHBhaWQgaW4uIEZpeGVkIGF0IGxpc3RpbmcuAAAAAAAFdG9rZW4AAAAAAAATAAAAAAAAAAp1cGRhdGVkX2F0AAAAAAAG",
        "AAAAAAAAAAAAAAAMZ2V0X3RlbXBsYXRlAAAAAQAAAAAAAAALdGVtcGxhdGVfaWQAAAAAEAAAAAEAAAPpAAAH0AAAAAhUZW1wbGF0ZQAAAAM=",
        "AAAAAAAAAAAAAAAMc2V0X3RyZWFzdXJ5AAAAAQAAAAAAAAAIdHJlYXN1cnkAAAATAAAAAA==",
        "AAAAAAAAAC9DaGFuZ2UgdGhlIHByaWNlIG9mIGZ1dHVyZSBzYWxlcy4gQ3JlYXRvciBvbmx5LgAAAAAMdXBkYXRlX3ByaWNlAAAAAgAAAAAAAAALdGVtcGxhdGVfaWQAAAAAEAAAAAAAAAAFcHJpY2UAAAAAAAALAAAAAQAAA+kAAAPtAAAAAAAAAAM=",
        "AAAAAAAAAAAAAAANaGFzX3B1cmNoYXNlZAAAAAAAAAIAAAAAAAAAC3RlbXBsYXRlX2lkAAAAABAAAAAAAAAABWJ1eWVyAAAAAAAAEwAAAAEAAAAB",
        "AAAAAAAAAHhMaXN0IGEgbmV3IHRlbXBsYXRlLiBgcGFyZW50YCBtdXN0IGJlIGFuIGV4aXN0aW5nIHRlbXBsYXRlIGlkOyBpdHMKY3JlYXRvciBlYXJucyBgcGFyZW50X2Jwc2Agb2YgZXZlcnkgc2FsZSBvZiB0aGlzIG9uZS4AAAANbGlzdF90ZW1wbGF0ZQAAAAAAAAYAAAAAAAAAB2NyZWF0b3IAAAAAEwAAAAAAAAALdGVtcGxhdGVfaWQAAAAAEAAAAAAAAAAMY29udGVudF9oYXNoAAAD7gAAACAAAAAAAAAABXRva2VuAAAAAAAAEwAAAAAAAAAFcHJpY2UAAAAAAAALAAAAAAAAAAZwYXJlbnQAAAAAA+gAAAAQAAAAAQAAA+kAAAPtAAAAAAAAAAM=",
        "AAAAAAAAAEhSdW5zIG9uY2UgYXQgZGVwbG95LCBzbyB0aGUgY29uZmlnIGNhbid0IGJlIGZyb250LXJ1biBieSBhbm90aGVyIGNhbGxlci4AAAANX19jb25zdHJ1Y3RvcgAAAAAAAAUAAAAAAAAABWFkbWluAAAAAAAAEwAAAAAAAAAIdHJlYXN1cnkAAAATAAAAAAAAAAtjcmVhdG9yX2JwcwAAAAAEAAAAAAAAAApwYXJlbnRfYnBzAAAAAAAEAAAAAAAAAAx0cmVhc3VyeV9icHMAAAAEAAAAAQAAA+kAAAPtAAAAAAAAAAM=",
        "AAAAAAAAAAAAAAAQaXNfdG9rZW5fYWxsb3dlZAAAAAEAAAAAAAAABXRva2VuAAAAAAAAEwAAAAEAAAAB",
      ]),
      options,
    );
  }
  public readonly fromJSON = {
    buy: this.txFromJSON<Result<void>>,
    tip: this.txFromJSON<Result<void>>,
    get_config: this.txFromJSON<Config>,
    set_listed: this.txFromJSON<Result<void>>,
    get_template: this.txFromJSON<Result<Template>>,
    update_price: this.txFromJSON<Result<void>>,
    has_purchased: this.txFromJSON<boolean>,
    list_template: this.txFromJSON<Result<void>>,
    is_token_allowed: this.txFromJSON<boolean>,
  };
}

export { Buffer };

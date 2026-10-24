import { IS_MAINNET } from "@/lib/stellar/config";

export class DoqtriError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "DoqtriError";
  }
}

/**
 * The registry's workspace errors (WP-1.3), by contract error code, worded
 * for the person signing. Codes 1-5 keep their own handling below.
 */
const WORKSPACE_ERRORS: Record<number, [code: string, message: string]> = {
  6: ["WORKSPACE_EXISTS", "That workspace is already on-chain."],
  7: ["WORKSPACE_NOT_FOUND", "This workspace isn't on-chain yet."],
  8: ["NOT_WORKSPACE_OWNER", "Only the workspace's owner can do that on-chain."],
  9: ["NOT_WORKSPACE_ADMIN", "Only a workspace admin can do that on-chain."],
  10: ["NOT_EDITOR", "Your wallet isn't an editor of this note's workspace on-chain."],
  11: ["TARGET_IS_OWNER", "The workspace's owner already holds every right in it."],
  12: ["TARGET_IS_ADMIN", "That member is an admin; remove them as an admin instead."],
  13: ["TOO_MANY_MEMBERS", "This workspace already has the most members it can hold on-chain."],
};

/** The DoqtriError for a registry workspace error code, or null for any other code. */
export function workspaceContractError(code: number): DoqtriError | null {
  const entry = WORKSPACE_ERRORS[code];
  return entry ? new DoqtriError(entry[0], entry[1]) : null;
}

export function mapWalletError(err: unknown): DoqtriError {
  // Already typed (e.g. the pre-flight funding check): keep code and message.
  if (err instanceof DoqtriError) return err;
  const raw =
    err instanceof Error
      ? err.message
      : typeof err === "string"
        ? err
        : JSON.stringify(err);
  const m = raw.toLowerCase();

  // A contract error code names the error exactly; "#10" must not read as "#1".
  const contractCode = /error\(contract, #(\d+)\)/.exec(m)?.[1];
  const workspaceError = contractCode ? workspaceContractError(Number(contractCode)) : null;
  if (workspaceError) return workspaceError;

  if (m.includes("freighter") && (m.includes("not") || m.includes("install"))) {
    return new DoqtriError(
      "NO_FREIGHTER",
      "Install the Freighter extension to continue.",
    );
  }
  if (m.includes("user rejected") || m.includes("rejected") || m.includes("denied")) {
    return new DoqtriError("USER_REJECTED", "Signature rejected in Freighter.");
  }
  if (m.includes("wrong network") || m.includes("network mismatch")) {
    return new DoqtriError(
      "WRONG_NETWORK",
      "Switch Freighter to Stellar Testnet.",
    );
  }
  if (
    (m.includes("already") && m.includes("exist")) ||
    m.includes("documentalreadyexists") ||
    /#1(?!\d)/.test(m)
  ) {
    return new DoqtriError(
      "ALREADY_EXISTS",
      "Document already registered — updating instead.",
    );
  }
  if (
    m.includes("nodenotfound") ||
    m.includes("node not found") ||
    /#3(?!\d)/.test(m)
  ) {
    return new DoqtriError("NODE_NOT_FOUND", "Node not found on-chain.");
  }
  if (
    m.includes("documentnotfound") ||
    m.includes("document not found") ||
    /#2(?!\d)/.test(m)
  ) {
    return new DoqtriError("NOT_FOUND", "Document not found on-chain.");
  }
  if (
    m.includes("insufficient") ||
    m.includes("underfunded") ||
    m.includes("funding") ||
    m.includes("account not found") ||
    (m.includes("does not exist") && m.includes("account"))
  ) {
    return new DoqtriError(
      "NOT_FUNDED",
      IS_MAINNET
        ? "Account missing or unfunded on mainnet. Fund it with XLM, then retry."
        : "Account missing or unfunded on testnet. Fund it via Friendbot, then retry.",
    );
  }
  if (m.includes("simulation") && m.includes("fail")) {
    return new DoqtriError("SIM_FAILED", raw || "Simulation failed");
  }
  return new DoqtriError("UNKNOWN", raw || "Something went wrong");
}

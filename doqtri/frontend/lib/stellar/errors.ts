export class DoqtriError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "DoqtriError";
  }
}

export function mapWalletError(err: unknown): DoqtriError {
  const raw =
    err instanceof Error
      ? err.message
      : typeof err === "string"
        ? err
        : JSON.stringify(err);
  const m = raw.toLowerCase();

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
    m.includes("#1")
  ) {
    return new DoqtriError(
      "ALREADY_EXISTS",
      "Document already registered — updating instead.",
    );
  }
  if (
    m.includes("nodenotfound") ||
    m.includes("node not found") ||
    m.includes("#3")
  ) {
    return new DoqtriError("NODE_NOT_FOUND", "Node not found on-chain.");
  }
  if (
    m.includes("documentnotfound") ||
    m.includes("document not found") ||
    m.includes("#2")
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
      "Account missing or unfunded on testnet. Fund it via Friendbot, then retry.",
    );
  }
  if (m.includes("simulation") && m.includes("fail")) {
    return new DoqtriError("SIM_FAILED", raw || "Simulation failed");
  }
  return new DoqtriError("UNKNOWN", raw || "Something went wrong");
}

/*
 * Server log lines for errors a route catches but cannot name (DOQ-7).
 *
 * The Stellar SDK's HTTP errors carry the whole request on
 * `error.response.config`, URL included, and console.error(label, error)
 * prints that object in full. With SOROBAN_RPC_URL set to a provider URL
 * that embeds its API key, any RPC 429 or 5xx would write the key into the
 * runtime logs and every drain behind them. So the catch-alls log a line
 * built only from the error's name, message, stack, HTTP status and cause,
 * never the object itself, and the configured server URL is masked in case
 * a message ever quotes it.
 */

const REDACTED_RPC_URL = "[SOROBAN_RPC_URL]";
const MAX_CAUSES = 3;

/**
 * The server RPC URL as config.ts reads it (trimmed, dashboard quotes
 * stripped). Read here rather than imported, so logging never depends on
 * the Stellar config loading, and route tests that mock it still log.
 */
function configuredServerRpcUrl(): string {
  return process.env.SOROBAN_RPC_URL?.trim().replace(/^["']|["']$/g, "") ?? "";
}

/** The HTTP status an SDK or fetch error carries on `response`, if any. */
function httpStatus(error: object): number | null {
  const status = (error as { response?: { status?: unknown } }).response?.status;
  return typeof status === "number" ? status : null;
}

/** One error, without following its cause. */
function describeOne(error: unknown): string {
  if (error instanceof Error) {
    const text = error.stack ?? `${error.name}: ${error.message}`;
    const status = httpStatus(error);
    return status === null ? text : `${text}\n  (HTTP ${status})`;
  }
  if (typeof error === "string") return error;
  // Supabase/PostgREST errors are plain objects: their message is enough.
  if (error && typeof error === "object" && "message" in error) return String(error.message);
  return String(error);
}

/** Removes the keyed server RPC URL from a log line, wherever it appears. */
function redact(text: string, secretUrl: string): string {
  return secretUrl ? text.split(secretUrl).join(REDACTED_RPC_URL) : text;
}

/**
 * A caught error as a log-safe string: name, message, stack, HTTP status and
 * up to three causes, with SOROBAN_RPC_URL masked. `secretUrl` is for tests.
 */
export function describeError(
  error: unknown,
  secretUrl = configuredServerRpcUrl(),
): string {
  const lines = [describeOne(error)];
  let cause = error instanceof Error ? error.cause : undefined;
  for (let i = 0; cause !== undefined && i < MAX_CAUSES; i++) {
    lines.push(`caused by: ${describeOne(cause)}`);
    cause = cause instanceof Error ? cause.cause : undefined;
  }
  return redact(lines.join("\n"), secretUrl);
}

/** console.error for a catch-all: the label, then describeError's line. */
export function logError(label: string, error: unknown): void {
  console.error(`${label}: ${describeError(error)}`);
}

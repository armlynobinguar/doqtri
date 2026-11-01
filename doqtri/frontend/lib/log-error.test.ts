import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { inspect } from "node:util";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { rpc } from "@stellar/stellar-sdk";
import { describeError, logError } from "./log-error";

/*
 * A keyed SOROBAN_RPC_URL must never reach the logs (DOQ-7): the SDK's HTTP
 * errors carry the request URL on response.config, and inspecting the raw
 * error prints it.
 */
const KEY = "SECRETKEY123";

/** The shape stellar-sdk's fetch client gives an HTTP error (buildHttpError). */
function sdkHttpError(url: string, status: number): Error {
  return Object.assign(new Error(`Request failed with status code ${status}`), {
    response: { status, statusText: "Too Many Requests", headers: {}, data: {}, config: { url, method: "post" } },
  });
}

afterEach(() => vi.restoreAllMocks());

describe("describeError", () => {
  it("keeps the message and HTTP status but not the request URL", () => {
    const error = sdkHttpError(`https://rpc.provider.test/v1/${KEY}`, 429);
    expect(inspect(error)).toContain(KEY); // what console.error(label, error) would print
    const line = describeError(error, "");
    expect(line).toContain("Request failed with status code 429");
    expect(line).toContain("(HTTP 429)");
    expect(line).not.toContain(KEY);
  });

  it("masks the configured server URL wherever a message quotes it", () => {
    const secret = `https://rpc.provider.test/v1/${KEY}`;
    const error = new Error("outer", { cause: new Error(`connect to ${secret} refused`) });
    const line = describeError(error, secret);
    expect(line).toContain("caused by: Error: connect to [SOROBAN_RPC_URL] refused");
    expect(line).not.toContain(KEY);
  });

  it("reads the masked URL from SOROBAN_RPC_URL by default", () => {
    vi.stubEnv("SOROBAN_RPC_URL", ` "https://rpc.provider.test/v1/${KEY}"`);
    try {
      expect(describeError(`failed at https://rpc.provider.test/v1/${KEY}`)).toBe("failed at [SOROBAN_RPC_URL]");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("uses a plain object's message and stringifies anything else", () => {
    expect(describeError({ message: "duplicate key", code: "23505" }, "")).toBe("duplicate key");
    expect(describeError(42, "")).toBe("42");
  });
});

describe("logError against a real RPC failure", () => {
  let server: Server;
  let url: string;

  beforeAll(async () => {
    server = createServer((_req, res) => {
      res.writeHead(429, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "rate limited" }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/${KEY}`;
  });

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it("logs a provider 429 without the keyed URL", async () => {
    const error = await new rpc.Server(url, { allowHttp: true }).getLatestLedger().catch((e: unknown) => e);
    expect(inspect(error)).toContain(KEY);
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    logError("[chain/relay] unexpected error", error);
    const line = String(logged.mock.calls[0][0]);
    expect(line).toMatch(/^\[chain\/relay\] unexpected error: \w*Error: Request failed with status code 429/);
    expect(line).not.toContain(KEY);
  });
});

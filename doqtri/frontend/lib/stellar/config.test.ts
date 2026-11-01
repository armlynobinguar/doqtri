import { afterEach, describe, expect, it, vi } from "vitest";

const NEW = "CCCIDUCFQMTMAGESMPTB3MFW4TURS62ORSZNICFOE6MNQZO3MI7F6QRJ";
const OLD = "CCB5DFZRFFDCIBV5H5KWO6UCVN4ZXIPUSXONMBA6HVF433SPO7YEWMSB";

async function load(contractId?: string) {
  vi.resetModules();
  vi.stubEnv("NEXT_PUBLIC_CONTRACT_ID", contractId ?? "");
  vi.stubEnv("NEXT_PUBLIC_NETWORK_PASSPHRASE", "");
  return import("./config");
}

afterEach(() => vi.unstubAllEnvs());

describe("registry address", () => {
  it("defaults to the v2 registry and reads history from the old one too", async () => {
    const config = await load();
    expect(config.CONTRACT_ID).toBe(NEW);
    expect(config.LEGACY_CONTRACT_IDS).toEqual([OLD]);
  });

  it("treats a leftover setting naming the old registry as stale", async () => {
    const config = await load(OLD);
    expect(config.CONTRACT_ID).toBe(NEW);
    expect(config.LEGACY_CONTRACT_IDS).toEqual([OLD]);
  });

  it("still honours any other configured registry", async () => {
    const other = "CA6YPRXQ2IFGACBFLKWEFETGLZ2C5R7DG5TTBKTTP4AVYOF3HFOSBCC2";
    const config = await load(other);
    expect(config.CONTRACT_ID).toBe(other);
    expect(config.LEGACY_CONTRACT_IDS).toEqual([]);
  });
});

/*
 * Which Soroban RPC the app talks to (DOQ-7): the server prefers the
 * server-only SOROBAN_RPC_URL, which may carry a provider's API key; the
 * browser only ever sees NEXT_PUBLIC_SOROBAN_RPC_URL or the public default.
 */
describe("RPC endpoint", () => {
  const KEYED = "https://rpc.provider.test/v1/secret-key";
  const PUBLIC = "https://rpc.public.test";

  async function loadRpc(env: { server?: string; public?: string }) {
    vi.resetModules();
    vi.stubEnv("NEXT_PUBLIC_NETWORK_PASSPHRASE", "");
    vi.stubEnv("SOROBAN_RPC_URL", env.server ?? "");
    vi.stubEnv("NEXT_PUBLIC_SOROBAN_RPC_URL", env.public ?? "");
    return import("./config");
  }

  afterEach(() => vi.unstubAllGlobals());

  it("uses the server-only URL on the server when it is set", async () => {
    const config = await loadRpc({ server: KEYED, public: PUBLIC });
    expect(config.RPC_URL).toBe(KEYED);
  });

  it("falls back to the public URL on the server", async () => {
    const config = await loadRpc({ public: PUBLIC });
    expect(config.RPC_URL).toBe(PUBLIC);
  });

  it("falls back to the public testnet default when neither is set", async () => {
    const config = await loadRpc({});
    expect(config.RPC_URL).toBe("https://soroban-testnet.stellar.org");
  });

  it("never uses the server-only URL in the browser", async () => {
    vi.stubGlobal("window", {});
    expect((await loadRpc({ server: KEYED, public: PUBLIC })).RPC_URL).toBe(PUBLIC);
    expect((await loadRpc({ server: KEYED })).RPC_URL).toBe("https://soroban-testnet.stellar.org");
  });

  it("cleans dashboard quoting and ignores a blank server value", async () => {
    const { serverRpcUrl } = await loadRpc({});
    expect(serverRpcUrl(` "${KEYED}"\n`, PUBLIC)).toBe(KEYED);
    expect(serverRpcUrl("  ", PUBLIC)).toBe(PUBLIC);
    expect(serverRpcUrl(undefined, PUBLIC)).toBe(PUBLIC);
  });
});

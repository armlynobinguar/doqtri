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

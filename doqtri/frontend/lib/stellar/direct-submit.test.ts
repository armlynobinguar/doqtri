import { Keypair } from "@stellar/stellar-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";

// DOQTRI_RELAYER is read when smart-wallet-config loads, so each case loads
// the module afresh under its own environment.
async function load() {
  vi.resetModules();
  return import("./direct-submit");
}

describe("relayerKeypair", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("refuses when no relayer key is set", async () => {
    vi.stubEnv("DOQTRI_RELAYER_SECRET", "");
    const { relayerKeypair } = await load();
    expect(() => relayerKeypair()).toThrow("Paid writes are not configured");
  });

  it("refuses a key for another account than the one the app names", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubEnv("NEXT_PUBLIC_DOQTRI_RELAYER", "");
    vi.stubEnv("DOQTRI_RELAYER_SECRET", Keypair.random().secret());
    const { relayerKeypair } = await load();
    expect(() => relayerKeypair()).toThrow("Paid writes are misconfigured on this server");
  });

  it("signs as a deployment's own relayer when NEXT_PUBLIC_DOQTRI_RELAYER names it", async () => {
    const kp = Keypair.random();
    vi.stubEnv("NEXT_PUBLIC_DOQTRI_RELAYER", kp.publicKey());
    vi.stubEnv("DOQTRI_RELAYER_SECRET", kp.secret());
    const { relayerKeypair } = await load();
    expect(relayerKeypair().publicKey()).toBe(kp.publicKey());
  });
});

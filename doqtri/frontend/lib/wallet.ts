"use client";

/**
 * Stellar wallet access.
 *
 * The kit is imported lazily inside each function rather than at module scope
 * because `@creit.tech/stellar-wallets-kit` reads `localStorage` while it is
 * being evaluated. "use client" does not mean "browser only" — Next still
 * renders client components on the server for the initial HTML — so a top-level
 * import crashed every route that reached this module with
 * `localstorage?.getItem is not a function`.
 *
 * Everything that touches the kit is therefore async, and the browser-only
 * check stays inside the functions.
 */

type Kit = typeof import("@creit.tech/stellar-wallets-kit/sdk").StellarWalletsKit;

let initialized = false;

/**
 * Kit 2.8 renamed its Freighter module to Varial, and the module id with it
 * ("freighter" became "varial"). The kit remembers the chosen wallet by id in
 * localStorage, and reads it once while its module is being evaluated, so a
 * returning user still holding "freighter" matches no module: they look
 * disconnected and the modal never marks Varial as recently used. Rewrite the
 * old id before the kit is imported.
 */
const LEGACY_IDS: Record<string, string> = { freighter: "varial" };

function migrateStoredWalletIds(): void {
  try {
    const selectedKey = "@StellarWalletsKit/selectedModuleId";
    const selected = localStorage.getItem(selectedKey);
    if (selected && LEGACY_IDS[selected]) localStorage.setItem(selectedKey, LEGACY_IDS[selected]);

    const usedKey = "@StellarWalletsKit/usedWalletsIds";
    const used = localStorage.getItem(usedKey);
    if (used) {
      const ids = JSON.parse(used) as unknown;
      if (Array.isArray(ids) && ids.some((id) => typeof id === "string" && LEGACY_IDS[id])) {
        const next = [...new Set(ids.map((id) => (typeof id === "string" && LEGACY_IDS[id]) || id))];
        localStorage.setItem(usedKey, JSON.stringify(next));
      }
    }
  } catch {
    // Storage blocked or a malformed record: the kit falls back to no selection.
  }
}

async function kit(): Promise<Kit | null> {
  if (typeof window === "undefined") return null;

  if (!initialized) migrateStoredWalletIds();

  const [
    { StellarWalletsKit },
    { defaultModules },
    { Networks, SwkAppDarkTheme },
    { IS_MAINNET },
  ] = await Promise.all([
    import("@creit.tech/stellar-wallets-kit/sdk"),
    import("@creit.tech/stellar-wallets-kit/modules/utils"),
    import("@creit.tech/stellar-wallets-kit/types"),
    import("@/lib/stellar/config"),
  ]);

  if (!initialized) {
    StellarWalletsKit.init({
      modules: defaultModules(),
      network: IS_MAINNET ? Networks.PUBLIC : Networks.TESTNET,
      theme: SwkAppDarkTheme,
    });
    initialized = true;
  }

  return StellarWalletsKit;
}

export async function connectWallet(): Promise<string> {
  const wallets = await kit();
  if (!wallets) throw new Error("Wallet connection needs a browser.");
  const { address } = await wallets.authModal();
  return address;
}

export async function disconnectWallet(): Promise<void> {
  const wallets = await kit();
  await wallets?.disconnect();
}

export async function onWalletState(
  cb: (address: string | undefined) => void,
): Promise<() => void> {
  const [wallets, { KitEventType }] = await Promise.all([
    kit(),
    import("@creit.tech/stellar-wallets-kit/types"),
  ]);
  if (!wallets) return () => {};

  return wallets.on(KitEventType.STATE_UPDATED, (event) => {
    cb(event.payload.address);
  });
}

/** Pure string formatting — deliberately does not touch the kit. */
export function shortenAddress(address: string): string {
  if (address.length < 10) return address;
  return `${address.slice(0, 4)}…${address.slice(-4)}`;
}

export async function signSorobanTx(
  xdr: string,
  address: string,
): Promise<string> {
  const wallets = await kit();
  if (!wallets) throw new Error("Wallet signing needs a browser.");
  const { NETWORK_PASSPHRASE } = await import("@/lib/stellar/config");
  const { signedTxXdr } = await wallets.signTransaction(xdr, {
    networkPassphrase: NETWORK_PASSPHRASE,
    address,
  });
  return signedTxXdr;
}

/**
 * SEP-53 message signature (base64) from the connected wallet. Used to prove
 * wallet ownership at sign-in; it is not a transaction and costs nothing.
 */
export async function signWalletMessage(message: string, address: string): Promise<string> {
  const wallets = await kit();
  if (!wallets) throw new Error("Wallet signing needs a browser.");
  const { NETWORK_PASSPHRASE } = await import("@/lib/stellar/config");
  try {
    const { signedMessage } = await wallets.signMessage(message, {
      networkPassphrase: NETWORK_PASSPHRASE,
      address,
    });
    return signedMessage;
  } catch (err) {
    const text = (err as { message?: string })?.message ?? String(err);
    if (/does not support/i.test(text)) {
      throw new Error("This wallet can't sign messages. Connect with Varial or another wallet that supports message signing.");
    }
    throw err instanceof Error ? err : new Error(text || "Signing was cancelled.");
  }
}

/** Prefer the connected wallet address when available. */
export async function getWalletAddress(): Promise<string | null> {
  const wallets = await kit();
  if (!wallets) return null;
  try {
    const { address } = await wallets.fetchAddress();
    return address ?? null;
  } catch {
    return null;
  }
}

/**
 * Signs a Soroban authorization preimage (base64 HashIdPreimage) with the
 * connected wallet, for calls another party submits, such as a workspace
 * transfer (D-29). Returns the base64 signature.
 */
export async function signWalletAuthEntry(preimageXdr: string, address: string): Promise<string> {
  const wallets = await kit();
  if (!wallets) throw new Error("Wallet signing needs a browser.");
  const { NETWORK_PASSPHRASE } = await import("@/lib/stellar/config");
  const { signedAuthEntry } = await wallets.signAuthEntry(preimageXdr, { networkPassphrase: NETWORK_PASSPHRASE, address });
  if (!signedAuthEntry) throw new Error("The wallet didn't sign the approval.");
  return signedAuthEntry;
}

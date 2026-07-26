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

async function kit(): Promise<Kit | null> {
  if (typeof window === "undefined") return null;

  const [{ StellarWalletsKit }, { defaultModules }, { Networks, SwkAppDarkTheme }] =
    await Promise.all([
      import("@creit.tech/stellar-wallets-kit/sdk"),
      import("@creit.tech/stellar-wallets-kit/modules/utils"),
      import("@creit.tech/stellar-wallets-kit/types"),
    ]);

  if (!initialized) {
    StellarWalletsKit.init({
      modules: defaultModules(),
      network: Networks.TESTNET,
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

/** Prefer the connected Freighter address when available. */
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

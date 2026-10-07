"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useRouter } from "next/navigation";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { DoqtriError } from "@/lib/stellar/errors";
import {
  fundWithFriendbot,
  getAccountBalance,
  type AccountBalance,
} from "@/lib/stellar/horizon";
import {
  connectWallet,
  disconnectWallet,
  getWalletAddress,
  onWalletState,
  shortenAddress,
} from "@/lib/wallet";
import { exchangeWalletSession } from "@/lib/wallet-session";
import {
  addPasskey as addWalletPasskey,
  createPasskeyWallet,
  removePasskey as removeWalletPasskey,
  setPasskeyWallet,
} from "@/lib/passkey-wallet";
import type { VaultIdentity } from "@/lib/types";

const BALANCE_POLL_MS = 30_000;

/**
 * Two addresses that used to be conflated:
 *
 * - `sessionAddress` owns the vault: the wallet the Supabase session was
 *   issued for. It only changes through an explicit exchange.
 * - `walletAddress` is whatever the wallet kit reports right now. It comes and
 *   goes with extension state and account switches.
 *
 * Wallet events only ever update `walletAddress`. Nothing here navigates to
 * /login: a disconnected wallet leaves the session (and the vault) intact
 * with a reconnect affordance, and a different account is surfaced as a
 * mismatch the user resolves on purpose.
 */
type WalletContextValue = {
  identity: VaultIdentity;
  sessionAddress: string | null;
  walletAddress: string | null;
  mismatch: boolean;
  balance: AccountBalance | null;
  balanceError: boolean;
  refreshBalance: () => Promise<void>;
  /** The vault's wallet, connected; opens the wallet modal if it is not. */
  ensureWallet: () => Promise<string>;
  reconnect: () => Promise<void>;
  /** Re-issues the session for the wallet's current account. */
  switchVault: () => Promise<void>;
  disconnect: () => Promise<void>;
  /** Ends the session without touching any wallet (email accounts). */
  signOut: () => Promise<void>;
  /** Email accounts: one passkey prompt, then the deployed wallet's address. */
  createSmartWallet: () => Promise<string>;
  /** Email accounts: create a passkey and add it to the wallet. */
  addPasskey: () => Promise<void>;
  /** Email accounts: remove one passkey (never the last). */
  removePasskey: (credentialId: string) => Promise<void>;
  fund: () => Promise<void>;
};

const WalletContext = createContext<WalletContextValue | null>(null);

export function WalletProvider({
  identity,
  children,
}: {
  identity: VaultIdentity;
  children: React.ReactNode;
}) {
  const sessionAddress = identity.kind === "wallet" ? identity.address : null;
  const smartWallet = identity.kind === "email" ? identity.smartWallet : null;
  const router = useRouter();

  // The registry client signs as a C… address by looking its passkey up here.
  useEffect(() => {
    setPasskeyWallet(smartWallet);
    return () => setPasskeyWallet(null);
  }, [smartWallet]);
  const [walletAddress, setWalletAddress] = useState<string | null>(null);
  const [balance, setBalance] = useState<AccountBalance | null>(null);
  const [balanceError, setBalanceError] = useState(false);
  const switching = useRef(false);

  useEffect(() => {
    // Email accounts have no browser wallet to track; skip loading the kit.
    if (!sessionAddress) return;
    let cancelled = false;
    let unsubscribe: (() => void) | undefined;
    void getWalletAddress().then((address) => {
      if (!cancelled && address) setWalletAddress(address);
    });
    void onWalletState((address) => {
      if (!cancelled) setWalletAddress(address ?? null);
    }).then((off) => {
      if (cancelled) off();
      else unsubscribe = off;
    });
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [sessionAddress]);

  const refreshBalance = useCallback(async () => {
    if (!sessionAddress) return;
    try {
      setBalance(await getAccountBalance(sessionAddress));
      setBalanceError(false);
    } catch {
      setBalanceError(true);
    }
  }, [sessionAddress]);

  useEffect(() => {
    // The first read is deferred a tick so no state is set synchronously
    // inside the effect; polling and focus keep it current afterwards.
    const first = setTimeout(() => void refreshBalance(), 0);
    const timer = setInterval(() => void refreshBalance(), BALANCE_POLL_MS);
    const onFocus = () => void refreshBalance();
    window.addEventListener("focus", onFocus);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [refreshBalance]);

  const ensureWallet = useCallback(async () => {
    if (!sessionAddress) {
      // Email accounts sign with their passkey wallet; the relay pays.
      if (smartWallet) return smartWallet.address;
      throw new DoqtriError("NO_WALLET", "Create your passkey wallet first, from the account menu.");
    }
    let address = walletAddress ?? (await getWalletAddress());
    if (!address) address = await connectWallet();
    setWalletAddress(address);
    if (sessionAddress && address !== sessionAddress) {
      throw new DoqtriError(
        "WRONG_ACCOUNT",
        `This vault belongs to ${shortenAddress(sessionAddress)}, but your wallet is on ` +
          `${shortenAddress(address)}. Switch accounts in your wallet, or switch vaults ` +
          "from the account menu.",
      );
    }
    return address;
  }, [walletAddress, sessionAddress, smartWallet]);

  const reconnect = useCallback(async () => {
    setWalletAddress(await connectWallet());
  }, []);

  const switchVault = useCallback(async () => {
    if (!walletAddress || switching.current) return;
    switching.current = true;
    try {
      await exchangeWalletSession(walletAddress);
      router.push("/vault");
      router.refresh();
    } finally {
      switching.current = false;
    }
  }, [walletAddress, router]);

  const signOut = useCallback(async () => {
    // This browser only: signing out here should not end the same account's
    // sessions in other browsers (the default scope is global).
    await createSupabaseBrowserClient().auth.signOut({ scope: "local" });
    router.push("/");
    router.refresh();
  }, [router]);

  const createSmartWallet = useCallback(async () => {
    if (identity.kind !== "email") throw new Error("Wallet accounts already have a wallet.");
    const { address } = await createPasskeyWallet(identity.email);
    router.refresh();
    return address;
  }, [identity, router]);

  const addPasskey = useCallback(async () => {
    if (identity.kind !== "email" || !identity.smartWallet) throw new Error("Create your passkey wallet first.");
    await addWalletPasskey(identity.smartWallet, identity.email);
    router.refresh();
  }, [identity, router]);

  const removePasskey = useCallback(
    async (credentialId: string) => {
      if (identity.kind !== "email" || !identity.smartWallet) throw new Error("Create your passkey wallet first.");
      await removeWalletPasskey(identity.smartWallet, credentialId);
      router.refresh();
    },
    [identity, router],
  );

  const disconnect = useCallback(async () => {
    try {
      await disconnectWallet();
    } catch {
      // wallet may already be disconnected
    }
    await signOut();
  }, [signOut]);

  const fund = useCallback(async () => {
    if (!sessionAddress) return;
    await fundWithFriendbot(sessionAddress);
    await refreshBalance();
  }, [sessionAddress, refreshBalance]);

  const value = useMemo(
    () => ({
      identity,
      sessionAddress,
      walletAddress,
      mismatch: Boolean(sessionAddress && walletAddress && walletAddress !== sessionAddress),
      balance,
      balanceError,
      refreshBalance,
      ensureWallet,
      reconnect,
      switchVault,
      disconnect,
      signOut,
      createSmartWallet,
      addPasskey,
      removePasskey,
      fund,
    }),
    [
      identity,
      sessionAddress,
      walletAddress,
      balance,
      balanceError,
      refreshBalance,
      ensureWallet,
      reconnect,
      switchVault,
      disconnect,
      signOut,
      createSmartWallet,
      addPasskey,
      removePasskey,
      fund,
    ],
  );

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

export function useWallet(): WalletContextValue {
  const ctx = useContext(WalletContext);
  if (!ctx) throw new Error("useWallet must be used inside a WalletProvider");
  return ctx;
}

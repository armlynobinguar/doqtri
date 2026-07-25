"use client";

import { useRouter } from "next/navigation";
import { useWallet } from "@/lib/WalletContext";
import { shortenAddress } from "@/lib/wallet";
import styles from "./WalletButton.module.css";

type Props = {
  redirectToVault?: boolean;
  size?: "nav" | "hero";
};

export default function WalletButton({
  redirectToVault = false,
  size = "nav",
}: Props) {
  const { address, connecting, error, connect, disconnect } = useWallet();
  const router = useRouter();
  const sizeClass = size === "hero" ? styles.hero : "";

  if (address) {
    return (
      <button
        type="button"
        className={`${styles.btn} ${sizeClass}`}
        onClick={() => void disconnect()}
        title="Disconnect"
      >
        <span className={styles.addr}>{shortenAddress(address)}</span>
      </button>
    );
  }

  return (
    <div className={styles.wrapper}>
      <button
        type="button"
        className={`${styles.btn} ${sizeClass}`}
        disabled={connecting}
        aria-label="Connect Stellar wallet"
        title={error ?? "Connect a Stellar wallet"}
        onClick={() => {
          void connect()
            .then(() => {
              if (redirectToVault) router.push("/vault");
            })
            .catch(() => undefined);
        }}
      >
        {connecting ? "Connecting…" : "Connect wallet"}
      </button>
      {error ? (
        <span className={styles.error} role="alert">
          {error}
        </span>
      ) : null}
    </div>
  );
}

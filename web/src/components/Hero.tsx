"use client";

import Link from "next/link";
import WalletButton from "@/components/WalletButton";
import { useWallet } from "@/lib/WalletContext";
import styles from "./Hero.module.css";

export default function Hero() {
  const { address } = useWallet();

  return (
    <section className={styles.hero} id="top" aria-labelledby="doqtri-brand">
      <div className={styles.inner}>
        <h1 id="doqtri-brand" className={styles.brand}>
          Doqtri
        </h1>
        <p className={styles.headline}>Your last next plan.</p>
        <p className={styles.support}>
          Living docs into executable mindmaps — planned vs shipped, proven on
          Stellar.
        </p>
        <div className={styles.actions}>
          {address ? (
            <Link className={styles.primary} href="/vault">
              Open vault
            </Link>
          ) : (
            <WalletButton redirectToVault size="hero" />
          )}
          <a className={styles.secondary} href="#map">
            See the map
          </a>
        </div>
      </div>
    </section>
  );
}

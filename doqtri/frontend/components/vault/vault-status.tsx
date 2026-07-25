"use client";

import { createContext, useContext, useMemo, useState } from "react";
import type { SaveState } from "@/components/vault/status-bar";

export type RightTab = "graph" | "mindmap";

/**
 * The status bar and ribbon live in the vault layout, but the values they show
 * and control (word count, save state, which right-hand panel is showing) are
 * owned by the editor page nested inside it. This context is the seam between
 * the two, so neither has to be hoisted into the other.
 */
type VaultStatus = {
  wordCount: number | undefined;
  saveState: SaveState;
  rightTab: RightTab;
  setWordCount: (count: number | undefined) => void;
  setSaveState: (state: SaveState) => void;
  setRightTab: (tab: RightTab) => void;
};

const VaultStatusContext = createContext<VaultStatus | null>(null);

export function VaultStatusProvider({ children }: { children: React.ReactNode }) {
  const [wordCount, setWordCount] = useState<number | undefined>(undefined);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [rightTab, setRightTab] = useState<RightTab>("graph");

  const value = useMemo(
    () => ({
      wordCount,
      saveState,
      rightTab,
      setWordCount,
      setSaveState,
      setRightTab,
    }),
    [wordCount, saveState, rightTab],
  );

  return (
    <VaultStatusContext.Provider value={value}>
      {children}
    </VaultStatusContext.Provider>
  );
}

export function useVaultStatus(): VaultStatus {
  const ctx = useContext(VaultStatusContext);
  if (!ctx) {
    throw new Error("useVaultStatus must be used inside a VaultStatusProvider");
  }
  return ctx;
}

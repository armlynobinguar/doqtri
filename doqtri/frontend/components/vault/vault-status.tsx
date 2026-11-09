"use client";

import { createContext, useContext, useMemo, useState, useSyncExternalStore } from "react";
import type { SaveState } from "@/components/vault/status-bar";
import type { EditorStats } from "@/lib/text-stats";

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
  /** The editor's caret and selection counts; see useEditorStats. */
  setEditorStats: (stats: EditorStats | undefined) => void;
  editorStats: StatsStore;
};

/**
 * The editor's counts change with every caret move, so they skip the context
 * value (which would re-render the whole vault shell each time): the status
 * bar subscribes to this store on its own.
 */
type StatsStore = {
  get: () => EditorStats | undefined;
  set: (stats: EditorStats | undefined) => void;
  subscribe: (listener: () => void) => () => void;
};

function createStatsStore(): StatsStore {
  let value: EditorStats | undefined;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set: (stats) => {
      value = stats;
      for (const listener of listeners) listener();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

const VaultStatusContext = createContext<VaultStatus | null>(null);

export function VaultStatusProvider({ children }: { children: React.ReactNode }) {
  const [wordCount, setWordCount] = useState<number | undefined>(undefined);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [rightTab, setRightTab] = useState<RightTab>("graph");
  const [editorStats] = useState(createStatsStore);

  const value = useMemo(
    () => ({
      wordCount,
      saveState,
      rightTab,
      setWordCount,
      setSaveState,
      setRightTab,
      editorStats,
      setEditorStats: editorStats.set,
    }),
    [wordCount, saveState, rightTab, editorStats],
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

const noStats = () => () => {};

/** The open note's caret and selection counts; undefined with no editor open. */
export function useEditorStats(): EditorStats | undefined {
  const store = useContext(VaultStatusContext)?.editorStats;
  return useSyncExternalStore(store?.subscribe ?? noStats, () => store?.get(), () => undefined);
}

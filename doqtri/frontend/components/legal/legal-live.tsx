"use client";

import { createContext, useContext } from "react";

/**
 * Whether the legal pages are live, for the vault's client components. The
 * vault layout reads the gate on the server (lib/legal.ts) and passes this
 * boolean down; the operator's name never reaches the browser this way.
 */
const LegalLive = createContext(false);

export const LegalLiveProvider = LegalLive.Provider;

export function useLegalLive(): boolean {
  return useContext(LegalLive);
}

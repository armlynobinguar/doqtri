"use client";

import { useCallback, useEffect, useState } from "react";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import {
  applyPreferences,
  DEFAULT_PREFERENCES,
  parsePreferences,
  readStoredPreferences,
  storePreferences,
  type Preferences,
} from "@/lib/preferences";

/**
 * Keeps this browser's display preferences in step with the account:
 * - a browser with nothing saved adopts the account's preferences (set on
 *   another device), and
 * - "Auto" follows the device switching between light and dark.
 */
export function PreferencesSync({ account }: { account: unknown }) {
  useEffect(() => {
    if (!readStoredPreferences() && account) {
      const prefs = parsePreferences(account);
      storePreferences(prefs);
      applyPreferences(prefs);
    }
  }, [account]);

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => {
      const prefs = readStoredPreferences();
      if (prefs?.theme === "system") applyPreferences(prefs);
    };
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);

  return null;
}

/** The current preferences and a setter that applies, saves and syncs them. */
export function usePreferences(): [Preferences, (change: Partial<Preferences>) => void] {
  const [prefs, setPrefs] = useState<Preferences>(DEFAULT_PREFERENCES);

  useEffect(() => {
    // Read after mount: the server render can't see localStorage.
    const timer = setTimeout(() => setPrefs(readStoredPreferences() ?? DEFAULT_PREFERENCES), 0);
    const onApplied = (event: Event) => setPrefs((event as CustomEvent<Preferences>).detail);
    window.addEventListener("doqtri:preferences", onApplied);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("doqtri:preferences", onApplied);
    };
  }, []);

  const update = useCallback((change: Partial<Preferences>) => {
    const next = { ...(readStoredPreferences() ?? DEFAULT_PREFERENCES), ...change };
    storePreferences(next);
    applyPreferences(next);
    // Best effort: the account copy only matters for the next new browser.
    void createSupabaseBrowserClient()
      .auth.updateUser({ data: { preferences: next } })
      .catch(() => undefined);
  }, []);

  return [prefs, update];
}

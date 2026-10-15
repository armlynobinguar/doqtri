/**
 * Display preferences (Profile → Settings).
 *
 * Kept in localStorage so they apply before the first paint (the inline
 * script in app/layout.tsx reads the same key), and mirrored to the account's
 * Supabase user metadata so a new browser picks them up after sign-in. They
 * are cosmetic: nothing reads them for access or on-chain decisions, so it
 * doesn't matter that a user can rewrite their own metadata.
 */

export type ThemePreference = "dark" | "light" | "system";
export type TextSize = "small" | "medium" | "large";

export type Preferences = {
  theme: ThemePreference;
  textSize: TextSize;
  reduceMotion: boolean;
};

export const DEFAULT_PREFERENCES: Preferences = { theme: "dark", textSize: "medium", reduceMotion: false };

export const PREFERENCES_KEY = "doqtri.preferences";

const THEMES: ThemePreference[] = ["dark", "light", "system"];
const TEXT_SIZES: TextSize[] = ["small", "medium", "large"];

/** Anything stored or synced, coerced to valid preferences; unknown fields fall back to defaults. */
export function parsePreferences(value: unknown): Preferences {
  const v = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  return {
    theme: THEMES.includes(v.theme as ThemePreference) ? (v.theme as ThemePreference) : DEFAULT_PREFERENCES.theme,
    textSize: TEXT_SIZES.includes(v.textSize as TextSize) ? (v.textSize as TextSize) : DEFAULT_PREFERENCES.textSize,
    reduceMotion: typeof v.reduceMotion === "boolean" ? v.reduceMotion : DEFAULT_PREFERENCES.reduceMotion,
  };
}

/** The saved preferences in this browser, or null when nothing is saved here yet. */
export function readStoredPreferences(): Preferences | null {
  try {
    const raw = window.localStorage.getItem(PREFERENCES_KEY);
    return raw ? parsePreferences(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

export function storePreferences(prefs: Preferences): void {
  try {
    window.localStorage.setItem(PREFERENCES_KEY, JSON.stringify(prefs));
  } catch {
    // Storage blocked: they still apply for this page view.
  }
}

/** "system" resolved against the device's current setting. */
export function resolveTheme(theme: ThemePreference, prefersDark: boolean): "dark" | "light" {
  return theme === "system" ? (prefersDark ? "dark" : "light") : theme;
}

/** Puts preferences on <html>: the theme class, the editor's colour mode, text size and motion. */
export function applyPreferences(prefs: Preferences): void {
  const root = document.documentElement;
  const theme = resolveTheme(prefs.theme, window.matchMedia("(prefers-color-scheme: dark)").matches);
  root.classList.toggle("dark", theme === "dark");
  root.classList.toggle("light", theme === "light");
  root.dataset.colorMode = theme;
  root.style.colorScheme = theme;
  if (prefs.textSize === "medium") delete root.dataset.textSize;
  else root.dataset.textSize = prefs.textSize;
  if (prefs.reduceMotion) root.dataset.reduceMotion = "";
  else delete root.dataset.reduceMotion;
  window.dispatchEvent(new CustomEvent("doqtri:preferences", { detail: prefs }));
}

/**
 * Runs inline in <head> before anything paints: the stored theme and text
 * size, without waiting for React. Must stay self-contained (it is stringified)
 * and agree with applyPreferences.
 */
export const PREFERENCES_BOOT_SCRIPT = `(function(){try{var p=JSON.parse(localStorage.getItem(${JSON.stringify(
  PREFERENCES_KEY,
)})||"{}");var t=p.theme==="light"||p.theme==="system"?p.theme:"dark";if(t==="system")t=matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light";var r=document.documentElement;r.classList.toggle("dark",t==="dark");r.classList.toggle("light",t==="light");r.dataset.colorMode=t;r.style.colorScheme=t;if(p.textSize==="small"||p.textSize==="large")r.dataset.textSize=p.textSize;if(p.reduceMotion===true)r.dataset.reduceMotion="";}catch(e){}})();`;

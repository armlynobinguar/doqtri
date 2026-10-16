import { describe, expect, it } from "vitest";
import {
  DEFAULT_PREFERENCES,
  parsePreferences,
  PREFERENCES_BOOT_SCRIPT,
  PREFERENCES_KEY,
  resolveTheme,
} from "./preferences";

describe("parsePreferences", () => {
  it("keeps valid values", () => {
    expect(parsePreferences({ theme: "light", textSize: "large", reduceMotion: true })).toEqual({
      theme: "light",
      textSize: "large",
      reduceMotion: true,
    });
  });

  it("falls back to the defaults for anything missing or unknown", () => {
    expect(parsePreferences(null)).toEqual(DEFAULT_PREFERENCES);
    expect(parsePreferences("dark")).toEqual(DEFAULT_PREFERENCES);
    expect(parsePreferences({ theme: "sepia", textSize: 14, reduceMotion: "yes" })).toEqual(DEFAULT_PREFERENCES);
  });

  it("defaults to the dark brand theme", () => {
    expect(DEFAULT_PREFERENCES.theme).toBe("dark");
  });
});

describe("resolveTheme", () => {
  it("follows the device only for Auto", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
  });
});

/** Runs the inline <head> script against a minimal fake document. */
function boot(stored: unknown, prefersDark = true) {
  const classes = new Set(["dark"]);
  const root = {
    classList: { toggle: (name: string, on: boolean) => (on ? classes.add(name) : classes.delete(name)) },
    dataset: {} as Record<string, string>,
    style: {} as Record<string, string>,
  };
  const localStorage = {
    getItem: (key: string) => (key === PREFERENCES_KEY && stored !== undefined ? JSON.stringify(stored) : null),
  };
  const matchMedia = () => ({ matches: prefersDark });
  new Function("localStorage", "matchMedia", "document", PREFERENCES_BOOT_SCRIPT)(localStorage, matchMedia, {
    documentElement: root,
  });
  return { classes: [...classes], dataset: root.dataset, colorScheme: root.style.colorScheme };
}

describe("PREFERENCES_BOOT_SCRIPT", () => {
  it("leaves the dark default alone when nothing is saved", () => {
    expect(boot(undefined)).toEqual({ classes: ["dark"], dataset: { colorMode: "dark" }, colorScheme: "dark" });
  });

  it("applies a saved light theme, text size and reduced motion before paint", () => {
    expect(boot({ theme: "light", textSize: "large", reduceMotion: true })).toEqual({
      classes: ["light"],
      dataset: { colorMode: "light", textSize: "large", reduceMotion: "" },
      colorScheme: "light",
    });
  });

  it("resolves Auto against the device", () => {
    expect(boot({ theme: "system" }, false).classes).toEqual(["light"]);
    expect(boot({ theme: "system" }, true).classes).toEqual(["dark"]);
  });

  it("ignores a medium text size and unknown themes", () => {
    expect(boot({ theme: "sepia", textSize: "medium" }).dataset).toEqual({ colorMode: "dark" });
  });
});

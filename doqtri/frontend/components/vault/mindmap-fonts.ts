import localFont from "next/font/local";
import type { FontKey } from "@/lib/mindmap-style";

/*
 * Display faces for the mindmap studio. Not preloaded: the browser only
 * fetches a face once a map is drawn in it, so a vault that never leaves the
 * default font never pays for these.
 *
 * Self-hosted (Latin subset, OFL) rather than next/font/google: Turbopack
 * intermittently failed to resolve the Google font files at build time
 * ("next/font/google queries have exactly one entry"), which broke CI and dev.
 * All but the pixel face are variable fonts covering 500–700.
 */
const grotesk = localFont({ src: "./fonts/space-grotesk.woff2", weight: "500 700", preload: false });
const orbitron = localFont({ src: "./fonts/orbitron.woff2", weight: "500 700", preload: false });
const serif = localFont({ src: "./fonts/playfair-display.woff2", weight: "500 700", preload: false });
const hand = localFont({ src: "./fonts/caveat.woff2", weight: "500 700", preload: false });
const pixel = localFont({ src: "./fonts/press-start-2p.woff2", weight: "400", preload: false });

const SYSTEM = "ui-sans-serif, system-ui, sans-serif";

export const FONT_LABELS: Record<FontKey, string> = {
  sans: "Jakarta",
  mono: "Mono",
  grotesk: "Grotesk",
  orbitron: "Orbitron",
  serif: "Playfair",
  hand: "Hand",
  pixel: "Pixel",
};

/** Reads a font family the root layout exposes as a CSS variable. */
function cssVariableFamily(name: string, fallback: string): string {
  if (typeof document === "undefined") return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value ? `${value}, ${fallback}` : fallback;
}

/**
 * The font-family for `key` in DOM styles. Uses the layout's CSS variables
 * directly, so the server and the browser render the same string.
 */
export function cssFontFamily(key: FontKey): string {
  if (key === "sans") return `var(--font-sans), ${SYSTEM}`;
  if (key === "mono") return "var(--font-code), ui-monospace, monospace";
  return fontFamily(key);
}

/** The CSS font-family a canvas should use for `key`. */
export function fontFamily(key: FontKey): string {
  switch (key) {
    case "sans":
      return cssVariableFamily("--font-sans", SYSTEM);
    case "mono":
      return cssVariableFamily("--font-code", "ui-monospace, monospace");
    case "grotesk":
      return grotesk.style.fontFamily;
    case "orbitron":
      return orbitron.style.fontFamily;
    case "serif":
      return serif.style.fontFamily;
    case "hand":
      return hand.style.fontFamily;
    case "pixel":
      return pixel.style.fontFamily;
  }
}

/** The weight labels are drawn in; the pixel face only has one. */
export function fontWeight(key: FontKey): number {
  if (key === "pixel") return 400;
  return key === "sans" || key === "mono" ? 500 : 600;
}

/**
 * Resolves once `key` is ready to draw with.
 *
 * Canvas text does not wait for a web font: drawing before it has loaded uses
 * the fallback, and measuring then gives the fallback's widths — so the pills
 * would be sized for one font and drawn in another.
 */
export async function loadFont(key: FontKey): Promise<void> {
  if (typeof document === "undefined" || !document.fonts) return;
  try {
    await document.fonts.load(`${fontWeight(key)} 16px ${fontFamily(key)}`);
  } catch {
    // A face that fails to load leaves the fallback in place, which still draws.
  }
}

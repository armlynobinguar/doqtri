import type { MapNodeKind, MindmapGraph } from "@/lib/mindmap-graph";
import { MINDMAP_COLORS } from "@/lib/theme";

/**
 * How a mindmap looks: everything the studio panel can change.
 *
 * Kept pure and serialisable, because it is stored per map in the browser and
 * pasted between maps as a style code. Nothing in here may assume a canvas —
 * the 2D renderer, the 3D renderer and the PNG export all read the same object
 * and must agree on what it means.
 */

export type NodeShape = "pill" | "box" | "sharp" | "hexagon" | "bubble" | "underline";
export type ColorMode = "kind" | "branch" | "depth";
export type FillMode = "solid" | "glass" | "outline" | "gradient";
export type Backdrop = "solid" | "radial" | "linear" | "grid" | "dots" | "stars" | "aurora";
export type Layout2D = "radial" | "free" | "tree-down" | "tree-right";
export type Layout3D = "free" | "radial" | "tree";
export type Node3D = "label" | "orb" | "crystal";
export type FontKey = "sans" | "mono" | "grotesk" | "orbitron" | "serif" | "hand" | "pixel";
export type ViewMode = "2d" | "3d";

export type KindColors = { fill: string; stroke: string; text: string };

export type Palette = {
  background: string;
  /** Second stop for gradient and aurora backdrops. */
  backgroundAlt: string;
  link: string;
  kinds: Record<MapNodeKind, KindColors>;
  /** One colour per top-level branch, cycled, for the `branch` colour mode. */
  branches: string[];
  depthFrom: string;
  depthTo: string;
};

export type NodeOverride = {
  color?: string;
  emoji?: string;
  /** Size multiplier on top of the global text scale. */
  scale?: number;
  hidden?: boolean;
};

export type MindmapStyle = {
  version: 1;
  /** The preset the palette came from, or "custom" once a colour is edited. */
  preset: string;
  palette: Palette;
  colorMode: ColorMode;
  shape: NodeShape;
  fill: FillMode;
  font: FontKey;
  textScale: number;
  /** 0 to 1. */
  glow: number;
  borderWidth: number;
  link: {
    width: number;
    curvature: number;
    dashed: boolean;
    /** Blend each link from its source's colour to its target's. */
    gradient: boolean;
    opacity: number;
    /** Particles travelling along each link; 0 turns them off. */
    particles: number;
    particleSpeed: number;
    particleSize: number;
  };
  backdrop: Backdrop;
  vignette: boolean;
  layout: Layout2D;
  spacing: number;
  view: ViewMode;
  three: {
    layout: Layout3D;
    node: Node3D;
    autoRotate: boolean;
    rotateSpeed: number;
    /** Bloom strength, 0 to 3. */
    bloom: number;
  };
  caption: { show: boolean; text: string; watermark: boolean };
  /** Dim everything but a hovered (or held, on touch) node's branch. */
  focus: boolean;
  /** On big maps, draw deeper levels only once zoomed in far enough to read them. */
  zoomReveal: boolean;
  overrides: Record<string, NodeOverride>;
};

/* ------------------------------------------------------------------------ */
/* Colour helpers                                                            */
/* ------------------------------------------------------------------------ */

type Rgb = { r: number; g: number; b: number };

const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

export function isHexColor(value: unknown): value is string {
  return typeof value === "string" && HEX.test(value);
}

export function parseHex(hex: string): Rgb {
  let body = hex.slice(1);
  if (body.length === 3) body = body.replace(/./g, (c) => c + c);
  const n = Number.parseInt(body, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function toHex({ r, g, b }: Rgb): string {
  const part = (v: number) =>
    Math.round(Math.min(255, Math.max(0, v)))
      .toString(16)
      .padStart(2, "0");
  return `#${part(r)}${part(g)}${part(b)}`;
}

/** `a` blended toward `b` by `t` (0 keeps `a`, 1 gives `b`). */
export function mix(a: string, b: string, t: number): string {
  const x = parseHex(a);
  const y = parseHex(b);
  return toHex({
    r: x.r + (y.r - x.r) * t,
    g: x.g + (y.g - x.g) * t,
    b: x.b + (y.b - x.b) * t,
  });
}

export function withAlpha(hex: string, alpha: number): string {
  const { r, g, b } = parseHex(hex);
  return `rgba(${r}, ${g}, ${b}, ${Math.min(1, Math.max(0, alpha))})`;
}

/** Relative luminance, 0 (black) to 1 (white). */
export function luminance(hex: string): number {
  const { r, g, b } = parseHex(hex);
  const lin = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

export function isLight(hex: string): boolean {
  return luminance(hex) > 0.4;
}

/* ------------------------------------------------------------------------ */
/* Presets                                                                   */
/* ------------------------------------------------------------------------ */

/** Per-kind colours derived from one accent, for presets that are not hand-tuned. */
function kindsFrom(accent: string, secondary: string, background: string): Record<MapNodeKind, KindColors> {
  const light = isLight(background);
  const ink = light ? "#111111" : "#ffffff";
  const tone = (color: string, fillMix: number, textMix: number): KindColors => ({
    fill: mix(background, color, fillMix),
    stroke: color,
    text: mix(color, ink, textMix),
  });
  return {
    root: tone(accent, 0.32, 0.75),
    document: tone(accent, 0.24, 0.7),
    theme: tone(accent, 0.16, 0.55),
    hub: tone(secondary, 0.2, 0.6),
    concept: tone(mix(accent, secondary, 0.5), 0.1, 0.4),
    detail: tone(mix(secondary, background, 0.3), 0.06, 0.2),
  };
}

type Preset = {
  id: string;
  name: string;
  /** Swatch colours for the preset picker. */
  swatch: [string, string, string];
  style: Partial<Omit<MindmapStyle, "palette" | "overrides">> & { palette: Palette };
};

/** The look the canvas had before the studio, from the app theme. */
const MONOCHROME: Palette = {
  background: MINDMAP_COLORS.background,
  backgroundAlt: "#16171c",
  link: MINDMAP_COLORS.link,
  kinds: {
    root: { ...MINDMAP_COLORS.root },
    theme: { ...MINDMAP_COLORS.theme },
    concept: { ...MINDMAP_COLORS.concept },
    detail: { ...MINDMAP_COLORS.detail },
    document: { ...MINDMAP_COLORS.document },
    hub: { ...MINDMAP_COLORS.hub },
  },
  branches: ["#a9a3dc", "#8fb8de", "#9fd3b4", "#e4c590", "#e3a1a1", "#c9a4de"],
  depthFrom: MINDMAP_COLORS.root.stroke,
  depthTo: MINDMAP_COLORS.concept.stroke,
};

function palette(
  background: string,
  backgroundAlt: string,
  accent: string,
  secondary: string,
  branches: string[],
  link?: string,
): Palette {
  return {
    background,
    backgroundAlt,
    link: link ?? mix(background, accent, 0.35),
    kinds: kindsFrom(accent, secondary, background),
    branches,
    depthFrom: accent,
    depthTo: secondary,
  };
}

export const PRESETS: Preset[] = [
  {
    id: "monochrome",
    name: "Monochrome",
    swatch: ["#08090b", "#f4f5f7", "#a9a3dc"],
    style: { palette: MONOCHROME },
  },
  {
    id: "neon",
    name: "Neon Grid",
    swatch: ["#05010d", "#ff2bd6", "#00e5ff"],
    style: {
      palette: palette("#05010d", "#1a0533", "#ff2bd6", "#00e5ff", [
        "#ff2bd6", "#00e5ff", "#b4ff39", "#ffe600", "#ff6b2b", "#8c5bff",
      ]),
      colorMode: "branch",
      fill: "glass",
      glow: 0.8,
      backdrop: "grid",
      font: "grotesk",
      link: { width: 1.2, curvature: 0.2, dashed: false, gradient: true, opacity: 0.9, particles: 2, particleSpeed: 0.006, particleSize: 2 },
    },
  },
  {
    id: "aurora",
    name: "Aurora",
    swatch: ["#020b14", "#3cf2b4", "#8a6bff"],
    style: {
      palette: palette("#020b14", "#0c2a3a", "#3cf2b4", "#8a6bff", [
        "#3cf2b4", "#8a6bff", "#4cc9ff", "#d17bff", "#7dffcf", "#5b8cff",
      ]),
      colorMode: "depth",
      fill: "gradient",
      glow: 0.55,
      backdrop: "aurora",
      shape: "bubble",
      link: { width: 1, curvature: 0.3, dashed: false, gradient: true, opacity: 0.8, particles: 1, particleSpeed: 0.004, particleSize: 1.6 },
    },
  },
  {
    id: "sunset",
    name: "Sunset",
    swatch: ["#1a0612", "#ff8a3d", "#ff3d7f"],
    style: {
      palette: palette("#1a0612", "#3d0d2b", "#ffb03d", "#ff3d7f", [
        "#ffb03d", "#ff3d7f", "#ff7a3d", "#ffd93d", "#c23dff", "#ff5c5c",
      ]),
      colorMode: "branch",
      fill: "solid",
      glow: 0.4,
      backdrop: "linear",
      font: "serif",
      shape: "pill",
    },
  },
  {
    id: "vapor",
    name: "Vaporwave",
    swatch: ["#140024", "#ff71ce", "#01cdfe"],
    style: {
      palette: palette("#140024", "#2d0a4e", "#ff71ce", "#01cdfe", [
        "#ff71ce", "#01cdfe", "#05ffa1", "#b967ff", "#fffb96",
      ]),
      colorMode: "branch",
      fill: "outline",
      glow: 1,
      backdrop: "grid",
      font: "pixel",
      shape: "sharp",
      textScale: 0.8,
      link: { width: 1, curvature: 0, dashed: true, gradient: true, opacity: 0.9, particles: 3, particleSpeed: 0.008, particleSize: 1.8 },
    },
  },
  {
    id: "matrix",
    name: "Terminal",
    swatch: ["#000000", "#00ff66", "#0a3d1f"],
    style: {
      palette: palette("#000000", "#001a0b", "#00ff66", "#0f9d47", [
        "#00ff66", "#39ff14", "#00cc55", "#7dff9a",
      ], "#0f5c2c"),
      colorMode: "depth",
      fill: "outline",
      glow: 0.7,
      backdrop: "dots",
      font: "mono",
      shape: "sharp",
      link: { width: 0.8, curvature: 0, dashed: false, gradient: false, opacity: 1, particles: 1, particleSpeed: 0.01, particleSize: 1.4 },
    },
  },
  {
    id: "blueprint",
    name: "Blueprint",
    swatch: ["#0b3a7a", "#ffffff", "#8fc3ff"],
    style: {
      palette: {
        ...palette("#0b3a7a", "#0f4c9e", "#ffffff", "#8fc3ff", [
          "#ffffff", "#8fc3ff", "#ffe08f", "#b8f2ff",
        ], "#9cc4f2"),
        kinds: {
          root: { fill: "#0b3a7a", stroke: "#ffffff", text: "#ffffff" },
          document: { fill: "#0b3a7a", stroke: "#ffffff", text: "#ffffff" },
          theme: { fill: "#0b3a7a", stroke: "#dbeaff", text: "#ffffff" },
          hub: { fill: "#0b3a7a", stroke: "#ffe08f", text: "#fff3d1" },
          concept: { fill: "#0b3a7a", stroke: "#8fc3ff", text: "#dbeaff" },
          detail: { fill: "#0b3a7a", stroke: "#5f95d6", text: "#b8d4f5" },
        },
      },
      colorMode: "kind",
      fill: "outline",
      glow: 0,
      backdrop: "grid",
      font: "mono",
      shape: "box",
      link: { width: 0.8, curvature: 0, dashed: true, gradient: false, opacity: 1, particles: 0, particleSpeed: 0.006, particleSize: 2 },
    },
  },
  {
    id: "gold",
    name: "Black Gold",
    swatch: ["#0a0806", "#e8c372", "#8c6a2f"],
    style: {
      palette: palette("#0a0806", "#1c150b", "#e8c372", "#8c6a2f", [
        "#e8c372", "#f5dfa8", "#c99a4b", "#fff1c9",
      ]),
      colorMode: "depth",
      fill: "gradient",
      glow: 0.35,
      backdrop: "radial",
      font: "serif",
      shape: "pill",
    },
  },
  {
    id: "paper",
    name: "Paper",
    swatch: ["#f5f0e6", "#1d1d1f", "#d9480f"],
    style: {
      palette: palette("#f5f0e6", "#e9e0cf", "#1d1d1f", "#d9480f", [
        "#d9480f", "#1971c2", "#2b8a3e", "#9c36b5", "#e67700",
      ], "#b9ae98"),
      colorMode: "branch",
      fill: "solid",
      glow: 0,
      backdrop: "dots",
      font: "hand",
      shape: "underline",
      textScale: 1.3,
      link: { width: 1.2, curvature: 0.25, dashed: false, gradient: true, opacity: 0.9, particles: 0, particleSpeed: 0.006, particleSize: 2 },
    },
  },
  {
    id: "candy",
    name: "Candy",
    swatch: ["#1b1035", "#ffb3e6", "#b3f0ff"],
    style: {
      palette: palette("#1b1035", "#35206b", "#ffb3e6", "#b3f0ff", [
        "#ffb3e6", "#b3f0ff", "#c7ffb3", "#fff3b3", "#d9b3ff", "#ffc8b3",
      ]),
      colorMode: "branch",
      fill: "solid",
      glow: 0.5,
      backdrop: "stars",
      font: "grotesk",
      shape: "bubble",
      link: { width: 1.6, curvature: 0.35, dashed: false, gradient: true, opacity: 0.85, particles: 2, particleSpeed: 0.004, particleSize: 2.4 },
    },
  },
];

/* ------------------------------------------------------------------------ */
/* Defaults and parsing                                                      */
/* ------------------------------------------------------------------------ */

/** The look the mindmap had before the studio existed, so nothing changes until asked. */
export const DEFAULT_STYLE: MindmapStyle = {
  version: 1,
  preset: "monochrome",
  palette: MONOCHROME,
  colorMode: "kind",
  shape: "pill",
  fill: "solid",
  font: "sans",
  textScale: 1,
  glow: 0,
  borderWidth: 0.5,
  link: {
    width: 0.8,
    curvature: 0.18,
    dashed: false,
    gradient: false,
    opacity: 1,
    particles: 0,
    particleSpeed: 0.006,
    particleSize: 2,
  },
  backdrop: "solid",
  vignette: false,
  layout: "radial",
  spacing: 1,
  view: "2d",
  three: { layout: "free", node: "label", autoRotate: true, rotateSpeed: 1, bloom: 1 },
  caption: { show: false, text: "", watermark: true },
  focus: true,
  zoomReveal: true,
  overrides: {},
};

/** The default for a map, which differs only in layout: the global map is a forest. */
export function defaultStyleFor(layout: Layout2D): MindmapStyle {
  return { ...DEFAULT_STYLE, layout };
}

export function applyPreset(style: MindmapStyle, presetId: string): MindmapStyle {
  const preset = PRESETS.find((p) => p.id === presetId);
  if (!preset) return style;
  const base = DEFAULT_STYLE;
  // Start from the defaults so a preset never inherits a previous preset's
  // particles or backdrop, but keep what is about the map rather than the look.
  return {
    ...base,
    ...preset.style,
    link: { ...base.link, ...preset.style.link },
    three: style.three,
    view: style.view,
    layout: style.layout,
    spacing: style.spacing,
    caption: style.caption,
    focus: style.focus,
    zoomReveal: style.zoomReveal,
    overrides: style.overrides,
    preset: preset.id,
  };
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

function num(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function color(value: unknown, fallback: string): string {
  return isHexColor(value) ? value : fallback;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

const KINDS: MapNodeKind[] = ["root", "theme", "concept", "detail", "document", "hub"];

export const SHAPES: readonly NodeShape[] = ["pill", "box", "sharp", "hexagon", "bubble", "underline"];
export const COLOR_MODES: readonly ColorMode[] = ["kind", "branch", "depth"];
export const FILLS: readonly FillMode[] = ["solid", "glass", "outline", "gradient"];
export const BACKDROPS: readonly Backdrop[] = ["solid", "radial", "linear", "grid", "dots", "stars", "aurora"];
export const LAYOUTS_2D: readonly Layout2D[] = ["radial", "free", "tree-down", "tree-right"];
export const LAYOUTS_3D: readonly Layout3D[] = ["free", "radial", "tree"];
export const NODES_3D: readonly Node3D[] = ["label", "orb", "crystal"];
export const FONT_KEYS: readonly FontKey[] = ["sans", "mono", "grotesk", "orbitron", "serif", "hand", "pixel"];

const MAX_OVERRIDES = 2000;
const MAX_EMOJI_LENGTH = 8;
const MAX_CAPTION_LENGTH = 120;

function parsePalette(value: unknown, fallback: Palette): Palette {
  const raw = record(value);
  const kindsRaw = record(raw.kinds);
  const kinds = {} as Record<MapNodeKind, KindColors>;
  for (const kind of KINDS) {
    const k = record(kindsRaw[kind]);
    const f = fallback.kinds[kind];
    kinds[kind] = {
      fill: color(k.fill, f.fill),
      stroke: color(k.stroke, f.stroke),
      text: color(k.text, f.text),
    };
  }
  const branches = Array.isArray(raw.branches)
    ? raw.branches.filter(isHexColor).slice(0, 12)
    : [];
  return {
    background: color(raw.background, fallback.background),
    backgroundAlt: color(raw.backgroundAlt, fallback.backgroundAlt),
    link: color(raw.link, fallback.link),
    kinds,
    branches: branches.length > 0 ? branches : fallback.branches,
    depthFrom: color(raw.depthFrom, fallback.depthFrom),
    depthTo: color(raw.depthTo, fallback.depthTo),
  };
}

function parseOverrides(value: unknown): Record<string, NodeOverride> {
  const out: Record<string, NodeOverride> = {};
  let count = 0;
  for (const [id, entry] of Object.entries(record(value))) {
    if (count >= MAX_OVERRIDES) break;
    const raw = record(entry);
    const override: NodeOverride = {};
    if (isHexColor(raw.color)) override.color = raw.color;
    if (typeof raw.emoji === "string" && raw.emoji.trim().length > 0) {
      override.emoji = [...raw.emoji.trim()].slice(0, MAX_EMOJI_LENGTH).join("");
    }
    if (typeof raw.scale === "number") override.scale = num(raw.scale, 0.5, 3, 1);
    if (raw.hidden === true) override.hidden = true;
    if (Object.keys(override).length > 0) {
      out[id] = override;
      count++;
    }
  }
  return out;
}

/**
 * Any stored or pasted value, made into a valid style.
 *
 * Every field is checked on its own and falls back to `fallback` when it is
 * missing or wrong, so a style saved by an older build — or a hand-edited
 * style code — loads as much of itself as it can instead of failing outright.
 */
export function parseStyle(value: unknown, fallback: MindmapStyle = DEFAULT_STYLE): MindmapStyle {
  const raw = record(value);
  const link = record(raw.link);
  const three = record(raw.three);
  const caption = record(raw.caption);
  const f = fallback;

  return {
    version: 1,
    preset: typeof raw.preset === "string" ? raw.preset.slice(0, 40) : f.preset,
    palette: parsePalette(raw.palette, f.palette),
    colorMode: oneOf(raw.colorMode, COLOR_MODES, f.colorMode),
    shape: oneOf(raw.shape, SHAPES, f.shape),
    fill: oneOf(raw.fill, FILLS, f.fill),
    font: oneOf(raw.font, FONT_KEYS, f.font),
    textScale: num(raw.textScale, 0.6, 2, f.textScale),
    glow: num(raw.glow, 0, 1, f.glow),
    borderWidth: num(raw.borderWidth, 0, 3, f.borderWidth),
    link: {
      width: num(link.width, 0.2, 4, f.link.width),
      curvature: num(link.curvature, 0, 0.6, f.link.curvature),
      dashed: bool(link.dashed, f.link.dashed),
      gradient: bool(link.gradient, f.link.gradient),
      opacity: num(link.opacity, 0.1, 1, f.link.opacity),
      particles: Math.round(num(link.particles, 0, 6, f.link.particles)),
      particleSpeed: num(link.particleSpeed, 0.001, 0.03, f.link.particleSpeed),
      particleSize: num(link.particleSize, 0.5, 6, f.link.particleSize),
    },
    backdrop: oneOf(raw.backdrop, BACKDROPS, f.backdrop),
    vignette: bool(raw.vignette, f.vignette),
    layout: oneOf(raw.layout, LAYOUTS_2D, f.layout),
    spacing: num(raw.spacing, 0.5, 2.5, f.spacing),
    view: oneOf(raw.view, ["2d", "3d"] as const, f.view),
    three: {
      layout: oneOf(three.layout, LAYOUTS_3D, f.three.layout),
      node: oneOf(three.node, NODES_3D, f.three.node),
      autoRotate: bool(three.autoRotate, f.three.autoRotate),
      rotateSpeed: num(three.rotateSpeed, 0.1, 5, f.three.rotateSpeed),
      bloom: num(three.bloom, 0, 3, f.three.bloom),
    },
    caption: {
      show: bool(caption.show, f.caption.show),
      text:
        typeof caption.text === "string"
          ? caption.text.slice(0, MAX_CAPTION_LENGTH)
          : f.caption.text,
      watermark: bool(caption.watermark, f.caption.watermark),
    },
    focus: bool(raw.focus, f.focus),
    zoomReveal: bool(raw.zoomReveal, f.zoomReveal),
    overrides: parseOverrides(raw.overrides),
  };
}

/* ------------------------------------------------------------------------ */
/* Style codes                                                               */
/* ------------------------------------------------------------------------ */

const CODE_PREFIX = "doqtri-style:";

/**
 * A style as a pasteable string. Per-node overrides are left out: node ids
 * belong to one map, so they mean nothing on another.
 */
export function encodeStyle(style: MindmapStyle): string {
  const { overrides: _overrides, ...portable } = style;
  void _overrides;
  const json = JSON.stringify(portable);
  const bytes = new TextEncoder().encode(json);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return CODE_PREFIX + btoa(binary);
}

/** The style in a pasted code, keeping `current`'s overrides; null when it is not one. */
export function decodeStyle(code: string, current: MindmapStyle): MindmapStyle | null {
  const trimmed = code.trim();
  if (!trimmed.startsWith(CODE_PREFIX)) return null;
  try {
    const binary = atob(trimmed.slice(CODE_PREFIX.length));
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return { ...parseStyle(parsed, current), overrides: current.overrides };
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------------ */
/* Randomiser                                                                */
/* ------------------------------------------------------------------------ */

function pick<T>(items: readonly T[], rand: () => number): T {
  return items[Math.floor(rand() * items.length) % items.length];
}

function hsl(h: number, s: number, l: number): string {
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return toHex({ r: f(0) * 255, g: f(8) * 255, b: f(4) * 255 });
}

/** A fresh, coherent look: a harmonic palette plus random shapes and effects. */
export function randomStyle(current: MindmapStyle, rand: () => number = Math.random): MindmapStyle {
  const hue = rand() * 360;
  const spread = 25 + rand() * 140;
  const dark = rand() > 0.15;
  const background = dark ? hsl(hue, 0.5, 0.03 + rand() * 0.05) : hsl(hue, 0.35, 0.94);
  const backgroundAlt = dark ? hsl(hue + spread / 2, 0.6, 0.12) : hsl(hue + spread / 2, 0.4, 0.86);
  const sat = 0.75 + rand() * 0.25;
  const lightness = dark ? 0.6 : 0.42;
  const accent = hsl(hue, sat, lightness);
  const secondary = hsl(hue + spread, sat, lightness);
  const branchCount = 5;
  const branches = Array.from({ length: branchCount }, (_, i) =>
    hsl(hue + (i * 360) / branchCount, sat, lightness),
  );

  return {
    ...current,
    preset: "custom",
    palette: palette(background, backgroundAlt, accent, secondary, branches),
    colorMode: pick(COLOR_MODES, rand),
    shape: pick(SHAPES, rand),
    fill: pick(FILLS, rand),
    font: pick(FONT_KEYS, rand),
    glow: dark ? Math.round(rand() * 10) / 10 : 0,
    borderWidth: Math.round((0.4 + rand() * 1.2) * 10) / 10,
    link: {
      ...current.link,
      curvature: Math.round(rand() * 0.45 * 100) / 100,
      dashed: rand() > 0.8,
      gradient: rand() > 0.4,
      particles: rand() > 0.5 ? 1 + Math.floor(rand() * 3) : 0,
      width: Math.round((0.6 + rand() * 1.4) * 10) / 10,
    },
    backdrop: pick(BACKDROPS, rand),
    vignette: rand() > 0.5,
  };
}

/* ------------------------------------------------------------------------ */
/* Per-node colour resolution                                                */
/* ------------------------------------------------------------------------ */

/**
 * Which top-level branch every node belongs to, and how deep the map goes.
 *
 * With one root, the branches are the root's children — the classic mindmap
 * colouring. With several roots (the global map), each root is a branch, so a
 * document and everything it reaches share a colour. A node reachable from
 * two branches keeps whichever reached it first, breadth-first.
 */
export function assignBranches(graph: MindmapGraph): {
  branch: Map<string, number>;
  maxDepth: number;
} {
  const children = new Map<string, string[]>();
  const hasParent = new Set<string>();
  for (const link of graph.links) {
    const list = children.get(link.source) ?? [];
    list.push(link.target);
    children.set(link.source, list);
    hasParent.add(link.target);
  }

  const roots = graph.nodes.filter((node) => !hasParent.has(node.id));
  const branch = new Map<string, number>();
  const queue: string[] = [];

  if (roots.length === 1) {
    const root = roots[0].id;
    branch.set(root, -1);
    (children.get(root) ?? []).forEach((child, index) => {
      if (branch.has(child)) return;
      branch.set(child, index);
      queue.push(child);
    });
  } else {
    roots.forEach((root, index) => {
      branch.set(root.id, index);
      queue.push(root.id);
    });
  }

  while (queue.length > 0) {
    const id = queue.shift()!;
    const value = branch.get(id)!;
    for (const child of children.get(id) ?? []) {
      if (branch.has(child)) continue;
      branch.set(child, value);
      queue.push(child);
    }
  }

  // Anything still unassigned sits in a cycle with no entry point.
  for (const node of graph.nodes) if (!branch.has(node.id)) branch.set(node.id, 0);

  const maxDepth = graph.nodes.reduce((max, node) => Math.max(max, node.depth), 0);
  return { branch, maxDepth };
}

export type NodeLook = {
  fill: string;
  /** The second gradient stop when the fill mode is `gradient`. */
  fillTo?: string;
  stroke: string;
  text: string;
  /** The node's identifying colour: glow, particles and link gradients use it. */
  accent: string;
};

/** The colours one node is drawn in. */
export function resolveLook(
  style: MindmapStyle,
  node: { id: string; kind: MapNodeKind; depth: number },
  branchIndex: number,
  maxDepth: number,
): NodeLook {
  const { palette: p } = style;
  const bg = p.background;
  const light = isLight(bg);
  const ink = light ? "#111111" : "#ffffff";
  const kindColors = p.kinds[node.kind] ?? p.kinds.concept;
  const override = style.overrides[node.id]?.color;

  let base: KindColors;
  if (override) {
    base = { fill: mix(bg, override, 0.22), stroke: override, text: mix(override, ink, 0.65) };
  } else if (style.colorMode === "branch" && branchIndex >= 0 && node.kind !== "root") {
    const hue = p.branches[branchIndex % p.branches.length];
    // Deeper nodes fade toward the background, so the branch reads as a family.
    const fade = Math.min(0.5, node.depth * 0.08);
    const accent = mix(hue, bg, fade);
    base = { fill: mix(bg, accent, 0.2), stroke: accent, text: mix(accent, ink, 0.6) };
  } else if (style.colorMode === "depth") {
    const t = maxDepth > 0 ? node.depth / maxDepth : 0;
    const accent = mix(p.depthFrom, p.depthTo, t);
    base = { fill: mix(bg, accent, 0.2), stroke: accent, text: mix(accent, ink, 0.6) };
  } else {
    base = kindColors;
  }

  const accent = base.stroke;
  switch (style.fill) {
    case "glass":
      return { fill: withAlpha(accent, light ? 0.12 : 0.16), stroke: accent, text: base.text, accent };
    case "outline":
      return { fill: withAlpha(bg, 0.85), stroke: accent, text: mix(accent, ink, light ? 0.3 : 0.25), accent };
    case "gradient":
      return {
        fill: mix(bg, accent, 0.45),
        fillTo: mix(bg, accent, 0.08),
        stroke: accent,
        text: base.text,
        accent,
      };
    default:
      return { fill: base.fill, stroke: base.stroke, text: base.text, accent };
  }
}

/** The text a node shows, with its emoji when it has one. */
export function displayLabel(style: MindmapStyle, node: { id: string; label: string }): string {
  const emoji = style.overrides[node.id]?.emoji;
  return emoji ? `${emoji} ${node.label}` : node.label;
}

export function isHidden(style: MindmapStyle, id: string): boolean {
  return style.overrides[id]?.hidden === true;
}

/** Most particles a map animates at once, across all of its links. */
export const PARTICLE_BUDGET = 600;

/**
 * Particles per link, held to `PARTICLE_BUDGET` across the whole map.
 *
 * Each particle is drawn every frame forever, so on a map with a thousand links
 * even one apiece is a thousand extra draws per frame. A small map gets what
 * the style asks for; a big one gets fewer, down to none.
 */
export function particlesPerLink(style: MindmapStyle, linkCount: number): number {
  if (linkCount <= 0) return style.link.particles;
  return Math.min(style.link.particles, Math.floor(PARTICLE_BUDGET / linkCount));
}

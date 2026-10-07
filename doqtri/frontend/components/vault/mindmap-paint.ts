import type { Extent } from "@/lib/mindmap-layout";
import type { MapNode, MapNodeKind } from "@/lib/mindmap-graph";
import {
  displayLabel,
  isHidden,
  isLight,
  mix,
  withAlpha,
  type MindmapStyle,
  type NodeLook,
} from "@/lib/mindmap-style";

/**
 * Canvas drawing for the 2D mindmap, shared by the live view and the PNG export.
 *
 * Both go through these functions so a snapshot is exactly what was on screen,
 * only bigger — the export does not screenshot the live canvas, it repaints the
 * same nodes at the resolution asked for.
 */

/** A node as the simulation holds it. */
export type PaintNode = MapNode & { x?: number; y?: number; fx?: number; fy?: number };
/** A link as force-graph hands it over: ids until d3 swaps in the node objects. */
export type PaintLink = { source?: PaintNode | string | number; target?: PaintNode | string | number };

/** Everything a paint call needs besides the node itself. */
export type Painter = {
  style: MindmapStyle;
  family: string;
  weight: number;
  look: (node: PaintNode) => NodeLook;
  selectedId?: string | null;
};

/**
 * Base pill geometry per node kind, in graph units, before the text scale.
 *
 * The canvas draws labelled pills rather than dots: a mindmap is unreadable if
 * you have to zoom in far enough for the labels to appear.
 */
const BASE: Record<MapNodeKind, { font: number; padX: number; padY: number }> = {
  root: { font: 7, padX: 7, padY: 4.5 },
  document: { font: 6, padX: 6, padY: 4 },
  hub: { font: 5.5, padX: 5.5, padY: 3.5 },
  theme: { font: 5.5, padX: 5.5, padY: 3.5 },
  concept: { font: 4.5, padX: 4.5, padY: 3 },
  detail: { font: 4, padX: 4, padY: 2.5 },
};

function sizeOf(painter: Painter, node: PaintNode) {
  const base = BASE[node.kind] ?? BASE.concept;
  const scale = painter.style.textScale * (painter.style.overrides[node.id]?.scale ?? 1);
  return { font: base.font * scale, padX: base.padX * scale, padY: base.padY * scale };
}

const extentCache = new Map<string, Extent>();
let measureContext: CanvasRenderingContext2D | null | undefined;

/**
 * A node's half-size, measured once per font, shape, size and label.
 *
 * Measurement happens on a detached canvas rather than inside the paint
 * callback, because the collision pass needs sizes before the first frame is
 * drawn. One cache means the layout, the hit area and the drawing can never
 * disagree about a node's size.
 */
export function measureNode(painter: Painter, node: PaintNode): Extent {
  const label = displayLabel(painter.style, node);
  const { font, padX, padY } = sizeOf(painter, node);
  const shape = painter.style.shape;
  const key = `${painter.family}|${painter.weight}|${shape}|${font}|${label}`;
  const cached = extentCache.get(key);
  if (cached) return cached;

  if (measureContext === undefined) {
    measureContext =
      typeof document === "undefined" ? null : document.createElement("canvas").getContext("2d");
  }

  let textWidth: number;
  if (measureContext) {
    measureContext.font = `${painter.weight} ${font}px ${painter.family}`;
    textWidth = measureContext.measureText(label).width;
  } else {
    textWidth = label.length * font * 0.55;
  }

  let halfWidth = textWidth / 2 + padX;
  let halfHeight = font / 2 + padY;
  switch (shape) {
    case "hexagon":
      // The pointed ends sit outside the text box.
      halfWidth += halfHeight * 0.6;
      break;
    case "bubble":
      halfWidth *= 1.12;
      halfHeight *= 1.3;
      break;
    case "underline":
      halfWidth = textWidth / 2 + padX * 0.4;
      halfHeight = font / 2 + padY * 0.7;
      break;
  }

  const extent = { halfWidth, halfHeight };
  extentCache.set(key, extent);
  return extent;
}

function isPinned(node: PaintNode): boolean {
  return node.fx !== undefined || node.fy !== undefined;
}

/** Device pixels per graph unit under the context's current transform. */
function pixelScale(ctx: CanvasRenderingContext2D): number {
  const m = ctx.getTransform();
  return Math.hypot(m.a, m.b) || 1;
}

function tracePath(ctx: CanvasRenderingContext2D, style: MindmapStyle, x: number, y: number, hw: number, hh: number) {
  ctx.beginPath();
  switch (style.shape) {
    case "pill":
      ctx.roundRect(x - hw, y - hh, hw * 2, hh * 2, hh);
      break;
    case "box":
    case "underline":
      ctx.roundRect(x - hw, y - hh, hw * 2, hh * 2, hh * 0.45);
      break;
    case "sharp":
      ctx.rect(x - hw, y - hh, hw * 2, hh * 2);
      break;
    case "hexagon": {
      const tip = hh * 0.6;
      ctx.moveTo(x - hw, y);
      ctx.lineTo(x - hw + tip, y - hh);
      ctx.lineTo(x + hw - tip, y - hh);
      ctx.lineTo(x + hw, y);
      ctx.lineTo(x + hw - tip, y + hh);
      ctx.lineTo(x - hw + tip, y + hh);
      ctx.closePath();
      break;
    }
    case "bubble":
      ctx.ellipse(x, y, hw, hh, 0, 0, Math.PI * 2);
      break;
  }
}

export function drawNode(ctx: CanvasRenderingContext2D, node: PaintNode, painter: Painter) {
  const { style } = painter;
  if (isHidden(style, node.id)) return;

  const look = painter.look(node);
  const { halfWidth: hw, halfHeight: hh } = measureNode(painter, node);
  const { font } = sizeOf(painter, node);
  const x = node.x ?? 0;
  const y = node.y ?? 0;
  const scale = pixelScale(ctx);
  const pinned = isPinned(node);

  ctx.save();
  if (style.glow > 0) {
    ctx.shadowColor = look.accent;
    ctx.shadowBlur = style.glow * 9 * scale;
  }

  if (style.shape === "underline") {
    // No body: the label floats, and a bar under it carries the colour. A
    // backdrop-coloured plate behind the text keeps links from crossing it.
    ctx.save();
    ctx.shadowBlur = 0;
    tracePath(ctx, { ...style, shape: "box" }, x, y, hw, hh);
    ctx.fillStyle = style.palette.background;
    ctx.fill();
    ctx.restore();
    ctx.beginPath();
    ctx.moveTo(x - hw, y + hh);
    ctx.lineTo(x + hw, y + hh);
    ctx.strokeStyle = look.accent;
    ctx.lineWidth = Math.max(0.6, style.borderWidth * 1.6) * (pinned ? 1.6 : 1);
    ctx.lineCap = "round";
    ctx.stroke();
  } else {
    tracePath(ctx, style, x, y, hw, hh);
    if (style.fill === "glass" || style.fill === "outline") {
      // Translucent fills sit on a plate of the backdrop colour, so the links
      // running into the node stop at its edge instead of showing through.
      ctx.save();
      ctx.shadowBlur = 0;
      ctx.fillStyle = style.palette.background;
      ctx.fill();
      ctx.restore();
    }
    if (look.fillTo) {
      const gradient = ctx.createLinearGradient(x, y - hh, x, y + hh);
      gradient.addColorStop(0, look.fill);
      gradient.addColorStop(1, look.fillTo);
      ctx.fillStyle = gradient;
    } else {
      ctx.fillStyle = look.fill;
    }
    ctx.fill();

    // A hand-placed node reads as deliberate, so its outline is firmer.
    const border = pinned ? Math.max(1.1, style.borderWidth * 1.8) : style.borderWidth;
    if (border > 0) {
      ctx.strokeStyle = look.stroke;
      ctx.lineWidth = border;
      ctx.stroke();
    }
  }

  // Text glows only on outline fills, where it is the brightest thing there.
  if (!(style.glow > 0 && style.fill === "outline")) ctx.shadowBlur = 0;
  else ctx.shadowBlur = style.glow * 5 * scale;

  ctx.font = `${painter.weight} ${font}px ${painter.family}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = look.text;
  ctx.fillText(displayLabel(style, node), x, y + (style.shape === "underline" ? -hh * 0.1 : 0));

  if (painter.selectedId === node.id) {
    ctx.shadowBlur = 0;
    const gap = 2.5;
    tracePath(ctx, { ...style, shape: style.shape === "underline" ? "box" : style.shape }, x, y, hw + gap, hh + gap);
    ctx.setLineDash([2, 1.5]);
    ctx.lineWidth = 0.8;
    ctx.strokeStyle = isLight(style.palette.background) ? "#111111" : "#ffffff";
    ctx.stroke();
  }
  ctx.restore();
}

/** The curve's control point, matching force-graph's so particles ride the drawn line. */
export function controlPoint(
  sx: number,
  sy: number,
  tx: number,
  ty: number,
  curvature: number,
): { x: number; y: number } | null {
  if (!curvature) return null;
  const length = Math.hypot(tx - sx, ty - sy);
  if (length === 0) return null;
  const angle = Math.atan2(ty - sy, tx - sx);
  const d = length * curvature;
  return {
    x: (sx + tx) / 2 + d * Math.cos(angle - Math.PI / 2),
    y: (sy + ty) / 2 + d * Math.sin(angle - Math.PI / 2),
  };
}

export function drawLink(ctx: CanvasRenderingContext2D, link: PaintLink, painter: Painter) {
  const { source, target } = link;
  if (typeof source !== "object" || typeof target !== "object") return;
  const { style } = painter;
  if (isHidden(style, source.id) || isHidden(style, target.id)) return;

  const sx = source.x ?? 0;
  const sy = source.y ?? 0;
  const tx = target.x ?? 0;
  const ty = target.y ?? 0;
  const cp = controlPoint(sx, sy, tx, ty, style.link.curvature);

  ctx.save();
  ctx.beginPath();
  ctx.moveTo(sx, sy);
  if (cp) ctx.quadraticCurveTo(cp.x, cp.y, tx, ty);
  else ctx.lineTo(tx, ty);

  const opacity = style.link.opacity;
  if (style.link.gradient) {
    const gradient = ctx.createLinearGradient(sx, sy, tx, ty);
    gradient.addColorStop(0, withAlpha(painter.look(source).accent, opacity));
    gradient.addColorStop(1, withAlpha(painter.look(target).accent, opacity * 0.85));
    ctx.strokeStyle = gradient;
  } else {
    ctx.strokeStyle = withAlpha(style.palette.link, opacity);
  }
  if (style.glow >= 0.5) {
    ctx.shadowColor = painter.look(target).accent;
    ctx.shadowBlur = style.glow * 4 * pixelScale(ctx);
  }
  ctx.lineWidth = style.link.width * 0.6;
  if (style.link.dashed) ctx.setLineDash([3, 2.5]);
  ctx.lineCap = "round";
  ctx.stroke();
  ctx.restore();
}

/* ------------------------------------------------------------------------ */
/* Backdrops                                                                 */
/* ------------------------------------------------------------------------ */

/** Deterministic noise, so the starfield is the same every frame and in exports. */
function seeded(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Star = { x: number; y: number; r: number; a: number; tint: number };
const STARS: Star[] = (() => {
  const rand = seeded(7);
  return Array.from({ length: 260 }, () => ({
    x: rand(),
    y: rand(),
    r: rand() ** 3 * 1.6 + 0.3,
    a: 0.25 + rand() * 0.75,
    tint: rand(),
  }));
})();

/**
 * The screen-space part of the backdrop: colour, gradients, stars, vignette.
 * Drawn in device pixels, with no transform, over the whole canvas.
 */
export function paintBackdrop(ctx: CanvasRenderingContext2D, width: number, height: number, style: MindmapStyle) {
  const { background: bg, backgroundAlt: alt, branches } = style.palette;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, width, height);
  const diag = Math.hypot(width, height);

  switch (style.backdrop) {
    case "radial":
    case "grid":
    case "dots": {
      const gradient = ctx.createRadialGradient(width / 2, height * 0.45, 0, width / 2, height / 2, diag * 0.6);
      gradient.addColorStop(0, withAlpha(alt, style.backdrop === "radial" ? 1 : 0.6));
      gradient.addColorStop(1, withAlpha(alt, 0));
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, width, height);
      break;
    }
    case "linear": {
      const gradient = ctx.createLinearGradient(0, 0, width, height);
      gradient.addColorStop(0, bg);
      gradient.addColorStop(1, alt);
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, width, height);
      break;
    }
    case "stars": {
      const glow = ctx.createRadialGradient(width * 0.3, height * 0.2, 0, width * 0.3, height * 0.2, diag * 0.7);
      glow.addColorStop(0, withAlpha(alt, 0.9));
      glow.addColorStop(1, withAlpha(alt, 0));
      ctx.fillStyle = glow;
      ctx.fillRect(0, 0, width, height);
      const unit = Math.max(1, diag / 1600);
      for (const star of STARS) {
        const tint = star.tint > 0.8 ? branches[Math.floor(star.tint * 97) % branches.length] : "#ffffff";
        ctx.fillStyle = withAlpha(tint, star.a);
        ctx.beginPath();
        ctx.arc(star.x * width, star.y * height, star.r * unit, 0, Math.PI * 2);
        ctx.fill();
      }
      break;
    }
    case "aurora": {
      const blobs: [number, number, number, string][] = [
        [0.2, 0.25, 0.55, branches[0] ?? alt],
        [0.8, 0.35, 0.5, branches[1] ?? alt],
        [0.5, 0.95, 0.6, branches[2] ?? alt],
      ];
      ctx.globalCompositeOperation = isLight(bg) ? "multiply" : "screen";
      for (const [bx, by, radius, tone] of blobs) {
        const gradient = ctx.createRadialGradient(bx * width, by * height, 0, bx * width, by * height, diag * radius);
        gradient.addColorStop(0, withAlpha(tone, 0.32));
        gradient.addColorStop(1, withAlpha(tone, 0));
        ctx.fillStyle = gradient;
        ctx.fillRect(0, 0, width, height);
      }
      ctx.globalCompositeOperation = "source-over";
      break;
    }
  }

  if (style.vignette) {
    const gradient = ctx.createRadialGradient(width / 2, height / 2, diag * 0.25, width / 2, height / 2, diag * 0.62);
    gradient.addColorStop(0, "rgba(0,0,0,0)");
    gradient.addColorStop(1, isLight(bg) ? "rgba(60,40,10,0.25)" : "rgba(0,0,0,0.65)");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, width, height);
  }
  ctx.restore();
}

/**
 * The graph-space part of the backdrop: a grid or dot field that pans and
 * zooms with the map, like a design canvas. Drawn under the current transform.
 */
export function paintGraphPattern(ctx: CanvasRenderingContext2D, width: number, height: number, style: MindmapStyle) {
  if (style.backdrop !== "grid" && style.backdrop !== "dots") return;

  const m = ctx.getTransform();
  const scale = pixelScale(ctx);
  const inverse = m.inverse();
  const a = inverse.transformPoint(new DOMPoint(0, 0));
  const b = inverse.transformPoint(new DOMPoint(width, height));
  const minX = Math.min(a.x, b.x);
  const maxX = Math.max(a.x, b.x);
  const minY = Math.min(a.y, b.y);
  const maxY = Math.max(a.y, b.y);

  // Double the cell until it is at least a dozen pixels across, so zooming out
  // never turns the pattern into a solid wash.
  let cell = 20;
  while (cell * scale < 12) cell *= 2;

  const tone = mix(style.palette.background, style.palette.link, 0.9);
  const light = isLight(style.palette.background);
  ctx.save();

  if (style.backdrop === "grid") {
    ctx.lineWidth = 1 / scale;
    for (const major of [false, true]) {
      const step = major ? cell * 5 : cell;
      ctx.strokeStyle = withAlpha(tone, major ? (light ? 0.35 : 0.45) : light ? 0.15 : 0.2);
      ctx.beginPath();
      for (let x = Math.floor(minX / step) * step; x <= maxX; x += step) {
        ctx.moveTo(x, minY);
        ctx.lineTo(x, maxY);
      }
      for (let y = Math.floor(minY / step) * step; y <= maxY; y += step) {
        ctx.moveTo(minX, y);
        ctx.lineTo(maxX, y);
      }
      ctx.stroke();
    }
  } else {
    ctx.fillStyle = withAlpha(tone, light ? 0.45 : 0.55);
    const r = 1.1 / scale;
    for (let x = Math.floor(minX / cell) * cell; x <= maxX; x += cell) {
      for (let y = Math.floor(minY / cell) * cell; y <= maxY; y += cell) {
        ctx.fillRect(x - r, y - r, r * 2, r * 2);
      }
    }
  }
  ctx.restore();
}

/* ------------------------------------------------------------------------ */
/* Export                                                                    */
/* ------------------------------------------------------------------------ */

export type SnapshotFrame =
  /** Fit every visible node, centred, with a margin. */
  | { kind: "fit" }
  /** What the live view shows: its centre and zoom, scaled up to the output. */
  | { kind: "view"; centerX: number; centerY: number; zoom: number; viewWidth: number; viewHeight: number };

export type SnapshotOptions = {
  width: number;
  height: number;
  frame: SnapshotFrame;
  /** Caption drawn bottom-left, or nothing. */
  title?: string;
  watermark: boolean;
  /** The mark drawn beside the watermark, from `loadWatermarkLogo`. */
  logo?: HTMLImageElement | null;
};

const MARK_URL = "/doqtri-mark.svg";
/** The colours the mark file is drawn in, swapped out per theme. */
const MARK_INK = "#f4f5f7";
const MARK_FILL = "#15171b";

let markSource: Promise<string | null> | null = null;

/**
 * The Doqtri mark, recoloured to sit on this style's background.
 *
 * The file in public/ is drawn light-on-dark; on a light theme that would be a
 * white smudge, so its two colours are replaced before it is rasterised. Null
 * when it cannot be loaded — the watermark then falls back to text alone
 * rather than failing the export.
 */
export async function loadWatermarkLogo(style: MindmapStyle): Promise<HTMLImageElement | null> {
  markSource ??= fetch(MARK_URL)
    .then((res) => (res.ok ? res.text() : null))
    .catch(() => null);
  const svg = await markSource;
  if (!svg) {
    markSource = null;
    return null;
  }

  const light = isLight(style.palette.background);
  const tinted = svg
    .replaceAll(MARK_INK, light ? "#111111" : MARK_INK)
    .replaceAll(MARK_FILL, style.palette.background);

  const image = new Image();
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(tinted)}`;
  try {
    await image.decode();
    return image;
  } catch {
    return null;
  }
}

/** Caption and watermark, shared with the 3D export. Drawn in output pixels. */
export function paintCaption(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  style: MindmapStyle,
  family: string,
  title: string | undefined,
  watermark: boolean,
  logo?: HTMLImageElement | null,
) {
  const unit = Math.min(width, height);
  const margin = unit * 0.05;
  const light = isLight(style.palette.background);
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.textBaseline = "alphabetic";

  if (title) {
    const size = unit * 0.052;
    ctx.font = `700 ${size}px ${family}`;
    ctx.textAlign = "left";
    const accent = style.palette.kinds.root.stroke;
    ctx.shadowColor = withAlpha(accent, 0.6);
    ctx.shadowBlur = style.glow * size * 0.6;
    ctx.fillStyle = light ? "#111111" : "#ffffff";
    ctx.fillText(title, margin, height - margin, width - margin * 2 - unit * 0.25);
    ctx.shadowBlur = 0;
    ctx.fillStyle = accent;
    ctx.fillRect(margin, height - margin + size * 0.3, size * 1.6, Math.max(2, size * 0.08));
  }

  if (watermark) {
    const size = unit * 0.022;
    ctx.font = `600 ${size}px ui-sans-serif, system-ui, sans-serif`;
    ctx.textAlign = "right";
    ctx.fillStyle = light ? "rgba(0,0,0,0.45)" : "rgba(255,255,255,0.55)";
    const label = "made with doqtri";
    ctx.fillText(label, width - margin, height - margin);

    if (logo) {
      // The mark sits left of the words, centred on their x-height.
      const logoHeight = size * 1.7;
      const logoWidth = logoHeight * (200 / 180);
      const textWidth = ctx.measureText(label).width;
      const x = width - margin - textWidth - size * 0.5 - logoWidth;
      const y = height - margin - size * 0.36 - logoHeight / 2;
      ctx.globalAlpha = 0.85;
      ctx.drawImage(logo, x, y, logoWidth, logoHeight);
      ctx.globalAlpha = 1;
    }
  }
  ctx.restore();
}

/** Repaints the map into a fresh canvas at the size asked for. */
export function renderSnapshot(
  nodes: PaintNode[],
  links: PaintLink[],
  painter: Painter,
  options: SnapshotOptions,
): HTMLCanvasElement {
  const { width, height, frame } = options;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas is not available in this browser");

  const visible = nodes.filter((node) => !isHidden(painter.style, node.id));
  paintBackdrop(ctx, width, height, painter.style);

  let scale: number;
  let centerX: number;
  let centerY: number;
  if (frame.kind === "view") {
    // Cover, not contain: the output is filled the way the screen was.
    scale = frame.zoom * Math.max(width / frame.viewWidth, height / frame.viewHeight);
    centerX = frame.centerX;
    centerY = frame.centerY;
  } else {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const node of visible) {
      const { halfWidth, halfHeight } = measureNode(painter, node);
      minX = Math.min(minX, (node.x ?? 0) - halfWidth);
      maxX = Math.max(maxX, (node.x ?? 0) + halfWidth);
      minY = Math.min(minY, (node.y ?? 0) - halfHeight);
      maxY = Math.max(maxY, (node.y ?? 0) + halfHeight);
    }
    if (!Number.isFinite(minX)) {
      minX = minY = -1;
      maxX = maxY = 1;
    }
    // Leave room at the bottom for the caption so it never sits on a node.
    const reserve = options.title || options.watermark ? Math.min(width, height) * 0.12 : 0;
    const margin = Math.min(width, height) * 0.07;
    scale = Math.min(
      (width - margin * 2) / Math.max(1, maxX - minX),
      (height - margin * 2 - reserve) / Math.max(1, maxY - minY),
    );
    centerX = (minX + maxX) / 2;
    centerY = (minY + maxY) / 2 + reserve / 2 / scale;
  }

  ctx.setTransform(scale, 0, 0, scale, width / 2 - centerX * scale, height / 2 - centerY * scale);
  paintGraphPattern(ctx, width, height, painter.style);
  for (const link of links) drawLink(ctx, link, painter);
  for (const node of visible) drawNode(ctx, node, painter);

  paintCaption(ctx, width, height, painter.style, painter.family, options.title, options.watermark, options.logo);
  return canvas;
}

export function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("Could not encode the image"))), "image/png");
  });
}

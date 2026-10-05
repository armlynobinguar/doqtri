import { useId } from "react";
import { GlyphPath, type Glyph } from "./glyphs";

// Triangle layout on a 200×180 canvas: tested (top) feeds both anchored
// (bottom-left) and shipped (bottom-right); anchored feeds shipped.
// `tint` is the ring color in the brand's color variant of the mark.
const NODES: { glyph: Glyph; x: number; y: number; tint: string }[] = [
  { glyph: "check", x: 100, y: 38, tint: "var(--brand-purple, #b38bef)" },
  { glyph: "stellar", x: 38, y: 142, tint: "var(--brand-green, #43c27a)" },
  { glyph: "hash", x: 162, y: 142, tint: "var(--brand-blue, #4a9df0)" },
];
const R = 28;
const EDGES: [number, number][] = [
  [0, 1],
  [0, 2],
  [1, 2],
];

function edgePoints(a: (typeof NODES)[number], b: (typeof NODES)[number]) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  const ux = dx / len;
  const uy = dy / len;
  const gap = R + 7;
  return {
    x1: a.x + ux * gap,
    y1: a.y + uy * gap,
    x2: b.x - ux * (gap + 2),
    y2: b.y - uy * (gap + 2),
    mx: (a.x + b.x) / 2,
    my: (a.y + b.y) / 2,
  };
}

type Props = {
  className?: string;
  /** Soft outer glow around the rings (off for tiny sizes such as the nav). */
  glow?: boolean;
  /** Accessible name; pass "" when the mark sits next to the word "Doqtri". */
  title?: string;
  /** "mono" draws in currentColor; "color" tints each ring with a brand accent. */
  tone?: "mono" | "color";
};

/** The Doqtri mark: ✓ → Ø → # joined block by block. */
export function DoqtriMark({ className, glow = true, title = "Doqtri", tone = "mono" }: Props) {
  const id = useId().replace(/:/g, "");
  return (
    <svg
      viewBox="0 0 200 180"
      className={className}
      fill="none"
      {...(title ? { role: "img", "aria-label": title } : { "aria-hidden": true })}
    >
      <defs>
        <marker id={`arrow-${id}`} viewBox="0 0 10 10" refX="7" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
          <path d="M1 1 9 5 1 9Z" fill="currentColor" />
        </marker>
        {glow && (
          <filter id={`glow-${id}`} x="-40%" y="-40%" width="180%" height="180%">
            <feGaussianBlur stdDeviation="3.2" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        )}
      </defs>

      <g stroke="currentColor" strokeLinecap="round" strokeWidth="3.2">
        {EDGES.map(([from, to]) => {
          const p = edgePoints(NODES[from], NODES[to]);
          return (
            <g key={`${from}-${to}`}>
              <line x1={p.x1} y1={p.y1} x2={p.x2} y2={p.y2} markerEnd={`url(#arrow-${id})`} opacity="0.9" />
              <circle cx={p.mx} cy={p.my} r="3.6" fill="currentColor" stroke="none" opacity="0.9" />
            </g>
          );
        })}
      </g>

      <g filter={glow ? `url(#glow-${id})` : undefined}>
        {NODES.map((n) => (
          <g key={n.glyph} transform={`translate(${n.x} ${n.y})`} color={tone === "color" ? n.tint : undefined}>
            <circle r={R} fill="var(--mark-fill, #11151c)" stroke="currentColor" strokeWidth="4.5" />
            <circle r={R - 6} stroke="currentColor" strokeOpacity="0.35" strokeWidth="1.4" />
            <g transform="translate(-19.2 -19.2) scale(1.6)" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <GlyphPath glyph={n.glyph} />
            </g>
          </g>
        ))}
      </g>
    </svg>
  );
}

"use client";

import { useEffect, useState } from "react";
import { GlyphPath, type Glyph } from "@/components/brand/glyphs";
import styles from "./landing-mindmap.module.css";

type Status = "Planned" | "Building" | "Built" | "Verified";

const NODES: { id: string; label: string; x: number; y: number; status: Status }[] = [
  { id: "root", label: "Launch plan", x: 480, y: 64, status: "Verified" },
  { id: "ingest", label: "Doc ingest", x: 170, y: 200, status: "Verified" },
  { id: "compile", label: "Mindmap", x: 480, y: 200, status: "Built" },
  { id: "ship", label: "Ship proof", x: 790, y: 200, status: "Building" },
  { id: "ops", label: "Ops", x: 310, y: 340, status: "Planned" },
  { id: "audit", label: "Audit", x: 650, y: 340, status: "Planned" },
];

// Each node is a glass pill: status glyph on the left, label beside it.
const PILL_W = 196;
const PILL_H = 48;

const EDGES = [
  ["root", "ingest"],
  ["root", "compile"],
  ["root", "ship"],
  ["ingest", "ops"],
  ["compile", "audit"],
  ["ship", "audit"],
] as const;

// Status reads through the brand blocks: anchored (Ø) once verified, hashed (#)
// once there is something built, a plain check while it's only planned.
const STATUS_GLYPH: Record<Status, Glyph> = {
  Planned: "check",
  Building: "hash",
  Built: "hash",
  Verified: "stellar",
};

export function LandingMindmap() {
  const [drawn, setDrawn] = useState(false);
  useEffect(() => {
    const t = window.setTimeout(() => setDrawn(true), 80);
    return () => window.clearTimeout(t);
  }, []);

  const byId = Object.fromEntries(NODES.map((n) => [n.id, n]));

  return (
    <div className={styles.stage} aria-hidden>
      <svg className={`${styles.svg} ${drawn ? styles.drawn : ""}`} viewBox="0 0 960 420" preserveAspectRatio="xMidYMid meet">
        {EDGES.map(([from, to], i) => {
          const a = byId[from];
          const b = byId[to];
          return (
            <path
              key={`${from}-${to}`}
              className={styles.edge}
              style={{ animationDelay: `${i * 0.1}s` }}
              // Pill bottom to pill top, so the thin connectors never cross a label.
              d={`M ${a.x} ${a.y + PILL_H / 2} C ${a.x} ${(a.y + b.y) / 2}, ${b.x} ${(a.y + b.y) / 2}, ${b.x} ${b.y - PILL_H / 2}`}
            />
          );
        })}
        {NODES.map((node, i) => (
          <g
            key={node.id}
            className={`${styles.node} ${styles[node.status.toLowerCase()]}`}
            style={{ animationDelay: `${0.15 + i * 0.07}s` }}
            transform={`translate(${node.x} ${node.y})`}
          >
            <rect
              x={-PILL_W / 2}
              y={-PILL_H / 2}
              width={PILL_W}
              height={PILL_H}
              rx={14}
              className={styles.pill}
            />
            <line x1={-PILL_W / 2 + 14} x2={PILL_W / 2 - 14} y1={-PILL_H / 2 + 0.5} y2={-PILL_H / 2 + 0.5} className={styles.sheen} />
            <g transform={`translate(${-PILL_W / 2 + 14} -10.8) scale(0.9)`} className={styles.glyph}>
              <GlyphPath glyph={STATUS_GLYPH[node.status]} />
            </g>
            <text className={styles.label} x={-PILL_W / 2 + 46} y={1}>
              {node.label}
            </text>
            <text className={styles.status} y={PILL_H / 2 + 16}>
              {node.status}
            </text>
          </g>
        ))}
      </svg>
    </div>
  );
}

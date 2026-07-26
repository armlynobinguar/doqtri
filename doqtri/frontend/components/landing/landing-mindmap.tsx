"use client";

import { useEffect, useState } from "react";
import styles from "./landing-mindmap.module.css";

const NODES = [
  { id: "root", label: "Launch plan", x: 480, y: 70, status: "Verified" },
  { id: "ingest", label: "Doc ingest", x: 160, y: 210, status: "Verified" },
  { id: "compile", label: "Mindmap", x: 480, y: 210, status: "Built" },
  { id: "ship", label: "Ship proof", x: 800, y: 210, status: "Building" },
  { id: "ops", label: "Ops", x: 300, y: 360, status: "Planned" },
  { id: "audit", label: "Audit", x: 660, y: 360, status: "Planned" },
] as const;

const EDGES = [
  ["root", "ingest"],
  ["root", "compile"],
  ["root", "ship"],
  ["ingest", "ops"],
  ["compile", "audit"],
  ["ship", "audit"],
] as const;

const COLORS: Record<string, string> = {
  Planned: "#808080",
  Building: "#4d9dff",
  Built: "#7dd3a0",
  Verified: "#c8a2ff",
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
      <svg
        className={`${styles.svg} ${drawn ? styles.drawn : ""}`}
        viewBox="0 0 960 440"
        preserveAspectRatio="xMidYMid meet"
      >
        {EDGES.map(([from, to], i) => {
          const a = byId[from];
          const b = byId[to];
          return (
            <path
              key={`${from}-${to}`}
              className={styles.edge}
              style={{ animationDelay: `${i * 0.1}s` }}
              d={`M ${a.x} ${a.y} C ${a.x} ${(a.y + b.y) / 2}, ${b.x} ${
                (a.y + b.y) / 2
              }, ${b.x} ${b.y}`}
            />
          );
        })}
        {NODES.map((node, i) => (
          <g
            key={node.id}
            className={styles.node}
            style={{ animationDelay: `${0.15 + i * 0.07}s` }}
            transform={`translate(${node.x} ${node.y})`}
          >
            <circle r={18} className={styles.circle} stroke={COLORS[node.status]} />
            <text className={styles.label} y={34}>
              {node.label}
            </text>
            <text className={styles.status} y={48}>
              {node.status}
            </text>
          </g>
        ))}
      </svg>
    </div>
  );
}

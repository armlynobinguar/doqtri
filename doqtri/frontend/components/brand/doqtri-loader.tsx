"use client";

import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { DoqtriMark, NODES, R } from "./doqtri-mark";
import styles from "./doqtri-loader.module.css";

type Props = {
  className?: string;
  /** Rotate status lines under the mark. Off for small inline uses. */
  messages?: boolean;
};

const LINES = [
  "Loading…",
  "Working on it…",
  "Hashing…",
  "Anchoring…",
  "Consulting the ledger…",
  "Untangling links…",
  "Mapping nodes…",
  "Checking proofs…",
  "Following the arrows…",
  "Almost there…",
];
const FIRST_LINE_MS = 900;
const LINE_MS = 2400;

// The server render and its hydration must agree, so the first loader on a
// page opens on LINES[0]. Loaders mounted later (client navigations) start on
// a random line, since most navigations finish before the first swap.
let hydrated = false;

function randomLine(except: number) {
  const next = Math.floor(Math.random() * (LINES.length - 1));
  return next >= except ? next + 1 : next;
}

// The ring walks the mark's own triangle, ✓ → Ø → # → ✓, along the arrows.
// The ring is drawn at ✓ and the path is relative to it: SMIL only starts once
// the page has loaded — exactly when a loader is on screen — so the static
// position must already be correct. An absolute path on an unplaced circle
// leaves the ring parked at the SVG origin until then.
const [A, B, C] = NODES;
const PATH = `M0 0 L${B.x - A.x} ${B.y - A.y} L${C.x - A.x} ${C.y - A.y} Z`;
const SIDE = Math.hypot(B.x - A.x, B.y - A.y);
const BASE = C.x - B.x;
const TOTAL = SIDE * 2 + BASE;
const AT_B = (SIDE / TOTAL).toFixed(4);
const AT_C = ((SIDE + BASE) / TOTAL).toFixed(4);

// Each lap: hold on a node, hop, hold, hop, hold, hop. SMIL rather than CSS
// transforms, which some browsers ignore on SVG children.
const DUR = "2.7s";
const TIMES = "0;0.16;0.333;0.493;0.666;0.826;1";
const EASE = "0 0 1 1;0.65 0 0.35 1;0 0 1 1;0.65 0 0.35 1;0 0 1 1;0.65 0 0.35 1";
const PURPLE = "#a9a3dc";
const GREEN = "#7cc4a0";
const BLUE = "#a3b8d9";
// The mark's resting colour (--brand-text); SMIL values cannot read CSS vars.
const IDLE = "#f4f5f7";

// When the ring lands on each node, as a fraction of the lap.
const ARRIVALS = [
  { node: A, at: 0, tint: PURPLE },
  { node: B, at: 0.333, tint: GREEN },
  { node: C, at: 0.666, tint: BLUE },
];
const SWELL = 0.06;
const SETTLE = 0.18;

/** keyTimes/values for a one-shot pulse starting at `at`, idle the rest of the lap. */
function pulse(at: number, idle: number | string, peak: number | string, end: number | string) {
  const t = (n: number) => n.toFixed(3);
  if (at === 0) {
    return { keyTimes: `0;${t(SWELL)};${t(SETTLE)};1`, values: `${idle};${peak};${end};${idle}` };
  }
  return {
    keyTimes: `0;${t(at)};${t(at + SWELL)};${t(at + SETTLE)};1`,
    values: `${idle};${idle};${peak};${end};${idle}`,
  };
}

/** The Doqtri mark with a ring hopping node to node, plus rotating status lines. */
export function DoqtriLoader({ className, messages = true }: Props) {
  const [line, setLine] = useState(() => (hydrated ? randomLine(-1) : 0));

  useEffect(() => {
    hydrated = true;
    if (!messages) return;
    let interval: ReturnType<typeof setInterval> | undefined;
    const first = setTimeout(() => {
      setLine((cur) => randomLine(cur));
      interval = setInterval(() => setLine((cur) => randomLine(cur)), LINE_MS);
    }, FIRST_LINE_MS);
    return () => {
      clearTimeout(first);
      clearInterval(interval);
    };
  }, [messages]);

  return (
    <div role="status" className={cn(styles.wrap, className)}>
      <div className={styles.loader}>
        <DoqtriMark
          className={styles.mark}
          glow={false}
          title=""
          nodeChildren={(i) => {
            const { at, tint } = ARRIVALS[i];
            return (
              <>
                {/* The node itself — ring, inner ring and icon — swells and takes its tint. */}
                <animateTransform
                  attributeName="transform"
                  type="scale"
                  additive="sum"
                  dur={DUR}
                  repeatCount="indefinite"
                  {...pulse(at, 1, 1.16, 1)}
                />
                <animate
                  attributeName="color"
                  dur={DUR}
                  repeatCount="indefinite"
                  {...pulse(at, IDLE, tint, IDLE)}
                />
              </>
            );
          }}
        />
        <svg viewBox="0 0 200 180" className={styles.overlay} fill="none" overflow="visible" aria-hidden>
          {/* A ripple carrying each node's pulse outward. */}
          {ARRIVALS.map(({ node, at, tint }) => (
            <circle key={node.glyph} cx={node.x} cy={node.y} r={R} stroke={tint} strokeWidth="2" opacity="0">
              <animate attributeName="r" dur={DUR} repeatCount="indefinite" {...pulse(at, R, R + 10, R + 20)} />
              <animate attributeName="opacity" dur={DUR} repeatCount="indefinite" {...pulse(at, 0, 0.6, 0)} />
            </circle>
          ))}
          <circle cx={A.x} cy={A.y} r={R + 8} strokeWidth="3" stroke={PURPLE}>
            <animateMotion
              dur={DUR}
              repeatCount="indefinite"
              path={PATH}
              calcMode="spline"
              keyTimes={TIMES}
              keyPoints={`0;0;${AT_B};${AT_B};${AT_C};${AT_C};1`}
              keySplines={EASE}
            />
            <animate
              attributeName="r"
              dur={DUR}
              repeatCount="indefinite"
              keyTimes="0;0.16;0.2465;0.333;0.493;0.5795;0.666;0.826;0.913;1"
              values={[1, 1, 0.5, 1, 1, 0.5, 1, 1, 0.5, 1].map((s) => (R + 8) * s).join(";")}
            />
            <animate
              attributeName="stroke"
              dur={DUR}
              repeatCount="indefinite"
              keyTimes={TIMES}
              values={[PURPLE, PURPLE, GREEN, GREEN, BLUE, BLUE, PURPLE].join(";")}
            />
          </circle>
        </svg>
      </div>
      {messages ? (
        <p key={line} className={styles.line}>
          {LINES[line]}
        </p>
      ) : (
        <span className="sr-only">Loading</span>
      )}
    </div>
  );
}

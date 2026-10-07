"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import dynamic from "next/dynamic";
import {
  BoxIcon,
  CameraIcon,
  ClipboardPasteIcon,
  CopyIcon,
  DicesIcon,
  DownloadIcon,
  EyeIcon,
  EyeOffIcon,
  Loader2Icon,
  Maximize2Icon,
  Minimize2Icon,
  PaletteIcon,
  RotateCcwIcon,
  Undo2Icon,
  LayersIcon,
  XIcon,
} from "lucide-react";
import { toast } from "sonner";
import {
  MindmapCanvas,
  type MindmapCanvasHandle,
  type MindmapCanvasProps,
} from "@/components/vault/mindmap-canvas";
import { DoqtriLoader } from "@/components/brand/doqtri-loader";
import { DoqtriMark } from "@/components/brand/doqtri-mark";
import { cssFontFamily, FONT_LABELS } from "@/components/vault/mindmap-fonts";
import { useMindmapStyle } from "@/hooks/use-mindmap-style";
import {
  applyPreset,
  BACKDROPS,
  decodeStyle,
  defaultStyleFor,
  encodeStyle,
  FONT_KEYS,
  isLight,
  mix,
  particlesPerLink,
  PRESETS,
  randomStyle,
  SHAPES,
  type Backdrop,
  type Layout2D,
  type MindmapStyle,
  type NodeOverride,
  type NodeShape,
} from "@/lib/mindmap-style";
import {
  LARGE_MAP_NODES,
  overviewGraph,
  type MapNode,
  type MapNodeKind,
  type MindmapGraph,
} from "@/lib/mindmap-graph";
import { cn } from "@/lib/utils";

const MindmapCanvas3D = dynamic(() => import("@/components/vault/mindmap-canvas-3d"), {
  ssr: false,
  loading: () => (
    <div className="text-label flex flex-1 items-center justify-center gap-2 text-[12px]">
      <Loader2Icon className="size-3.5 animate-spin" /> Loading 3D…
    </div>
  ),
});

type Tab = "theme" | "nodes" | "links" | "scene" | "node";

const TABS: { id: Tab; label: string }[] = [
  { id: "theme", label: "Theme" },
  { id: "nodes", label: "Nodes" },
  { id: "links", label: "Links" },
  { id: "scene", label: "Scene" },
  { id: "node", label: "Node" },
];

const EMOJI = ["🔥", "⭐", "💡", "🚀", "🎯", "✅", "⚡", "🧠", "📌", "❤️", "🌱", "💎", "⚠️", "🔒", "📈", "🎨"];

/** Undo steps closer together than this are one step: a slider drag is one edit. */
const UNDO_COALESCE_MS = 500;
const UNDO_LIMIT = 60;

type Aspect = "view" | "square" | "landscape" | "portrait" | "story";
const ASPECTS: { id: Aspect; label: string; ratio: number | null }[] = [
  { id: "view", label: "View", ratio: null },
  { id: "square", label: "1:1", ratio: 1 },
  { id: "landscape", label: "16:9", ratio: 16 / 9 },
  { id: "portrait", label: "4:5", ratio: 4 / 5 },
  { id: "story", label: "9:16", ratio: 9 / 16 },
];

function subscribeFullscreen(callback: () => void) {
  document.addEventListener("fullscreenchange", callback);
  return () => document.removeEventListener("fullscreenchange", callback);
}

/**
 * The mindmap with its studio: a canvas the viewer can restyle end to end —
 * presets, colours, shapes, fonts, glow, link particles, backdrops, a 3D mode —
 * and then export as a poster-sized PNG.
 *
 * Clicking a node still opens what it stands for. Only while the Node tab is
 * open does a click pick the node to style instead.
 */
export function MindmapStudio({
  scope,
  title,
  graph,
  defaultLayout,
  ...canvasProps
}: Omit<MindmapCanvasProps, "look" | "editing" | "selectedId" | "onSelect" | "handleRef"> & {
  /** Which map this is, for remembering its style. */
  scope: string;
  title: string;
  graph: MindmapGraph;
  defaultLayout: Layout2D;
}) {
  const fallback = useMemo(() => defaultStyleFor(defaultLayout), [defaultLayout]);
  const [style, setStoredStyle] = useMindmapStyle(scope, fallback);
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<Tab>("theme");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [shotOpen, setShotOpen] = useState(false);
  const [zenFallback, setZenFallback] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<MindmapCanvasHandle>(null);

  const fullscreen = useSyncExternalStore(
    subscribeFullscreen,
    () => document.fullscreenElement !== null && document.fullscreenElement === rootRef.current,
    () => false,
  );
  const zen = fullscreen || zenFallback;

  const history = useRef<{ stack: MindmapStyle[]; at: number }>({ stack: [], at: 0 });
  const [canUndo, setCanUndo] = useState(false);

  const update = useCallback(
    (next: (current: MindmapStyle) => MindmapStyle) => {
      setStoredStyle((current) => {
        const now = Date.now();
        const h = history.current;
        if (now - h.at > UNDO_COALESCE_MS) {
          h.stack.push(current);
          if (h.stack.length > UNDO_LIMIT) h.stack.shift();
        }
        h.at = now;
        return next(current);
      });
      setCanUndo(true);
    },
    [setStoredStyle],
  );

  const undo = useCallback(() => {
    const previous = history.current.stack.pop();
    if (previous) setStoredStyle(previous);
    history.current.at = 0;
    setCanUndo(history.current.stack.length > 0);
  }, [setStoredStyle]);

  useEffect(() => {
    if (!open) return;
    function onKey(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z" && !event.shiftKey) {
        event.preventDefault();
        undo();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, undo]);

  useEffect(() => {
    if (!zenFallback) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setZenFallback(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [zenFallback]);

  async function toggleZen() {
    if (zen) {
      if (document.fullscreenElement) await document.exitFullscreen().catch(() => {});
      setZenFallback(false);
      return;
    }
    setOpen(false);
    setShotOpen(false);
    const root = rootRef.current;
    if (root?.requestFullscreen) {
      try {
        await root.requestFullscreen();
        return;
      } catch {
        // Refused (iOS Safari, an iframe): hide the chrome without it.
      }
    }
    setZenFallback(true);
  }

  /*
   * Big maps ask first. "overview" draws only the shallowest levels that fit
   * the overview budget; "all" draws everything. Small maps never ask.
   */
  const total = graph.nodes.length;
  const isLarge = total > LARGE_MAP_NODES;
  const [scale, setScale] = useState<"ask" | "overview" | "all">(isLarge ? "ask" : "all");
  const overview = useMemo(() => overviewGraph(graph), [graph]);
  const shown = scale === "overview" ? overview.graph : graph;

  // A big map shows "Building mindmap…" until its layout has settled, once per
  // view and scale — switching to 3D or to everything is a fresh build.
  const runKey = `${style.view}|${scale}|${shown.nodes.length}`;
  const [settledKey, setSettledKey] = useState<string | null>(null);
  const building = isLarge && scale !== "ask" && settledKey !== runKey;

  const editing = open && tab === "node";
  const selected = selectedId ? shown.nodes.find((node) => node.id === selectedId) ?? null : null;
  const caption = style.caption.text.trim() || title;
  const light = isLight(style.palette.background);

  const Canvas = style.view === "3d" ? MindmapCanvas3D : MindmapCanvas;

  return (
    <div ref={rootRef} className="relative flex min-h-0 flex-1 flex-col" style={{ backgroundColor: style.palette.background }}>
      {scale === "ask" ? (
        <LargeMapGate
          total={total}
          overviewCount={overview.graph.nodes.length}
          onOverview={() => setScale("overview")}
          onAll={() => setScale("all")}
        />
      ) : (
        <Canvas
          // A different set of nodes is a different map; start its layout fresh.
          key={scale}
          {...canvasProps}
          graph={shown}
          look={style}
          editing={editing}
          selectedId={editing ? selectedId : null}
          onSelect={(node) => setSelectedId(node.id)}
          handleRef={handleRef}
          onSettled={() => setSettledKey(runKey)}
        />
      )}

      {building && (
        <div
          role="status"
          className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3"
          style={{ backgroundColor: style.palette.background }}
        >
          <DoqtriLoader className="w-20" messages={false} />
          <p className="text-foreground text-[13px] font-medium">Building mindmap…</p>
          <p className="text-label text-[11.5px]">
            Laying out {shown.nodes.length.toLocaleString()} nodes
          </p>
        </div>
      )}

      {/* The caption is part of the picture, so screenshots taken by hand get it too. */}
      {(style.caption.show || style.caption.watermark) && shown.nodes.length > 0 && scale !== "ask" && !building && (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 bottom-0 flex items-end justify-between gap-4 p-5"
          style={{ fontFamily: cssFontFamily(style.font) }}
        >
          <div className="min-w-0">
            {style.caption.show && (
              <>
                <p
                  className="truncate text-[clamp(18px,3.2vw,34px)] leading-tight font-bold"
                  style={{
                    color: light ? "#111" : "#fff",
                    textShadow: style.glow > 0 ? `0 0 ${style.glow * 18}px ${style.palette.kinds.root.stroke}` : undefined,
                  }}
                >
                  {caption}
                </p>
                <div className="mt-1.5 h-[3px] w-12 rounded-full" style={{ backgroundColor: style.palette.kinds.root.stroke }} />
              </>
            )}
          </div>
          {style.caption.watermark && (
            <span
              className="flex shrink-0 items-center gap-1.5 text-[11px] font-semibold"
              style={{ color: light ? "rgba(0,0,0,0.45)" : "rgba(255,255,255,0.55)", fontFamily: "ui-sans-serif, system-ui" }}
            >
              {/* The mark reads its ring fill from --mark-fill; match the backdrop. */}
              <span
                className="flex opacity-85"
                style={
                  {
                    color: light ? "#111111" : "#f4f5f7",
                    "--mark-fill": style.palette.background,
                  } as React.CSSProperties
                }
              >
                <DoqtriMark title="" glow={false} className="h-[18px] w-auto" />
              </span>
              made with doqtri
            </span>
          )}
        </div>
      )}

      {scale === "ask" ? null : zen ? (
        <button
          type="button"
          onClick={toggleZen}
          title="Leave zen mode (Esc)"
          className="glass-float text-muted-foreground hover:text-foreground absolute top-3 right-3 z-20 flex size-8 items-center justify-center rounded-full opacity-20 backdrop-blur transition-opacity hover:opacity-100 focus-visible:opacity-100"
        >
          <Minimize2Icon className="size-3.5" />
        </button>
      ) : (
        <div className="absolute top-2 right-2 z-20 flex items-center gap-1">
          {isLarge && (
            <ToolButton
              label={
                scale === "overview"
                  ? `Showing ${shown.nodes.length} of ${total} nodes — click to render all`
                  : `Showing all ${total} nodes — click for the overview`
              }
              active={scale === "overview"}
              onClick={() => {
                setSelectedId(null);
                setScale(scale === "overview" ? "all" : "overview");
              }}
            >
              <LayersIcon className="size-3.5" />
              <span className="text-[11px] font-semibold max-sm:hidden">
                {scale === "overview"
                  ? `Overview · ${shown.nodes.length.toLocaleString()} of ${total.toLocaleString()}`
                  : `All ${total.toLocaleString()}`}
              </span>
            </ToolButton>
          )}
          <ToolButton
            label={style.view === "3d" ? "Switch to 2D" : "Switch to 3D"}
            active={style.view === "3d"}
            onClick={() => update((s) => ({ ...s, view: s.view === "3d" ? "2d" : "3d" }))}
          >
            <BoxIcon className="size-3.5" />
            <span className="text-[11px] font-semibold">{style.view === "3d" ? "3D" : "2D"}</span>
          </ToolButton>
          <ToolButton
            label="Snapshot"
            active={shotOpen}
            onClick={() => {
              // Both panels sit in the same corner; one at a time.
              setOpen(false);
              setShotOpen((v) => !v);
            }}
          >
            <CameraIcon className="size-3.5" />
          </ToolButton>
          <ToolButton label="Zen mode — hide everything but the map" onClick={toggleZen}>
            <Maximize2Icon className="size-3.5" />
          </ToolButton>
          <ToolButton label="Release every node back into the layout" onClick={() => handleRef.current?.releaseAll()}>
            <RotateCcwIcon className="size-3.5" />
          </ToolButton>
          <ToolButton
            label="Customize"
            active={open}
            onClick={() => {
              setShotOpen(false);
              setOpen((v) => !v);
            }}
            accent
          >
            <PaletteIcon className="size-3.5" />
            <span className="text-[11px] font-semibold max-sm:hidden">Customize</span>
          </ToolButton>
        </div>
      )}

      {shotOpen && !zen && (
        <SnapshotPanel
          style={style}
          title={caption}
          onClose={() => setShotOpen(false)}
          capture={(request) => {
            const handle = handleRef.current;
            if (!handle) return Promise.reject(new Error("The map is still loading"));
            return handle.snapshot(request);
          }}
          viewSize={() => handleRef.current?.viewSize() ?? { width: 1600, height: 900 }}
          filename={title}
        />
      )}

      {open && !zen && (
        <StudioPanel
          style={style}
          update={update}
          tab={tab}
          setTab={(next) => {
            setTab(next);
            if (next !== "node") setSelectedId(null);
          }}
          selected={selected}
          nodes={shown.nodes}
          linkCount={shown.links.length}
          clearSelection={() => setSelectedId(null)}
          title={title}
          undo={undo}
          canUndo={canUndo}
          reset={() => update(() => ({ ...fallback, view: style.view }))}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------------ */
/* Large maps                                                                */
/* ------------------------------------------------------------------------ */

/**
 * Asked before a big map draws anything.
 *
 * Laying out a thousand-plus nodes takes real time and draws every one of them
 * every frame, which a phone or an older laptop feels. The overview keeps the
 * outer shape — every branch, minus its finest detail — at a fraction of the
 * cost, and everything is one click away from either.
 */
function LargeMapGate({
  total,
  overviewCount,
  onOverview,
  onAll,
}: {
  total: number;
  overviewCount: number;
  onOverview: () => void;
  onAll: () => void;
}) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center p-4">
      <div className="glass-float flex w-full max-w-[400px] flex-col gap-5 rounded-2xl p-6 backdrop-blur">
        <div className="flex flex-col items-center gap-3 text-center">
          <span className="bg-accent/15 text-accent flex size-10 items-center justify-center rounded-full">
            <LayersIcon className="size-4.5" />
          </span>
          <div className="flex flex-col gap-1.5">
            <h2 className="text-foreground text-[15px] font-semibold">Large mindmap — render it?</h2>
            <p className="text-muted-foreground text-[12.5px] leading-relaxed text-balance">
              This map has <b className="text-foreground font-semibold">{total.toLocaleString()} nodes</b>. Drawing
              all of them at once can slow the page down on some devices.
            </p>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2.5">
          <GateChoice
            primary
            art={<FewNodesArt />}
            title="Overview"
            detail={`${overviewCount.toLocaleString()} nodes`}
            note="Every branch, less detail"
            onClick={onOverview}
          />
          <GateChoice
            art={<ManyNodesArt />}
            title="Render all"
            detail={`${total.toLocaleString()} nodes`}
            note="May take a few seconds"
            onClick={onAll}
          />
        </div>

        <p className="text-label text-center text-[11px]">You can switch between them any time.</p>
      </div>
    </div>
  );
}

/**
 * One of the two ways to open a large map, as a tall card: the illustration
 * says how much will be drawn before the words do.
 */
function GateChoice({
  art,
  title,
  detail,
  note,
  primary,
  onClick,
}: {
  art: React.ReactNode;
  title: string;
  detail: string;
  note: string;
  primary?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`${title}: ${detail}. ${note}.`}
      className={cn(
        "group flex flex-col items-center gap-3 rounded-xl border px-3 pt-4 pb-3.5 text-center transition-colors",
        primary
          ? "border-accent/40 bg-accent/10 hover:bg-accent/15 hover:border-accent/60"
          : "border-[var(--glass-lo)] bg-[var(--glass)] hover:bg-[var(--glass-strong)] hover:border-[var(--glass-hi)]",
      )}
    >
      <span
        className={cn(
          "flex h-[72px] w-full items-center justify-center transition-transform duration-300 group-hover:scale-105",
          primary ? "text-accent" : "text-foreground/85",
        )}
      >
        {art}
      </span>
      <span className="flex flex-col gap-0.5">
        <span className="text-foreground text-[13.5px] leading-tight font-semibold">{title}</span>
        <span className="text-foreground/80 text-[12px] font-medium tabular-nums">{detail}</span>
        <span className="text-label mt-0.5 text-[11px] leading-snug">{note}</span>
      </span>
    </button>
  );
}

/** A handful of big nodes: the map's outline, nothing more. */
function FewNodesArt() {
  const around = [0, 1, 2, 3, 4].map((i) => {
    const angle = -Math.PI / 2 + (i * 2 * Math.PI) / 5;
    return { x: 36 + Math.cos(angle) * 22, y: 36 + Math.sin(angle) * 22 };
  });
  return (
    <svg viewBox="0 0 72 72" className="h-full w-auto" fill="none" aria-hidden>
      <circle cx="36" cy="36" r="30" stroke="currentColor" strokeOpacity="0.15" strokeDasharray="2 3" />
      {around.map((p, i) => (
        <line key={i} x1="36" y1="36" x2={p.x} y2={p.y} stroke="currentColor" strokeOpacity="0.45" strokeWidth="1.5" />
      ))}
      {around.map((p, i) => (
        <circle key={i} cx={p.x} cy={p.y} r="6" fill="currentColor" fillOpacity="0.18" stroke="currentColor" strokeWidth="1.6" />
      ))}
      <circle cx="36" cy="36" r="9" fill="currentColor" fillOpacity="0.3" stroke="currentColor" strokeWidth="1.8" />
    </svg>
  );
}

/** A dense constellation in rings: the whole map, down to the last detail. */
function ManyNodesArt() {
  const rings = [
    { count: 6, radius: 12, r: 2.6, offset: 0 },
    { count: 12, radius: 21, r: 1.8, offset: 0.26 },
    { count: 22, radius: 29, r: 1.2, offset: 0.1 },
  ];
  const points = rings.map(({ count, radius, r, offset }) =>
    Array.from({ length: count }, (_, i) => {
      const angle = offset + (i * 2 * Math.PI) / count;
      return { x: 36 + Math.cos(angle) * radius, y: 36 + Math.sin(angle) * radius, r };
    }),
  );
  // Each node links to the nearest node one ring in, like a tree fanning out.
  const links = points.slice(1).flatMap((ring, depth) =>
    ring.map((p) => {
      const parent = points[depth].reduce((best, q) =>
        Math.hypot(q.x - p.x, q.y - p.y) < Math.hypot(best.x - p.x, best.y - p.y) ? q : best,
      );
      return { from: parent, to: p, depth: depth + 1 };
    }),
  );
  return (
    <svg viewBox="0 0 72 72" className="h-full w-auto" fill="none" aria-hidden>
      {points[0].map((p, i) => (
        <line key={`c${i}`} x1="36" y1="36" x2={p.x} y2={p.y} stroke="currentColor" strokeOpacity="0.5" strokeWidth="1" />
      ))}
      {links.map((l, i) => (
        <line
          key={i}
          x1={l.from.x}
          y1={l.from.y}
          x2={l.to.x}
          y2={l.to.y}
          stroke="currentColor"
          strokeOpacity={l.depth === 1 ? 0.4 : 0.28}
          strokeWidth={l.depth === 1 ? 0.9 : 0.7}
        />
      ))}
      {points.flat().map((p, i) => (
        <circle key={i} cx={p.x} cy={p.y} r={p.r} fill="currentColor" fillOpacity={p.r > 2 ? 0.9 : p.r > 1.5 ? 0.7 : 0.5} />
      ))}
      <circle cx="36" cy="36" r="4" fill="currentColor" />
    </svg>
  );
}

/* ------------------------------------------------------------------------ */
/* Toolbar                                                                   */
/* ------------------------------------------------------------------------ */

function ToolButton({
  label,
  active,
  accent,
  onClick,
  children,
}: {
  label: string;
  active?: boolean;
  accent?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      aria-pressed={active}
      className={cn(
        "glass-float flex h-7 items-center gap-1.5 rounded-full px-2.5 backdrop-blur transition-colors pointer-coarse:h-9",
        active ? "text-foreground bg-[var(--glass-strong)]" : "text-muted-foreground hover:text-foreground",
        accent && "text-accent hover:text-accent",
      )}
    >
      {children}
    </button>
  );
}

/* ------------------------------------------------------------------------ */
/* Controls                                                                  */
/* ------------------------------------------------------------------------ */

function Section({ title, children, aside }: { title: string; children: React.ReactNode; aside?: React.ReactNode }) {
  return (
    <section className="border-border/50 border-b px-3 py-3 last:border-b-0">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="text-label text-[10.5px] font-semibold tracking-[0.08em] uppercase">{title}</h3>
        {aside}
      </div>
      <div className="flex flex-col gap-2.5">{children}</div>
    </section>
  );
}

function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: React.ReactNode; title?: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <div className="flex rounded-lg border border-[var(--glass-lo)] bg-black/30 p-0.5">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          title={option.title}
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
          className={cn(
            "flex-1 rounded-md px-1.5 py-1 text-[11px] font-medium transition-colors",
            value === option.value
              ? "text-foreground bg-[var(--glass-hi)]"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function Range({
  label,
  value,
  min,
  max,
  step,
  onChange,
  format = (v) => v.toFixed(step < 0.1 ? 3 : step < 1 ? 1 : 0),
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
  format?: (value: number) => string;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="flex items-center justify-between text-[11.5px]">
        <span className="text-muted-foreground">{label}</span>
        <span className="text-foreground font-mono text-[10.5px] tabular-nums">{format(value)}</span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        className="accent-[var(--accent)] h-1.5 w-full cursor-pointer"
      />
    </label>
  );
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (value: boolean) => void }) {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-2 text-[11.5px]">
      <span className="text-muted-foreground">{label}</span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={cn(
          "relative h-[18px] w-8 shrink-0 rounded-full border border-[var(--glass-lo)] transition-colors",
          checked ? "bg-accent/70" : "bg-black/40",
        )}
      >
        <span
          className={cn(
            "absolute top-[2px] left-0 size-3 rounded-full bg-white shadow transition-transform",
            checked ? "translate-x-[15px]" : "translate-x-[2px]",
          )}
        />
      </button>
    </label>
  );
}

function ColorField({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <label className="flex items-center justify-between gap-2 text-[11.5px]">
      <span className="text-muted-foreground truncate">{label}</span>
      <span className="flex items-center gap-1.5">
        <span className="text-label font-mono text-[10px] uppercase">{value}</span>
        <input
          type="color"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className="size-6 cursor-pointer rounded-md border border-[var(--glass-lo)] bg-transparent p-0"
        />
      </span>
    </label>
  );
}

function ChipGrid({ children, columns = 3 }: { children: React.ReactNode; columns?: number }) {
  return (
    <div className="grid gap-1.5" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>
      {children}
    </div>
  );
}

function Chip({
  active,
  onClick,
  children,
  title,
  style,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  title?: string;
  style?: React.CSSProperties;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-pressed={active}
      onClick={onClick}
      style={style}
      className={cn(
        "flex min-h-8 flex-col items-center justify-center gap-1 rounded-lg border px-1.5 py-1.5 text-[11px] transition-colors",
        active
          ? "border-accent/70 text-foreground bg-[var(--glass-strong)]"
          : "text-muted-foreground hover:text-foreground border-[var(--glass-lo)] hover:bg-[var(--glass)]",
      )}
    >
      {children}
    </button>
  );
}

/* ------------------------------------------------------------------------ */
/* Studio panel                                                              */
/* ------------------------------------------------------------------------ */

const SHAPE_LABELS: Record<NodeShape, string> = {
  pill: "Pill",
  box: "Rounded",
  sharp: "Square",
  hexagon: "Hex",
  bubble: "Bubble",
  underline: "Underline",
};

function ShapePreview({ shape }: { shape: NodeShape }) {
  const common = { fill: "currentColor", fillOpacity: 0.15, stroke: "currentColor", strokeWidth: 1.2 };
  return (
    <svg viewBox="0 0 40 18" className="h-3.5 w-9" aria-hidden>
      {shape === "pill" && <rect x="1" y="2" width="38" height="14" rx="7" {...common} />}
      {shape === "box" && <rect x="1" y="2" width="38" height="14" rx="3.5" {...common} />}
      {shape === "sharp" && <rect x="1" y="2" width="38" height="14" {...common} />}
      {shape === "hexagon" && <path d="M1 9 L6 2 H34 L39 9 L34 16 H6 Z" {...common} />}
      {shape === "bubble" && <ellipse cx="20" cy="9" rx="19" ry="8" {...common} />}
      {shape === "underline" && <path d="M3 15 H37" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />}
    </svg>
  );
}

const BACKDROP_LABELS: Record<Backdrop, string> = {
  solid: "Solid",
  radial: "Spotlight",
  linear: "Gradient",
  grid: "Grid",
  dots: "Dots",
  stars: "Stars",
  aurora: "Aurora",
};

const KIND_LABELS: Record<MapNodeKind, string> = {
  root: "Root",
  document: "Note",
  theme: "Theme",
  hub: "Shared",
  concept: "Concept",
  detail: "Detail",
};

function StudioPanel({
  style,
  update,
  tab,
  setTab,
  selected,
  nodes,
  clearSelection,
  title,
  undo,
  canUndo,
  linkCount,
  reset,
  onClose,
}: {
  style: MindmapStyle;
  update: (next: (current: MindmapStyle) => MindmapStyle) => void;
  tab: Tab;
  setTab: (tab: Tab) => void;
  selected: MapNode | null;
  nodes: MapNode[];
  clearSelection: () => void;
  title: string;
  undo: () => void;
  canUndo: boolean;
  linkCount: number;
  reset: () => void;
  onClose: () => void;
}) {
  const set = <K extends keyof MindmapStyle>(key: K, value: MindmapStyle[K]) =>
    update((s) => ({ ...s, [key]: value }));
  const setLink = <K extends keyof MindmapStyle["link"]>(key: K, value: MindmapStyle["link"][K]) =>
    update((s) => ({ ...s, link: { ...s.link, [key]: value } }));
  const setThree = <K extends keyof MindmapStyle["three"]>(key: K, value: MindmapStyle["three"][K]) =>
    update((s) => ({ ...s, three: { ...s.three, [key]: value } }));
  const setCaption = <K extends keyof MindmapStyle["caption"]>(key: K, value: MindmapStyle["caption"][K]) =>
    update((s) => ({ ...s, caption: { ...s.caption, [key]: value } }));
  const setPalette = (patch: Partial<MindmapStyle["palette"]>) =>
    update((s) => ({ ...s, preset: "custom", palette: { ...s.palette, ...patch } }));

  const setKindAccent = (kind: MapNodeKind, accent: string) =>
    update((s) => {
      const ink = isLight(s.palette.background) ? "#111111" : "#ffffff";
      return {
        ...s,
        preset: "custom",
        palette: {
          ...s.palette,
          kinds: {
            ...s.palette.kinds,
            [kind]: { fill: mix(s.palette.background, accent, 0.18), stroke: accent, text: mix(accent, ink, 0.6) },
          },
        },
      };
    });

  // Only nodes on this map: a rebuilt mindmap can leave overrides behind for
  // concepts that no longer exist, and those cannot be shown again anyway.
  const hiddenNodes = nodes.filter((node) => style.overrides[node.id]?.hidden);
  const hiddenCount = hiddenNodes.length;

  const editNode = (id: string, patch: NodeOverride) =>
    update((s) => {
      const merged: NodeOverride = { ...s.overrides[id], ...patch };
      for (const key of Object.keys(merged) as (keyof NodeOverride)[]) {
        if (merged[key] === undefined) delete merged[key];
      }
      const overrides = { ...s.overrides };
      if (Object.keys(merged).length === 0) delete overrides[id];
      else overrides[id] = merged;
      return { ...s, overrides };
    });

  const showAll = () =>
    update((s) => ({
      ...s,
      overrides: Object.fromEntries(
        Object.entries(s.overrides).map(([id, o]) => [id, { ...o, hidden: undefined }]),
      ),
    }));

  async function copyCode() {
    try {
      await navigator.clipboard.writeText(encodeStyle(style));
      toast.success("Style code copied — paste it on any map");
    } catch {
      toast.error("Clipboard is blocked in this browser");
    }
  }

  async function pasteCode() {
    let code: string | null = null;
    try {
      code = await navigator.clipboard.readText();
    } catch {
      // Reading the clipboard needs a permission some browsers never grant.
    }
    if (!code || !code.trim().startsWith("doqtri-style:")) code = window.prompt("Paste a style code");
    if (!code) return;
    const decoded = decodeStyle(code, style);
    if (!decoded) {
      toast.error("That is not a Doqtri style code");
      return;
    }
    update(() => decoded);
    toast.success("Style applied");
  }

  return (
    <aside
      className="glass-float absolute top-11 right-2 bottom-2 z-30 flex w-[300px] flex-col overflow-hidden rounded-2xl backdrop-blur-xl max-sm:inset-x-2 max-sm:top-auto max-sm:h-[62%] max-sm:w-auto"
      style={{ backgroundColor: "color-mix(in oklch, var(--background) 82%, transparent)" }}
    >
      <header className="flex shrink-0 items-center justify-between gap-2 px-3 pt-2.5 pb-2">
        <div className="flex items-center gap-1.5">
          <PaletteIcon className="text-accent size-3.5" />
          <h2 className="text-foreground text-[13px] font-semibold">Mindmap studio</h2>
        </div>
        <div className="flex items-center gap-0.5">
          <IconButton label="Undo (⌘Z)" onClick={undo} disabled={!canUndo}>
            <Undo2Icon className="size-3.5" />
          </IconButton>
          <IconButton label="Close" onClick={onClose}>
            <XIcon className="size-3.5" />
          </IconButton>
        </div>
      </header>

      <nav className="flex shrink-0 gap-0.5 border-b border-[var(--glass-lo)] px-2 pb-1.5">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            aria-pressed={tab === t.id}
            className={cn(
              "flex-1 rounded-md px-1 py-1 text-[11.5px] font-medium transition-colors",
              tab === t.id ? "text-foreground bg-[var(--glass-strong)]" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {t.label}
          </button>
        ))}
      </nav>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {tab === "theme" && (
          <>
            <Section
              title="Presets"
              aside={
                <button
                  type="button"
                  onClick={() => update((s) => randomStyle(s))}
                  className="text-accent hover:text-foreground flex items-center gap-1 text-[11px] font-semibold transition-colors"
                >
                  <DicesIcon className="size-3.5" /> Surprise me
                </button>
              }
            >
              <ChipGrid columns={2}>
                {PRESETS.map((preset) => (
                  <Chip
                    key={preset.id}
                    active={style.preset === preset.id}
                    onClick={() => update((s) => applyPreset(s, preset.id))}
                  >
                    <span
                      className="flex h-7 w-full items-center justify-center gap-1 rounded-md"
                      style={{ background: `linear-gradient(135deg, ${preset.swatch[0]}, ${mix(preset.swatch[0], preset.swatch[2], 0.35)})` }}
                    >
                      <span className="size-2.5 rounded-full" style={{ backgroundColor: preset.swatch[1], boxShadow: `0 0 8px ${preset.swatch[1]}` }} />
                      <span className="size-2.5 rounded-full" style={{ backgroundColor: preset.swatch[2], boxShadow: `0 0 8px ${preset.swatch[2]}` }} />
                    </span>
                    {preset.name}
                  </Chip>
                ))}
              </ChipGrid>
            </Section>

            <Section title="Colour by">
              <Segmented
                value={style.colorMode}
                onChange={(v) => set("colorMode", v)}
                options={[
                  { value: "kind", label: "Type" },
                  { value: "branch", label: "Branch" },
                  { value: "depth", label: "Depth" },
                ]}
              />
              {style.colorMode === "kind" &&
                (Object.keys(KIND_LABELS) as MapNodeKind[]).map((kind) => (
                  <ColorField
                    key={kind}
                    label={KIND_LABELS[kind]}
                    value={style.palette.kinds[kind].stroke}
                    onChange={(v) => setKindAccent(kind, v)}
                  />
                ))}
              {style.colorMode === "branch" && (
                <div className="flex flex-wrap items-center gap-1.5">
                  {style.palette.branches.map((hue, index) => (
                    <input
                      key={index}
                      type="color"
                      value={hue}
                      title={`Branch ${index + 1}`}
                      onChange={(event) => {
                        const branches = [...style.palette.branches];
                        branches[index] = event.target.value;
                        setPalette({ branches });
                      }}
                      className="size-7 cursor-pointer rounded-md border border-[var(--glass-lo)] bg-transparent p-0"
                    />
                  ))}
                  {style.palette.branches.length < 12 && (
                    <button
                      type="button"
                      onClick={() => setPalette({ branches: [...style.palette.branches, style.palette.branches[0] ?? "#ffffff"] })}
                      className="text-muted-foreground hover:text-foreground size-7 rounded-md border border-dashed border-[var(--glass-hi)] text-[13px]"
                      title="Add a branch colour"
                    >
                      +
                    </button>
                  )}
                  {style.palette.branches.length > 1 && (
                    <button
                      type="button"
                      onClick={() => setPalette({ branches: style.palette.branches.slice(0, -1) })}
                      className="text-muted-foreground hover:text-foreground size-7 rounded-md border border-dashed border-[var(--glass-hi)] text-[13px]"
                      title="Remove the last branch colour"
                    >
                      −
                    </button>
                  )}
                </div>
              )}
              {style.colorMode === "depth" && (
                <>
                  <ColorField label="Centre" value={style.palette.depthFrom} onChange={(v) => setPalette({ depthFrom: v })} />
                  <ColorField label="Edges" value={style.palette.depthTo} onChange={(v) => setPalette({ depthTo: v })} />
                </>
              )}
            </Section>

            <Section title="Canvas colours">
              <ColorField label="Background" value={style.palette.background} onChange={(v) => setPalette({ background: v })} />
              <ColorField label="Glow tone" value={style.palette.backgroundAlt} onChange={(v) => setPalette({ backgroundAlt: v })} />
              <ColorField label="Links" value={style.palette.link} onChange={(v) => setPalette({ link: v })} />
            </Section>

            <Section title="Share a look">
              <div className="flex gap-1.5">
                <PanelButton onClick={copyCode}>
                  <CopyIcon className="size-3.5" /> Copy code
                </PanelButton>
                <PanelButton onClick={pasteCode}>
                  <ClipboardPasteIcon className="size-3.5" /> Paste code
                </PanelButton>
              </div>
            </Section>
          </>
        )}

        {tab === "nodes" && (
          <>
            <Section title="Shape">
              <ChipGrid>
                {SHAPES.map((shape) => (
                  <Chip key={shape} active={style.shape === shape} onClick={() => set("shape", shape)}>
                    <ShapePreview shape={shape} />
                    {SHAPE_LABELS[shape]}
                  </Chip>
                ))}
              </ChipGrid>
            </Section>
            <Section title="Fill">
              <Segmented
                value={style.fill}
                onChange={(v) => set("fill", v)}
                options={[
                  { value: "solid", label: "Solid" },
                  { value: "glass", label: "Glass" },
                  { value: "outline", label: "Neon" },
                  { value: "gradient", label: "Gradient" },
                ]}
              />
            </Section>
            <Section title="Font">
              <ChipGrid>
                {FONT_KEYS.map((key) => (
                  <Chip
                    key={key}
                    active={style.font === key}
                    onClick={() => set("font", key)}
                    style={{ fontFamily: cssFontFamily(key), fontSize: key === "pixel" ? 8 : undefined }}
                  >
                    {FONT_LABELS[key]}
                  </Chip>
                ))}
              </ChipGrid>
              <Range label="Text size" value={style.textScale} min={0.6} max={2} step={0.05} onChange={(v) => set("textScale", v)} format={(v) => `${Math.round(v * 100)}%`} />
            </Section>
            <Section title="Effects">
              <Range label="Glow" value={style.glow} min={0} max={1} step={0.05} onChange={(v) => set("glow", v)} format={(v) => `${Math.round(v * 100)}%`} />
              <Range label="Border" value={style.borderWidth} min={0} max={3} step={0.1} onChange={(v) => set("borderWidth", v)} />
            </Section>
            <Section title="One node at a time">
              <p className="text-muted-foreground text-[11.5px] leading-relaxed">
                Open the <b className="text-foreground">Node</b> tab, then click any node to give it its own colour, emoji or size.
              </p>
              {hiddenCount > 0 && (
                <PanelButton onClick={showAll}>
                  <EyeIcon className="size-3.5" /> Show {hiddenCount} hidden {hiddenCount === 1 ? "node" : "nodes"}
                </PanelButton>
              )}
            </Section>
          </>
        )}

        {tab === "links" && (
          <>
            <Section title="Lines">
              <Range label="Width" value={style.link.width} min={0.2} max={4} step={0.1} onChange={(v) => setLink("width", v)} />
              <Range label="Curve" value={style.link.curvature} min={0} max={0.6} step={0.01} onChange={(v) => setLink("curvature", v)} format={(v) => v.toFixed(2)} />
              <Range label="Opacity" value={style.link.opacity} min={0.1} max={1} step={0.05} onChange={(v) => setLink("opacity", v)} format={(v) => `${Math.round(v * 100)}%`} />
              <Toggle label="Colour from nodes" checked={style.link.gradient} onChange={(v) => setLink("gradient", v)} />
              <Toggle label="Dashed" checked={style.link.dashed} onChange={(v) => setLink("dashed", v)} />
            </Section>
            <Section title="Particles">
              <Range label="Per link" value={style.link.particles} min={0} max={6} step={1} onChange={(v) => setLink("particles", v)} />
              <Range label="Speed" value={style.link.particleSpeed} min={0.001} max={0.03} step={0.001} onChange={(v) => setLink("particleSpeed", v)} format={(v) => `${Math.round(v * 1000)}`} />
              <Range label="Size" value={style.link.particleSize} min={0.5} max={6} step={0.1} onChange={(v) => setLink("particleSize", v)} />
              {particlesPerLink(style, linkCount) < style.link.particles && (
                <p className="text-label text-[11px] leading-relaxed">
                  {particlesPerLink(style, linkCount) === 0
                    ? `Off on this map: ${linkCount.toLocaleString()} links is too many to animate smoothly.`
                    : `Held to ${particlesPerLink(style, linkCount)} per link here, so ${linkCount.toLocaleString()} links stay smooth.`}
                </p>
              )}
            </Section>
          </>
        )}

        {tab === "scene" && (
          <>
            <Section title="View">
              <Segmented
                value={style.view}
                onChange={(v) => set("view", v)}
                options={[
                  { value: "2d", label: "2D canvas" },
                  { value: "3d", label: "3D space" },
                ]}
              />
              {style.view === "2d" ? (
                <Segmented
                  value={style.layout}
                  onChange={(v) => set("layout", v)}
                  options={[
                    { value: "radial", label: "Radial" },
                    { value: "free", label: "Free" },
                    { value: "tree-down", label: "Tree ↓", title: "Top-down tree" },
                    { value: "tree-right", label: "Tree →", title: "Left-to-right tree" },
                  ]}
                />
              ) : (
                <>
                  <Segmented
                    value={style.three.layout}
                    onChange={(v) => setThree("layout", v)}
                    options={[
                      { value: "free", label: "Cloud" },
                      { value: "radial", label: "Burst" },
                      { value: "tree", label: "Tower" },
                    ]}
                  />
                  <Segmented
                    value={style.three.node}
                    onChange={(v) => setThree("node", v)}
                    options={[
                      { value: "label", label: "Labels" },
                      { value: "orb", label: "Orbs" },
                      { value: "crystal", label: "Crystals" },
                    ]}
                  />
                  <Range label="Bloom" value={style.three.bloom} min={0} max={3} step={0.05} onChange={(v) => setThree("bloom", v)} />
                  <Toggle label="Orbit camera" checked={style.three.autoRotate} onChange={(v) => setThree("autoRotate", v)} />
                  {style.three.autoRotate && (
                    <Range label="Orbit speed" value={style.three.rotateSpeed} min={0.1} max={5} step={0.1} onChange={(v) => setThree("rotateSpeed", v)} />
                  )}
                </>
              )}
              <Range label="Spacing" value={style.spacing} min={0.5} max={2.5} step={0.05} onChange={(v) => set("spacing", v)} format={(v) => `${Math.round(v * 100)}%`} />
            </Section>
            <Section title="Backdrop">
              <ChipGrid columns={4}>
                {BACKDROPS.map((backdrop) => (
                  <Chip key={backdrop} active={style.backdrop === backdrop} onClick={() => set("backdrop", backdrop)}>
                    {BACKDROP_LABELS[backdrop]}
                  </Chip>
                ))}
              </ChipGrid>
              <Toggle label="Vignette" checked={style.vignette} onChange={(v) => set("vignette", v)} />
            </Section>
            <Section title="Caption">
              <Toggle label="Show title" checked={style.caption.show} onChange={(v) => setCaption("show", v)} />
              {style.caption.show && (
                <input
                  type="text"
                  value={style.caption.text}
                  maxLength={120}
                  placeholder={title}
                  onChange={(event) => setCaption("text", event.target.value)}
                  className="text-foreground placeholder:text-label h-8 rounded-lg border border-[var(--glass-lo)] bg-black/30 px-2.5 text-[12px] outline-none focus:border-[var(--glass-hi)]"
                />
              )}
              <Toggle label="Doqtri watermark" checked={style.caption.watermark} onChange={(v) => setCaption("watermark", v)} />
            </Section>
          </>
        )}

        {tab === "node" && (
          <>
            <NodeEditor node={selected} style={style} onChange={editNode} onDone={clearSelection} />
            <HiddenNodes
              nodes={hiddenNodes}
              onShow={(id) => editNode(id, { hidden: undefined })}
              onShowAll={showAll}
            />
          </>
        )}
      </div>

      <footer className="flex shrink-0 items-center justify-between gap-2 border-t border-[var(--glass-lo)] px-3 py-2">
        <span className="text-label truncate text-[10.5px]">Saved in this browser</span>
        <button
          type="button"
          onClick={reset}
          className="text-muted-foreground hover:text-foreground text-[11px] font-medium transition-colors"
        >
          Reset look
        </button>
      </footer>
    </aside>
  );
}

/**
 * The nodes hidden on this map, each with its own way back.
 *
 * A hidden node is not drawn, so it cannot be clicked to select it again; this
 * list is the only handle on it short of showing every hidden node at once.
 */
function HiddenNodes({
  nodes,
  onShow,
  onShowAll,
}: {
  nodes: MapNode[];
  onShow: (id: string) => void;
  onShowAll: () => void;
}) {
  if (nodes.length === 0) return null;
  return (
    <Section
      title={`Hidden (${nodes.length})`}
      aside={
        nodes.length > 1 && (
          <button type="button" onClick={onShowAll} className="text-muted-foreground hover:text-foreground text-[11px]">
            Show all
          </button>
        )
      }
    >
      <ul className="flex flex-col gap-1">
        {nodes.map((node) => (
          <li
            key={node.id}
            className="flex items-center justify-between gap-2 rounded-lg border border-[var(--glass-lo)] bg-[var(--glass)] py-1 pr-1 pl-2.5"
          >
            <span className="text-muted-foreground min-w-0 truncate text-[12px]" title={node.label}>
              {node.label}
            </span>
            <button
              type="button"
              onClick={() => onShow(node.id)}
              aria-label={`Show ${node.label}`}
              className="text-foreground flex h-6 shrink-0 items-center gap-1 rounded-md px-2 text-[11px] font-medium transition-colors hover:bg-[var(--glass-strong)]"
            >
              <EyeIcon className="size-3" /> Show
            </button>
          </li>
        ))}
      </ul>
    </Section>
  );
}

function NodeEditor({
  node,
  style,
  onChange,
  onDone,
}: {
  node: MapNode | null;
  style: MindmapStyle;
  onChange: (id: string, patch: NodeOverride) => void;
  onDone: () => void;
}) {
  if (!node) {
    return (
      <div className="flex flex-col items-center gap-2 px-6 py-10 text-center">
        <span className="bg-accent/20 text-accent flex size-9 items-center justify-center rounded-full">
          <PaletteIcon className="size-4" />
        </span>
        <p className="text-foreground text-[12.5px] font-medium">Click any node on the map</p>
        <p className="text-muted-foreground text-[11.5px] leading-relaxed">
          While this tab is open, clicking a node selects it here instead of opening it.
        </p>
      </div>
    );
  }

  const override = style.overrides[node.id] ?? {};
  const swatches = Array.from(new Set([...style.palette.branches, style.palette.kinds.root.stroke, style.palette.depthTo]));

  return (
    <>
      <Section title="Selected" aside={<button type="button" onClick={onDone} className="text-muted-foreground hover:text-foreground text-[11px]">Done</button>}>
        <p className="text-foreground text-[13px] leading-snug font-medium">{node.label}</p>
      </Section>
      <Section
        title="Colour"
        aside={
          override.color && (
            <button type="button" onClick={() => onChange(node.id, { color: undefined })} className="text-muted-foreground hover:text-foreground text-[11px]">
              Clear
            </button>
          )
        }
      >
        <div className="flex flex-wrap items-center gap-1.5">
          {swatches.map((hue) => (
            <button
              key={hue}
              type="button"
              title={hue}
              onClick={() => onChange(node.id, { color: hue })}
              className={cn(
                "size-6 rounded-full border-2 transition-transform hover:scale-110",
                override.color === hue ? "border-white" : "border-transparent",
              )}
              style={{ backgroundColor: hue, boxShadow: `0 0 10px ${hue}80` }}
            />
          ))}
          <input
            type="color"
            value={override.color ?? style.palette.kinds[node.kind].stroke}
            onChange={(event) => onChange(node.id, { color: event.target.value })}
            title="Any colour"
            className="size-6 cursor-pointer rounded-full border border-[var(--glass-lo)] bg-transparent p-0"
          />
        </div>
      </Section>
      <Section
        title="Emoji"
        aside={
          override.emoji && (
            <button type="button" onClick={() => onChange(node.id, { emoji: undefined })} className="text-muted-foreground hover:text-foreground text-[11px]">
              Clear
            </button>
          )
        }
      >
        <div className="grid grid-cols-8 gap-1">
          {EMOJI.map((emoji) => (
            <button
              key={emoji}
              type="button"
              onClick={() => onChange(node.id, { emoji })}
              className={cn(
                "flex aspect-square items-center justify-center rounded-md text-[15px] transition-colors hover:bg-[var(--glass-strong)]",
                override.emoji === emoji && "bg-[var(--glass-hi)]",
              )}
            >
              {emoji}
            </button>
          ))}
        </div>
        <input
          type="text"
          value={override.emoji ?? ""}
          maxLength={8}
          placeholder="Or type any emoji"
          onChange={(event) => onChange(node.id, { emoji: event.target.value.trim() || undefined })}
          className="text-foreground placeholder:text-label h-8 rounded-lg border border-[var(--glass-lo)] bg-black/30 px-2.5 text-[12px] outline-none focus:border-[var(--glass-hi)]"
        />
      </Section>
      <Section title="Size">
        <Range
          label="Scale"
          value={override.scale ?? 1}
          min={0.5}
          max={3}
          step={0.05}
          onChange={(v) => onChange(node.id, { scale: v === 1 ? undefined : v })}
          format={(v) => `${Math.round(v * 100)}%`}
        />
      </Section>
      <Section title="Visibility">
        <div className="flex gap-1.5">
          <PanelButton
            onClick={() => {
              onChange(node.id, { hidden: true });
              onDone();
            }}
          >
            <EyeOffIcon className="size-3.5" /> Hide node
          </PanelButton>
          <PanelButton onClick={() => onChange(node.id, { color: undefined, emoji: undefined, scale: undefined, hidden: undefined })}>
            <RotateCcwIcon className="size-3.5" /> Reset node
          </PanelButton>
        </div>
      </Section>
    </>
  );
}

function IconButton({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
      className="text-muted-foreground hover:text-foreground flex size-7 items-center justify-center rounded-md transition-colors hover:bg-[var(--glass-strong)] disabled:opacity-35"
    >
      {children}
    </button>
  );
}

function PanelButton({ onClick, children, primary, disabled }: { onClick: () => void; children: React.ReactNode; primary?: boolean; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "flex h-8 flex-1 items-center justify-center gap-1.5 rounded-lg px-2 text-[11.5px] font-medium transition-colors disabled:opacity-50",
        primary
          ? "bg-primary text-primary-foreground hover:bg-[color-mix(in_oklch,var(--primary),white_18%)]"
          : "text-foreground border border-[var(--glass-lo)] bg-[var(--glass)] hover:bg-[var(--glass-strong)]",
      )}
    >
      {children}
    </button>
  );
}

/* ------------------------------------------------------------------------ */
/* Snapshot                                                                  */
/* ------------------------------------------------------------------------ */

function SnapshotPanel({
  style,
  title,
  filename,
  capture,
  viewSize,
  onClose,
}: {
  style: MindmapStyle;
  title: string;
  filename: string;
  capture: (request: {
    width: number;
    height: number;
    fit: boolean;
    title?: string;
    watermark: boolean;
  }) => Promise<Blob>;
  viewSize: () => { width: number; height: number };
  onClose: () => void;
}) {
  const [aspect, setAspect] = useState<Aspect>("view");
  const [longEdge, setLongEdge] = useState(2560);
  const [fit, setFit] = useState(true);
  const [withTitle, setWithTitle] = useState(style.caption.show);
  const [watermark, setWatermark] = useState(style.caption.watermark);
  const [busy, setBusy] = useState(false);

  function dimensions() {
    const ratio = ASPECTS.find((a) => a.id === aspect)?.ratio ?? (() => {
      const view = viewSize();
      return view.height > 0 ? view.width / view.height : 16 / 9;
    })();
    return ratio >= 1
      ? { width: longEdge, height: Math.round(longEdge / ratio) }
      : { width: Math.round(longEdge * ratio), height: longEdge };
  }

  async function run(action: "download" | "copy") {
    setBusy(true);
    try {
      const { width, height } = dimensions();
      const blob = await capture({ width, height, fit, title: withTitle ? title : undefined, watermark });
      if (action === "copy") {
        await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
        toast.success("Snapshot copied to the clipboard");
      } else {
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = `${filename.replace(/[^\w\- ]+/g, "").trim() || "mindmap"} — doqtri.png`;
        anchor.click();
        setTimeout(() => URL.revokeObjectURL(url), 2000);
        toast.success(`Saved ${width}×${height} PNG`);
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Snapshot failed");
    } finally {
      setBusy(false);
    }
  }

  const { width, height } = dimensions();

  return (
    <div
      className="glass-float absolute top-11 right-2 z-30 flex w-[280px] flex-col gap-3 rounded-2xl p-3 backdrop-blur-xl max-sm:inset-x-2 max-sm:w-auto"
      style={{ backgroundColor: "color-mix(in oklch, var(--background) 85%, transparent)" }}
    >
      <div className="flex items-center justify-between">
        <h2 className="text-foreground flex items-center gap-1.5 text-[13px] font-semibold">
          <CameraIcon className="size-3.5" /> Snapshot
        </h2>
        <IconButton label="Close" onClick={onClose}>
          <XIcon className="size-3.5" />
        </IconButton>
      </div>

      <div className="flex flex-col gap-1.5">
        <span className="text-label text-[10.5px] font-semibold tracking-[0.08em] uppercase">Frame</span>
        <Segmented value={aspect} onChange={setAspect} options={ASPECTS.map((a) => ({ value: a.id, label: a.label }))} />
        <Segmented
          value={fit ? "fit" : "view"}
          onChange={(v) => setFit(v === "fit")}
          options={[
            { value: "fit", label: "Whole map" },
            { value: "view", label: "What I see" },
          ]}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <span className="text-label text-[10.5px] font-semibold tracking-[0.08em] uppercase">Resolution</span>
        <Segmented
          value={String(longEdge)}
          onChange={(v) => setLongEdge(Number(v))}
          options={[
            { value: "1920", label: "HD" },
            { value: "2560", label: "2.5K" },
            { value: "3840", label: "4K" },
          ]}
        />
        <span className="text-label font-mono text-[10.5px]">
          {width} × {height}px
        </span>
      </div>

      <Toggle label="Title on image" checked={withTitle} onChange={setWithTitle} />
      <Toggle label="Doqtri watermark" checked={watermark} onChange={setWatermark} />

      <div className="flex gap-1.5">
        <PanelButton onClick={() => run("copy")} disabled={busy}>
          <CopyIcon className="size-3.5" /> Copy
        </PanelButton>
        <PanelButton onClick={() => run("download")} disabled={busy} primary>
          {busy ? <Loader2Icon className="size-3.5 animate-spin" /> : <DownloadIcon className="size-3.5" />} Download
        </PanelButton>
      </div>
    </div>
  );
}

"use client";

import { useMemo, useState } from "react";
import { LayoutTemplateIcon, Loader2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { buildMindmap, type MindmapNode } from "@/lib/mindmap";
import {
  TEMPLATE_CATEGORIES,
  TEMPLATES,
  templateMarkdown,
  type NoteTemplate,
  type TemplateCategory,
} from "@/lib/templates";
import { cn } from "@/lib/utils";

/** Rough label width at the preview's 11px type, for laying out columns. */
function labelWidth(label: string): number {
  return Math.min(150, Math.max(44, label.length * 6.1 + 18));
}

type Placed = { node: MindmapNode; depth: number; x: number; y: number; w: number };

/** Left-to-right tree: one column per depth, leaves stacked, parents centred. */
function layoutTree(root: MindmapNode) {
  const ROW = 26;
  const GAP = 28;
  const placed: Placed[] = [];
  const links: { from: Placed; to: Placed }[] = [];
  const colWidth: number[] = [];
  const visit = (node: MindmapNode, depth: number) => {
    colWidth[depth] = Math.max(colWidth[depth] ?? 0, labelWidth(node.label));
    node.children.forEach((child) => visit(child, depth + 1));
  };
  visit(root, 0);
  const colX = colWidth.map((_, d) => colWidth.slice(0, d).reduce((sum, w) => sum + w + GAP, 0));

  let row = 0;
  const place = (node: MindmapNode, depth: number): Placed => {
    const kids = node.children.map((child) => place(child, depth + 1));
    const y = kids.length ? (kids[0].y + kids[kids.length - 1].y) / 2 : row++ * ROW + ROW / 2;
    const self = { node, depth, x: colX[depth], y, w: labelWidth(node.label) };
    placed.push(self);
    kids.forEach((kid) => links.push({ from: self, to: kid }));
    return self;
  };
  place(root, 0);
  const width = colX[colX.length - 1] + colWidth[colWidth.length - 1];
  return { placed, links, width, height: Math.max(row, 1) * ROW };
}

/** A static, instant picture of the map a template produces. */
function TemplateMapPreview({ tree }: { tree: MindmapNode }) {
  const { placed, links, width, height } = useMemo(() => layoutTree(tree), [tree]);
  const PAD = 10;
  return (
    <svg
      viewBox={`${-PAD} ${-PAD} ${width + PAD * 2} ${height + PAD * 2}`}
      preserveAspectRatio="xMidYMid meet"
      className="size-full"
      role="img"
      aria-label="Mindmap preview"
    >
      {links.map(({ from, to }) => {
        const x1 = from.x + from.w;
        const x2 = to.x;
        const mid = (x1 + x2) / 2;
        return (
          <path
            key={`${from.node.id}-${to.node.id}`}
            d={`M${x1},${from.y} C${mid},${from.y} ${mid},${to.y} ${x2},${to.y}`}
            fill="none"
            stroke="var(--muted-foreground)"
            strokeOpacity={0.45}
          />
        );
      })}
      {placed.map(({ node, depth, x, y, w }) => (
        <g key={node.id}>
          <rect
            x={x}
            y={y - 10}
            width={w}
            height={20}
            rx={10}
            fill={depth === 0 ? "var(--primary)" : "var(--glass-strong)"}
            stroke="var(--glass-hi)"
          />
          <text
            x={x + w / 2}
            y={y + 3.8}
            textAnchor="middle"
            fontSize={11}
            fontWeight={depth < 2 ? 600 : 500}
            fill={depth === 0 ? "var(--primary-foreground)" : "var(--foreground)"}
          >
            {node.label.length > 24 ? `${node.label.slice(0, 23)}…` : node.label}
          </text>
        </g>
      ))}
    </svg>
  );
}

const chip =
  "rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors focus-visible:ring-ring focus-visible:ring-1 focus-visible:outline-hidden";

/**
 * The template gallery: pick a sample on the left, see its mindmap and
 * markdown on the right, then start a note from it. Nothing is written until
 * "Use template", so browsing is free.
 */
export function TemplatesDialog({
  open,
  onOpenChange,
  onUse,
  creating,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onUse: (template: NoteTemplate) => void;
  creating: boolean;
}) {
  const [category, setCategory] = useState<TemplateCategory | "All">("All");
  const [selectedId, setSelectedId] = useState(TEMPLATES[0].id);

  const shown = useMemo(
    () => (category === "All" ? TEMPLATES : TEMPLATES.filter((t) => t.category === category)),
    [category],
  );
  const selected = TEMPLATES.find((t) => t.id === selectedId) ?? TEMPLATES[0];
  const markdown = templateMarkdown(selected);
  // The body alone: the root is already the title, so this skips the `# Title`
  // heading that would otherwise repeat it as the only child.
  const tree = useMemo(() => buildMindmap(selected.title, selected.body), [selected]);
  const nodeCount = useMemo(() => {
    const count = (n: MindmapNode): number => n.children.reduce((sum, c) => sum + count(c), 1);
    return count(tree);
  }, [tree]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-testid="templates-dialog"
        className="flex max-h-[90dvh] flex-col gap-3 overflow-hidden sm:max-w-5xl"
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <LayoutTemplateIcon className="size-4" strokeWidth={1.5} />
            Templates
          </DialogTitle>
          <DialogDescription className="text-muted-foreground">
            Start from a sample. Headings become the mindmap, and everything stays editable.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Template categories">
          {(["All", ...TEMPLATE_CATEGORIES] as const).map((c) => (
            <button
              key={c}
              type="button"
              role="tab"
              aria-selected={category === c}
              onClick={() => setCategory(c)}
              className={cn(
                chip,
                category === c
                  ? "border-[var(--glass-hi)] bg-[var(--glass-strong)] text-foreground"
                  : "text-muted-foreground border-[var(--glass-lo)] hover:text-foreground",
              )}
            >
              {c}
            </button>
          ))}
        </div>

        <div className="grid min-h-0 flex-1 gap-3 overflow-y-auto md:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)] md:overflow-hidden">
          <ScrollArea className="min-h-0 md:h-full">
            <ul className="grid gap-2 pr-2 sm:grid-cols-2" aria-label="Templates">
              {shown.map((t) => (
                <li key={t.id}>
                  <button
                    type="button"
                    onClick={() => setSelectedId(t.id)}
                    aria-pressed={t.id === selected.id}
                    data-testid={`template-${t.id}`}
                    className={cn(
                      "h-full w-full rounded-xl border p-3 text-left transition-colors focus-visible:ring-ring focus-visible:ring-1 focus-visible:outline-hidden",
                      t.id === selected.id
                        ? "border-[var(--glass-hi)] bg-[var(--glass-strong)]"
                        : "border-[var(--glass-lo)] bg-[var(--glass)] hover:border-[var(--glass-hi)]",
                    )}
                  >
                    <span className="eyebrow text-label block text-[10px]">{t.category}</span>
                    <span className="text-foreground mt-1 block text-[13px] font-semibold">{t.title}</span>
                    <span className="text-muted-foreground mt-1 block text-[12px] leading-snug">
                      {t.description}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </ScrollArea>

          <section
            aria-label={`${selected.title} preview`}
            className="flex min-h-0 flex-col gap-2 rounded-xl border border-[var(--glass-lo)] bg-[var(--glass)] p-3"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-foreground truncate text-[14px] font-semibold">{selected.title}</p>
                <p className="text-muted-foreground text-[12px]">
                  {nodeCount} mindmap nodes
                </p>
              </div>
              <Button
                size="sm"
                disabled={creating}
                onClick={() => onUse(selected)}
                data-testid="use-template"
                className="shrink-0 rounded-full"
              >
                {creating ? <Loader2Icon className="animate-spin" /> : null}
                {creating ? "Creating…" : "Use template"}
              </Button>
            </div>
            <div className="bg-background relative h-56 shrink-0 overflow-hidden rounded-lg border border-[var(--glass-lo)] p-2 md:h-64">
              <TemplateMapPreview tree={tree} />
            </div>
            <ScrollArea className="min-h-0 flex-1">
              <pre className="text-muted-foreground max-h-60 font-mono text-[11px] leading-relaxed whitespace-pre-wrap md:max-h-none">
                {markdown}
              </pre>
            </ScrollArea>
          </section>
        </div>
      </DialogContent>
    </Dialog>
  );
}

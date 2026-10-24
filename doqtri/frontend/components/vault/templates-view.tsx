"use client";

import { useEffect, useMemo, useState } from "react";
import {
  BlocksIcon,
  BriefcaseIcon,
  CalendarRangeIcon,
  ClockIcon,
  ExternalLinkIcon,
  FilePlus2Icon,
  FlagIcon,
  FlameIcon,
  GraduationCapIcon,
  HandCoinsIcon,
  LayoutGridIcon,
  LayoutTemplateIcon,
  Loader2Icon,
  PackageIcon,
  ShoppingBagIcon,
  StoreIcon,
  TagIcon,
  UserIcon,
  UsersIcon,
  type LucideIcon,
} from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
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
import { expertContractUrl, expertTxUrl, MARKET_CONTRACT_ID } from "@/lib/stellar/config";
import { TemplateMarket } from "@/lib/stellar/market-client";
import { formatAmount, parseAmount, shortAddress, type CommunityTemplate } from "@/lib/market";
import { useWallet } from "@/components/vault/wallet-provider";
import { BuyTemplateDialog } from "@/components/vault/buy-template-dialog";
import { ReportTemplateDialog } from "@/components/vault/report-template-dialog";
import { EarningsView } from "@/components/vault/earnings-view";
import { createBlankNote } from "@/lib/create-note";
import { useActiveWorkspace } from "@/components/vault/workspace-context";

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
 *
 * Starter templates are Doqtri's own; Community templates are notes other
 * users published through the TemplateMarket contract (progress/004). The
 * Community tab only exists where that contract is deployed.
 */
const CATEGORY_ICONS: Record<TemplateCategory | "All", LucideIcon> = {
  All: LayoutGridIcon,
  Planning: CalendarRangeIcon,
  Product: PackageIcon,
  Web3: BlocksIcon,
  Learning: GraduationCapIcon,
  Work: BriefcaseIcon,
  Personal: UserIcon,
};

const TABS = [
  { id: "starter", label: "Starter", Icon: LayoutTemplateIcon },
  { id: "community", label: "Community", Icon: UsersIcon },
  { id: "yours", label: "Yours", Icon: StoreIcon },
] as const;
type PageTab = (typeof TABS)[number]["id"];

function isTab(value: string | null): value is PageTab {
  return TABS.some((t) => t.id === value) && (value === "starter" || MARKET_CONTRACT_ID !== null);
}

const DESCRIPTIONS: Record<PageTab, string> = {
  starter: "Start from a sample. Headings become the mindmap, and everything stays editable.",
  community: "Templates published by Doqtri users. Authorship is recorded on Stellar.",
  yours:
    "Templates you published: what each earned, recent sales, and price and listing changes. Every payment went straight to your wallet.",
};

/**
 * The template page (/vault/templates): Doqtri's starter templates, the
 * community marketplace, and the creator's own published templates with their
 * earnings (progress/004), as tabs of one page. The tab lives in the URL
 * (`?tab=`), so the earnings view and the gallery can be linked to directly.
 */
export function TemplatesView() {
  const router = useRouter();
  const params = useSearchParams();
  const requested = params.get("tab");
  const tab: PageTab = isTab(requested) ? requested : "starter";
  const [category, setCategory] = useState<TemplateCategory | "All">("All");
  const [creating, setCreating] = useState(false);
  // Template copies go into the workspace on screen (WP-1.7); a viewer
  // there can browse but not copy (D-14).
  const { active: workspace, canCreate } = useActiveWorkspace();

  function setTab(next: PageTab) {
    router.replace(next === "starter" ? "/vault/templates" : `/vault/templates?tab=${next}`, { scroll: false });
  }

  /** A note now exists (from a starter or a community template): open it. */
  function opened({ id, title }: { id: string; title: string }) {
    toast.success(`Created “${title}”`);
    // Navigate first, then refresh, so the explorer lists the new note.
    router.push(`/vault/${id}`);
    router.refresh();
  }

  async function startFromTemplate(template: NoteTemplate) {
    if (creating || !canCreate) return;
    setCreating(true);
    try {
      opened(await createBlankNote(template.title, template.body, workspace.id));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not create note");
    } finally {
      setCreating(false);
    }
  }

  const tabs = MARKET_CONTRACT_ID ? TABS : TABS.filter((t) => t.id === "starter");

  return (
    <div className="h-full overflow-y-auto" data-testid="templates-page">
      <main className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-8 sm:px-8">
        <header>
          <h1 className="display flex items-center gap-2 text-3xl">
            <LayoutTemplateIcon className="size-6" strokeWidth={1.5} />
            Templates
          </h1>
          <p className="text-muted-foreground mt-2 text-[14px]">{DESCRIPTIONS[tab]}</p>
        </header>

        {tabs.length > 1 ? (
          <Tabs value={tab} onValueChange={(value) => setTab(value as PageTab)}>
            <TabsList className="h-9">
              {tabs.map(({ id, label, Icon }) => (
                <TabsTrigger
                  key={id}
                  value={id}
                  data-testid={`templates-tab-${id}`}
                  className="text-muted-foreground gap-1.5 px-3.5 text-[13px]"
                >
                  <Icon className="size-3.5" strokeWidth={1.5} />
                  {label}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        ) : null}

        {tab === "yours" ? (
          <EarningsView />
        ) : (
          <>
            <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Template categories">
              {(["All", ...TEMPLATE_CATEGORIES] as const).map((c) => {
                const Icon = CATEGORY_ICONS[c];
                return (
                  <button
                    key={c}
                    type="button"
                    role="tab"
                    aria-selected={category === c}
                    onClick={() => setCategory(c)}
                    className={cn(
                      chip,
                      "inline-flex items-center gap-1.5",
                      category === c
                        ? "border-[var(--glass-hi)] bg-[var(--glass-strong)] text-foreground"
                        : "text-muted-foreground border-[var(--glass-lo)] hover:text-foreground",
                    )}
                  >
                    <Icon className="size-3" strokeWidth={1.75} aria-hidden />
                    {c}
                  </button>
                );
              })}
            </div>
            {/* A viewport-tall frame, so the list and the preview scroll on their own as in a split view. */}
            <div className="flex min-h-0 flex-col md:h-[calc(100dvh-17rem)] md:min-h-[480px]">
              {tab === "community" ? (
                <CommunityGallery category={category} active onCreated={opened} />
              ) : (
                <StarterGallery
                  category={category}
                  creating={creating}
                  viewerIn={canCreate ? null : workspace.name}
                  onUse={(t) => void startFromTemplate(t)}
                />
              )}
            </div>
          </>
        )}
      </main>
    </div>
  );
}

/**
 * Why "Use template" is disabled for a viewer: the copy would go into the
 * workspace on screen, where they cannot add notes (D-14). Worded as the buy
 * dialog words it.
 */
function ViewerCopyNote({ workspaceName }: { workspaceName: string }) {
  return (
    <p className="text-muted-foreground text-[12px]" data-testid="template-viewer">
      You&apos;re a viewer in {workspaceName}, so a copy can&apos;t be added to it. Switch to a workspace you edit
      first.
    </p>
  );
}

/** Doqtri's own starter templates: pick on the left, preview on the right. */
function StarterGallery({
  category,
  creating,
  viewerIn,
  onUse,
}: {
  category: TemplateCategory | "All";
  creating: boolean;
  /** The workspace's name when the user is a viewer there: copying is then disabled. */
  viewerIn: string | null;
  onUse: (template: NoteTemplate) => void;
}) {
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
                <span className="text-muted-foreground mt-1 block text-[12px] leading-snug">{t.description}</span>
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
            <p className="text-muted-foreground text-[12px]">{nodeCount} mindmap nodes</p>
          </div>
          <Button
            size="sm"
            disabled={creating || viewerIn !== null}
            onClick={() => onUse(selected)}
            data-testid="use-template"
            className="shrink-0 rounded-full"
          >
            {creating ? <Loader2Icon className="animate-spin" /> : <FilePlus2Icon />}
            {creating ? "Creating…" : "Use template"}
          </Button>
        </div>
        {viewerIn !== null ? <ViewerCopyNote workspaceName={viewerIn} /> : null}
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
  );
}

type Sort = "popular" | "newest" | "price";

const SORT_LABELS: Record<Sort, string> = { popular: "Most used", newest: "Newest", price: "Price" };
const SORT_ICONS: Record<Sort, LucideIcon> = { popular: FlameIcon, newest: ClockIcon, price: TagIcon };

function priceLabel(t: CommunityTemplate): string {
  return t.free ? "Free" : `${formatAmount(BigInt(t.price))} ${t.tokenCode}`;
}

/** The Community tab: fetched from /api/market/templates when it opens. */
function CommunityGallery({
  category,
  active,
  onCreated,
}: {
  category: TemplateCategory | "All";
  active: boolean;
  onCreated: (note: { id: string; title: string }) => void;
}) {
  const [sort, setSort] = useState<Sort>("popular");
  const { active: workspace, canCreate } = useActiveWorkspace();
  // Results remember the query they answer; a newer query reads as loading
  // until its own response lands, without resetting state inside the effect.
  const query = `${sort}|${category}`;
  const [result, setResult] = useState<
    | { query: string; kind: "error"; message: string }
    | { query: string; kind: "unavailable" }
    | { query: string; kind: "ready"; templates: CommunityTemplate[] }
    | null
  >(null);
  const state = result && result.query === query ? result : { kind: "loading" as const };
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [claiming, setClaiming] = useState(false);

  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    const params = new URLSearchParams({ sort });
    if (category !== "All") params.set("category", category);
    const key = `${sort}|${category}`;
    void (async () => {
      try {
        const res = await fetch(`/api/market/templates?${params}`, { signal: controller.signal });
        const body = (await res.json().catch(() => ({}))) as {
          templates?: CommunityTemplate[];
          available?: boolean;
          error?: string;
        };
        if (!res.ok) throw new Error(body.error || "Community templates couldn't be loaded.");
        if (body.available === false) {
          setResult({ query: key, kind: "unavailable" });
          return;
        }
        setResult({ query: key, kind: "ready", templates: body.templates ?? [] });
      } catch (error) {
        if (controller.signal.aborted) return;
        setResult({
          query: key,
          kind: "error",
          message: error instanceof Error ? error.message : "Community templates couldn't be loaded.",
        });
      }
    })();
    return () => controller.abort();
  }, [active, category, sort]);

  const templates = state.kind === "ready" ? state.templates : [];
  const selected = templates.find((t) => t.id === selectedId) ?? templates[0] ?? null;

  async function claim(template: CommunityTemplate) {
    if (!canCreate) return;
    setClaiming(true);
    try {
      const res = await fetch("/api/market/claim", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ templateId: template.id, workspaceId: workspace.id }),
      });
      const body = (await res.json().catch(() => ({}))) as { id?: string; title?: string; error?: string };
      if (!res.ok || !body.id) throw new Error(body.error || "The template could not be copied.");
      onCreated({ id: body.id, title: body.title ?? template.title });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "The template could not be copied.");
    } finally {
      setClaiming(false);
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2" data-testid="community-gallery">
      <div className="flex items-center justify-between gap-2">
        <label className="text-muted-foreground flex items-center gap-2 text-[11px]">
          Sort
          <Select value={sort} onValueChange={(next) => next && setSort(next as Sort)} items={SORT_LABELS}>
            <SelectTrigger size="sm" aria-label="Sort" className="w-auto" data-testid="community-sort">
              <SelectValue>
                {(value: Sort) => {
                  const Icon = SORT_ICONS[value];
                  return (
                    <>
                      <Icon className="size-3.5" strokeWidth={1.5} />
                      {SORT_LABELS[value]}
                    </>
                  );
                }}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(SORT_LABELS) as Sort[]).map((s) => {
                const Icon = SORT_ICONS[s];
                return (
                  <SelectItem key={s} value={s}>
                    <Icon className="size-3.5" strokeWidth={1.5} />
                    {SORT_LABELS[s]}
                  </SelectItem>
                );
              })}
            </SelectContent>
          </Select>
        </label>
        {MARKET_CONTRACT_ID ? (
          <a
            href={expertContractUrl(MARKET_CONTRACT_ID)}
            target="_blank"
            rel="noopener noreferrer"
            className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-[11px]"
          >
            On-chain
            <ExternalLinkIcon className="size-3" strokeWidth={1.5} />
          </a>
        ) : null}
      </div>

      {state.kind === "loading" ? (
        <p className="text-muted-foreground flex items-center gap-2 py-8 text-[12px]">
          <Loader2Icon className="size-3.5 animate-spin" /> Loading community templates…
        </p>
      ) : state.kind === "unavailable" ? (
        <p className="text-muted-foreground py-8 text-[12px]">
          Community templates aren&apos;t available on this network.
        </p>
      ) : state.kind === "error" ? (
        <p role="alert" className="text-destructive py-8 text-[12px]">
          {state.message}
        </p>
      ) : templates.length === 0 ? (
        <p className="text-muted-foreground py-8 text-[12px]" data-testid="community-empty">
          No community templates {category === "All" ? "yet" : `in ${category} yet`}. Publish one of your notes from its
          Stellar proof panel.
        </p>
      ) : (
        <div className="grid min-h-0 flex-1 gap-3 overflow-y-auto md:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)] md:overflow-hidden">
          <ScrollArea className="min-h-0 md:h-full">
            <ul className="grid gap-2 pr-2 sm:grid-cols-2" aria-label="Community templates">
              {templates.map((t) => (
                <li key={t.id}>
                  <button
                    type="button"
                    onClick={() => setSelectedId(t.id)}
                    aria-pressed={t.id === selected?.id}
                    data-testid={`community-template-${t.id}`}
                    className={cn(
                      "h-full w-full rounded-xl border p-3 text-left transition-colors focus-visible:ring-ring focus-visible:ring-1 focus-visible:outline-hidden",
                      t.id === selected?.id
                        ? "border-[var(--glass-hi)] bg-[var(--glass-strong)]"
                        : "border-[var(--glass-lo)] bg-[var(--glass)] hover:border-[var(--glass-hi)]",
                    )}
                  >
                    <span className="flex items-center justify-between gap-2">
                      <span className="eyebrow text-label text-[10px]">{t.category}</span>
                      <span className="text-foreground text-[11px] font-medium">{priceLabel(t)}</span>
                    </span>
                    <span className="text-foreground mt-1 block text-[13px] font-semibold">{t.title}</span>
                    {t.description ? (
                      <span className="text-muted-foreground mt-1 block text-[12px] leading-snug">{t.description}</span>
                    ) : null}
                    <span className="text-label mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px]">
                      <span className="font-mono">{shortAddress(t.creatorWallet)}</span>
                      <span>
                        {t.uses} {t.uses === 1 ? "use" : "uses"}
                      </span>
                      {t.mine ? (
                        <span className="rounded-full border border-[var(--glass-lo)] px-1.5 py-px text-[10px]">
                          Yours
                        </span>
                      ) : t.owned ? (
                        <span className="rounded-full border border-[var(--glass-lo)] px-1.5 py-px text-[10px]">
                          Owned
                        </span>
                      ) : null}
                    </span>
                    {t.parent ? (
                      <span className="text-muted-foreground mt-1 block truncate text-[11px]">
                        Derived from <span className="text-foreground">{t.parent.title}</span>
                      </span>
                    ) : null}
                  </button>
                </li>
              ))}
            </ul>
          </ScrollArea>
          {selected ? (
            <CommunityPreview
              key={selected.id}
              template={selected}
              candidates={templates}
              claiming={claiming}
              viewerIn={canCreate ? null : workspace.name}
              onClaim={() => void claim(selected)}
              onCreated={onCreated}
            />
          ) : null}
        </div>
      )}
    </div>
  );
}

function CommunityPreview({
  template,
  candidates,
  claiming,
  viewerIn,
  onClaim,
  onCreated,
}: {
  template: CommunityTemplate;
  /** The loaded gallery, to pick an original from when reporting a copy. */
  candidates: CommunityTemplate[];
  claiming: boolean;
  /** The workspace's name when the user is a viewer there: copying is then disabled. */
  viewerIn: string | null;
  onClaim: () => void;
  onCreated: (note: { id: string; title: string }) => void;
}) {
  const tree = useMemo(() => buildMindmap(template.title, template.preview), [template]);
  const paid = !template.free;
  // Bought before or yours: copying is free. Otherwise a paid template is bought first.
  const mustBuy = paid && !template.mine && !template.owned;
  const [buyOpen, setBuyOpen] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  return (
    <section
      aria-label={`${template.title} preview`}
      className="flex min-h-0 flex-col gap-2 rounded-xl border border-[var(--glass-lo)] bg-[var(--glass)] p-3"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-foreground truncate text-[14px] font-semibold">{template.title}</p>
          <p className="text-muted-foreground text-[12px]">
            by <span className="font-mono">{shortAddress(template.creatorWallet)}</span> · {priceLabel(template)}
          </p>
          {template.parent ? (
            <p className="text-muted-foreground text-[11px]">
              Derived from “{template.parent.title}” by{" "}
              <span className="font-mono">{shortAddress(template.parent.creatorWallet)}</span>
            </p>
          ) : null}
        </div>
        {mustBuy ? (
          <Button
            size="sm"
            onClick={() => setBuyOpen(true)}
            data-testid="buy-template"
            className="shrink-0 rounded-full"
          >
            <ShoppingBagIcon />
            Buy · {priceLabel(template)}
          </Button>
        ) : (
          <Button
            size="sm"
            disabled={claiming || viewerIn !== null}
            onClick={onClaim}
            data-testid="use-community-template"
            className="shrink-0 rounded-full"
          >
            {claiming ? <Loader2Icon className="animate-spin" /> : <FilePlus2Icon />}
            {claiming ? "Creating…" : template.owned && !template.mine ? "Use again" : "Use template"}
          </Button>
        )}
      </div>
      {viewerIn !== null && !mustBuy ? <ViewerCopyNote workspaceName={viewerIn} /> : null}
      <div className="bg-background relative h-56 shrink-0 overflow-hidden rounded-lg border border-[var(--glass-lo)] p-2 md:h-64">
        <TemplateMapPreview tree={tree} />
      </div>
      {!template.mine ? (
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1">
            <TipCreator template={template} />
          </div>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => setReportOpen(true)}
            data-testid="report-template"
            className="text-muted-foreground h-8 shrink-0 text-[11px]"
            title="Report this template as a copy of another"
          >
            <FlagIcon />
            Report copy
          </Button>
        </div>
      ) : null}
      <ScrollArea className="min-h-0 flex-1">
        <pre className="text-muted-foreground max-h-60 font-mono text-[11px] leading-relaxed whitespace-pre-wrap md:max-h-none">
          {template.preview}
        </pre>
        {paid ? (
          <p className="text-label mt-2 text-[11px]">Headings only. The full text unlocks after purchase.</p>
        ) : null}
      </ScrollArea>
      {mustBuy && buyOpen ? (
        <BuyTemplateDialog template={template} open={buyOpen} onOpenChange={setBuyOpen} onBought={onCreated} />
      ) : null}
      {reportOpen ? (
        <ReportTemplateDialog
          template={template}
          candidates={candidates}
          open={reportOpen}
          onOpenChange={setReportOpen}
        />
      ) : null}
    </section>
  );
}

/** Sends a tip in the template's token, straight to its creator. */
function TipCreator({ template }: { template: CommunityTemplate }) {
  const wallet = useWallet();
  const [amount, setAmount] = useState("");
  const [sending, setSending] = useState(false);
  const parsed = parseAmount(amount);
  const valid = parsed !== null && parsed > BigInt(0);

  async function send() {
    if (!valid) return;
    setSending(true);
    try {
      const address = await wallet.ensureWallet();
      const { txHash } = await TemplateMarket.tip(address, template.id, template.token, parsed);
      setAmount("");
      toast.success(`Tipped ${formatAmount(parsed)} ${template.tokenCode}`, {
        action: { label: "View tx", onClick: () => window.open(expertTxUrl(txHash), "_blank", "noopener,noreferrer") },
      });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "The tip could not be sent.");
    } finally {
      setSending(false);
      void wallet.refreshBalance();
    }
  }

  return (
    <form
      className="flex items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        void send();
      }}
    >
      <label className="sr-only" htmlFor={`tip-${template.id}`}>
        Tip amount in {template.tokenCode}
      </label>
      <Input
        id={`tip-${template.id}`}
        inputMode="decimal"
        placeholder={`Tip in ${template.tokenCode}`}
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
        aria-invalid={amount !== "" && !valid}
        className="h-8 flex-1 text-[12px]"
      />
      <Button
        type="submit"
        size="sm"
        variant="outline"
        disabled={!valid || sending}
        className="h-8 shrink-0 text-[12px]"
      >
        {sending ? <Loader2Icon className="animate-spin" /> : <HandCoinsIcon />}
        {sending ? "Sending…" : "Tip creator"}
      </Button>
    </form>
  );
}

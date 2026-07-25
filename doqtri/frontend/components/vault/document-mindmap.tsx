"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeftIcon, Loader2Icon, NetworkIcon, SparklesIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { MindmapCanvas } from "@/components/vault/mindmap-canvas";
import { graphFromMindmap } from "@/lib/mindmap-graph";
import { mindmapFromHeadings, type DocMindmap } from "@/lib/mindmap-types";

/**
 * The full-screen mindmap of a single document.
 *
 * This is the view the feature exists for: a vault with one document in it has
 * nothing to say in the vault graph, but it still has a shape, and this is
 * where that shape is visible.
 */
export function DocumentMindmap({
  docId,
  title,
  markdown,
  mindmap,
  stale,
}: {
  docId: string;
  title: string;
  markdown: string;
  mindmap: DocMindmap | null;
  stale: boolean;
}) {
  const router = useRouter();
  const [building, setBuilding] = useState(false);

  const derived = mindmap === null;
  const tree = useMemo(
    () => mindmap ?? mindmapFromHeadings(title, markdown),
    [mindmap, title, markdown],
  );
  const graph = useMemo(() => graphFromMindmap(tree), [tree]);

  async function rebuild() {
    setBuilding(true);
    try {
      const res = await fetch("/api/mindmap", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: docId }),
      });
      const payload: unknown = await res.json().catch(() => null);

      if (!res.ok) {
        const message =
          payload && typeof payload === "object" && "error" in payload
            ? String((payload as { error: unknown }).error)
            : `Could not build the mindmap (${res.status})`;
        throw new Error(message);
      }

      toast.success("Mindmap rebuilt");
      router.refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Mindmap failed");
    } finally {
      setBuilding(false);
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="border-border bg-background flex h-9 shrink-0 items-center justify-between gap-2 border-b px-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <Link
            href={`/vault/${docId}`}
            aria-label="Back to note"
            className="text-muted-foreground hover:text-foreground hover:bg-muted-foreground/10 flex size-6 shrink-0 items-center justify-center rounded transition-colors"
          >
            <ArrowLeftIcon className="size-3.5" strokeWidth={1.75} />
          </Link>
          <h1 className="text-foreground truncate text-[13px] font-medium">{title}</h1>
          <span className="text-label shrink-0 text-[11px]">
            {derived
              ? "· heading outline"
              : stale
                ? "· note has changed since this map"
                : "· concept mindmap"}
          </span>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={rebuild}
            disabled={building}
            // Purple is reserved for AI-driven affordances.
            className="text-accent hover:text-accent hover:bg-accent/10 h-7 gap-1.5 px-2 text-[12px]"
          >
            {building ? (
              <Loader2Icon className="size-3.5 animate-spin" />
            ) : (
              <SparklesIcon className="size-3.5" strokeWidth={1.75} />
            )}
            {derived ? "Build mindmap" : "Rebuild"}
          </Button>

          <Button
            variant="ghost"
            size="sm"
            // Renders an <a>, so Base UI must not assume native button semantics.
            nativeButton={false}
            render={
              <Link href="/vault/mindmap">
                <NetworkIcon className="size-3.5" strokeWidth={1.75} />
                Global mindmap
              </Link>
            }
            className="text-muted-foreground hover:text-foreground h-7 gap-1.5 px-2 text-[12px]"
          />
        </div>
      </header>

      <MindmapCanvas
        graph={graph}
        // Every node belongs to this one note, so there is only one place a
        // click can usefully go.
        onNodeClick={() => router.push(`/vault/${docId}`)}
        emptyMessage="No mindmap yet. Use Build mindmap to generate one from this note."
      />
    </div>
  );
}

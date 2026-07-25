"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { EditorPane } from "@/components/vault/editor-pane";
import { RightPanel } from "@/components/vault/right-panel";
import { RegenerateDialog } from "@/components/vault/regenerate-dialog";
import { useVaultStatus } from "@/components/vault/vault-status";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import type { Doc } from "@/lib/types";

const SETTLE_MS = 700;

function countWords(markdown: string): number {
  const words = markdown.trim().split(/\s+/).filter(Boolean);
  return words.length;
}

/**
 * Owns the markdown for the active note. The markdown is the single source of
 * truth: the editor writes it, Supabase persists it, and both the graph and
 * the mindmap are derived from it — nothing else is stored.
 *
 * Mounted with `key={active.id}` by the page, so navigating between notes
 * remounts rather than reconciling stale editor state.
 */
export function DocWorkspace({
  docs,
  active,
}: {
  docs: Doc[];
  active: Doc;
}) {
  const router = useRouter();
  const { setWordCount, setSaveState } = useVaultStatus();

  const [markdown, setMarkdown] = useState(active.markdown);
  const [regenerateOpen, setRegenerateOpen] = useState(false);
  const lastSavedRef = useRef(active.markdown);

  // Keeps the Supabase write and the force simulation off the keystroke path.
  const settled = useDebouncedValue(markdown, SETTLE_MS);

  useEffect(() => {
    setWordCount(countWords(markdown));
  }, [markdown, setWordCount]);

  useEffect(() => {
    if (markdown !== lastSavedRef.current) setSaveState("saving");
  }, [markdown, setSaveState]);

  // Clear the shared status when leaving the note.
  useEffect(() => {
    return () => {
      setWordCount(undefined);
      setSaveState("idle");
    };
  }, [setWordCount, setSaveState]);

  useEffect(() => {
    if (settled === lastSavedRef.current) return;

    let cancelled = false;
    const pending = settled;

    (async () => {
      const supabase = createSupabaseBrowserClient();
      // Anon key + RLS: the update policy restricts this to the caller's row.
      const { error } = await supabase
        .from("documents")
        .update({ markdown: pending, updated_at: new Date().toISOString() })
        .eq("id", active.id);

      if (cancelled) return;

      if (error) {
        setSaveState("error");
        toast.error(`Could not save: ${error.message}`);
        return;
      }

      lastSavedRef.current = pending;
      setSaveState("saved");
    })();

    return () => {
      cancelled = true;
    };
  }, [settled, active.id, setSaveState]);

  /**
   * The graph reads the settled text so the simulation is not restarted on
   * every keystroke. The mindmap reads the live text — it is cheap DOM and
   * benefits from immediate feedback.
   */
  const docsForGraph = useMemo(
    () =>
      docs.map((doc) =>
        doc.id === active.id ? { ...doc, markdown: settled } : doc,
      ),
    [docs, active.id, settled],
  );

  const handleRegenerate = useCallback(async () => {
    const res = await fetch("/api/regenerate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: active.id }),
    });

    const payload: unknown = await res.json().catch(() => null);

    if (!res.ok) {
      const message =
        payload && typeof payload === "object" && "error" in payload
          ? String((payload as { error: unknown }).error)
          : `Regenerate failed (${res.status})`;
      toast.error(message);
      return;
    }

    const next =
      payload && typeof payload === "object" && "markdown" in payload
        ? String((payload as { markdown: unknown }).markdown)
        : null;

    if (next === null) {
      toast.error("Regenerate returned no markdown");
      return;
    }

    // The route already wrote this row, so adopt it as the saved baseline
    // rather than letting the debounced effect write it straight back.
    lastSavedRef.current = next;
    setMarkdown(next);
    setSaveState("saved");
    toast.success("Note regenerated");
    router.refresh();
  }, [active.id, router, setSaveState]);

  return (
    <>
      <ResizablePanelGroup orientation="horizontal" className="min-h-0">
        <ResizablePanel id="editor" minSize={320} className="min-h-0">
          <EditorPane
            title={active.title}
            markdown={markdown}
            onChange={setMarkdown}
            onRegenerate={() => setRegenerateOpen(true)}
          />
        </ResizablePanel>

        <ResizableHandle className="hover:bg-primary/40 transition-colors" />

        <ResizablePanel
          id="right"
          defaultSize={250}
          minSize={200}
          maxSize={460}
          className="min-h-0"
        >
          <RightPanel
            docs={docsForGraph}
            activeId={active.id}
            title={active.title}
            markdown={markdown}
          />
        </ResizablePanel>
      </ResizablePanelGroup>

      <RegenerateDialog
        open={regenerateOpen}
        onOpenChange={setRegenerateOpen}
        onConfirm={handleRegenerate}
      />
    </>
  );
}

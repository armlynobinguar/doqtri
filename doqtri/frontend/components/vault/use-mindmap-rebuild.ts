"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { parseDocMindmap, type DocMindmap } from "@/lib/mindmap-types";

/**
 * Rebuilds a note's concept map through /api/mindmap and shows the map the
 * route answers with at once, rather than waiting for router.refresh() to
 * re-read every note on the page. The refresh still follows, in the
 * background, so the server data catches up; the rebuilt map is shown only
 * while `stored` is still the map it replaced, so newer server data wins.
 *
 * Returns the map to show, whether it is stale, and the rebuild action.
 */
export function useMindmapRebuild({
  docId,
  stored,
  stale,
}: {
  docId: string;
  stored: DocMindmap | null;
  stale: boolean;
}) {
  const router = useRouter();
  const [building, setBuilding] = useState(false);
  const [rebuilt, setRebuilt] = useState<{ replaced: DocMindmap | null; map: DocMindmap } | null>(null);

  const current = rebuilt && rebuilt.replaced === stored ? rebuilt : null;

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

      const map =
        payload && typeof payload === "object" && "mindmap" in payload
          ? parseDocMindmap((payload as { mindmap: unknown }).mindmap)
          : null;
      if (map) setRebuilt({ replaced: stored, map });

      toast.success("Mindmap rebuilt");
      router.refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Mindmap failed");
    } finally {
      setBuilding(false);
    }
  }

  return {
    mindmap: current ? current.map : stored,
    // Just built from the text the server holds, so not stale against it.
    stale: current ? false : stale,
    building,
    rebuild,
  };
}

/**
 * A stored map's root carries the title the note had when it was built; the
 * views show the note's title now, so a rename (pending or done) reaches it.
 */
export function withRootLabel(mindmap: DocMindmap, title: string): DocMindmap {
  return mindmap.root.label === title ? mindmap : { ...mindmap, root: { ...mindmap.root, label: title } };
}

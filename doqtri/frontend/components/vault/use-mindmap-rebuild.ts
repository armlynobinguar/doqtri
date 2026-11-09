"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { parseDocMindmap, type DocMindmap } from "@/lib/mindmap-types";
import { useNavigationStatus } from "@/components/vault/navigation";

/**
 * Rebuilds a note's concept map through /api/mindmap and shows the map the
 * route answers with at once, rather than waiting for router.refresh() to
 * re-read every note on the page. The refresh still follows, in the
 * background, so the server data catches up. The rebuilt map is shown while
 * `stored` still has the content it had when the route answered: a refresh
 * started earlier can bring that older map back without hiding the new one,
 * and once server data moves on (to this map, or a newer one) it wins.
 * Content, not identity: every refresh hands over a new object.
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
  const { navigating, isNavigating } = useNavigationStatus();
  const [building, setBuilding] = useState(false);
  // A refresh asked for during a navigation, which Next would batch with it
  // and so hold the navigation up; it runs once the navigation commits.
  const refreshAfterNavigation = useRef(false);
  useEffect(() => {
    if (navigating || !refreshAfterNavigation.current) return;
    refreshAfterNavigation.current = false;
    router.refresh();
  }, [navigating, router]);
  const [rebuilt, setRebuilt] = useState<{ base: string; map: DocMindmap } | null>(null);

  const storedKey = useMemo(() => mindmapKey(stored), [stored]);
  // The stored map as of the route's answer, which may be newer than the
  // render that started the rebuild.
  const latestKey = useRef(storedKey);
  useEffect(() => {
    latestKey.current = storedKey;
  }, [storedKey]);

  const current = rebuilt && rebuilt.base === storedKey ? rebuilt : null;

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
      if (map) setRebuilt({ base: latestKey.current, map });

      toast.success("Mindmap rebuilt");
      if (isNavigating()) refreshAfterNavigation.current = true;
      else router.refresh();
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

/** Compares maps by content. */
function mindmapKey(mindmap: DocMindmap | null): string {
  return JSON.stringify(mindmap);
}

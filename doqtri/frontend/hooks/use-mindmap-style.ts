"use client";

import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import { parseStyle, type MindmapStyle } from "@/lib/mindmap-style";
import { createStyleStore, type SavedStyle, type StyleStore } from "@/lib/mindmap-style-sync";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";

/**
 * A map's studio style. One per map (`scope`), so a document's map and the
 * global map can look different.
 *
 * With `saved` — the signed-in user's row, loaded by the server page — the
 * style is saved to that user and follows them to every device. Without it
 * (the demo vault, where nobody is signed in) it stays in this browser. How
 * edits reach the server is in lib/mindmap-style-sync.ts.
 */

let store: StyleStore | null = null;

function getStore(): StyleStore {
  if (store) return store;
  const created = createStyleStore({
    storage: () => window.localStorage,
    save: async ({ userId, scope, style }) => {
      const { data, error } = await createSupabaseBrowserClient()
        .from("mindmap_styles")
        .upsert(
          {
            user_id: userId,
            scope,
            document_id: scope.startsWith("doc:") ? scope.slice("doc:".length) : null,
            style,
          },
          { onConflict: "user_id,scope" },
        )
        .select("updated_at")
        .single();
      if (error) throw error;
      return data.updated_at as string;
    },
  });

  // Leaving or backgrounding the page: send what is waiting now rather than
  // trust the timer to fire. Anything that still misses stays parked.
  window.addEventListener("pagehide", () => created.flush());
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") created.flush();
  });

  store = created;
  return created;
}

function subscribe(listener: () => void) {
  return getStore().subscribe(listener);
}

export function useMindmapStyle(scope: string, fallback: MindmapStyle, saved?: SavedStyle) {
  // What the server renders, so the first paint already has the user's look.
  const serverStyle = useMemo(
    () => (saved?.style != null ? parseStyle(saved.style, fallback) : fallback),
    [saved, fallback],
  );

  const style = useSyncExternalStore(
    subscribe,
    () => getStore().read(scope, fallback, saved),
    () => serverStyle,
  );

  // An edit parked by an earlier visit, or a style taken over from this
  // browser, goes out once the map is open.
  useEffect(() => {
    getStore().resume(scope, saved);
  }, [scope, saved]);

  const setStyle = useCallback(
    (next: MindmapStyle | ((current: MindmapStyle) => MindmapStyle)) => {
      const current = getStore().read(scope, fallback, saved);
      getStore().write(scope, typeof next === "function" ? next(current) : next, saved);
    },
    [scope, fallback, saved],
  );

  return [style, setStyle] as const;
}

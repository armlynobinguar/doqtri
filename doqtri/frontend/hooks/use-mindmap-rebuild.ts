"use client";

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

/**
 * Builds (or rebuilds) a note's AI concept map: `POST /api/mindmap`, which
 * charges the AI quota, then a refresh so the server components read the
 * stored map back. Shared by every place that offers the action, so they
 * report success and failure the same way.
 */
export function useMindmapRebuild(docId: string) {
  const router = useRouter();
  const [building, setBuilding] = useState(false);

  const rebuild = useCallback(async () => {
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
  }, [docId, router]);

  return { building, rebuild };
}

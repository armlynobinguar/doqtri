"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useActiveWorkspaceId } from "@/components/vault/workspace-context";

/**
 * Keeps the shell in step with the page (WP-1.7). A page resolves the active
 * workspace on every request, but a soft navigation may reuse the layout
 * rendered before a switch (one made in another tab, or by following a link
 * into a note in another workspace), leaving the explorer on the old
 * workspace's notes. When the page's workspace and the shell's differ, this
 * refreshes the layout once.
 */
export function WorkspaceGuard({ workspaceId }: { workspaceId: string }) {
  const router = useRouter();
  const shellId = useActiveWorkspaceId();
  const stale = shellId !== null && shellId !== workspaceId;

  useEffect(() => {
    if (stale) router.refresh();
  }, [stale, router]);

  return null;
}

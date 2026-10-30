"use client";

import { createContext, useCallback, useContext, useMemo, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { toast } from "sonner";
import { useNavigate } from "@/components/vault/navigation";
import { canCreateIn, pathAfterSwitch, workspaceLabel, type WorkspaceChoice } from "@/lib/workspace-scope";

/**
 * The vault's active workspace on the client (WP-1.7). The layout resolves
 * it on the server and hands it down; switching asks the server to remember
 * the new one and reloads the layout, so every list, graph and mindmap is
 * read again for it. Nothing here grants access: the server re-checks the
 * membership on every load and every write.
 */

type ActiveWorkspaceValue = {
  active: WorkspaceChoice;
  workspaces: WorkspaceChoice[];
  /** Editors and above add notes here (D-14). */
  canCreate: boolean;
  /** The workspace being switched to, while the switch is in flight. */
  switchingTo: string | null;
  switchTo: (workspaceId: string, options?: { to?: string }) => Promise<void>;
};

const ActiveWorkspaceContext = createContext<ActiveWorkspaceValue | null>(null);

/** Asks the server to make `workspaceId` the active workspace; throws its refusal. */
export async function rememberActiveWorkspace(workspaceId: string): Promise<WorkspaceChoice> {
  const res = await fetch("/api/workspaces/active", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ workspaceId }),
  });
  const payload = (await res.json().catch(() => null)) as { workspace?: WorkspaceChoice; error?: string } | null;
  if (!res.ok || !payload?.workspace) throw new Error(payload?.error ?? `Could not switch workspace (${res.status})`);
  return payload.workspace;
}

export function ActiveWorkspaceProvider({
  active,
  workspaces,
  children,
}: {
  active: WorkspaceChoice;
  workspaces: WorkspaceChoice[];
  children: React.ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const navigate = useNavigate();
  const [switchingTo, setSwitchingTo] = useState<string | null>(null);

  const switchTo = useCallback(
    async (workspaceId: string, options: { to?: string } = {}) => {
      if (workspaceId === active.id && !options.to) return;
      setSwitchingTo(workspaceId);
      try {
        const workspace = await rememberActiveWorkspace(workspaceId);
        // Navigate first, then refresh: the explorer lives in the layout,
        // and a refresh issued before the push is superseded by it.
        navigate(options.to ?? pathAfterSwitch(pathname));
        router.refresh();
        if (workspace.id !== active.id) toast.success(`Switched to ${workspaceLabel(workspace)}`);
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Could not switch workspace");
      } finally {
        setSwitchingTo(null);
      }
    },
    [active.id, navigate, pathname, router],
  );

  const value = useMemo<ActiveWorkspaceValue>(
    () => ({ active, workspaces, canCreate: canCreateIn(active), switchingTo, switchTo }),
    [active, workspaces, switchingTo, switchTo],
  );
  return <ActiveWorkspaceContext.Provider value={value}>{children}</ActiveWorkspaceContext.Provider>;
}

/** The active workspace. Only inside the vault shell. */
export function useActiveWorkspace(): ActiveWorkspaceValue {
  const value = useContext(ActiveWorkspaceContext);
  if (!value) throw new Error("useActiveWorkspace must be used inside the vault shell");
  return value;
}

/** The active workspace's id, or null outside the vault shell (e.g. the demo vault). */
export function useActiveWorkspaceId(): string | null {
  return useContext(ActiveWorkspaceContext)?.active.id ?? null;
}

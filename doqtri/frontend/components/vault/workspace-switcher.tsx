"use client";

import { useState } from "react";
import { BriefcaseIcon, CheckIcon, ChevronsUpDownIcon, Loader2Icon, PlusIcon, UserRoundIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useActiveWorkspace } from "@/components/vault/workspace-context";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";
import {
  checkWorkspaceName,
  MAX_WORKSPACE_NAME,
  workspaceLabel,
  workspaceSlug,
  type WorkspaceChoice,
} from "@/lib/workspace-scope";

const ROLE_LABEL: Record<WorkspaceChoice["role"], string> = {
  viewer: "Viewer",
  editor: "Editor",
  admin: "Admin",
  owner: "Owner",
};

/**
 * Picks the workspace the vault shows (WP-1.7), and creates a new one. Sits
 * at the top of the file explorer, so it is in the docked explorer on a
 * desktop and in the notes drawer on a phone.
 */
export function WorkspaceSwitcher({ className }: { className?: string }) {
  const { active, workspaces, switchingTo, switchTo } = useActiveWorkspace();
  const [creating, setCreating] = useState(false);
  const busy = switchingTo !== null;

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label={`Workspace: ${workspaceLabel(active)}. Switch workspace`}
          data-testid="workspace-switcher"
          className={cn(
            "text-sidebar-foreground hover:text-foreground hover:bg-sidebar-accent focus-visible:ring-ring -ml-1.5 flex h-7 min-w-0 items-center gap-1.5 rounded-lg px-1.5 text-[12.5px] font-medium transition-colors pointer-coarse:h-10 pointer-coarse:text-[14px] focus-visible:ring-1 focus-visible:outline-hidden",
            className,
          )}
        >
          {busy ? (
            <Loader2Icon className="size-3.5 shrink-0 animate-spin" strokeWidth={1.5} aria-hidden />
          ) : (
            <WorkspaceIcon workspace={active} />
          )}
          <span className="truncate">{active.name}</span>
          <ChevronsUpDownIcon className="text-label size-3 shrink-0" strokeWidth={1.5} aria-hidden />
        </DropdownMenuTrigger>

        <DropdownMenuContent side="bottom" align="start" className="w-64 text-[13px]">
          <DropdownMenuGroup>
            <DropdownMenuLabel>Workspaces</DropdownMenuLabel>
            {workspaces.map((w) => (
              <DropdownMenuItem
                key={w.id}
                data-testid="workspace-option"
                disabled={busy}
                onClick={() => void switchTo(w.id)}
              >
                <WorkspaceIcon workspace={w} />
                <span className="min-w-0 flex-1 truncate">{workspaceLabel(w)}</span>
                <span className="text-muted-foreground text-[11px]">{ROLE_LABEL[w.role]}</span>
                <CheckIcon className={cn("size-3.5", w.id === active.id ? "opacity-100" : "opacity-0")} aria-hidden />
              </DropdownMenuItem>
            ))}
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem data-testid="new-workspace" disabled={busy} onClick={() => setCreating(true)}>
            <PlusIcon />
            New workspace
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <CreateWorkspaceDialog
        open={creating}
        onOpenChange={setCreating}
        onCreated={(id) => switchTo(id, { to: "/vault" })}
      />
    </>
  );
}

function WorkspaceIcon({ workspace }: { workspace: WorkspaceChoice }) {
  const Icon = workspace.personal ? UserRoundIcon : BriefcaseIcon;
  return <Icon className="size-3.5 shrink-0" strokeWidth={1.5} aria-hidden />;
}

/** Postgres unique_violation: the random slug tail collided. */
const UNIQUE_VIOLATION = "23505";

/**
 * Names a new team workspace and creates it through create_workspace(),
 * which makes the caller its owner in the same statement; the vault then
 * switches to it, empty and ready for notes.
 */
function CreateWorkspaceDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (workspaceId: string) => Promise<void>;
}) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    const checked = checkWorkspaceName(value);
    if ("error" in checked) {
      setError(checked.error);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const supabase = createSupabaseBrowserClient();
      let id: string | null = null;
      // A second try only for a slug that happened to be taken.
      for (let attempt = 0; attempt < 2 && !id; attempt += 1) {
        const { data, error: rpcError } = await supabase.rpc("create_workspace", {
          p_name: checked.name,
          p_slug: workspaceSlug(checked.name),
        });
        if (rpcError && rpcError.code !== UNIQUE_VIOLATION) throw new Error(rpcError.message);
        id = (data as { id?: string } | null)?.id ?? null;
      }
      if (!id) throw new Error("Could not create the workspace. Try again.");
      setValue("");
      onOpenChange(false);
      await onCreated(id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not create the workspace");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (busy) return;
        if (!next) setError(null);
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-[440px]">
        <form onSubmit={create} className="grid gap-4">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <BriefcaseIcon className="text-foreground size-4" strokeWidth={1.5} />
              New workspace
            </DialogTitle>
            <DialogDescription className="text-muted-foreground leading-relaxed">
              A shared space for a team&apos;s notes. You&apos;ll be its owner; your personal notes stay where they
              are.
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-1.5">
            <Input
              aria-label="Workspace name"
              data-testid="new-workspace-name"
              placeholder="Acme product team"
              autoFocus
              value={value}
              maxLength={MAX_WORKSPACE_NAME}
              disabled={busy}
              aria-invalid={error ? true : undefined}
              onChange={(event) => {
                setValue(event.target.value);
                setError(null);
              }}
            />
            {error ? (
              <p role="alert" className="text-destructive text-[12px]">
                {error}
              </p>
            ) : null}
          </div>

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !value.trim()} data-testid="create-workspace">
              {busy ? (
                <>
                  <Loader2Icon className="animate-spin" />
                  Creating…
                </>
              ) : (
                "Create workspace"
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

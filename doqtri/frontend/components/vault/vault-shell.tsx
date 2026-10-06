"use client";

import { useCallback, useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { Ribbon, type RibbonAction } from "@/components/vault/ribbon";
import { FileExplorer } from "@/components/vault/file-explorer";
import { StatusBar } from "@/components/vault/status-bar";
import { QuickSwitcher } from "@/components/vault/quick-switcher";
import { UploadDialog, type RetryTarget } from "@/components/vault/upload-dialog";
import { DeleteNoteDialog } from "@/components/vault/delete-note-dialog";
import { SettingsDialog } from "@/components/vault/settings-dialog";
import { AccountMenu } from "@/components/vault/account-menu";
import { WalletProvider } from "@/components/vault/wallet-provider";
import { isStellarPublicKey } from "@/lib/wallet-address";
import {
  VaultStatusProvider,
  useVaultStatus,
} from "@/components/vault/vault-status";
import { createBlankNote } from "@/lib/create-note";
import { deleteNote, DeleteNoteError } from "@/lib/delete-note";
import { anchoredDocIds } from "@/lib/stellar/anchored";
import type { FailedImport, NoteSummary } from "@/lib/types";
import {
  NavigationOverlay,
  NavigationProvider,
  useNavigate,
} from "@/components/vault/navigation";

export function VaultShell({
  notes,
  failedImports,
  email,
  children,
}: {
  notes: NoteSummary[];
  failedImports: FailedImport[];
  email: string;
  children: React.ReactNode;
}) {
  return (
    <WalletProvider sessionAddress={isStellarPublicKey(email) ? email : null}>
      <VaultStatusProvider>
        <NavigationProvider>
          <VaultShellInner notes={notes} failedImports={failedImports} email={email}>
            {children}
          </VaultShellInner>
        </NavigationProvider>
      </VaultStatusProvider>
    </WalletProvider>
  );
}

function VaultShellInner({
  notes,
  failedImports,
  email,
  children,
}: {
  notes: NoteSummary[];
  failedImports: FailedImport[];
  email: string;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const navigate = useNavigate();
  const { wordCount, saveState } = useVaultStatus();

  const [explorerOpen, setExplorerOpen] = useState(true);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [retryTarget, setRetryTarget] = useState<RetryTarget | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [ribbonActive, setRibbonActive] = useState<RibbonAction>("files");
  const [creating, setCreating] = useState(false);
  const [anchored, setAnchored] = useState<ReadonlySet<string>>(new Set());
  const [pendingDelete, setPendingDelete] = useState<NoteSummary | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  // The shell lives in the layout, so the active note comes from the URL
  // rather than from props. `/vault/mindmap` and `/vault/graph` are
  // vault-wide views, not notes.
  const segment = pathname.startsWith("/vault/")
    ? pathname.split("/")[2] || undefined
    : undefined;
  const routeAction: RibbonAction | undefined =
    segment === "mindmap" || segment === "graph" ? segment : undefined;
  const activeId = routeAction ? undefined : segment;

  const handleNewNote = useCallback(async () => {
    if (creating) return;
    setCreating(true);
    try {
      const { id, title } = await createBlankNote();
      toast.success(`Created “${title}”`);
      // Navigate first, then refresh: a refresh issued before the push is
      // superseded by it, and the push reuses the cached layout, so the
      // explorer (rendered by the layout) would never list the new note.
      navigate(`/vault/${id}`);
      router.refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not create note");
    } finally {
      setCreating(false);
    }
  }, [creating, navigate, router]);

  // Whether a note is anchored decides whether it can be deleted at all, and
  // only the ledger knows. One batched read covers the whole vault; the string
  // key keeps it from re-running when the layout hands back an equal list.
  const noteIdKey = notes.map((note) => note.id).join(",");
  useEffect(() => {
    const ids = noteIdKey ? noteIdKey.split(",") : [];
    let cancelled = false;
    void (async () => {
      try {
        // An empty vault resolves to an empty set without touching the RPC.
        const found = await anchoredDocIds(ids);
        if (!cancelled) setAnchored(found);
      } catch {
        // Ledger unreachable: leave the rows deletable rather than locking the
        // vault. /api/notes/[id] re-checks and refuses with the real reason.
        if (!cancelled) setAnchored(new Set());
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [noteIdKey]);

  const handleDeleteNote = useCallback(
    async (note: NoteSummary) => {
      setDeletingId(note.id);
      try {
        const { purgedUploads } = await deleteNote(note.id);
        toast.success(
          purgedUploads > 0
            ? `Deleted “${note.title}” and its archived original`
            : `Deleted “${note.title}”`,
        );
        // Same ordering as handleNewNote: a refresh issued before the push is
        // superseded by it, and the explorer lives in the layout.
        if (activeId === note.id) navigate("/vault");
        router.refresh();
      } catch (error) {
        // The ledger moved since the explorer last looked — show the chain
        // icon on that row now, so the refusal is not a dead end.
        if (error instanceof DeleteNoteError && error.code === "ANCHORED") {
          setAnchored((prev) => new Set(prev).add(note.id));
        }
        toast.error(
          error instanceof Error ? error.message : "Could not delete note",
        );
      } finally {
        setDeletingId(null);
      }
    },
    [activeId, navigate, router],
  );

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "k" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        setSwitcherOpen((open) => !open);
      }
      if (event.key === "n" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        void handleNewNote();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [handleNewNote]);

  const handleRibbonAction = useCallback(
    (action: RibbonAction) => {
      switch (action) {
        case "files":
          setExplorerOpen((open) => !open);
          setRibbonActive("files");
          break;
        case "search":
          setSwitcherOpen(true);
          break;
        case "graph":
        case "mindmap":
          // Routes rather than panel tabs: the vault-wide views need the whole
          // pane, and the ribbon's active state follows the URL below.
          navigate(`/vault/${action}`);
          break;
        case "settings":
          setSettingsOpen(true);
          break;
      }
    },
    [navigate],
  );

  return (
    <div className="flex h-svh min-h-0 flex-col overflow-hidden">
      <div className="flex min-h-0 flex-1">
        <Ribbon
          // On the vault-wide views the URL is the truth; elsewhere the last
          // ribbon click is, since those actions only toggle panels.
          active={routeAction ?? ribbonActive}
          onAction={handleRibbonAction}
        />

        <ResizablePanelGroup orientation="horizontal" className="min-h-0 flex-1">
          {explorerOpen && (
            <>
              <ResizablePanel
                id="explorer"
                defaultSize={210}
                minSize={160}
                maxSize={420}
                className="min-h-0"
              >
                <FileExplorer
                  notes={notes}
                  activeId={activeId}
                  creating={creating}
                  onNewNote={() => void handleNewNote()}
                  onUploadClick={() => {
                    setRetryTarget(null);
                    setUploadOpen(true);
                  }}
                  failedImports={failedImports}
                  onRetryImport={(target) => {
                    setRetryTarget(target);
                    setUploadOpen(true);
                  }}
                  anchoredIds={anchored}
                  deletingId={deletingId}
                  onDeleteNote={setPendingDelete}
                />
              </ResizablePanel>
              <ResizableHandle className="hover:bg-primary/40 transition-colors" />
            </>
          )}

          <ResizablePanel id="main" className="relative min-h-0">
            {children}
            <NavigationOverlay />
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>

      <StatusBar
        noteCount={notes.length}
        wordCount={wordCount}
        saveState={saveState}
        trailing={<AccountMenu />}
      />

      <QuickSwitcher
        notes={notes}
        open={switcherOpen}
        onOpenChange={setSwitcherOpen}
      />
      <UploadDialog
        open={uploadOpen}
        retry={retryTarget}
        onOpenChange={(next) => {
          setUploadOpen(next);
          if (!next) setRetryTarget(null);
        }}
      />
      <DeleteNoteDialog
        open={pendingDelete !== null}
        title={pendingDelete?.title ?? ""}
        onOpenChange={(next) => {
          if (!next) setPendingDelete(null);
        }}
        onConfirm={async () => {
          if (pendingDelete) await handleDeleteNote(pendingDelete);
        }}
      />
      <SettingsDialog
        email={email}
        noteCount={notes.length}
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
      />
    </div>
  );
}

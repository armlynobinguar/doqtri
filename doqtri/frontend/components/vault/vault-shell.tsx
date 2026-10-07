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
import { RenameNoteDialog } from "@/components/vault/rename-note-dialog";
import { SettingsDialog } from "@/components/vault/settings-dialog";
import { AccountMenu } from "@/components/vault/account-menu";
import { MobileTabBar, MobileTopBar } from "@/components/vault/mobile-chrome";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { useIsCompactVault } from "@/hooks/use-mobile";
import { WalletProvider } from "@/components/vault/wallet-provider";
import {
  VaultStatusProvider,
  useVaultStatus,
} from "@/components/vault/vault-status";
import { createBlankNote } from "@/lib/create-note";
import { deleteNote, DeleteNoteError } from "@/lib/delete-note";
import { renameNote } from "@/lib/rename-note";
import { anchoredDocIds } from "@/lib/stellar/anchored";
import type { FailedImport, NoteSummary, VaultIdentity } from "@/lib/types";
import {
  NavigationOverlay,
  NavigationProvider,
  useNavigate,
} from "@/components/vault/navigation";

export function VaultShell({
  notes,
  failedImports,
  identity,
  children,
}: {
  notes: NoteSummary[];
  failedImports: FailedImport[];
  identity: VaultIdentity;
  children: React.ReactNode;
}) {
  return (
    <WalletProvider identity={identity}>
      <VaultStatusProvider>
        <NavigationProvider>
          <VaultShellInner notes={notes} failedImports={failedImports} identity={identity}>
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
  identity,
  children,
}: {
  notes: NoteSummary[];
  failedImports: FailedImport[];
  identity: VaultIdentity;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const navigate = useNavigate();
  const { wordCount, saveState } = useVaultStatus();

  const isMobile = useIsCompactVault();
  const [explorerOpen, setExplorerOpen] = useState(true);
  // The explorer's home on a phone, where there is no room to dock it.
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [retryTarget, setRetryTarget] = useState<RetryTarget | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [ribbonActive, setRibbonActive] = useState<RibbonAction>("files");
  const [creating, setCreating] = useState(false);
  const [anchored, setAnchored] = useState<ReadonlySet<string>>(new Set());
  const [pendingDelete, setPendingDelete] = useState<NoteSummary | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [pendingRename, setPendingRename] = useState<NoteSummary | null>(null);

  // The shell lives in the layout, so the active note comes from the URL
  // rather than from props. `/vault/mindmap` and `/vault/graph` are
  // vault-wide views, not notes.
  const segment = pathname.startsWith("/vault/")
    ? pathname.split("/")[2] || undefined
    : undefined;
  const routeAction: RibbonAction | undefined =
    segment === "mindmap" || segment === "graph" ? segment : undefined;
  const activeId = routeAction ? undefined : segment;

  // What the mobile top bar calls the current pane. The desktop layout has no
  // equivalent: there the explorer's highlight and the tab strip say it.
  const mobileTitle =
    routeAction === "graph"
      ? "Graph view"
      : routeAction === "mindmap"
        ? "Global mindmap"
        : (notes.find((note) => note.id === activeId)?.title ?? "Vault");

  const handleNewNote = useCallback(async () => {
    if (creating) return;
    setCreating(true);
    setDrawerOpen(false);
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

  // Errors are rethrown so the dialog can show them beside the title field.
  const handleRenameNote = useCallback(
    async (note: NoteSummary, title: string) => {
      const renamed = await renameNote(note.id, title);
      toast.success(`Renamed to “${renamed.title}”`);
      // The explorer, tabs, and mindmap root all read the title from the
      // layout's server data.
      router.refresh();
    },
    [router],
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
          if (isMobile) {
            setDrawerOpen(true);
            break;
          }
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
    [isMobile, navigate],
  );

  const explorer = (
    <FileExplorer
      notes={notes}
      activeId={activeId}
      creating={creating}
      onNewNote={() => void handleNewNote()}
      onUploadClick={() => {
        setDrawerOpen(false);
        setRetryTarget(null);
        setUploadOpen(true);
      }}
      failedImports={failedImports}
      onRetryImport={(target) => {
        setDrawerOpen(false);
        setRetryTarget(target);
        setUploadOpen(true);
      }}
      anchoredIds={anchored}
      deletingId={deletingId}
      onDeleteNote={setPendingDelete}
      onRenameNote={(note) => {
        setDrawerOpen(false);
        setPendingRename(note);
      }}
    />
  );

  return (
    <div className="flex h-dvh min-h-0 flex-col overflow-hidden">
      <MobileTopBar
        title={mobileTitle}
        // Desktop shows this in the status bar; one live "Saved" is enough.
        saveState={isMobile ? saveState : "idle"}
        creating={creating}
        onNewNote={() => void handleNewNote()}
      />

      <div className="flex min-h-0 flex-1">
        <Ribbon
          // On the vault-wide views the URL is the truth; elsewhere the last
          // ribbon click is, since those actions only toggle panels.
          active={routeAction ?? ribbonActive}
          onAction={handleRibbonAction}
        />

        <ResizablePanelGroup orientation="horizontal" className="min-h-0 flex-1">
          {/*
            Phones get the explorer in a drawer instead. `max-lg:hidden` covers
            the server render and hydration, before useIsCompactVault can answer;
            the main panel keeps its slot either way, so it never remounts.
          */}
          {explorerOpen && !isMobile && (
            <>
              <ResizablePanel
                id="explorer"
                defaultSize={210}
                minSize={160}
                maxSize={420}
                className="min-h-0 max-lg:hidden"
              >
                {explorer}
              </ResizablePanel>
              <ResizableHandle className="hover:bg-primary/40 transition-colors max-lg:hidden" />
            </>
          )}

          <ResizablePanel id="main" className="relative min-h-0">
            {children}
            <NavigationOverlay />
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>

      <MobileTabBar
        active={drawerOpen ? "files" : (routeAction ?? (activeId ? "files" : undefined))}
        onAction={handleRibbonAction}
      />

      <StatusBar
        className="max-lg:hidden"
        noteCount={notes.length}
        wordCount={wordCount}
        saveState={saveState}
        trailing={<AccountMenu />}
      />

      <Sheet open={drawerOpen && isMobile} onOpenChange={setDrawerOpen}>
        <SheetContent
          side="left"
          showCloseButton={false}
          className="w-[85%] max-w-xs gap-0 border-r-border pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]"
          // Picking a note is the drawer's whole job, so any link closes it.
          onClick={(event) => {
            if ((event.target as HTMLElement).closest("a")) setDrawerOpen(false);
          }}
        >
          <SheetTitle className="sr-only">Notes</SheetTitle>
          <div className="min-h-0 flex-1">{explorer}</div>
          <div className="bg-sidebar border-border flex h-12 shrink-0 items-center justify-between gap-2 border-t px-3 text-[12px]">
            <span className="text-label tabular-nums">
              {notes.length} {notes.length === 1 ? "note" : "notes"}
            </span>
            <AccountMenu className="text-sidebar-foreground h-9 text-[12px]" />
          </div>
        </SheetContent>
      </Sheet>

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
      <RenameNoteDialog
        key={pendingRename?.id ?? "closed"}
        open={pendingRename !== null}
        title={pendingRename?.title ?? ""}
        onOpenChange={(next) => {
          if (!next) setPendingRename(null);
        }}
        onConfirm={async (title) => {
          if (pendingRename) await handleRenameNote(pendingRename, title);
        }}
      />
      <SettingsDialog
        identity={identity}
        noteCount={notes.length}
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
      />
    </div>
  );
}

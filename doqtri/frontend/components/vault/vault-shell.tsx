"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { Ribbon, ribbonRouteAction, type RibbonAction } from "@/components/vault/ribbon";
import { FileExplorer } from "@/components/vault/file-explorer";
import { StatusBar } from "@/components/vault/status-bar";
import { QuickSwitcher } from "@/components/vault/quick-switcher";
import { UploadDialog, type RetryTarget } from "@/components/vault/upload-dialog";
import { DeleteNoteDialog } from "@/components/vault/delete-note-dialog";
import { RenameNoteDialog } from "@/components/vault/rename-note-dialog";
import { SettingsDialog } from "@/components/vault/settings-dialog";
import type { AccountPage } from "@/components/vault/account-menu";
import type { NoteTemplate } from "@/lib/templates";
import { MobileTabBar, MobileTopBar } from "@/components/vault/mobile-chrome";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { useIsCompactVault } from "@/hooks/use-mobile";
import { WalletProvider } from "@/components/vault/wallet-provider";
import { LegalLiveProvider } from "@/components/legal/legal-live";
import { LegalUpdateNotice } from "@/components/legal/legal-update-notice";
import { WalletSetupDialog } from "@/components/vault/wallet-setup-dialog";
import {
  VaultStatusProvider,
  useVaultStatus,
} from "@/components/vault/vault-status";
import { createBlankNote } from "@/lib/create-note";
import { deleteNote, DeleteNoteError } from "@/lib/delete-note";
import { renameNote } from "@/lib/rename-note";
import { isNoAnswer, NoResponseError, REQUEST_TIMEOUT_MS } from "@/lib/no-response";
import { isTitleTaken } from "@/lib/title";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { anchoredDocIds } from "@/lib/stellar/anchored";
import type { FailedImport, NoteSummary, VaultIdentity } from "@/lib/types";
import type { WorkspaceChoice } from "@/lib/workspace-scope";
import { ActiveWorkspaceProvider, useActiveWorkspace } from "@/components/vault/workspace-context";
import { WorkspaceSwitcher } from "@/components/vault/workspace-switcher";
import {
  NavigationOverlay,
  NavigationProvider,
  useNavigate,
  useNavigationStatus,
} from "@/components/vault/navigation";
import {
  NoteOverlayProvider,
  isNotePending,
  overlayNotes,
  useNoteOverlayState,
} from "@/components/vault/note-overlay";

export function VaultShell({
  notes,
  failedImports,
  identity,
  isAdmin,
  legalLive,
  referralsLive = false,
  workspace,
  workspaces,
  children,
}: {
  /** The active workspace's notes: the only ones the vault lists (WP-1.7). */
  notes: NoteSummary[];
  failedImports: FailedImport[];
  identity: VaultIdentity;
  /** Staff (DOQTRI_ADMINS) get a ribbon shortcut to the review screens. */
  isAdmin: boolean;
  /** The legal pages are live (lib/legal.ts): shows their notice and links. */
  legalLive: boolean;
  /** The referral dashboard exists: the same gate as the legal pages (lib/legal.ts). */
  referralsLive?: boolean;
  /** The workspace the vault shows, resolved on the server. */
  workspace: WorkspaceChoice;
  /** Every workspace the user belongs to, for the switcher. */
  workspaces: WorkspaceChoice[];
  children: React.ReactNode;
}) {
  return (
    <LegalLiveProvider value={legalLive}>
      <WalletProvider identity={identity}>
        <VaultStatusProvider>
          <NavigationProvider>
            <ActiveWorkspaceProvider active={workspace} workspaces={workspaces}>
              <VaultShellInner
                notes={notes}
                failedImports={failedImports}
                identity={identity}
                isAdmin={isAdmin}
                referralsLive={referralsLive}
              >
                {children}
              </VaultShellInner>
            </ActiveWorkspaceProvider>
            <WalletSetupDialog />
          </NavigationProvider>
        </VaultStatusProvider>
      </WalletProvider>
    </LegalLiveProvider>
  );
}

function VaultShellInner({
  notes,
  failedImports,
  identity,
  isAdmin,
  referralsLive,
  children,
}: {
  notes: NoteSummary[];
  failedImports: FailedImport[];
  identity: VaultIdentity;
  /** Staff (DOQTRI_ADMINS) get a ribbon shortcut to the review screens. */
  isAdmin: boolean;
  referralsLive: boolean;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const navigate = useNavigate();
  const { navigating, isNavigating } = useNavigationStatus();
  const { wordCount, saveState } = useVaultStatus();
  const { active: workspace, canCreate } = useActiveWorkspace();

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
  // Null until the ledger answers, or if it cannot: the explorer then lists
  // notes in one group instead of guessing which are on-chain.
  const [anchored, setAnchored] = useState<ReadonlySet<string> | null>(null);
  const [pendingDelete, setPendingDelete] = useState<NoteSummary | null>(null);
  // `draft` is the title typed last time, when a refused rename is retried.
  const [pendingRename, setPendingRename] = useState<{ note: NoteSummary; draft?: string } | null>(null);

  // Renames, deletes and dismissals show at once and hold until the server's
  // data catches up; see note-overlay.tsx. Everything below that lists notes
  // reads the overlaid list, and the pages under `children` read the same
  // overlay from context.
  const refresh = useCallback(() => router.refresh(), [router]);
  const { overlay, run } = useNoteOverlayState({
    notes,
    failedImports,
    location: pathname,
    navigating,
    isNavigating,
    refresh,
  });
  const shownNotes = useMemo(() => overlayNotes(notes, overlay), [notes, overlay]);
  const shownImports = useMemo(
    () => failedImports.filter((item) => !overlay.dismissed.has(item.id)),
    [failedImports, overlay],
  );
  // For toast actions, which run long after the render that made them.
  const latest = useRef({ overlay, shownNotes });
  useEffect(() => {
    latest.current = { overlay, shownNotes };
  }, [overlay, shownNotes]);

  // The shell lives in the layout, so the active note comes from the URL
  // rather than from props. `/vault/mindmap`, `/vault/graph` and
  // `/vault/templates` are vault-wide views, not notes, and so is
  // `/vault/referrals` when it exists; `/vault/profile` and
  // `/vault/earnings` and `/vault/workspace/members` are account pages, not
  // notes either.
  const segment = pathname.startsWith("/vault/")
    ? pathname.split("/")[2] || undefined
    : undefined;
  const routeAction = ribbonRouteAction(segment, referralsLive);
  const accountPage = segment === "profile" || segment === "earnings" || segment === "workspace";
  const currentAccountPage: AccountPage | undefined =
    segment === "profile" ? "profile" : segment === "workspace" ? "members" : undefined;
  const activeId = routeAction || accountPage ? undefined : segment;

  // What the mobile top bar calls the current pane. The desktop layout has no
  // equivalent: there the explorer's highlight and the tab strip say it.
  const mobileTitle =
    routeAction === "graph"
      ? "Graph view"
      : routeAction === "mindmap"
        ? "Global mindmap"
        : routeAction === "templates"
          ? "Templates"
          : routeAction === "referrals"
            ? "Referrals"
            : segment === "profile"
              ? "Profile"
              : segment === "workspace"
                ? "Members"
                : // With no note open, the phone says which workspace it is showing.
                  (shownNotes.find((note) => note.id === activeId)?.title ?? workspace.name);

  // Blank by default; a template seeds the title and body instead. Into the
  // workspace on screen, named explicitly so a switch in another tab cannot
  // send it elsewhere.
  const handleNewNote = useCallback(async (template?: NoteTemplate) => {
    if (creating) return;
    if (!canCreate) {
      toast.error(`You're a viewer in ${workspace.name}, so you can't add notes to it.`);
      return;
    }
    setCreating(true);
    setDrawerOpen(false);
    try {
      const { id, title } = await createBlankNote(template?.title, template?.body, workspace.id);
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
  }, [canCreate, creating, navigate, router, workspace.id, workspace.name]);

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
        if (!cancelled) setAnchored(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [noteIdKey]);

  const handleDeleteNote = useCallback(
    (note: NoteSummary) => {
      const wasOpen = activeId === note.id;
      // Leaving the note has to be undone by hand if the delete is refused.
      const reopen = wasOpen
        ? { action: { label: "Open note", onClick: () => navigate(`/vault/${note.id}`) } }
        : undefined;
      // The request runs outside any transition, so this commits at once.
      if (wasOpen) navigate("/vault");
      run(
        { kind: "delete", id: note.id },
        async () => {
          const { purgedUploads } = await deleteNote(note.id);
          toast.success(
            purgedUploads > 0
              ? `Deleted “${note.title}” and its archived original`
              : `Deleted “${note.title}”`,
          );
        },
        (error) => {
          // The ledger moved since the explorer last looked — show the chain
          // icon on that row now, so the refusal is not a dead end.
          if (error instanceof DeleteNoteError && error.code === "ANCHORED") {
            setAnchored((prev) => new Set(prev ?? []).add(note.id));
          }
          if (error instanceof NoResponseError) {
            toast.warning(`Could not reach doqtri, so “${note.title}” may not have been deleted.`, reopen);
            return;
          }
          toast.error(error instanceof Error ? error.message : "Could not delete note", reopen);
        },
      );
    },
    [activeId, navigate, run],
  );

  // A title another note already has is refused here, before any request,
  // with the route's own rule and wording; the dialog shows the throw beside
  // the field. Anything the server refuses later comes back as a toast, since
  // the dialog has closed by then.
  const handleRenameNote = useCallback(
    (note: NoteSummary, title: string) => {
      const others = shownNotes.filter((other) => other.id !== note.id).map((other) => other.title);
      if (isTitleTaken(title, others)) throw new Error(`Another note is already called “${title}”`);

      const retry = {
        action: {
          label: "Retry",
          onClick: () => {
            // Read now, not when the toast was made: the note may have been
            // renamed, deleted or be mid-change since.
            const current = latest.current.shownNotes.find((other) => other.id === note.id);
            if (!current) {
              toast.info("That note has been deleted since.");
              return;
            }
            if (isNotePending(latest.current.overlay, note.id)) {
              toast.info(`“${current.title}” is still being changed. Try again in a moment.`);
              return;
            }
            setPendingRename({ note: current, draft: title });
          },
        },
      };
      run(
        { kind: "rename", id: note.id, title, previousTitle: note.title },
        async () => {
          await renameNote(note.id, title);
        },
        (error) => {
          if (error instanceof NoResponseError) {
            toast.warning(`Could not reach doqtri, so renaming “${note.title}” may not have saved.`, retry);
            return;
          }
          toast.error(error instanceof Error ? error.message : "Could not rename note", retry);
        },
      );
    },
    [run, shownNotes],
  );

  const handleDismissImport = useCallback(
    (id: string) => {
      run(
        { kind: "dismiss", id },
        async () => {
          // RLS allows the owner to delete their own ingest rows; a row it
          // hides is not an error, just nothing deleted, so ask for the ids.
          const { data, error, status } = await createSupabaseBrowserClient()
            .from("ingests")
            .delete()
            .eq("id", id)
            .select("id")
            .abortSignal(AbortSignal.timeout(REQUEST_TIMEOUT_MS));
          // supabase-js reports a lost answer as an error with status 0
          // rather than throwing.
          if (error && isNoAnswer(status)) throw new NoResponseError();
          if (error) throw new Error(error.message);
          if (!data?.length) throw new Error("That import could not be dismissed");
        },
        (error) => {
          if (error instanceof NoResponseError) {
            toast.warning("Could not reach doqtri, so that import may not have been dismissed.");
            return;
          }
          toast.error(error instanceof Error ? error.message : "Could not dismiss that import");
        },
      );
    },
    [run],
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
        case "templates":
          navigate("/vault/templates");
          break;
        case "referrals":
          navigate("/vault/referrals");
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
      notes={shownNotes}
      activeId={activeId}
      header={<WorkspaceSwitcher />}
      canCreate={canCreate}
      creating={creating}
      onNewNote={() => void handleNewNote()}
      onUploadClick={() => {
        setDrawerOpen(false);
        setRetryTarget(null);
        setUploadOpen(true);
      }}
      onTemplatesClick={() => {
        setDrawerOpen(false);
        navigate("/vault/templates");
      }}
      failedImports={shownImports}
      onDismissImport={handleDismissImport}
      onRetryImport={(target) => {
        setDrawerOpen(false);
        setRetryTarget(target);
        setUploadOpen(true);
      }}
      anchoredIds={anchored ?? undefined}
      isPending={(id) => isNotePending(overlay, id)}
      onDeleteNote={setPendingDelete}
      onRenameNote={(note) => {
        setDrawerOpen(false);
        setPendingRename({ note });
      }}
    />
  );

  return (
    <NoteOverlayProvider value={overlay}>
      <div className="flex h-dvh min-h-0 flex-col overflow-hidden">
        <MobileTopBar
          title={mobileTitle}
          // Desktop shows this in the status bar; one live "Saved" is enough.
          saveState={isMobile ? saveState : "idle"}
          creating={creating}
          canCreate={canCreate}
          onNewNote={() => void handleNewNote()}
          accountPage={currentAccountPage}
        />
        <LegalUpdateNotice />

        <div className="flex min-h-0 flex-1">
          <Ribbon
            // On the vault-wide views the URL is the truth; elsewhere the last
            // ribbon click is, since those actions only toggle panels.
            active={routeAction ?? ribbonActive}
            onAction={handleRibbonAction}
            isAdmin={isAdmin}
            referralsLive={referralsLive}
            accountPage={currentAccountPage}
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
                <ResizableHandle className="hover:bg-foreground/25 transition-colors max-lg:hidden" />
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
          noteCount={shownNotes.length}
          workspaceName={workspace.name}
          wordCount={wordCount}
          saveState={saveState}
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
          </SheetContent>
        </Sheet>

        <QuickSwitcher
          notes={shownNotes}
          open={switcherOpen}
          onOpenChange={setSwitcherOpen}
        />
        <UploadDialog
          workspaceId={workspace.id}
          open={uploadOpen}
          retry={retryTarget}
          onOpenChange={(next) => {
            setUploadOpen(next);
            if (!next) setRetryTarget(null);
          }}
        />
        <DeleteNoteDialog
          open={pendingDelete !== null}
          // After a delete the row is gone; land on the explorer's list.
          focusAfterConfirm={() => noteRowLink()}
          title={pendingDelete?.title ?? ""}
          onOpenChange={(next) => {
            if (!next) setPendingDelete(null);
          }}
          onConfirm={() => {
            if (pendingDelete) handleDeleteNote(pendingDelete);
          }}
        />
        <RenameNoteDialog
          key={pendingRename ? `${pendingRename.note.id}:${pendingRename.draft ?? ""}` : "closed"}
          open={pendingRename !== null}
          title={pendingRename?.note.title ?? ""}
          initialValue={pendingRename?.draft}
          // After a rename the trigger is disabled (the rename is in flight),
          // which would drop focus to the page; the row's link is next best.
          focusAfterConfirm={() => noteRowLink(pendingRename?.note.id)}
          onOpenChange={(next) => {
            if (!next) setPendingRename(null);
          }}
          onConfirm={(title) => {
            if (pendingRename) handleRenameNote(pendingRename.note, title);
          }}
        />
        <SettingsDialog
          identity={identity}
          noteCount={shownNotes.length}
          open={settingsOpen}
          onOpenChange={setSettingsOpen}
        />
      </div>
    </NoteOverlayProvider>
  );
}

/**
 * A note's link in the explorer (`id`), or its first one, to move focus to
 * when a dialog closes; null when the explorer is not on screen (a phone,
 * with the drawer closed).
 */
function noteRowLink(id?: string): HTMLElement | null {
  const links = [...document.querySelectorAll<HTMLElement>("[data-note-link]")].filter(
    (link) => link.getClientRects().length > 0,
  );
  return (id ? links.find((link) => link.dataset.noteLink === id) : links[0]) ?? null;
}

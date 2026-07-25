"use client";

import { useCallback, useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { Ribbon, type RibbonAction } from "@/components/vault/ribbon";
import { FileExplorer } from "@/components/vault/file-explorer";
import { StatusBar } from "@/components/vault/status-bar";
import { QuickSwitcher } from "@/components/vault/quick-switcher";
import { UploadDialog } from "@/components/vault/upload-dialog";
import { SettingsDialog } from "@/components/vault/settings-dialog";
import {
  VaultStatusProvider,
  useVaultStatus,
} from "@/components/vault/vault-status";
import type { NoteSummary } from "@/lib/types";

export function VaultShell({
  notes,
  email,
  children,
}: {
  notes: NoteSummary[];
  email: string;
  children: React.ReactNode;
}) {
  return (
    <VaultStatusProvider>
      <VaultShellInner notes={notes} email={email}>
        {children}
      </VaultShellInner>
    </VaultStatusProvider>
  );
}

function VaultShellInner({
  notes,
  email,
  children,
}: {
  notes: NoteSummary[];
  email: string;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const { wordCount, saveState, setRightTab } = useVaultStatus();

  const [explorerOpen, setExplorerOpen] = useState(true);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [ribbonActive, setRibbonActive] = useState<RibbonAction>("files");

  // The shell lives in the layout, so the active note comes from the URL
  // rather than from props.
  const activeId = pathname.startsWith("/vault/")
    ? pathname.split("/")[2] || undefined
    : undefined;

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "k" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        setSwitcherOpen((open) => !open);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

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
          setRightTab("graph");
          setRibbonActive("graph");
          break;
        case "settings":
          setSettingsOpen(true);
          break;
      }
    },
    [setRightTab],
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex min-h-0 flex-1">
        <Ribbon active={ribbonActive} onAction={handleRibbonAction} />

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
                  onUploadClick={() => setUploadOpen(true)}
                />
              </ResizablePanel>
              <ResizableHandle className="hover:bg-primary/40 transition-colors" />
            </>
          )}

          <ResizablePanel id="main" className="min-h-0">
            {children}
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>

      <StatusBar
        noteCount={notes.length}
        wordCount={wordCount}
        saveState={saveState}
      />

      <QuickSwitcher
        notes={notes}
        open={switcherOpen}
        onOpenChange={setSwitcherOpen}
      />
      <UploadDialog open={uploadOpen} onOpenChange={setUploadOpen} />
      <SettingsDialog
        email={email}
        noteCount={notes.length}
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
      />
    </div>
  );
}

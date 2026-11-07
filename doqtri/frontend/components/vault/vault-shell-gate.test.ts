import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

/*
 * The referral dashboard's switch on its way through the real vault shell to the
 * real ribbon and top bar (WP-4.6, DOQ-24). referrals-gate.test.ts checks the
 * layout hands the shell the answer; this checks what the shell does with it, so
 * hardcoding it anywhere inside fails here. Only the shell's other panes are
 * stubbed, and they have nothing to do with the switch.
 */

const nav = vi.hoisted(() => ({ pathname: "/vault/referrals" }));

vi.mock("next/navigation", () => ({
  usePathname: () => nav.pathname,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

const nothing = () => null;
const passThrough = ({ children }: { children?: ReactNode }) => children;

vi.mock("@/components/ui/resizable", () => ({
  ResizablePanelGroup: passThrough,
  ResizablePanel: passThrough,
  ResizableHandle: nothing,
}));
vi.mock("@/components/ui/sheet", () => ({ Sheet: nothing, SheetContent: nothing, SheetTitle: nothing }));
vi.mock("@/components/vault/account-menu", () => ({ AccountMenu: nothing }));
vi.mock("@/components/vault/file-explorer", () => ({ FileExplorer: nothing }));
vi.mock("@/components/vault/status-bar", () => ({ StatusBar: nothing }));
vi.mock("@/components/vault/quick-switcher", () => ({ QuickSwitcher: nothing }));
vi.mock("@/components/vault/upload-dialog", () => ({ UploadDialog: nothing }));
vi.mock("@/components/vault/delete-note-dialog", () => ({ DeleteNoteDialog: nothing }));
vi.mock("@/components/vault/rename-note-dialog", () => ({ RenameNoteDialog: nothing }));
vi.mock("@/components/vault/settings-dialog", () => ({ SettingsDialog: nothing }));
vi.mock("@/components/vault/wallet-provider", () => ({ WalletProvider: passThrough }));
vi.mock("@/components/vault/wallet-setup-dialog", () => ({ WalletSetupDialog: nothing }));
vi.mock("@/components/vault/workspace-switcher", () => ({ WorkspaceSwitcher: nothing }));

const { VaultShell } = await import("@/components/vault/vault-shell");
const { TooltipProvider } = await import("@/components/ui/tooltip");

const workspace = { id: "w", name: "Acme team", personal: false, role: "owner", mine: true } as const;

function shell(referralsLive: boolean, pathname = "/vault/referrals") {
  nav.pathname = pathname;
  return renderToStaticMarkup(
    createElement(
      TooltipProvider,
      null,
      createElement(
        VaultShell,
        {
          notes: [],
          failedImports: [],
          identity: { kind: "email", email: "me@example.com", smartWallet: null },
          isAdmin: false,
          referralsLive,
          workspace,
          workspaces: [workspace],
        } as unknown as Parameters<typeof VaultShell>[0],
        null,
      ),
    ),
  );
}

const topBarTitle = (html: string) => /<h1[^>]*>([^<]*)<\/h1>/.exec(html)?.[1];

/** The classes of the ribbon button with this label: where it shows whether it's current. */
const ribbonClasses = (html: string, label: string) =>
  new RegExp(`<button[^>]*aria-label="${label}"[^>]*class="([^"]*)"`).exec(html)?.[1];

describe("while off", () => {
  it("the ribbon has no Referrals item, on any route", () => {
    expect(shell(false)).not.toContain('aria-label="Referrals"');
    expect(shell(false, "/vault")).not.toContain('aria-label="Referrals"');
  });

  it("/vault/referrals is any unknown path: no Referrals title on a phone", () => {
    expect(topBarTitle(shell(false))).toBe("Acme team");
  });
});

describe("once on", () => {
  it("the ribbon has its item, on every route", () => {
    expect(shell(true)).toContain('aria-label="Referrals"');
    expect(shell(true, "/vault")).toContain('aria-label="Referrals"');
  });

  it("on the page, the phone's title says so and the ribbon marks it", () => {
    const html = shell(true);
    expect(topBarTitle(html)).toBe("Referrals");
    expect(ribbonClasses(html, "Referrals")).not.toBe(ribbonClasses(html, "Graph view"));
  });

  it("elsewhere, it doesn't", () => {
    const html = shell(true, "/vault/graph");
    expect(topBarTitle(html)).toBe("Graph view");
    expect(ribbonClasses(html, "Referrals")).toBe(ribbonClasses(html, "Templates"));
  });
});

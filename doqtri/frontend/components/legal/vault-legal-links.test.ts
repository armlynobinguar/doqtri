import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LegalLiveProvider } from "@/components/legal/legal-live";
import { AccountMenu } from "@/components/vault/account-menu";
import { ProfileView } from "@/components/vault/profile-view";

/* What the vault's client components show with the legal pages' gate off and on. */

const wallet = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));

vi.mock("next/navigation", async (original) => ({
  ...(await original<typeof import("next/navigation")>()),
  useRouter: () => ({ push() {}, refresh() {} }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/components/vault/wallet-provider", () => ({ useWallet: () => wallet.current }));
vi.mock("@/components/vault/navigation", () => ({ useNavigate: () => () => {} }));
vi.mock("@/components/vault/passkeys-dialog", () => ({ PasskeysDialog: () => null }));

// A menu renders its content only once opened; here it is always open.
const passthroughs = vi.hoisted(() => (names: string[]) => async () => {
  const { createElement } = await import("react");
  const Open = ({ children }: { children?: React.ReactNode }) => createElement("div", null, children);
  return Object.fromEntries(names.map((name) => [name, Open]));
});
vi.mock(
  "@/components/ui/dropdown-menu",
  passthroughs([
    "DropdownMenu",
    "DropdownMenuContent",
    "DropdownMenuGroup",
    "DropdownMenuItem",
    "DropdownMenuLabel",
    "DropdownMenuSeparator",
    "DropdownMenuTrigger",
  ]),
);
vi.mock("@/components/ui/tooltip", passthroughs(["Tooltip", "TooltipContent", "TooltipTrigger"]));

function render(live: boolean, node: ReturnType<typeof createElement>) {
  return renderToStaticMarkup(createElement(LegalLiveProvider, { value: live }, node));
}

describe("Profile", () => {
  const profile = () =>
    createElement(ProfileView, { joinedAt: "2026-01-01T00:00:00Z", referral: null, workspaceId: "w" });

  beforeEach(() => {
    wallet.current = { identity: { kind: "email", email: "someone@example.com", smartWallet: null } };
  });

  it("has no legal links with the gate off", () => {
    const html = render(false, profile());
    expect(html).not.toContain('href="/privacy"');
    expect(html).not.toContain('href="/terms"');
  });

  it("links to both with the gate on", () => {
    const html = render(true, profile());
    expect(html).toContain('href="/privacy"');
    expect(html).toContain('href="/terms"');
  });
});

describe("the account menu's Switch vault, which creates an account for a new wallet", () => {
  const menu = () => createElement(AccountMenu, {});

  beforeEach(() => {
    wallet.current = {
      identity: { kind: "wallet", address: "GSESSION" },
      sessionAddress: "GSESSIONAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      walletAddress: "GOTHERBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
      mismatch: true,
      balance: null,
      balanceError: false,
    };
  });

  it("has no notice with the gate off", () => {
    const html = render(false, menu());
    expect(html).toContain("Switch vault to");
    expect(html).not.toContain("sign-up-notice");
  });

  it("shows the sign-up notice with the gate on", () => {
    const html = render(true, menu());
    expect(html).toContain("Switch vault to");
    expect(html).toContain("sign-up-notice");
    expect(html).toContain('href="/terms"');
  });
});

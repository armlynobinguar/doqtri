import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * While LEGAL_OPERATOR_NAME is empty the referral dashboard doesn't exist
 * (WP-4.6, DOQ-24): every place that reads the switch is checked here with it off
 * and on, through the real server component, so removing any one of those guards
 * fails a test. These mock the client trees they hand the answer to, which have
 * tests of their own: components/vault/vault-shell-gate.test.ts follows it through
 * the shell to the ribbon, and components/vault/profile-invite-gate.test.ts through
 * ProfileView to the Invite tab. GET /api/referrals has its own in
 * app/api/referrals/route.test.ts.
 *
 * The payout questionnaire (DOQ-25) opens only from that page, so the page's
 * notFound() is its guard in the UI; GET and PUT /api/referrals/payout-profile
 * have theirs in app/api/referrals/payout-profile/route.test.ts.
 */

const NOT_FOUND = "NEXT_NOT_FOUND";

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error(NOT_FOUND);
  },
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => "/vault",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => ({ value: "signed" }), has: () => false }),
  headers: async () => new Headers({ host: "localhost:3000" }),
}));

const supabaseQuery = {
  select: () => supabaseQuery,
  eq: () => supabaseQuery,
  order: async () => ({ data: [], error: null }),
  maybeSingle: async () => ({ data: null, error: null }),
};
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: "me", email: "me@example.com", created_at: "2026-01-01" } } }) },
    from: () => supabaseQuery,
    rpc: async () => ({ data: [], error: null }),
  }),
  createSupabaseAdminClient: () => ({
    rpc: () => ({ single: async () => ({ data: { code: "abcdefgh" }, error: null }) }),
  }),
}));
vi.mock("@/lib/active-workspace", () => ({
  getActiveWorkspace: async () => ({ active: { id: "w" }, workspaces: [] }),
}));
vi.mock("@/lib/ingest/failed", () => ({ loadFailedImports: async () => [] }));
vi.mock("@/lib/integrations/qdit-config", () => ({ qditIntegrationEnabled: () => false }));
vi.mock("@/lib/referral", async (original) => ({
  ...(await original<typeof import("@/lib/referral")>()),
  readReferralCookie: () => ({ code: "abcdefgh" }),
}));

// The heavy client trees around what's under test; each only passes props along.
vi.mock("@/components/vault/vault-shell", () => ({ VaultShell: () => null }));
vi.mock("@/components/vault/preferences", () => ({ PreferencesSync: () => null }));
vi.mock("@/components/vault/referral-claim", () => ({ ReferralClaim: () => null }));
vi.mock("@/components/vault/profile-view", () => ({ ProfileView: () => null }));
vi.mock("@/components/vault/account-menu", () => ({ AccountMenu: () => null }));

const { default: ReferralsPage, generateMetadata } = await import("@/app/vault/referrals/page");
const { default: VaultLayout } = await import("@/app/vault/layout");
const { default: ProfilePage } = await import("@/app/vault/profile/page");
const { Ribbon, ribbonRouteAction } = await import("@/components/vault/ribbon");
const { VaultShell } = await import("@/components/vault/vault-shell");
const { ProfileView } = await import("@/components/vault/profile-view");
const { ReferralInviteIntro } = await import("@/components/vault/referral-invite-intro");
const { TooltipProvider } = await import("@/components/ui/tooltip");

/** The element of a given component anywhere in a tree, without rendering it. */
function findElement(node: ReactNode, type: unknown): ReactElement<Record<string, unknown>> | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findElement(child, type);
      if (found) return found;
    }
    return null;
  }
  if (!isValidElement(node)) return null;
  if (node.type === type) return node as ReactElement<Record<string, unknown>>;
  return findElement((node.props as { children?: ReactNode }).children, type);
}

const off = () => vi.stubEnv("LEGAL_OPERATOR_NAME", "");
const on = () => vi.stubEnv("LEGAL_OPERATOR_NAME", "Test Operator");

beforeEach(off);
afterEach(() => vi.unstubAllEnvs());

describe("/vault/referrals", () => {
  it("is not found while off", async () => {
    await expect(ReferralsPage()).rejects.toThrow(NOT_FOUND);
  });

  it("is not found with a blank name", async () => {
    vi.stubEnv("LEGAL_OPERATOR_NAME", "   ");
    await expect(ReferralsPage()).rejects.toThrow(NOT_FOUND);
  });

  it("renders once on, with the link for the empty state", async () => {
    on();
    const page = await ReferralsPage();
    expect((page.props as { inviteUrl: string }).inviteUrl).toContain("/r/abcdefgh");
  });
});

describe("the page's metadata", () => {
  it("is nothing of its own while off, so its title is that of any unknown path", () => {
    expect(generateMetadata()).toEqual({});
  });

  it("is nothing with a blank name either", () => {
    vi.stubEnv("LEGAL_OPERATOR_NAME", "   ");
    expect(generateMetadata()).toEqual({});
  });

  it("names the page once on", () => {
    on();
    expect(generateMetadata()).toEqual({ title: "Referrals · Doqtri", robots: { index: false } });
  });
});

describe("the vault layout", () => {
  const live = async () =>
    findElement(await VaultLayout({ children: null }), VaultShell)?.props.referralsLive;

  it("tells the shell it's off", async () => {
    expect(await live()).toBe(false);
  });

  it("tells the shell once it's on", async () => {
    on();
    expect(await live()).toBe(true);
  });
});

describe("the profile page", () => {
  const live = async () => findElement(await ProfilePage(), ProfileView)?.props.referralsLive;

  it("tells the Invite tab it's off", async () => {
    expect(await live()).toBe(false);
  });

  it("tells the Invite tab once it's on", async () => {
    on();
    expect(await live()).toBe(true);
  });
});

describe("the ribbon", () => {
  const render = (referralsLive: boolean) =>
    renderToStaticMarkup(
      createElement(TooltipProvider, null, createElement(Ribbon, { onAction: () => {}, referralsLive })),
    );

  it("has no Referrals item while off, and keeps its others", () => {
    const html = render(false);
    expect(html).not.toContain('aria-label="Referrals"');
    expect(html).toContain('aria-label="Global mindmap"');
    expect(html).toContain('aria-label="Settings"');
  });

  it("has one once on", () => {
    expect(render(true)).toContain('aria-label="Referrals"');
  });

  it("marks nothing for the route while off, so it stays a 404 like any unknown note", () => {
    expect(ribbonRouteAction("referrals", false)).toBeUndefined();
    expect(ribbonRouteAction("referrals", true)).toBe("referrals");
  });

  it("leaves the other routes alone either way", () => {
    for (const live of [false, true]) {
      expect(ribbonRouteAction("graph", live)).toBe("graph");
      expect(ribbonRouteAction("mindmap", live)).toBe("mindmap");
      expect(ribbonRouteAction("templates", live)).toBe("templates");
      expect(ribbonRouteAction("profile", live)).toBeUndefined();
      expect(ribbonRouteAction(undefined, live)).toBeUndefined();
    }
  });
});

describe("Profile → Invite", () => {
  const render = (live: boolean) => renderToStaticMarkup(createElement(ReferralInviteIntro, { live }));

  it("stays byte-identical while off", () => {
    expect(render(false)).toBe(
      '<p class="text-muted-foreground text-[13px]">Share your link, let someone scan your QR code, or give them your code to enter when they sign up. Anyone who then creates an account is counted as your referral.</p>',
    );
  });

  it("explains the rule and links to the dashboard once on", () => {
    const html = render(true).replace(/&#x27;/g, "'");
    expect(html).not.toContain("counted as your referral");
    expect(html).toContain("earns you 30 PHP once they've made 3 on-chain activities");
    expect(html).toContain('href="/vault/referrals"');
    expect(html).toContain("View your referrals");
  });
});

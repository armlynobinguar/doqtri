import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * Every server-rendered place the legal pages' gate hides something. Each case
 * runs both ways, so it fails if its guard is removed and if the thing it
 * guards stops rendering at all.
 */

vi.mock("next/navigation", async (original) => ({
  ...(await original<typeof import("next/navigation")>()),
  useRouter: () => ({ push() {}, refresh() {} }),
}));

/** Answers any Supabase query chain with no rows. */
function noRows(): unknown {
  const chain: unknown = new Proxy(() => {}, {
    get: (_target, key) =>
      key === "then"
        ? (resolve: (value: unknown) => void) => resolve({ data: [], error: null })
        : () => chain,
  });
  return chain;
}

const supabase = vi.hoisted(() => ({ user: null as { id: string; email: string; user_metadata: object } | null }));

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({
    auth: { getUser: async () => ({ data: { user: supabase.user } }) },
    from: () => noRows(),
    rpc: () => noRows(),
  }),
  createSupabaseAdminClient: () => ({ from: () => noRows(), rpc: () => noRows() }),
}));
vi.mock("next/headers", () => ({ cookies: async () => ({ has: () => false, get: () => undefined }) }));
vi.mock("@/lib/active-workspace", () => ({
  getActiveWorkspace: async () => ({
    active: { id: "w", name: "Personal", personal: true, role: "owner", mine: true, former: false },
    workspaces: [],
  }),
}));
vi.mock("@/lib/ingest/failed", () => ({ loadFailedImports: async () => [] }));
vi.mock("@/components/vault/preferences", () => ({ PreferencesSync: () => null }));
vi.mock("@/components/vault/referral-claim", () => ({ ReferralClaim: () => null }));
// The vault's client side is tested in components/legal: here, only what the layout tells it.
vi.mock("@/components/vault/vault-shell", () => ({
  VaultShell: ({ legalLive }: { legalLive: boolean }) => `legalLive=${legalLive}`,
}));

const noParams = { searchParams: Promise.resolve({}) };

const RENDERED_PAGES: [string, () => Promise<ReactElement>][] = [
  ["the landing footer", async () => (await import("./page")).default()],
  ["the docs", async () => (await import("./docs/page")).default()],
  ["sign-up", async () => (await import("./(auth)/signup/page")).default(noParams)],
  ["login", async () => (await import("./(auth)/login/page")).default(noParams)],
];

const LINKS = ['href="/privacy"', 'href="/terms"'];

beforeEach(() => {
  // The sign-up page reads the referral cookie only with this key.
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");
  supabase.user = null;
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe.each(RENDERED_PAGES)("%s", (_name, page) => {
  it("has no legal links with the gate off", async () => {
    vi.stubEnv("LEGAL_OPERATOR_NAME", undefined);
    const html = renderToStaticMarkup(await page());
    for (const link of LINKS) expect(html).not.toContain(link);
    expect(html).not.toContain("sign-up-notice");
  });

  it("links to both with the gate on", async () => {
    vi.stubEnv("LEGAL_OPERATOR_NAME", "Test Operator");
    const html = renderToStaticMarkup(await page());
    for (const link of LINKS) expect(html).toContain(link);
  });
});

describe.each([
  ["sign-up", RENDERED_PAGES[2][1]],
  ["login", RENDERED_PAGES[3][1]],
])("%s", (_name, page) => {
  it("shows the sign-up notice with the gate on", async () => {
    vi.stubEnv("LEGAL_OPERATOR_NAME", "Test Operator");
    expect(renderToStaticMarkup(await page())).toContain("sign-up-notice");
  });
});

describe("the vault layout", () => {
  async function shellProp() {
    supabase.user = { id: "u", email: "someone@example.com", user_metadata: {} };
    const { default: VaultLayout } = await import("./vault/layout");
    return renderToStaticMarkup(await VaultLayout({ children: null }));
  }

  it("tells the vault the gate is off", async () => {
    vi.stubEnv("LEGAL_OPERATOR_NAME", undefined);
    expect(await shellProp()).toContain("legalLive=false");
  });

  it("tells the vault the gate is on", async () => {
    vi.stubEnv("LEGAL_OPERATOR_NAME", "Test Operator");
    expect(await shellProp()).toContain("legalLive=true");
  });
});

describe("the promo page, whatever the gate says", () => {
  it.each([[undefined], ["Test Operator"]])("discloses the AI rating, with LEGAL_OPERATOR_NAME %s", async (value) => {
    vi.stubEnv("LEGAL_OPERATOR_NAME", value);
    const { default: PromoPage } = await import("./promo/page");
    const html = renderToStaticMarkup(await PromoPage());
    expect(html).toContain("sent to OpenAI for an AI rating");
    expect(html).not.toContain("only reviewed by");
  });

  it.each([[undefined], ["Test Operator"]])("discloses it on the form too, with LEGAL_OPERATOR_NAME %s", async (value) => {
    vi.stubEnv("LEGAL_OPERATOR_NAME", value);
    const { PromoSubmissionForm } = await import("@/components/promo/promo-submission-form");
    const html = renderToStaticMarkup(createElement(PromoSubmissionForm, { submission: null }));
    expect(html).toContain("promo-ai-disclosure");
    expect(html).toContain("sent to OpenAI for an AI rating");
  });
});

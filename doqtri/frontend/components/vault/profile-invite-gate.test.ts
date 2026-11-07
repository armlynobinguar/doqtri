import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

/*
 * The last step of the switch on Profile → Invite (WP-4.6, DOQ-24): the real
 * ProfileView on its Invite tab. referrals-gate.test.ts covers the page handing
 * it the switch; this is what the view does with it.
 */

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams("tab=invite"),
}));
vi.mock("@/components/vault/wallet-provider", () => ({
  useWallet: () => ({ identity: { kind: "email", email: "me@example.com", smartWallet: null } }),
}));
vi.mock("@/components/vault/preferences", () => ({
  usePreferences: () => [{ theme: "system", textSize: "medium", reduceMotion: false }, vi.fn()],
}));
vi.mock("@/components/vault/passkeys-dialog", () => ({ PasskeysDialog: () => null }));
vi.mock("@/components/vault/connected-apps", () => ({ ConnectedApps: () => null }));

const { ProfileView } = await import("@/components/vault/profile-view");

const referral = {
  code: "abcdefgh",
  url: "https://doqtri.xyz/r/abcdefgh",
  qrSvg: "<svg></svg>",
  referred: 0,
  via: { link: 0, qr: 0, code: 0 },
};

const invite = (referralsLive: boolean) =>
  renderToStaticMarkup(
    createElement(ProfileView, { joinedAt: "2026-01-01T00:00:00Z", referral, referralsLive, workspaceId: "w" }),
  );

describe("Profile → Invite", () => {
  it("while off: the old copy, no link, and still the link, code and QR", () => {
    const html = invite(false);
    expect(html).toContain("Anyone who then creates an account is counted as your referral.");
    expect(html).not.toContain("/vault/referrals");
    expect(html).not.toContain("View your referrals");
    expect(html).toContain('data-testid="referral-code"');
    expect(html).toContain('data-testid="referral-link"');
  });

  it("once on: the rule and the link to the dashboard, with the rest still there", () => {
    const html = invite(true);
    expect(html).not.toContain("counted as your referral");
    expect(html).toContain("3 on-chain activities");
    expect(html).toContain('href="/vault/referrals"');
    expect(html).toContain("View your referrals");
    expect(html).toContain('data-testid="referral-code"');
    expect(html).toContain('data-testid="referral-link"');
  });
});

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LegalLiveProvider } from "@/components/legal/legal-live";
import { LegalUpdateNotice } from "@/components/legal/legal-update-notice";
import { LEGAL_NOTICE_DISMISS_KEY } from "@/lib/legal-copy";

/*
 * A static render takes the store's server snapshot, which always hides the
 * notice. To reach the gate check, this reads the browser snapshot instead,
 * against a stand-in localStorage.
 */
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useSyncExternalStore: (_subscribe: unknown, browserSnapshot: () => unknown) => browserSnapshot(),
}));

function renderWith(live: boolean, stored: Record<string, string> = {}) {
  vi.stubGlobal("window", { localStorage: { getItem: (key: string) => stored[key] ?? null } });
  return renderToStaticMarkup(createElement(LegalLiveProvider, { value: live }, createElement(LegalUpdateNotice)));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the vault's existing-user notice", () => {
  it("does not render with the gate off", () => {
    expect(renderWith(false)).toBe("");
  });

  it("renders with the gate on, linking to both documents", () => {
    const html = renderWith(true);
    expect(html).toContain("legal-update-notice");
    expect(html).toContain('href="/privacy"');
    expect(html).toContain('href="/terms"');
  });

  it("stays hidden once dismissed", () => {
    expect(renderWith(true, { [LEGAL_NOTICE_DISMISS_KEY]: "1" })).toBe("");
  });
});

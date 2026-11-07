import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SignUpNotice } from "@/components/legal/legal-links";
import { MINIMUM_AGE, REFERRAL_DELETION_CLAUSE } from "@/lib/legal-copy";
import { REFERRAL_ACTIVITY_THRESHOLD, REFERRAL_REWARD_LIMIT, REFERRAL_REWARD_PHP } from "@/lib/referral-program";
import PrivacyPage from "./privacy/page";
import robots from "./robots";
import sitemap from "./sitemap";
import TermsPage from "./terms/page";

/** Markup with tags removed and entities and whitespace evened out, to read as a visitor would. */
function readable(page: () => React.ReactElement): string {
  return renderToStaticMarkup(createElement(page))
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
}

const paths = () => sitemap().map((entry) => new URL(entry.url).pathname);

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("with the gate off", () => {
  it.each([
    ["/privacy", PrivacyPage],
    ["/terms", TermsPage],
  ])("%s is a 404", (_path, page) => {
    vi.stubEnv("LEGAL_OPERATOR_NAME", "  ");
    expect(() => page()).toThrow("NEXT_HTTP_ERROR_FALLBACK;404");
  });

  it("the sitemap leaves both out", () => {
    vi.stubEnv("LEGAL_OPERATOR_NAME", undefined);
    expect(paths()).not.toContain("/privacy");
    expect(paths()).not.toContain("/terms");
    expect(paths()).toContain("/docs");
  });
});

describe("with the gate on", () => {
  it.each([
    ["Privacy Policy", PrivacyPage],
    ["Terms of Service", TermsPage],
  ])("%s shows the operator from the environment", (title, page) => {
    vi.stubEnv("LEGAL_OPERATOR_NAME", "Test Operator");
    const text = readable(page);
    expect(text).toContain(title);
    expect(text).toContain("Test Operator");
    expect(text).toContain("Last updated");
    expect(text).not.toMatch(/placeholder text|TODO|TBD/);
  });

  it("the sitemap lists both", () => {
    vi.stubEnv("LEGAL_OPERATOR_NAME", "Test Operator");
    expect(paths()).toEqual(expect.arrayContaining(["/privacy", "/terms"]));
  });

  it("the Terms state the program's rules from lib/referral-program.ts", () => {
    vi.stubEnv("LEGAL_OPERATOR_NAME", "Test Operator");
    const text = readable(TermsPage);
    expect(text).toContain(`${REFERRAL_REWARD_PHP} PHP`);
    expect(text).toContain(`${REFERRAL_ACTIVITY_THRESHOLD} or more successful on-chain activities`);
    expect(text).toContain(`up to ${REFERRAL_REWARD_LIMIT} rewards`);
  });

  it("both documents carry the same deletion clause and the same age", () => {
    vi.stubEnv("LEGAL_OPERATOR_NAME", "Test Operator");
    for (const page of [PrivacyPage, TermsPage]) {
      const text = readable(page);
      expect(text).toContain(REFERRAL_DELETION_CLAUSE);
      expect(text).toContain(`Doqtri is for people ${MINIMUM_AGE} or older.`);
    }
  });
});

describe("the sign-up notice", () => {
  it("has the agreed wording, with both names linked", () => {
    const html = renderToStaticMarkup(createElement(SignUpNotice));
    expect(html.replace(/<[^>]+>/g, "")).toBe(
      "By creating an account you confirm you are 18 or older, agree to the Terms of Service and acknowledge the Privacy Policy.",
    );
    expect(html).toContain('href="/terms"');
    expect(html).toContain('href="/privacy"');
  });
});

describe("robots.txt", () => {
  it("allows both paths whether or not the gate is on", () => {
    vi.stubEnv("LEGAL_OPERATOR_NAME", undefined);
    const rules = robots().rules;
    expect(Array.isArray(rules) ? rules[0].allow : rules.allow).toEqual(expect.arrayContaining(["/privacy", "/terms"]));
  });
});

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SignUpNotice } from "@/components/legal/legal-links";
import { KEPT_CONTENT_CLAUSE, REFERRAL_DELETION_CLAUSE, TESTIMONIAL_CLAUSE } from "@/lib/legal-copy";
import PrivacyPage, { generateMetadata as privacyMetadata } from "./privacy/page";
import robots from "./robots";
import sitemap from "./sitemap";
import TermsPage, { generateMetadata as termsMetadata } from "./terms/page";

/** Markup with tags removed and entities and whitespace evened out, to read as a visitor would. */
function readable(page: () => React.ReactElement): string {
  return renderToStaticMarkup(createElement(page))
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
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

  it.each([
    ["/privacy", privacyMetadata],
    ["/terms", termsMetadata],
  ])("%s has no metadata of its own", (_path, metadata) => {
    vi.stubEnv("LEGAL_OPERATOR_NAME", undefined);
    expect(metadata()).toEqual({});
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

  it.each([
    ["Privacy Policy · Doqtri", privacyMetadata],
    ["Terms of Service · Doqtri", termsMetadata],
  ])("%s is the title", (title, metadata) => {
    vi.stubEnv("LEGAL_OPERATOR_NAME", "Test Operator");
    expect(metadata().title).toBe(title);
  });

  it("the sitemap lists both", () => {
    vi.stubEnv("LEGAL_OPERATOR_NAME", "Test Operator");
    expect(paths()).toEqual(expect.arrayContaining(["/privacy", "/terms"]));
  });

  // Literal on purpose. If a rule changes, this fails, and the legal text has
  // to be read again before the number is changed here.
  it("the Terms state the referral rules as reviewed: 3 activities, 30 PHP, limit 30", () => {
    vi.stubEnv("LEGAL_OPERATOR_NAME", "Test Operator");
    const text = readable(TermsPage);
    expect(text).toContain("You earn 30 PHP for each person");
    expect(text).toContain("3 or more successful on-chain activities");
    expect(text).toContain("up to 30 rewards");
    expect(text).toContain("The first 30 referrals to qualify count");
  });

  it("both documents state the minimum age as reviewed: 18", () => {
    vi.stubEnv("LEGAL_OPERATOR_NAME", "Test Operator");
    for (const page of [PrivacyPage, TermsPage]) {
      expect(readable(page)).toContain("Doqtri is for people 18 or older.");
    }
  });

  it("both documents carry the same clauses on deletion and testimonials", () => {
    vi.stubEnv("LEGAL_OPERATOR_NAME", "Test Operator");
    for (const page of [PrivacyPage, TermsPage]) {
      const text = readable(page);
      for (const clause of [REFERRAL_DELETION_CLAUSE, KEPT_CONTENT_CLAUSE, TESTIMONIAL_CLAUSE]) {
        expect(text).toContain(clause);
      }
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
  it("names neither page, and `Allow: /` leaves both open", () => {
    const rules = robots().rules;
    const { allow, disallow } = Array.isArray(rules) ? rules[0] : rules;
    expect(allow).toEqual(["/", "/docs", "/demo", "/d/"]);
    for (const path of ["/privacy", "/terms"]) {
      expect(disallow).not.toContain(path);
    }
  });
});

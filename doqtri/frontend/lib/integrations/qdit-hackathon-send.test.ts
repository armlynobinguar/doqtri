import { describe, expect, it } from "vitest";
import { hackathonUrl, parseHackathonInput } from "@/lib/integrations/qdit-hackathon-send";

/* The hackathon field of "Send to qdit hackathon" (WP-4.7, D-117). */

const ORIGIN = "https://qdit.test";
const SLUG = "stellar-build-2026";

describe("parseHackathonInput", () => {
  it.each([
    [SLUG, SLUG],
    [`  ${SLUG}  `, SLUG],
    [`https://qdit.test/hackathons/${SLUG}`, SLUG],
    [`https://WWW.qdit.test/hackathons/${SLUG}/admin?x=1#y`, SLUG],
    [`https://other.test/hackathons/${SLUG}`, null],
    [`https://qdit.test/hackathons/Bad_Slug`, null],
    [`https://qdit.test/projects/${SLUG}`, null],
    ["ftp://qdit.test/hackathons/x", null],
    ["Stellar", null],
    ["a".repeat(65), null],
    [42, null],
  ])("%j gives %j", (input, expected) => {
    expect(parseHackathonInput(input, ORIGIN)).toBe(expected);
  });

  it("takes only a bare slug while qdit's origin is unknown", () => {
    expect(parseHackathonInput(SLUG, null)).toBe(SLUG);
    expect(parseHackathonInput(`https://qdit.test/hackathons/${SLUG}`, null)).toBeNull();
    expect(parseHackathonInput(`https://anything.test/hackathons/${SLUG}`, null)).toBeNull();
  });
});

describe("hackathonUrl", () => {
  it("is the hackathon's page, or null without an origin", () => {
    expect(hackathonUrl("https://qdit.test/", SLUG)).toBe(`https://qdit.test/hackathons/${SLUG}`);
    expect(hackathonUrl(null, SLUG)).toBeNull();
  });
});

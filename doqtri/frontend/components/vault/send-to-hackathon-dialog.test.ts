import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  hackathonChoices,
  opensOn,
  pickedHackathon,
  projectChoices,
  SendError,
  SendResult,
  SendToHackathonButton,
  type HackathonSendSetup,
} from "@/components/vault/send-to-hackathon-dialog";
import { canSendToHackathon, type HackathonSendSuccess } from "@/lib/integrations/qdit-hackathon-send";

/*
 * "Send to qdit hackathon" on the global mindmap (WP-4.7, D-117): hidden
 * unless the flag is on and the page handed over a setup (admin or owner,
 * qdit connected), the project picker's order, the hackathon picker's
 * entries and default (D-122), and the success state's next step. Rendered
 * to static markup (no DOM).
 */

const SETUP: HackathonSendSetup = {
  workspaceId: "10000000-0000-4000-8000-000000000001",
  workspaceName: "Team",
  qditOrigin: "https://qdit.test",
  linkedProjects: [{ id: "p-linked", name: "Payroll" }],
};

const button = (setup: HackathonSendSetup | null) =>
  renderToStaticMarkup(createElement(SendToHackathonButton, { setup, noteCount: 3 }));

const result = (over: Partial<HackathonSendSuccess> = {}) =>
  renderToStaticMarkup(
    createElement(SendResult, {
      result: {
        ok: true,
        note_count: 12,
        submission_state: "none",
        qdit_url: "https://qdit.test/hackathons/stellar-build-2026",
        warnings: [],
        ...over,
      },
    }),
  );

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_QDIT_INTEGRATION", "1");
  vi.stubEnv("NEXT_PUBLIC_QDIT_HACKATHON", "1");
});

describe("SendToHackathonButton", () => {
  it("shows with the flag on and a setup", () => {
    expect(button(SETUP)).toContain("Send to qdit hackathon");
  });

  it.each([
    ["the hackathon flag off", "1", ""],
    ["the hackathon flag set to something else", "1", "true"],
    ["the integration off", "", "1"],
  ])("is hidden with %s", (_name, integration, hackathon) => {
    vi.stubEnv("NEXT_PUBLIC_QDIT_INTEGRATION", integration);
    vi.stubEnv("NEXT_PUBLIC_QDIT_HACKATHON", hackathon);
    expect(button(SETUP)).toBe("");
  });

  it("is hidden when the page gave no setup", () => {
    expect(button(null)).toBe("");
  });
});

describe("canSendToHackathon (D-10)", () => {
  it.each([
    ["owner", true, true],
    ["admin", true, true],
    ["editor", true, false],
    ["viewer", true, false],
    ["admin", false, false],
    [null, true, false],
  ] as const)("%s with qdit connected=%s: %s", (role, connected, expected) => {
    expect(canSendToHackathon(role, connected)).toBe(expected);
  });
});

describe("projectChoices", () => {
  const qdit = [
    { id: "p-other", name: "Other", can_link: true },
    { id: "P-LINKED", name: "Payroll", can_link: true },
    { id: "p-member", name: "Member only", can_link: false },
  ];

  it("offers linked projects first, then other projects the user administers", () => {
    expect(projectChoices(SETUP.linkedProjects, qdit)).toEqual([
      { id: "p-linked", label: "Payroll · linked here" },
      { id: "p-other", label: "Other" },
    ]);
  });

  it("drops a linked project the user doesn't administer in qdit", () => {
    expect(projectChoices(SETUP.linkedProjects, [{ id: "p-linked", name: "Payroll", can_link: false }])).toEqual([]);
  });

  it("offers linked projects while qdit's list is loading or failed", () => {
    expect(projectChoices(SETUP.linkedProjects, null)).toEqual([{ id: "p-linked", label: "Payroll · linked here" }]);
  });
});

describe("hackathonChoices (D-122)", () => {
  const GB = { locale: "en-GB", timeZone: "UTC" };
  const hackathon = (slug: string, state: string, opens_at = "2026-11-14T01:00:00.000Z") => ({
    slug,
    name: slug.toUpperCase(),
    opens_at,
    closes_at: "2026-11-21T09:00:00.000Z",
    state,
  });

  it("offers open hackathons, and shows upcoming ones with their opening date, disabled, in qdit's order", () => {
    expect(hackathonChoices([hackathon("a", "open"), hackathon("b", "upcoming"), hackathon("c", "open")], GB)).toEqual([
      { id: "a", label: "A", disabled: false },
      { id: "b", label: "B · opens 14 Nov", disabled: true },
      { id: "c", label: "C", disabled: false },
    ]);
  });

  it("leaves out a state doqtri doesn't know", () => {
    expect(hackathonChoices([hackathon("a", "judging"), hackathon("b", "closed")], GB)).toEqual([]);
  });

  it("still names an upcoming hackathon whose opening time is unreadable", () => {
    expect(hackathonChoices([hackathon("b", "upcoming", "soon")], GB)).toEqual([
      { id: "b", label: "B · not open yet", disabled: true },
    ]);
  });

  it("dates in the viewer's locale and timezone", () => {
    expect(opensOn("2026-11-14T01:00:00.000Z", { locale: "en-US", timeZone: "UTC" })).toBe("Nov 14");
    // 1:00 UTC on the 14th is still the 13th in Los Angeles.
    expect(opensOn("2026-11-14T01:00:00.000Z", { locale: "en-GB", timeZone: "America/Los_Angeles" })).toBe("13 Nov");
    expect(opensOn("not a time")).toBeNull();
  });
});

describe("pickedHackathon", () => {
  const choices = [
    { id: "soon", disabled: true },
    { id: "a", disabled: false },
    { id: "b", disabled: false },
  ];

  it("preselects the first open hackathon", () => {
    expect(pickedHackathon(choices, "")).toBe("a");
  });

  it("keeps the user's pick while it can be picked", () => {
    expect(pickedHackathon(choices, "b")).toBe("b");
  });

  it("never picks an upcoming or unknown hackathon", () => {
    expect(pickedHackathon(choices, "soon")).toBe("a");
    expect(pickedHackathon(choices, "gone")).toBe("a");
  });

  it("picks nothing when no hackathon is open, so Send stays disabled", () => {
    expect(pickedHackathon([{ id: "soon", disabled: true }], "soon")).toBe("");
    expect(pickedHackathon([], "")).toBe("");
  });
});

describe("SendResult", () => {
  it("shows the note count and the next step, linking the hackathon", () => {
    const html = result();
    expect(html).toContain("qdit received 12 notes and the global mindmap.");
    expect(html).toContain("Now submit (or resubmit) in qdit");
    expect(html).toContain('href="https://qdit.test/hackathons/stellar-build-2026"');
  });

  it("asks for a resubmit when qdit has an older submission", () => {
    const html = result({ submission_state: "submitted_older", note_count: 1 });
    expect(html).toContain("qdit received 1 note and the global mindmap.");
    expect(html).toContain("Resubmit in qdit to include this");
    expect(html).not.toContain("Now submit");
  });

  it("lists warnings, and works without a qdit link", () => {
    const html = result({ qdit_url: null, warnings: ["A warning"] });
    expect(html).toContain("<li>A warning</li>");
    expect(html).not.toContain("href=");
  });
});

describe("SendError", () => {
  const render = (checkUrl: string | null) =>
    renderToStaticMarkup(createElement(SendError, { message: "qdit may have received this.", checkUrl }));

  it("links the entry in qdit after no answer", () => {
    const html = render("https://qdit.test/hackathons/stellar-build-2026");
    expect(html).toContain("qdit may have received this.");
    expect(html).toContain("Check your entry in qdit");
    expect(html).toContain('href="https://qdit.test/hackathons/stellar-build-2026"');
  });

  it("is only the message otherwise", () => {
    expect(render(null)).not.toContain("href=");
  });
});

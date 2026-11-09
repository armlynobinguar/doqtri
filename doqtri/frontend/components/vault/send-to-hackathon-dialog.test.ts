import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  projectChoices,
  SendResult,
  SendToHackathonButton,
  type HackathonSendSetup,
} from "@/components/vault/send-to-hackathon-dialog";
import { canSendToHackathon, type HackathonSendSuccess } from "@/lib/integrations/qdit-hackathon-send";

/*
 * "Send to qdit hackathon" on the global mindmap (WP-4.7, D-117): hidden
 * unless the flag is on and the page handed over a setup (admin or owner,
 * qdit connected), the project picker's order, and the success state's next
 * step. Rendered to static markup (no DOM).
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

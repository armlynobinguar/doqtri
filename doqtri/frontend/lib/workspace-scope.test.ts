import { describe, expect, it } from "vitest";
import {
  canCreateIn,
  checkWorkspaceName,
  encodeActiveWorkspace,
  parseActiveWorkspace,
  pathAfterSwitch,
  pickActiveWorkspace,
  sortWorkspaces,
  switchWorkspaceUrl,
  vaultReturnPath,
  workspaceLabel,
  workspaceSlug,
  type WorkspaceChoice,
} from "./workspace-scope";

const USER = "11111111-1111-4111-8111-111111111111";
const OTHER_USER = "22222222-2222-4222-8222-222222222222";
const PERSONAL = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TEAM = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const FRIEND = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const personal: WorkspaceChoice = { id: PERSONAL, name: "Ana", personal: true, role: "owner", mine: true };
const team: WorkspaceChoice = { id: TEAM, name: "Acme", personal: false, role: "viewer", mine: false };
// Someone else's personal workspace the user was added to (D-30).
const friend: WorkspaceChoice = { id: FRIEND, name: "Bo", personal: true, role: "editor", mine: false };

describe("active workspace cookie", () => {
  it("round-trips for the user who set it", () => {
    expect(parseActiveWorkspace(encodeActiveWorkspace(USER, TEAM), USER)).toBe(TEAM);
  });

  it("names nothing for whoever signs in next on the same browser", () => {
    expect(parseActiveWorkspace(encodeActiveWorkspace(USER, TEAM), OTHER_USER)).toBeNull();
  });

  it("ignores missing and malformed values", () => {
    expect(parseActiveWorkspace(undefined, USER)).toBeNull();
    expect(parseActiveWorkspace("", USER)).toBeNull();
    expect(parseActiveWorkspace(TEAM, USER)).toBeNull();
    expect(parseActiveWorkspace(`${USER}.not-a-uuid`, USER)).toBeNull();
    expect(parseActiveWorkspace(`${USER}.${TEAM}.extra`, USER)).toBeNull();
  });
});

describe("pickActiveWorkspace", () => {
  const all = [team, personal, friend];

  it("defaults to the personal workspace", () => {
    expect(pickActiveWorkspace(all, null)?.id).toBe(PERSONAL);
    expect(pickActiveWorkspace(all, undefined)?.id).toBe(PERSONAL);
  });

  it("keeps the requested workspace while the user is a member", () => {
    expect(pickActiveWorkspace(all, TEAM)?.id).toBe(TEAM);
    expect(pickActiveWorkspace(all, FRIEND)?.id).toBe(FRIEND);
  });

  it("falls back to the personal workspace once the user is removed (D-16)", () => {
    expect(pickActiveWorkspace([personal, friend], TEAM)?.id).toBe(PERSONAL);
  });

  it("never falls back to someone else's personal workspace", () => {
    expect(pickActiveWorkspace([team, friend], null)).toBeNull();
  });
});

describe("sortWorkspaces", () => {
  it("puts the user's own personal workspace first, then the rest by name", () => {
    expect(sortWorkspaces([friend, team, personal]).map((w) => w.id)).toEqual([PERSONAL, TEAM, FRIEND]);
  });

  it("does not reorder the list it is given", () => {
    const list = [team, personal];
    sortWorkspaces(list);
    expect(list).toEqual([team, personal]);
  });
});

describe("canCreateIn", () => {
  it("lets editors and above create, not viewers (D-14)", () => {
    expect(canCreateIn({ role: "viewer" })).toBe(false);
    expect(canCreateIn({ role: "editor" })).toBe(true);
    expect(canCreateIn({ role: "admin" })).toBe(true);
    expect(canCreateIn({ role: "owner" })).toBe(true);
    expect(canCreateIn(null)).toBe(false);
  });
});

describe("workspaceLabel", () => {
  it("marks only the user's own personal workspace", () => {
    expect(workspaceLabel(personal)).toBe("Ana (personal)");
    expect(workspaceLabel(friend)).toBe("Bo");
    expect(workspaceLabel(team)).toBe("Acme");
  });
});

describe("checkWorkspaceName", () => {
  it("trims the name", () => {
    expect(checkWorkspaceName("  Acme  ")).toEqual({ name: "Acme" });
  });

  it("refuses an empty or overlong name", () => {
    expect(checkWorkspaceName("   ")).toHaveProperty("error");
    expect(checkWorkspaceName("x".repeat(101))).toHaveProperty("error");
    expect(checkWorkspaceName("x".repeat(100))).toEqual({ name: "x".repeat(100) });
  });
});

describe("workspaceSlug", () => {
  const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

  it("fits the workspaces.slug check", () => {
    for (const name of ["Acme Labs", "  Ünïcødé & Co!  ", "---", "x".repeat(120), "日本語"]) {
      const slug = workspaceSlug(name);
      expect(slug).toMatch(SLUG);
      expect(slug.length).toBeLessThanOrEqual(64);
    }
  });

  it("is the name plus a random tail", () => {
    expect(workspaceSlug("Acme Labs", () => 0)).toBe("acme-labs-00000");
    expect(workspaceSlug("!!!", () => 0)).toBe("workspace-00000");
  });
});

describe("vaultReturnPath", () => {
  it("allows vault paths", () => {
    expect(vaultReturnPath("/vault")).toBe("/vault");
    expect(vaultReturnPath("/vault/abc/mindmap")).toBe("/vault/abc/mindmap");
    expect(vaultReturnPath("/vault?x=1")).toBe("/vault?x=1");
  });

  it("refuses anything that could leave the vault", () => {
    for (const raw of [null, "", "https://evil.example/vault", "//evil.example", "/vaulted", "/promo", "/vault\\..\\x"]) {
      expect(vaultReturnPath(raw)).toBe("/vault");
    }
  });
});

describe("pathAfterSwitch", () => {
  it("keeps the vault-wide views and leaves a note's pages", () => {
    expect(pathAfterSwitch("/vault/graph")).toBe("/vault/graph");
    expect(pathAfterSwitch("/vault/mindmap")).toBe("/vault/mindmap");
    expect(pathAfterSwitch("/vault/templates")).toBe("/vault/templates");
    expect(pathAfterSwitch("/vault/profile")).toBe("/vault/profile");
    expect(pathAfterSwitch("/vault/0d3c/mindmap")).toBe("/vault");
    expect(pathAfterSwitch("/vault/0d3c")).toBe("/vault");
    expect(pathAfterSwitch("/vault")).toBe("/vault");
  });
});

describe("switchWorkspaceUrl", () => {
  it("encodes the workspace and a vault return path", () => {
    expect(switchWorkspaceUrl(TEAM, "/vault/x/mindmap")).toBe(`/api/workspaces/active?ws=${TEAM}&next=%2Fvault%2Fx%2Fmindmap`);
  });

  it("never carries a path outside the vault", () => {
    expect(switchWorkspaceUrl(TEAM, "https://evil.example")).toBe(`/api/workspaces/active?ws=${TEAM}&next=%2Fvault`);
  });
});

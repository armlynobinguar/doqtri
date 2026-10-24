import { describe, expect, it } from "vitest";
import {
  allowedChainRole,
  chainRoleOf,
  grantCall,
  parseChainWorkspace,
  revocationCall,
} from "@/lib/stellar/workspace-chain";

describe("parseChainWorkspace", () => {
  const expected = { owner: "GOWNER", members: { CADMIN: "admin", CEDIT: "editor" } };

  it("reads members from a Map of { tag } enums", () => {
    const members = new Map<string, unknown>([
      ["CADMIN", { tag: "Admin", values: undefined }],
      ["CEDIT", { tag: "Editor", values: undefined }],
    ]);
    expect(parseChainWorkspace({ owner: "GOWNER", members, created_at: BigInt(1) })).toEqual(expected);
  });

  it("reads members from pairs, or an object, with [tag] enums", () => {
    expect(parseChainWorkspace({ owner: "GOWNER", members: [["CADMIN", ["Admin"]], ["CEDIT", ["Editor"]]] })).toEqual(expected);
    expect(parseChainWorkspace({ owner: "GOWNER", members: { CADMIN: "Admin", CEDIT: "Editor" } })).toEqual(expected);
  });

  it("refuses a value with no owner", () => {
    expect(() => parseChainWorkspace({ members: {} })).toThrow();
  });
});

describe("chain roles against database roles", () => {
  const workspace = { owner: "GOWNER", members: { CADMIN: "admin" as const } };

  it("names the owner, members and outsiders", () => {
    expect(chainRoleOf(workspace, "GOWNER")).toBe("owner");
    expect(chainRoleOf(workspace, "CADMIN")).toBe("admin");
    expect(chainRoleOf(workspace, "CNOBODY")).toBeNull();
  });

  it("allows viewers no on-chain role (D-14)", () => {
    expect(allowedChainRole("viewer")).toBeNull();
    expect(allowedChainRole(null)).toBeNull();
    expect(allowedChainRole("editor")).toBe("editor");
  });

  it("revokes only what the database no longer allows", () => {
    expect(revocationCall("admin", null)).toBe("remove_admin");
    expect(revocationCall("admin", "editor")).toBe("remove_admin");
    expect(revocationCall("editor", null)).toBe("remove_editor");
    expect(revocationCall("editor", "admin")).toBeNull();
    expect(revocationCall(null, null)).toBeNull();
    expect(revocationCall("owner", "admin")).toBe("owner");
  });

  it("grants what the database allows and the chain lacks, never the owner role", () => {
    expect(grantCall(null, "editor")).toBe("add_editor");
    expect(grantCall(null, "admin")).toBe("add_admin");
    expect(grantCall("editor", "admin")).toBe("add_admin");
    expect(grantCall("admin", "editor")).toBeNull();
    expect(grantCall("editor", "editor")).toBeNull();
    expect(grantCall(null, "owner")).toBeNull();
  });
});

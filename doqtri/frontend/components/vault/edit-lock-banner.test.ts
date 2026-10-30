import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { EditLockBanner } from "@/components/vault/edit-lock-banner";
import type { DocLockState } from "@/lib/doc-lock-client";

/*
 * The "elsewhere" strip (WP-1.6, WP-1.10). Rendered to static markup, since
 * the unit tests run in Node without a DOM.
 */

const elsewhere: DocLockState = {
  phase: "elsewhere",
  holderName: null,
  canEdit: true,
  canTakeOver: true,
  version: 3,
  error: null,
};

function render(lock: DocLockState): string {
  return renderToStaticMarkup(createElement(EditLockBanner, { lock, conflict: false, onTakeOver: () => {}, onReload: () => {} }));
}

describe("EditLockBanner", () => {
  it("covers a tab just closed or reloaded, whose lock outlives it, and offers Edit here", () => {
    const html = render(elsewhere);
    expect(html).toContain('data-testid="edit-lock-elsewhere-banner"');
    expect(html).toContain("You are editing this note in another tab or window (or one you just closed).");
    expect(html).toContain("Edit here");
  });

  it("offers no Edit here to a caller who cannot edit", () => {
    expect(render({ ...elsewhere, canEdit: false })).not.toContain("Edit here");
  });
});

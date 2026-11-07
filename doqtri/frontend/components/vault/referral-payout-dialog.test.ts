import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { payoutDraft, type PayoutDraft } from "@/components/vault/referral-payout-client";
import { PayoutForm } from "@/components/vault/referral-payout-dialog";

/*
 * The questionnaire's form as it renders (WP-4.6, DOQ-25, D-112), to static
 * markup, since the unit tests run in Node without a DOM. Typing, focus and the
 * dialog itself are covered by e2e/referral-dashboard.spec.ts.
 */

const G = "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H";

function render(initial: Partial<PayoutDraft> = {}, { canEdit = true, saving = false } = {}) {
  const html = renderToStaticMarkup(
    createElement(PayoutForm, {
      initial: { ...payoutDraft(null), ...initial },
      canEdit,
      saving,
      onSavingChange: () => {},
      onClose: () => {},
      onSaved: () => {},
    }),
  );
  return { html, text: html.replace(/<[^>]+>/g, "").replace(/&#x27;/g, "'").replace(/&amp;/g, "&") };
}

/** The element with this data-testid, as markup. */
const tag = (html: string, testId: string) => new RegExp(`<[^>]*data-testid="${testId}"[^>]*>`).exec(html)?.[0] ?? "";
const attr = (element: string, name: string) => new RegExp(`\\s${name}="([^"]*)"`).exec(element)?.[1];

/** Every label's text and the id it points at, and whether that id is on a field. */
function labels(html: string) {
  return [...html.matchAll(/<label[^>]*for="([^"]+)"[^>]*>(.*?)<\/label>/g)].map(([, id, inner]) => ({
    id,
    text: inner.replace(/<[^>]+>/g, ""),
    field: new RegExp(`<(input|button)[^>]*id="${id}"`).test(html),
  }));
}

describe("the fields", () => {
  it("asks for a name and a method first, both marked required, with nothing filled in", () => {
    const { html } = render();
    const name = tag(html, "payout-name");
    expect(attr(name, "value")).toBe("");
    expect(name).toContain("required");
    expect(labels(html)).toEqual([{ id: attr(name, "id"), text: "Name *(required)", field: true }]);
    expect(html).toMatch(/<legend[^>]*>Payout method.*?\(required\)/);
    expect(tag(html, "payout-method-xlm")).toContain('type="radio"');
    expect(tag(html, "payout-method-ewallet")).toContain('type="radio"');
    // No method yet: neither method's fields.
    expect(html).not.toContain('data-testid="payout-address"');
    expect(html).not.toContain('data-testid="payout-accountNumber"');
  });

  it("for XLM: the address, required, an optional memo with its byte count, and every field labelled", () => {
    const { html } = render({ method: "xlm" });
    const address = tag(html, "payout-address");
    // Never the user's own testnet wallet.
    expect(attr(address, "value")).toBe("");
    expect(labels(html).map(({ text, field }) => [text, field])).toEqual([
      ["Name *(required)", true],
      ["Stellar address *(required)", true],
      ["Memo (optional)", true],
    ]);
    const memo = tag(html, "payout-memo");
    expect(memo).not.toMatch(/\srequired/);
    const hint = attr(memo, "aria-describedby")!;
    expect(html).toContain(`id="${hint}"`);
    expect(new RegExp(`id="${hint}"[^>]*>0/28 characters`).test(html)).toBe(true);
  });

  it("counts a text memo as it's typed", () => {
    expect(render({ method: "xlm", memo: "x".repeat(28) }).text).toContain("28/28 characters");
    // An invisible character counts as the one it is, not as its three bytes.
    expect(render({ method: "xlm", memo: "123456\u200b" }).text).toContain("7/28 characters");
  });

  it("asks for the memo's type, Text by default, with ID as the other choice", () => {
    const { html, text } = render({ method: "xlm" });
    expect(html).toMatch(/<legend[^>]*>Memo type<\/legend>/);
    expect(tag(html, "payout-memo-type-text")).toContain('type="radio"');
    expect(tag(html, "payout-memo-type-text")).toContain("checked");
    expect(tag(html, "payout-memo-type-id")).not.toContain("checked");
    expect(text).toContain("ID (a number)");
    expect(text).toContain("use the memo and the type it shows");
    // The fieldset points at its explanation.
    const fieldset = tag(html, "payout-memo-type");
    expect(html).toContain(`id="${attr(fieldset, "aria-describedby")}"`);
  });

  it("for an ID memo, says what a number may be and offers the number pad", () => {
    const { html, text } = render({ method: "xlm", memo: "42", memoType: "id" });
    expect(text).toContain("A whole number, up to 18446744073709551615.");
    expect(attr(tag(html, "payout-memo"), "inputMode")).toBe("numeric");
    expect(tag(html, "payout-memo-type-id")).toContain("checked");
  });

  it("for XLM, explains mainnet, the memo and passkey addresses in the ticket's terms", () => {
    const { text } = render({ method: "xlm" });
    expect(text).toContain(
      "Doqtri runs on testnet, but rewards are real XLM on mainnet. The address must be an activated mainnet account. We don't fill in your Doqtri wallet, because it's a testnet wallet.",
    );
    expect(text).toContain("Exchanges usually require a memo, and XLM sent without one can be lost.");
    expect(text).toContain("Passkey wallet addresses, which start with C, can't receive payouts.");
  });

  it("for an e-wallet: provider, account name and number required, details optional, all labelled", () => {
    const { html, text } = render({ method: "ewallet" });
    expect(labels(html).map(({ text: label, field }) => [label, field])).toEqual([
      ["Name *(required)", true],
      ["Provider *(required)", true],
      ["Account name *(required)", true],
      ["Account or bank number *(required)", true],
      ["Other details (optional)", true],
    ]);
    expect(tag(html, "payout-provider")).toContain('role="combobox"');
    expect(tag(html, "payout-provider")).toContain('aria-required="true"');
    expect(text).toContain("Choose a provider");
    expect(text).not.toContain("testnet");
  });

  it("keeps the inputs at 16px on a phone, so iOS doesn't zoom, as the app's Input does", () => {
    const { html } = render({ method: "ewallet" });
    for (const id of ["payout-name", "payout-accountName", "payout-accountNumber", "payout-details"]) {
      expect(attr(tag(html, id), "class")).toMatch(/(^|\s)text-base(\s|$)/);
    }
  });

  it("opens on what's saved", () => {
    const { html } = render({ name: "A Referrer", method: "xlm", address: G, memo: "123" });
    expect(attr(tag(html, "payout-address"), "value")).toBe(G);
    expect(attr(tag(html, "payout-memo"), "value")).toBe("123");
    expect(tag(html, "payout-method-xlm")).toContain("checked");
  });
});

describe("who sees this, and when a change applies", () => {
  it("says who sees the details and why, and that edits apply to future payouts only", () => {
    const { text } = render();
    expect(text).toContain(
      "Only you and Doqtri's admins can see these details. We use them only to pay your referral rewards.",
    );
    expect(text).toContain("A change applies to future payouts only. Payouts already made aren't affected.");
  });

  it("links the Privacy Policy at /privacy", () => {
    const { html } = render();
    const links = [...html.matchAll(/<a [^>]*href="([^"]+)"[^>]*>([^<]*)<\/a>/g)].map(([, href, label]) => [href, label]);
    expect(links).toEqual([["/privacy", "Privacy Policy"]]);
  });
});

describe("while saving, and for someone who can't edit", () => {
  it("disables the fields and keeps the Save button focusable while it saves", () => {
    const { html, text } = render({ method: "xlm" }, { saving: true });
    expect(tag(html, "payout-name")).toContain("disabled");
    expect(tag(html, "payout-address")).toContain("disabled");
    expect(tag(html, "payout-method-xlm")).toContain("disabled");
    const save = tag(html, "payout-save");
    expect(save).toContain('aria-disabled="true"');
    expect(save).not.toMatch(/\sdisabled=""/);
    expect(text).toContain("Saving…");
    expect(tag(html, "payout-cancel")).toContain("disabled");
  });

  it("is read-only, says why, and offers no Save, for an owner who no longer qualifies", () => {
    const { html, text } = render({ name: "A Referrer", method: "xlm", address: G }, { canEdit: false });
    expect(text).toContain("You don't have an eligible referral right now, so these details can't be changed.");
    expect(tag(html, "payout-name")).toContain("readOnly");
    expect(tag(html, "payout-address")).toContain("readOnly");
    expect(tag(html, "payout-method-xlm")).toContain("disabled");
    expect(html).not.toContain('data-testid="payout-save"');
    expect(text).toContain("Close");
  });
});

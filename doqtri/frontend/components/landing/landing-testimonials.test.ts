import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LandingTestimonials } from "@/components/landing/landing-testimonials";

/*
 * The landing page's testimonials (WP-4.6, DOQ-28, D-113), rendered to static
 * markup: nothing at all without an approved one (AC 6), and otherwise name and
 * text as plain, escaped text.
 */

const render = (items: { name: string; feedback: string }[]) =>
  renderToStaticMarkup(createElement(LandingTestimonials, { items }));

describe("LandingTestimonials", () => {
  it("renders nothing, not even a heading, when none is approved (AC 6)", () => {
    expect(render([])).toBe("");
  });

  it("shows each name and text, under a heading", () => {
    const html = render([
      { name: "Payee Name", feedback: "I used Doqtri to map my ideas!" },
      { name: "Other Payee", feedback: "Planned, shipped, proven." },
    ]);
    expect(html).toContain('id="testimonials-title"');
    expect(html.match(/data-testid="landing-testimonial"/g)).toHaveLength(2);
    expect(html).toContain("I used Doqtri to map my ideas!");
    expect(html).toContain("<figcaption");
    expect(html).toContain("Payee Name");
  });

  it("escapes markup, and makes nothing a link", () => {
    const html = render([
      {
        name: '<img src=x onerror="alert(1)">',
        feedback: '<script>alert(1)</script> see https://example.com and <a href="https://example.com">here</a>',
      },
    ]);
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<a ");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("https://example.com");
  });
});

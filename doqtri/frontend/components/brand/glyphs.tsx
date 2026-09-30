/**
 * Doqtri's three block glyphs, drawn on a 24×24 grid:
 * ✓ tested, Ø anchored on Stellar, # shipped (content hash).
 */
export type Glyph = "check" | "stellar" | "hash";

export const GLYPH_LABEL: Record<Glyph, string> = {
  check: "Tested",
  stellar: "Anchored on Stellar",
  hash: "Shipped",
};

export function GlyphPath({ glyph }: { glyph: Glyph }) {
  switch (glyph) {
    case "check":
      return <path d="M6.2 12.4 10.2 16.3 17.8 7.9" />;
    case "stellar":
      return (
        <>
          <circle cx="12" cy="12" r="6.4" />
          <path d="M5 17.6 19 6.4" />
        </>
      );
    case "hash":
      return <path d="M9.6 5.5 8.2 18.5M15.8 5.5l-1.4 13M5.8 9.6h13M5.2 14.4h13" />;
  }
}

/** A glyph inside a rounded square: one block in the chain. */
export function BlockGlyph({ glyph, className }: { glyph: Glyph; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="1.5" y="1.5" width="21" height="21" rx="4.5" strokeWidth="1.6" />
      <g strokeWidth="1.9">
        <GlyphPath glyph={glyph} />
      </g>
    </svg>
  );
}

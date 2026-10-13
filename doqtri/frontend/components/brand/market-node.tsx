/**
 * Marketplace icons drawn as nodes of the Doqtri mark (doqtri-mark.tsx): a
 * dark disc with a ring, a faint inner ring, and a round-capped glyph on the
 * same 24×24 grid as the mark's ✓ / Ø / #. Strokes are lighter than the
 * mark's, which is drawn for display sizes; these sit at ~44px in forms.
 */
export type MarketGlyph = "gift" | "coin";

function MarketGlyphPath({ glyph }: { glyph: MarketGlyph }) {
  switch (glyph) {
    // A wrapped box with a bow: free to take, tips welcome.
    case "gift":
      return (
        <>
          <path d="M5.6 9.6h12.8v3H5.6z" />
          <path d="M6.9 12.6v5.6h10.2v-5.6M12 9.6v8.6" />
          <path d="M12 9.6c-.9-2.5-4.3-3.3-4.3-1.3 0 1.1 1.8 1.3 4.3 1.3ZM12 9.6c.9-2.5 4.3-3.3 4.3-1.3 0 1.1-1.8 1.3-4.3 1.3Z" />
        </>
      );
    // A coin: the Stellar node's disc with a value mark through it.
    case "coin":
      return (
        <>
          <circle cx="12" cy="12" r="6.4" />
          <path d="M12 7.8v8.4" />
          <path d="M14.3 10c-.4-.8-1.2-1.2-2.3-1.2-1.3 0-2.3.7-2.3 1.6 0 2.3 4.7 1.2 4.7 3.4 0 1-1 1.7-2.4 1.7-1.1 0-2-.4-2.4-1.2" />
        </>
      );
  }
}

/** Mark tints, the same accents the mark's color variant uses. */
export const MARKET_TINT: Record<MarketGlyph, string> = {
  gift: "var(--brand-green, #7cc4a0)",
  coin: "var(--brand-purple, #a9a3dc)",
};

export function MarketNode({
  glyph,
  className,
  tinted = false,
}: {
  glyph: MarketGlyph;
  className?: string;
  /** Ring and glyph in the glyph's brand accent instead of currentColor. */
  tinted?: boolean;
}) {
  return (
    <svg
      viewBox="0 0 64 64"
      className={className}
      fill="none"
      aria-hidden
      color={tinted ? MARKET_TINT[glyph] : undefined}
    >
      <g transform="translate(32 32)">
        <circle r="28" fill="var(--mark-fill, #0f1114)" stroke="currentColor" strokeWidth="2.4" />
        <circle r="22" stroke="currentColor" strokeOpacity="0.35" strokeWidth="1" />
        <g
          transform="translate(-19.2 -19.2) scale(1.6)"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <MarketGlyphPath glyph={glyph} />
        </g>
      </g>
    </svg>
  );
}

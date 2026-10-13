/**
 * Token badges for the marketplace's price tokens, in their usual exchange
 * colors: Stellar's white mark on black (with a faint rim, so the black disc
 * holds its edge on Doqtri's dark surfaces), Circle's USDC on #2775CA blue.
 * Simplified for small sizes (16–24px); the canonical artwork lives with the
 * issuers.
 */
import type { MarketTokenCode } from "@/lib/stellar/market-config";

export function TokenIcon({ code, className }: { code: MarketTokenCode | string; className?: string }) {
  if (code === "USDC") {
    return (
      <svg viewBox="0 0 32 32" className={className} role="img" aria-label="USDC">
        <circle cx="16" cy="16" r="16" fill="#2775CA" />
        <g fill="none" stroke="#fff" strokeLinecap="round">
          {/* Circle's two open brackets around the dollar sign. */}
          <path d="M12.6 7.3a9.4 9.4 0 0 0 0 17.4" strokeWidth="1.9" />
          <path d="M19.4 7.3a9.4 9.4 0 0 1 0 17.4" strokeWidth="1.9" />
          <path d="M16 9.4v13.2" strokeWidth="1.7" />
          <path
            d="M19 12.7c-.3-1.3-1.5-2-3.1-2-1.8 0-3 .9-3 2.2 0 3.1 6.3 1.6 6.3 4.6 0 1.4-1.3 2.4-3.2 2.4-1.7 0-2.9-.7-3.3-2"
            strokeWidth="1.7"
          />
        </g>
      </svg>
    );
  }
  if (code === "XLM") {
    return (
      <svg viewBox="0 0 32 32" className={className} role="img" aria-label="XLM">
        <circle cx="16" cy="16" r="15.5" fill="#000" stroke="#fff" strokeOpacity="0.28" />
        <g fill="none" stroke="#fff" strokeLinecap="round" strokeWidth="1.8">
          {/* The Stellar mark: an open ring crossed by two parallel bands. */}
          <path d="M22.1 11.1A7.4 7.4 0 0 0 9 17.9" />
          <path d="M9.9 20.9A7.4 7.4 0 0 0 23 14.1" />
          <path d="M6.6 19.5 25.6 11.1" />
          <path d="M6.4 21.1 25.4 12.7" />
        </g>
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden>
      <circle cx="16" cy="16" r="15" fill="none" stroke="currentColor" strokeWidth="2" />
    </svg>
  );
}

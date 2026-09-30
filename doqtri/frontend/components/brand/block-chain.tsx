import { BlockGlyph, GLYPH_LABEL, type Glyph } from "./glyphs";
import styles from "./block-chain.module.css";

/** The banner sequence: plans tested, anchored and shipped, block by block. */
export const BANNER_CHAIN: Glyph[] = ["check", "stellar", "check", "hash", "stellar", "check", "hash", "stellar"];

type Props = {
  blocks?: Glyph[];
  className?: string;
  /** Reveal blocks one after another on first paint. */
  animate?: boolean;
};

export function BlockChain({ blocks = BANNER_CHAIN, className, animate = true }: Props) {
  return (
    <ol
      className={`${styles.chain} ${animate ? styles.animate : ""} ${className ?? ""}`}
      aria-label={`Block chain: ${blocks.map((b) => GLYPH_LABEL[b]).join(", ")}`}
    >
      {blocks.map((glyph, i) => (
        <li key={i} className={styles.item} style={{ animationDelay: `${i * 70}ms` }}>
          {i > 0 && (
            <svg viewBox="0 0 16 8" className={styles.link} aria-hidden>
              <path d="M1 4h11.5M10 1.2 13.4 4 10 6.8" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          )}
          <BlockGlyph glyph={glyph} className={styles.block} />
        </li>
      ))}
    </ol>
  );
}

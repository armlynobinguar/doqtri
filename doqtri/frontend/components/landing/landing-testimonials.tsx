import type { PublicTestimonial } from "@/lib/referral-testimonial";
import styles from "./landing-page.module.css";

/**
 * Referrers' words on the landing page (WP-4.6, DOQ-28, D-113): only those they
 * opted in to show and an admin approved, as name and text. Nothing at all, not
 * even the heading, when there are none, which is always the case until the
 * legal pages go live. Plain text: React escapes it, and nothing in it becomes
 * a link or markup.
 */
export function LandingTestimonials({ items }: { items: readonly PublicTestimonial[] }) {
  if (items.length === 0) return null;
  return (
    <section
      className={styles.testimonials}
      id="testimonials"
      aria-labelledby="testimonials-title"
      data-testid="landing-testimonials"
    >
      <p className={styles.eyebrow}>In their words</p>
      <h2 id="testimonials-title" className={styles.sectionTitle}>
        What people map with Doqtri
      </h2>
      <ul className={styles.quoteGrid}>
        {items.map((item, index) => (
          <li key={`${index}:${item.name}`} className={styles.quoteCard} data-testid="landing-testimonial">
            <figure className={styles.quoteFigure}>
              <blockquote className={styles.quoteText}>
                {/* dir="auto": a right-to-left quote reads, and is punctuated, the right way round. */}
                <p dir="auto">{item.feedback}</p>
              </blockquote>
              <figcaption className={styles.quoteName} dir="auto">
                {item.name}
              </figcaption>
            </figure>
          </li>
        ))}
      </ul>
    </section>
  );
}

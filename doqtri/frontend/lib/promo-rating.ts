/**
 * The rubric promo entries are auto-rated against, and the pure helpers around
 * it. Client-safe: the admin screen imports the labels from here. The model
 * call and persistence live in lib/promo-rating-ai.ts.
 *
 * The model scores each criterion 0-10; the 0-100 total is computed here from
 * the weights, never taken from the model, so changing a weight re-ranks
 * consistently and a model cannot hand out a total its parts do not support.
 */

export const RATING_CRITERIA = [
  {
    key: "structure",
    label: "Structure",
    weight: 30,
    guide:
      "A focused root, distinct branches that do not overlap, and a sensible depth. A flat list of nodes or a tangle of crossing branches scores low.",
  },
  {
    key: "depth",
    label: "Depth",
    weight: 25,
    guide:
      "How far the branches go past surface labels into specific concepts, examples or decisions.",
  },
  {
    key: "clarity",
    label: "Clarity",
    weight: 20,
    guide:
      "Labels are concise and meaningful, and the map is readable at the size it was captured.",
  },
  {
    key: "relevance",
    label: "Relevance",
    weight: 15,
    guide: "How well the subject fits the brief given below.",
  },
  {
    key: "originality",
    label: "Originality",
    weight: 10,
    guide: "A fresh angle or real insight rather than a generic textbook outline.",
  },
] as const;

export type RatingCriterionKey = (typeof RATING_CRITERIA)[number]["key"];

/** Things a reviewer should look at regardless of the score. */
export const RATING_FLAGS = {
  not_mindmap: "No mindmap visible",
  unreadable: "Too small or blurry to judge",
  off_brief: "Off brief",
  manipulation: "Tries to instruct the rater",
} as const;

export type RatingFlag = keyof typeof RATING_FLAGS;

export type PromoRating = {
  criteria: Record<RatingCriterionKey, { score: number; note: string }>;
  summary: string;
  flags: RatingFlag[];
  model: string;
};

/** A rating as stored on a promo_submissions row. */
export type StoredRating = { score: number; rating: PromoRating; ratedAt: string };

/** Weighted 0-100 total from 0-10 criterion scores. */
export function ratingTotal(criteria: PromoRating["criteria"]): number {
  const weights = RATING_CRITERIA.reduce((sum, c) => sum + c.weight, 0);
  const points = RATING_CRITERIA.reduce(
    (sum, c) => sum + (criteria[c.key].score / 10) * c.weight,
    0,
  );
  return Math.round((points / weights) * 100);
}

function clampScore(value: unknown): number {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.round(value) : 0;
  return Math.min(10, Math.max(0, n));
}

function text(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

/**
 * Turns the model's JSON (or a stored `ai_rating`) into a PromoRating, or null
 * when it is not one. Scores are clamped and unknown flags dropped, so a
 * schema slip cannot push a total out of range.
 */
export function parseRating(raw: unknown, model: string): PromoRating | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as { criteria?: unknown; summary?: unknown; flags?: unknown };
  if (!value.criteria || typeof value.criteria !== "object") return null;

  const given = value.criteria as Record<string, { score?: unknown; note?: unknown } | undefined>;
  const criteria = {} as PromoRating["criteria"];
  for (const c of RATING_CRITERIA) {
    const entry = given[c.key];
    if (!entry || typeof entry !== "object") return null;
    criteria[c.key] = { score: clampScore(entry.score), note: text(entry.note, 300) };
  }

  const flags = Array.isArray(value.flags)
    ? [...new Set(value.flags.filter((f): f is RatingFlag => typeof f === "string" && f in RATING_FLAGS))]
    : [];

  return { criteria, summary: text(value.summary, 600), flags, model };
}

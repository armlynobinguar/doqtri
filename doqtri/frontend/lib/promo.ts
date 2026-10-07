/**
 * The beta launch promo: users submit screenshots of their mindmaps for a
 * chance at a shared prize pool. Set `active` to false to take down the landing
 * announcement and the mindmap banners and close the portal to new entries.
 */
export const MINDMAP_PROMO = {
  id: "mindmap-showcase",
  active: true,
  prizePool: "$100 USD",
  xHandle: "usedoqtri",
  maxImages: 4,
  /** Mirrors the bucket's file_size_limit; the bucket is what enforces it. */
  maxImageBytes: 5 * 1024 * 1024,
  maxCaption: 500,
  maxContact: 200,
} as const;

export const PROMO_BUCKET = "promo-submissions";

/** Mirrors the bucket's allowed_mime_types. */
export const PROMO_IMAGE_TYPES: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

export const PROMO_PATH = "/promo";

/** Review states, set from /admin/promo. Mirrors the column's check. */
export const PROMO_STATUSES = ["pending", "shortlisted", "winner", "rejected"] as const;
export type PromoStatus = (typeof PROMO_STATUSES)[number];

export function isPromoStatus(value: unknown): value is PromoStatus {
  return PROMO_STATUSES.includes(value as PromoStatus);
}

export type PromoSubmission = {
  imageUrls: string[];
  caption: string;
  contact: string;
  updatedAt: string;
};

export type PromoFileSpec = { type: string; size: number };

/** Why a set of screenshots cannot be submitted, or null when it can. */
export function promoFilesProblem(files: PromoFileSpec[]): string | null {
  if (files.length === 0) return "Attach at least one screenshot.";
  if (files.length > MINDMAP_PROMO.maxImages) {
    return `Attach up to ${MINDMAP_PROMO.maxImages} screenshots.`;
  }
  for (const file of files) {
    if (!(file.type in PROMO_IMAGE_TYPES)) {
      return "Screenshots must be PNG, JPEG or WebP.";
    }
    if (file.size <= 0) return "One of the screenshots is empty.";
    if (file.size > MINDMAP_PROMO.maxImageBytes) {
      return `Each screenshot must be ${MINDMAP_PROMO.maxImageBytes / 1024 / 1024} MB or smaller.`;
    }
  }
  return null;
}

/** The folder one upload's screenshots live in, inside the caller's own. */
export function promoUploadFolder(userId: string, uploadId: string): string {
  return `${userId}/${uploadId}`;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Checks paths a client claims to have uploaded: each must be a distinct file
 * directly inside this caller's upload folder, as minted by /api/promo/uploads.
 * Returns the file names, or null when any path falls outside it.
 */
export function promoPathsInFolder(
  paths: unknown,
  userId: string,
  uploadId: unknown,
): string[] | null {
  if (typeof uploadId !== "string" || !UUID.test(uploadId)) return null;
  if (!Array.isArray(paths) || paths.length === 0) return null;
  if (paths.length > MINDMAP_PROMO.maxImages) return null;

  const prefix = `${promoUploadFolder(userId, uploadId)}/`;
  const names = new Set<string>();
  for (const path of paths) {
    if (typeof path !== "string" || !path.startsWith(prefix)) return null;
    const name = path.slice(prefix.length);
    if (!/^[0-9]\.(png|jpg|webp)$/.test(name)) return null;
    names.add(name);
  }
  return names.size === paths.length ? [...names] : null;
}

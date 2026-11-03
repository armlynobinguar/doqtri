/**
 * Keeps the mutating specs off production (DOQ-16).
 *
 * The suite seeds and deletes rows with the service role key. The qdit and
 * workspace specs go further: they create a second wallet account, team
 * workspaces, memberships, invites and qdit connections. None of that may
 * land in the production project, so those specs call this first.
 *
 * The production project ref is public (it is in every browser bundle as
 * NEXT_PUBLIC_SUPABASE_URL), so naming it here reveals nothing. Override
 * with E2E_PRODUCTION_SUPABASE_REFS (comma-separated) if it ever changes.
 */
const PRODUCTION_REFS = (process.env.E2E_PRODUCTION_SUPABASE_REFS || "omoalynhmtbqffogjvoy")
  .split(",")
  .map((ref) => ref.trim())
  .filter(Boolean);

export function assertNotProduction(): void {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  let host = "";
  try {
    host = new URL(url).hostname;
  } catch {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL is missing or not a URL; the e2e suite needs a staging project.");
  }
  const ref = host.split(".")[0];
  if (PRODUCTION_REFS.includes(ref)) {
    throw new Error(
      `Refusing to run: NEXT_PUBLIC_SUPABASE_URL is the production project (${ref}). ` +
        "Point .env.local at staging (URL, anon key and service role key) and run again.",
    );
  }
}

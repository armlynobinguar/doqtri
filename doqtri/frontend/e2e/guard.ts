/**
 * Keeps the mutating specs on a project picked for them (DOQ-16).
 *
 * The suite seeds and deletes rows with the service role key. The qdit and
 * workspace specs go further: they create a second wallet account, team
 * workspaces, memberships, invites and qdit connections. None of that may
 * land in production, so those specs call this first.
 *
 * It is an allow-list, and it fails closed: E2E_ALLOWED_SUPABASE_REFS (in
 * .env.local, comma-separated) must name the project NEXT_PUBLIC_SUPABASE_URL
 * points at. No project ref is written here; tracked files carry none.
 */
export function assertNotProduction(): void {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  let host = "";
  try {
    host = new URL(url).hostname;
  } catch {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL is missing or not a URL; the e2e suite needs a staging project.");
  }
  const ref = host.split(".")[0];
  const allowed = (process.env.E2E_ALLOWED_SUPABASE_REFS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (!allowed.includes(ref)) {
    throw new Error(
      `Refusing to run: Supabase project "${ref}" is not in E2E_ALLOWED_SUPABASE_REFS. ` +
        "Point .env.local at a staging project (URL, anon key, service role key) and list its ref there. " +
        "Never list production.",
    );
  }
}

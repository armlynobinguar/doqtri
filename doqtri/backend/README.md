# Backend

The backend is Supabase — there is no separate server. This directory holds the
version-controlled source of what lives in the remote project.

| | |
| --- | --- |
| Project | `Doqtri` |
| Ref | `omoalynhmtbqffogjvoy` |
| URL | `https://omoalynhmtbqffogjvoy.supabase.co` |
| Region | `ap-southeast-1` |
| Postgres | 17 |

## Layout

```
migrations/   SQL already applied to the remote project, in order
tests/        pgTAP tests for the migrations (run with pg_prove, see each file)
prompts/      The two AI prompts, mirrored from lib/openai.ts
```

`migrations/` mirrors the applied migrations one-to-one:

```
20260724220911_create_documents_with_rls.sql
20260724220920_create_private_uploads_bucket.sql
20260725000000_add_document_mindmap.sql
20260928000000_create_ingests.sql
20260928000100_create_wallet_accounts.sql
20260928000200_add_documents_publish_headings.sql
20261002000000_create_ai_usage.sql        # NOT yet applied: apply before deploying
20261006000000_create_node_links.sql      # NOT yet applied: apply before deploying
20261009000000_create_promo_submissions.sql
20261009000100_add_promo_submission_status.sql
20261018000000_create_referrals.sql       # NOT yet applied: apply before deploying
20261019000000_chain_writes_anchor.sql    # NOT yet applied: apply before deploying
20261021000000_create_mindmap_styles.sql
20261024000000_add_promo_submission_rating.sql
20261024120000_create_workspaces.sql      # NOT yet applied: dry-run on a branch first
20261024130000_workspace_document_ownership.sql  # NOT yet applied (WP-1.2)
20261024140000_chain_writes_editor_calls.sql     # NOT yet applied (WP-1.4)
20261024150000_doc_locks.sql              # NOT yet applied: dry-run on a branch first
20261024150500_workspace_members_management.sql  # NOT yet applied (WP-1.5)
20261024160000_workspace_member_removals.sql  # NOT yet applied (WP-1.8)
20261025090000_chain_jobs_scheduler.sql   # NOT yet applied (WP-1.9)
20261025100000_integration_connections.sql    # NOT yet applied (WP-2.3)
20261025110000_qdit_linking.sql               # NOT yet applied (WP-2.5)
```

The remote records its own version stamps (e.g. `20260929114657` for
`create_ingests`); match on the name, not the number.

These were applied through the Supabase MCP server, so the remote project is
already in this state, except those marked "NOT yet applied". The workspace
migrations (`20261024120000` through `20261025090000`) go out together with
the on-chain editors rollout, in the same release window as the
`integration/suite` merge into `main` and never ahead of it (`main`'s code
cannot create or save notes on them): follow
[docs/runbooks/registry-editors-rollout.md](../docs/runbooks/registry-editors-rollout.md),
which covers the branch dry-run, the registry v3 upgrade, the revoker key,
the scheduler's Vault secrets and the `NEXT_PUBLIC_REGISTRY_EDITORS` flag. The files exist so the schema is reviewable in git and
replayable into a fresh project.

## Data model

`public.documents` holds the notes, with RLS restricting every operation to
`auth.uid() = user_id`. `publish_headings` (default `false`) is the owner's
opt-in for showing heading labels on the public `/d/[docId]` audit page.

Two supporting tables:

- `public.ingests` — one row per upload attempt, pointing at the archived
  original in `uploads`, so failed imports can be retried. Owners can read and
  delete their rows; only `/api/ingest` writes them.
- `public.wallet_accounts` — Stellar address → auth user, used by
  `/api/auth/wallet`. RLS on with no policies: service role only, which the
  advisor reports as `rls_enabled_no_policy` by design.
- `public.ai_usage` — one row per accepted AI request, written only through
  `consume_ai_quota()` (service role; execute is revoked from `anon` and
  `authenticated`). It enforces the per-user `AI_DAILY_LIMIT` atomically under a
  per-user advisory lock. Owners can read their own rows.
- `public.node_links` — mindmap node → GitHub issue or PR (one per node), read
  by `/api/github/status` to suggest the next node status. Owners select,
  insert and delete their own rows, and can only link their own documents.
  Nothing in it touches the chain; the owner signs any status change.
- `public.promo_submissions` — one mindmap-showcase entry per user (1-4
  screenshot paths in the private `promo-submissions` bucket, plus an optional
  caption and contact). Written only by `/api/promo/submissions` with the
  service role; owners can read their own row. `status` (pending, shortlisted,
  winner, rejected) is set from `/admin/promo` and resets on resubmission.
- `public.referral_codes` / `public.referrals` — each user's referral code
  (their link is `/r/<code>`, created on first visit to the profile page by
  `referral_code_for()`) and who referred whom (one referrer per account).
  `/r/<code>` stores the code in a signed cookie; after sign-up the vault calls
  `/api/referrals/claim`, which records it through `claim_referral()` only for
  an account created after the link was opened, never for the user's own code.
  Both functions are service role only. Owners can read their own code;
  referrals are exposed only as a count on the profile page.
- `public.mindmap_styles` — each user's mindmap studio style, one row per map
  (`global`, or `doc:<id>` with a cascading `document_id`), so a look follows
  the user across devices. The browser upserts its own rows under RLS a moment
  after the last change; edits the server has not confirmed yet are parked in
  localStorage and resent on the next visit. `updated_at` is set by a trigger
  and acts as the row's version. The demo vault's styles stay in the browser.

- `public.workspaces` / `public.workspace_members` — team workspaces and who
  is in them, as viewer, editor, admin or owner. Every account has one
  personal workspace (`is_personal`) that it owns: existing accounts through
  the migration's backfill, new ones through the `on_auth_user_created_workspace`
  trigger on `auth.users`. Members read their workspaces and rosters; owners
  manage members, admins manage everyone but owners, anyone may leave, and a
  trigger keeps at least one owner per workspace and keeps each personal
  workspace's creator as its owner. Any user may create a team workspace
  through the `create_workspace(name, slug)` RPC and becomes its owner; there
  is no direct insert. Members are still added without their consent, so
  WP-1.5 must replace that with an invite the invitee accepts. Documents do
  not belong to workspaces yet;
  WP-1.2 adds `documents.workspace_id` and moves the policies over to
  `is_workspace_member()`.
- `public.workspace_invites`, `public.workspace_transfers`,
  `public.workspace_chain_jobs` — invites the invitee accepts (by wallet
  address, or by confirmed email once switched on), ownership transfers the
  new owner accepts, and the work the server owes the chain after a
  membership change (revocations by the revoke-only key, D-16, and D-31
  handovers). Written only through their RPCs and the service role. The
  queue is worked at once by the app, every minute by the `doqtri-chain-jobs`
  pg_cron job and daily by Vercel Cron
  (`20261025090000_chain_jobs_scheduler.sql`, which says how to store its
  Vault secrets); `chain_jobs_scheduler_health()` reports whether the
  minutely job can run. Deleting an account queues revocations for every
  role its wallets hold, deletes the invites to and from it, and then lets
  its wallet records cascade (D-50, D-51). It refuses, with a hint, an
  account whose personal workspace holds anchored notes or other people's
  notes, the last owner of a team workspace with no admin (D-31), and, a
  known limit until those rows can be anonymised, an account that has
  published a community template or bought or claimed one
  (`market_templates.creator_id`, `market_purchases.buyer_id` are
  `on delete restrict`).
- `public.workspace_member_removals` — when each member lost the right to
  sign in a workspace (removed, left, account deleted, or demoted to viewer),
  with the wallet addresses they had then, and when they got it back. Written
  only by triggers; RLS on with no policies. The public audit page reads it
  through `signer_removals_for_document()` (service role) to flag history
  entries signed after the signer was removed (WP-1.8, risk R-05).

- `public.doc_locks` — who is editing a document (D-17). One editor holds a
  document's lock at a time, from one edit session (one open tab: every call
  names it, so a user's second tab is read-only and cannot release the
  first's); it frees after ten minutes without a heartbeat, and an admin or
  owner may take it over (anyone may take over their own lock from another
  tab). Written only by `take_doc_lock()`, `release_doc_lock()` and
  `save_document()`; workspace members read who holds it, and only editors
  and above are told the holder's name. `documents.version` counts saves,
  and the browser saves text only through
  `save_document(id, markdown, base_version, session)`, which refuses a
  caller without the lock in that session (`DQLCK`) or with a stale version
  (`DQVER`). A plain client UPDATE of `markdown` is refused. Removing or
  demoting a member drops their locks.

- `public.integration_connections` — a user's OAuth connection to their qdit
  account (WP-2.3, D-02): one row per user and provider, with the qdit user id,
  the granted scopes and the access and refresh tokens as AES-256-GCM
  ciphertext (encrypted by the app with `INTEGRATION_TOKEN_KEY`). Service role
  only: RLS on with no policies, and no privileges for anon or authenticated.
  The browser reads its own connection's status, never a token, through
  `my_integration_connections()`. `generation` goes up on every token write,
  so concurrent refreshes on different server instances cannot overwrite each
  other's rotated refresh token.

- `public.doc_project_links` — the qdit project a note is linked to (WP-2.5,
  D-09: one per note), with qdit's name, slug and link id cached. Viewers of
  the note's workspace read it; only the integration routes write it, with
  the service role, after checking the caller is an admin (D-10) and with
  what qdit answered. `node_links` gained a `provider` (`github`, the default
  for every existing row, or `qdit`) and the qdit milestone's ids; editors
  still write GitHub rows from the browser, and qdit rows are written by the
  routes only. Each save remaps moved headings through
  `apply_node_link_remap()` (R-03), and `qdit_state` says whether qdit has
  been told yet. A note linked to a project cannot be deleted, by any path
  (its owner's account deletion included), until an admin unlinks it: qdit
  would keep links to it that nothing could remove. If qdit no longer shows
  the project, the admin can confirm forgetting the link in doqtri only
  (qdit may keep dangling links, which are logged); with the integration
  turned off, only SQL on the database removes the row.

The notes table itself is still the only content store. There are deliberately **no** graph tables: nodes and
edges are parsed from `markdown` at render time by `lib/wikilinks.ts`, so the
graph cannot drift from the text.

## Trust boundary

- The **browser** uses the anon key and is always subject to RLS. It reads the
  vault directly, scoped by the policies. Note text is saved through
  `/api/notes/[id]` (PUT), which calls `save_document()` as the user, so the
  edit lock and version are checked in the database.
- The **API routes** (`/api/ingest`, `/api/regenerate`) use the service role,
  which bypasses RLS. They therefore resolve the user from the verified session
  first and scope every statement by that `user_id`. A `user_id` from a request
  body is never trusted.

## Auth configuration

Email + password.

### Intended v1 setting: confirmations off

v1 is meant to run with **Confirm email disabled**, so sign-up returns a session
immediately and the app needs no email delivery at all.

> **This is a manual step.** Turn it off at *Authentication → Providers → Email →
> Confirm email*. The MCP server exposes no auth-config tool, so it cannot be
> applied from an agent session. Until it is off, sign-up creates a user with no
> session and the confirmation mail never arrives (the built-in quota is spent),
> which strands the account.

The trade-offs, stated plainly:

- Unverified addresses can register. Anyone can sign up as
  `someone-elses@address` without proving they own it.
- Workspace invites by email stay off. An invite can wait for an address
  nobody has signed up with, and with confirmations off Supabase marks a new
  account's email confirmed at signup, so whoever registered
  `colleague@corp.com` first would take an invite sent there, at its role
  (admin, even). While `public.invite_settings.email_invites` is false (as the
  WP-1.5 migration ships it), the database refuses email invites and delivers
  none, and the members screen asks for a wallet address. Members who only
  have an email cannot be invited until a wallet is set up or the switch is on.
- There is no password reset, because that also sends mail.

That is acceptable while the vault is private and single-user. It is **not**
acceptable once real users exist — at that point turn confirmations back on and
follow the runbook below.

Note that Supabase's built-in email service cannot substitute here. Its own docs
say it will "send messages only to pre-authorized addresses", carries no
delivery SLA, and "is not meant for production use". This project's built-in
quota is already exhausted (`over_email_send_rate_limit`).

### Runbook: turning confirmations back on with Resend

App code needs no changes. `components/auth/login-form.tsx` already handles a
sign-up that returns a user but no session, showing a "check your inbox" toast.

1. **Verify a domain in Resend.** Required — Resend will not send to arbitrary
   recipients otherwise. Add the SPF and DKIM TXT records it generates to your
   DNS provider. Verification fails if it does not complete within 72 hours.
2. **Create a Resend API key.**
3. **Configure Supabase SMTP** under *Authentication → Emails → SMTP Settings*:

   | Field | Value |
   | --- | --- |
   | Host | `smtp.resend.com` |
   | Port | `587` (STARTTLS; 465 and 2465 are implicit SSL) |
   | Username | `resend` |
   | Password | the Resend API key |
   | Sender | an address on the verified domain, e.g. `noreply@yourdomain` |

4. **Raise the rate limit.** This is the step that gets missed: enabling custom
   SMTP imposes a fresh limit of **30 messages per hour** to protect the
   sender's reputation. Adjust it under *Authentication → Rate Limits*.
5. **Re-enable Confirm email**, then sign up with a real address and confirm
   the mail arrives.
6. **Then switch email invites on** (D-49), in the SQL editor, and not before:

   ```sql
   update public.invite_settings set email_invites = true;
   ```

   Turning confirmations off again later means setting it back to `false`
   first; open email invites are then held back until it is on again.

Equivalent Management API call, if you would rather script it than click
(requires a personal access token with account-wide scope):

```
PATCH https://api.supabase.com/v1/projects/{ref}/config/auth
{
  "external_email_enabled": true,
  "mailer_autoconfirm": false,
  "smtp_host": "smtp.resend.com",
  "smtp_port": 587,
  "smtp_user": "resend",
  "smtp_pass": "<resend-api-key>",
  "smtp_admin_email": "noreply@yourdomain",
  "smtp_sender_name": "Mindmap"
}
```

The MCP server exposes no auth-config tool, so this cannot be applied from an
agent session without that token.

### Test users

Tests do not depend on email delivery in either configuration. `e2e/` signs in
as a pre-existing user, and users are created via the Admin API
(`POST /auth/v1/admin/users` with `email_confirm: true`), which bypasses
confirmation by design. Keep it that way — an e2e suite that waits on real mail
is a flaky suite.

## Known advisory

`get_advisors` reports two `SECURITY DEFINER` warnings for
`public.rls_auto_enable()`. That function is a Supabase platform event trigger
that auto-enables RLS on new public tables. It predates this schema and is not
callable in a meaningful way over RPC (an event-trigger function errors outside
its trigger context), so it is left as-is.

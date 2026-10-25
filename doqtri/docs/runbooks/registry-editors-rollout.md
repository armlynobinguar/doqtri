# Runbook: rolling out workspace editors on-chain

Turns on what phase 1 of the doqtri × qdit masterplan built (WP-1.1 to
WP-1.9): team workspaces whose editors sign with their own wallets (D-14),
an on-chain editor list per workspace (D-15), and removal that reaches the
chain within a ledger (D-16). The code is already merged into
`integration/suite`; nothing here is done by an agent. Every step is the
product owner's, in this order, and nothing reaches `main` before the live
G1 sign-off (D-47).

What changes for users, and when:

| Step | Visible to users |
| --- | --- |
| 1 Dry-run on a Supabase branch | No. Production is not touched |
| 3 Registry v3 upgrade | No. Old records load as before (G1.4) |
| 4-5 Revoker key, cron | No |
| 6.5 Release: `main` merge, production deploy, then the migrations, flag off | Yes: personal workspaces, team workspaces, invites, edit locking (a second tab of a note is read-only, D-54). Saves fail for the few minutes between the deploy and the migrations |
| 6.6 `NEXT_PUBLIC_REGISTRY_EDITORS=1` on production | Yes: team notes are signed by their editors, the members screen shows on-chain state |

Keep this page open while you go; each step ends with a check, and a
failed check means stop.

## 0. Before you start

- Stellar CLI and the contract admin's key (`GCLICUN2…GOGD7GS4`, the
  registry's admin on testnet) as a CLI identity, here called `doqtri-admin`.
- Access to the Supabase project `Doqtri` (`omoalynhmtbqffogjvoy`) with
  branching, and to the Vercel project.
- This runbook targets **testnet** (`CCCIDUCF…F6QRJ`), which is what the
  live app runs on. Mainnet is the same steps against its own registry
  and project, later.

Migrations to apply, in order (none is applied to the remote project yet):

```
20261024120000_create_workspaces.sql
20261024130000_workspace_document_ownership.sql
20261024140000_chain_writes_editor_calls.sql
20261024150000_doc_locks.sql
20261024150500_workspace_members_management.sql
20261024160000_workspace_member_removals.sql
20261025090000_chain_jobs_scheduler.sql
20261025130000_chain_jobs_claim_token.sql
```

`20261025130000` (WP-1.10) amends the chain job queue of `20261024150500`
and `signer_removals_for_document()` of `20261024160000` (one more column,
`revoked_at`, which an older server ignores; a server without it reads a
removed member's feed on to now once their day has passed), and depends on
nothing else, so it goes with this set even though the integration
migrations (`20261025100000` to `20261025120000`) sort before it. Apply it
before the server that releases claim tokens on finish goes live: that
server's finish writes `claim_token`, which only this migration adds.

## 1. Dry-run on a Supabase branch

Never on production first.

1. Create a branch of the `Doqtri` project with a copy of production data
   (Dashboard → Branches), or restore a recent backup into a scratch
   project.
2. Enable **pg_cron** and **pg_net** on the branch (Database → Extensions).
   Vault is on by default.
3. Apply the migrations above in order in the branch's SQL editor (or
   `supabase db push` against the branch). Read the output:
   - `renamed duplicate title` NOTICEs from `20261024130000`: titles are
     unique per workspace now, so a case- or spacing-collision in one
     account's notes is renamed `… 2`. Note which ones; tell those users.
   - From `20261025090000`, one WARNING is expected:
     `doqtri-chain-jobs is scheduled but will send nothing until Vault
     holds doqtri_chain_jobs_url, doqtri_cron_secret`. That is step 5.
     A WARNING that **pg_cron, pg_net or Vault is missing** means step 2
     did not take: enable them and run that migration again (it is safe to
     re-run).
4. Run the pgTAP suite against the branch:

   ```bash
   pg_prove -d "$BRANCH_DATABASE_URL" doqtri/backend/tests/*.sql
   ```

   Expect every file to pass: 624 tests in 8 files as of WP-1.9
   (`chain_jobs_scheduler.test.sql` needs pg_cron, pg_net and Vault, so it
   only runs where step 2 was done). Each file runs in a transaction it
   rolls back.
5. Check the backfill on the copied data, in the SQL editor:

   ```sql
   -- every account has exactly one personal workspace, which it owns alone
   select (select count(*) from auth.users) as accounts,
          (select count(*) from public.workspaces where is_personal) as personal;
   select w.id from public.workspaces w
    where w.is_personal
      and (select count(*) from public.workspace_members m where m.workspace_id = w.id) <> 1;
   -- every note is in a workspace
   select count(*) from public.documents where workspace_id is null;   -- 0
   -- the scheduler is there and waiting for its secrets
   select public.chain_jobs_scheduler_health();
   -- {"status": "missing", "job": true, "missing_secrets": [...both...]}
   ```

   `accounts` must equal `personal`; the second and third queries return
   nothing and 0.

Do **not** apply them to production now. Production gets them only in
the release window of step 6.5, after the live G1 sign-off and right after
`integration/suite` is merged into `main` and deployed, never ahead of
`main`'s code. The live app runs `main`, and `main` writes notes in ways
these migrations refuse, flag or no flag:

- `20261024130000` makes `documents.workspace_id` required, with no
  default, and its insert policy requires workspace membership. `main`'s
  note route (`app/api/notes/route.ts`) and import pipeline
  (`lib/ingest/pipeline.ts`) insert `{ user_id, title, markdown }`
  without one, so every new note and every import would fail.
- `20261024150000`'s `documents_before_save` trigger refuses a markdown
  change from a signed-in browser (the new code saves through
  `save_document()`, which checks the edit lock and version).
  `main` saves from the browser (`components/vault/doc-workspace.tsx`), so
  every save would be refused.

The other way round fails too: the new code queries tables these
migrations create. That is why step 6.5 deploys first and migrates at once
after.

## 2. Supabase auth settings

Nothing to change for this rollout. Email invites stay off
(`public.invite_settings.email_invites = false`, as the migration ships
them) until "Confirm email" is turned on with working SMTP; see
`doqtri/backend/README.md`, *Runbook: turning confirmations back on*. Until
then members are invited by wallet address.

## 3. Upgrade the testnet registry to v3

The registry is upgraded in place (D-18): same contract id, every record
kept. Only the contract admin can do it.

```bash
cd contract
stellar contract build
shasum -a 256 ../target/wasm32v1-none/release/doqtri_registry.wasm
# G1's build of integration/suite was ac258c87…d82c; a different hash means
# different code: stop and find out why.

stellar contract upload \
  --wasm ../target/wasm32v1-none/release/doqtri_registry.wasm \
  --source doqtri-admin --network testnet
# prints the uploaded wasm hash

REGISTRY=CCCIDUCFQMTMAGESMPTB3MFW4TURS62ORSZNICFOE6MNQZO3MI7F6QRJ
stellar contract invoke --id $REGISTRY --source doqtri-admin --network testnet -- \
  upgrade --new_wasm_hash <hash from upload>
```

Verify before going on:

```bash
# the admin is unchanged
stellar contract invoke --id $REGISTRY --network testnet --source doqtri-admin -- admin
# a few existing documents read back exactly as before the upgrade
# (pick ids from public.chain_writes; compare owner, version, hash)
stellar contract invoke --id $REGISTRY --network testnet --source doqtri-admin -- \
  get_document --doc_id <an existing doc id>
stellar contract invoke --id $REGISTRY --network testnet --source doqtri-admin -- \
  get_node --doc_id <that doc id> --node_id <one of its node ids>
# the v3 calls exist (no revoker yet, so: none)
stellar contract invoke --id $REGISTRY --network testnet --source doqtri-admin -- get_revoker
```

Then open an existing note's public page (`/d/<docId>`) in the live app:
its history loads as before.

Update the testnet table in the root `README.md` (version, wasm hash) in a
later commit.

## 4. The revoke-only key

The server removes a member on-chain with its own key, which can do
nothing but remove editors and admins (D-16). `add_editor` stays with
workspace admins, signed by their own wallets.

```bash
stellar keys generate doqtri-revoker --network testnet --fund
stellar keys address doqtri-revoker      # G…
stellar contract invoke --id $REGISTRY --source doqtri-admin --network testnet -- \
  set_revoker --revoker <that G address>
stellar contract invoke --id $REGISTRY --network testnet --source doqtri-admin -- get_revoker
# prints the same G address
```

The revoker's account pays its own fees (it is the transaction source), so
keep it funded; Friendbot on testnet, real XLM on mainnet.

Set on Vercel, **Preview** environment first (step 6 moves them to
Production):

| Variable | Value |
| --- | --- |
| `REVOKER_SECRET_KEY` | `stellar keys show doqtri-revoker` (S…) |
| `CRON_SECRET` | a long random string, e.g. `openssl rand -hex 32` |
| `CONTRACT_ADMIN_SECRET` | usually **unset**: then a D-31 handover (the last owner of a team workspace deleting their account) waits as "needs the product owner" on the members screen, and you sign `admin_reassign_owner` yourself |

## 5. The scheduler: Vault secrets and cron

`GET /api/chain/jobs` retries every removal the immediate send missed.
Two callers, both authenticated with `CRON_SECRET`:

- **pg_cron, every minute** (`doqtri-chain-jobs`, from
  `20261025090000_chain_jobs_scheduler.sql`). Store its two secrets once
  per database, in the SQL editor:

  ```sql
  select vault.create_secret('https://www.doqtri.xyz/api/chain/jobs', 'doqtri_chain_jobs_url');
  select vault.create_secret('<the same CRON_SECRET as Vercel>', 'doqtri_cron_secret');
  -- later changes: select vault.update_secret(id, '<new value>') from vault.secrets where name = '…';
  ```

  The URL is the deployment that should run the queue. On the branch from
  step 1 it is the preview deployment of step 6 (if Vercel Deployment
  Protection is on for previews, pg_net is refused with 401/403: test the
  preview through the members screen instead, or add a protection bypass
  token to the URL).

- **Vercel Cron, once a day** (`doqtri/frontend/vercel.json`, 03:30 UTC), a
  backstop that works on the Hobby plan. Vercel runs crons on production
  deployments only.

Check:

```sql
select public.chain_jobs_scheduler_health();
-- {"status": "configured", "job": true, "missing_secrets": []}
select status_code, created from net._http_response order by created desc limit 5;
-- 200s, one a minute
select jobid, status, return_message, start_time
  from cron.job_run_details
 where jobid = (select jobid from cron.job where jobname = 'doqtri-chain-jobs')
 order by start_time desc limit 5;
-- succeeded; a WARNING in return_message or the Postgres log naming a
-- secret means it is not stored
```

Signed in as a doqtri admin (`DOQTRI_ADMINS`), `GET /api/admin/chain-jobs`
shows the same health with the open jobs by status and the oldest pending
one. Pending jobs older than a few minutes while it says `configured`
mean the runs are failing: read the route's logs on Vercel.

## 6. The flag: preview, then production

`NEXT_PUBLIC_REGISTRY_EDITORS=1` is read at build time, so each change
needs a new deployment.

1. **Preview.** Branches other than `main` never deploy from git (D-58,
   `git.deploymentEnabled` in `vercel.json`: never remove it). Make the
   preview by hand from `integration/suite`: `vercel deploy` (CLI) with the
   Preview environment, which has `NEXT_PUBLIC_REGISTRY_EDITORS=1`,
   `REVOKER_SECRET_KEY` and `CRON_SECRET`, and points at the Supabase branch
   of step 1 (its URL and keys in the Preview environment).
2. Run the **two-person browser test** (below) on the preview.
3. Run the **flag-off smoke test** (below) on a deployment without the flag.
4. **Live G1 sign-off** (D-47). Nothing below happens before it.
5. **Release window, flag off.** Code and schema change together here,
   once. Pick a quiet hour and tell users that saving pauses for a few
   minutes: between 1 and 3 below the new code runs on the old schema and
   its workspace queries fail. Leave `NEXT_PUBLIC_REGISTRY_EDITORS` unset
   in Production for now. Before the window, enable pg_cron and pg_net on
   production (as in step 1.2) and take a database backup (or note the
   point-in-time-recovery time) for Rollback.
   1. Merge `integration/suite` into `main`. That deploys production.
   2. Check production is serving the new build before touching the
      database: in Vercel → Deployments, the current production
      deployment is **Ready** and its commit is the merge commit, and the
      live site's assigned domain points at it. Still the old build:
      wait, or stop. Do not migrate under the old build (step 1).
   3. Straight away, apply the seven migrations to production, in order,
      as in step 1.3, and read the same NOTICEs and WARNING.
   4. Run step 1.5's checks on production. A failed check: stop, and see
      Rollback.
   5. Run the flag-off smoke test's steps 1, 2 and 4 on production with a
      test account: create, save and anchor a note, open a second tab.
6. **Flag on, production.** Store the production Vault secrets (step 5,
   the production URL), copy `REVOKER_SECRET_KEY` and `CRON_SECRET` to
   Production, set `NEXT_PUBLIC_REGISTRY_EDITORS=1` there and redeploy.
   `chain_jobs_scheduler_health()` must answer `configured`. Repeat the
   two-person test's removal step on production with two test accounts.

## The two-person browser test

Account A signs in with email and a passkey wallet; account B with
Freighter. Two browsers (or one private window).

1. A creates a team workspace in the switcher, opens **Manage members**,
   presses **Create on-chain** and signs. B tells A their Freighter address
   (G…); A invites it as an editor.
2. B sees the invite and accepts. A grants B on-chain write access
   (`add_editor`, signed by A). The members screen shows B as on-chain.
3. A opens a team note and edits. B opens the same note: banner
   "<A's email before the @> is editing" (D-53), read-only. A, as owner,
   can take over a lock B holds.
4. Both anchor the same note (B after A releases it). The note's audit page
   `/d/<docId>` lists both, each with their own wallet as signer.
5. A removes B. Within about one ledger the members screen shows the
   removal as done, with a transaction hash. Check on-chain:

   ```bash
   stellar contract invoke --id $REGISTRY --network testnet --source doqtri-admin -- \
     get_role --workspace_id <workspace id> --who <B's G address>
   # nothing
   ```

6. B's next write through the app is refused ("That note isn't in your
   vault."). B submitting straight from Freighter (e.g. Stellar Lab,
   `anchor_as`) fails with `Error(Contract, #10)` (NotEditor).
7. A personal workspace's members screen offers no **Create on-chain**, and
   the relay refuses `create_workspace` for one (D-52).

Pass when every step behaves as written.

## The flag-off smoke test

On a deployment without `NEXT_PUBLIC_REGISTRY_EDITORS`, with prod-like data
(the branch of step 1):

1. An existing user signs in and lands in their personal workspace with all
   their notes; titles as before (bar any renamed duplicates from step 1).
2. Edit, save and anchor a note: it goes through the owner-only calls, as
   before. Its audit page loads its old records.
3. In a team workspace, an editor who is not a note's author sees no Anchor
   button on it (D-43).
4. A second tab of the same note opens read-only with **Edit here** (D-54),
   the one intended change.
5. The members screen shows no on-chain parts; removing a member works and
   queues nothing that is sent (`/api/chain/jobs` answers `skipped`).

## Rollback

- **The flag is the switch.** Unset `NEXT_PUBLIC_REGISTRY_EDITORS` and
  redeploy: the app goes back to the owner-only calls, the members screen
  hides the chain, and the job route skips. Data written meanwhile stays.
- **The contract upgrade is not rolled back.** v3 keeps every v2 call and
  record (G1.4), so the app with the flag off runs on it exactly as on v2.
  Notes already assigned to an on-chain workspace stay there; their
  workspace owner can still write them through the owner-only calls.
- **The revoker** can be left in place. To revoke the key itself, call
  `set_revoker` with a fresh address and unset `REVOKER_SECRET_KEY`.
- **The scheduler**: `select cron.unschedule('doqtri-chain-jobs');` stops
  it; deleting the Vault secrets makes it send nothing (and warn).
- **The migrations** are not reversed. They add workspaces around the
  existing data without removing any; with the flag off the new code runs
  on them. The old code does not (step 1): once they are on production,
  do not roll the deployment back to a build from before the merge
  (Vercel Instant Rollback included), or note creation, imports and saves
  stop. Roll forward with a fix on `main` instead. A real restore means a
  database backup from before step 6.5 together with the pre-merge
  deployment, losing what was written since.

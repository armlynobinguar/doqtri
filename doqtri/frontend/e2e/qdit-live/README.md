# qdit-live: doqtri staging against real qdit staging

DOQ-20, WP-2.8, gate G2. The everyday qdit suite, `../qdit-integration.spec.ts`,
runs against a stub built from `docs/integration/CONTRACT.md`, so it cannot
tell you whether real qdit still works with doqtri. This suite can. It runs
the deployed staging pair over the real wire:

| Test | What it proves |
| --- | --- |
| connect | doqtri's OAuth goes to qdit staging; sign-in, consent and callback work; the stored token answers `GET /me` |
| projects | doqtri lists qdit's projects, and a note links to one |
| milestone | a milestone made from a heading exists in qdit, linked to the note |
| a doqtri token cannot approve | qdit refuses a status change from doqtri's token (G2) |
| unlink | the links go and the milestone stays in qdit |
| revoke | revoking Doqtri in qdit's settings cuts doqtri off at once (D-59, G2) |

Approving a milestone is not covered. qdit approves only on chain, signed by
the project owner's wallet, and its webhook to doqtri fires from that anchor.
Approval and the webhook stay G2's manual step (decision on DOQ-20).

The suite refuses to start unless doqtri is `staging.doqtri.xyz`, qdit is
`staging.qdit.app`, and the doqtri Supabase ref is in
`E2E_ALLOWED_SUPABASE_REFS`. It stops again if any qdit page it lands on is
not qdit staging.

## Run it

1. Bring up the staging pair: both apps deployed from their `staging` branches
   on their Supabase staging branches, with doqtri's OAuth client and webhook
   registered on qdit's.
2. Once, on qdit staging: sign in with a wallet, add a recovery email and
   password, and create a project. That account must be the project's admin
   or owner. Authorize nothing else with it, because the revoke test revokes
   its first authorized app and checks that it is Doqtri.
3. Write `doqtri/frontend/.env.qdit-live` (gitignored):

   ```sh
   # doqtri's Supabase staging branch, the one doqtri staging runs on
   NEXT_PUBLIC_SUPABASE_URL=https://<staging-branch-ref>.supabase.co
   NEXT_PUBLIC_SUPABASE_ANON_KEY=...
   SUPABASE_SERVICE_ROLE_KEY=...
   E2E_ALLOWED_SUPABASE_REFS=<staging-branch-ref>
   # doqtri staging's token key, as set on its Vercel staging environment
   INTEGRATION_TOKEN_KEY=...
   # the qdit staging account from step 2
   QDIT_LIVE_EMAIL=...
   QDIT_LIVE_PASSWORD=...
   QDIT_LIVE_PROJECT_ID=<uuid of the project>
   ```

4. `npm run test:e2e:qdit-live`

The suite deletes its doqtri rows: the note, the team workspace, the qdit
connection and milestone state. On qdit staging it leaves the milestone
(unlinked) and the revoked grant. They go when qdit's staging branch is torn
down.

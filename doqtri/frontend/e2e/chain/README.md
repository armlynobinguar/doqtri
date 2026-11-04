# The chain project: on-chain flows on Stellar testnet (DOQ-19)

`e2e/chain/doqtri.chain.ts` drives the sanity checklist's on-chain steps through the real UI:

- **Passkey wallets:** two email accounts set up passkey wallets ("Finish setting up your vault", then "Create passkey", then "You're ready to anchor"). Top up answers too.
- **Anchoring:** "Saved & registered as v1", then "Saved & updated to v2". An up-to-date note leaves "Save & anchor" disabled. "Mark mindmap done", a node status with "Sync node status", and an anchored note has no delete button.
- **The audit page `/d/[docId]`:** version history with signers, build status, and "Check a copy" ("Match", then "No match").
- **The marketplace:**
  - A publishes a free and a paid template on-chain.
  - B buys the paid one and gets its full text.
  - B tips the free one and reports the paid one as a copy.
  - A's Yours tab counts the sale and the tip.
  - Change price, Delist and Relist.
- **On-chain workspaces:** "Create on-chain", "Sign editor role", and a removal that reaches the chain ("Removed on-chain").

It is slow (several minutes), spends testnet XLM and depends on public testnet RPC. That is why it is not part of `npm run test:e2e`.

## Running it

```sh
npm run test:e2e:chain              # its own throwaway Supabase branch, "e2e-chain"
npm run test:e2e:chain -- --keep    # leave the branch up for another run
```

It uses the same runner as `test:e2e:staging` (`scripts/e2e-staging.mjs --chain`): branch, schema, auth, then `playwright test --project=chain`, and the branch is deleted afterwards.

## What it needs

- **From `.env`:** the testnet settings the dev server already uses. The registry and market contracts and the RPC default to testnet's in `lib/stellar/config.ts`.
  - `DOQTRI_RELAYER_SECRET`: the relay that submits paid writes.
  - `CHANNELS_API_KEY`: wallet deploys.
- **From `.env.chain`** (gitignored, read only by this project):
  - `REVOKER_SECRET_KEY`: the testnet registry's revoke-only key. Without it the last test is skipped and says so, because removals cannot reach the chain.
- **Set by `playwright.config.ts` for chain runs:**
  - `NEXT_PUBLIC_REGISTRY_EDITORS=1`
  - a run-local `CRON_SECRET`, so the spec can run the chain job queue (`GET /api/chain/jobs`).

The specs themselves read no secret.

## Safety

- **Mainnet refusal:** `assertTestnet()` (`testnet.ts`) runs before anything writes. It refuses unless the passphrase is testnet's, the RPC answers with testnet's passphrase, and both contracts exist on that RPC.
- **Database:** `assertNotProduction()` keeps the run on the e2e branch.
- **Funding:** wallets are funded only by the app's Friendbot top-up.
- **Timeouts:** every on-chain wait has a bounded timeout (`untilConfirmed`). When one times out it says which step and that testnet may be slow, so a slow ledger reads differently from a broken app. Calls the specs make to public RPC are retried and fail as `RpcFailure`.

## Passkeys

Chromium's virtual authenticator (CDP `WebAuthn.addVirtualAuthenticator`, see `passkey.ts`) answers every passkey prompt as a platform passkey with user verification. The wallet contract checks each signature on-chain, as it does for a hardware passkey.

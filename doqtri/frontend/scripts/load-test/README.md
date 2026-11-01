# Paid-write load test (DOQ-2, WP-4.1)

Fires N paid writes at `/api/chain/relay` at the same moment, one from each of
N test email accounts with its own passkey wallet. It reports how many landed,
how many failed and why, and p50/p95 latency. This is the baseline the relay
pool (DOQ-1) is measured against: today every paid write is sent from the one
`DOQTRI_RELAYER` account, so writes that arrive together fight over its
sequence number.

It is not part of `npm test`. It runs only through its own vitest config,
needs a running deployment and that deployment's Supabase keys, and spends
testnet XLM. It refuses mainnet.

## What one write does

Each wallet follows the browser's path (`payAndRelay` in
`lib/passkey-wallet.ts`):

1. Read the wallet's XLM balance and the latest ledger.
2. Wrap `register_document` for a new note in the FeeForwarder's `forward(...)`.
3. Simulate it, and have the passkey sign the wallet's auth entry.
4. POST `{ func, auth }` to `/api/chain/relay`, signed in as the wallet's owner.
   The relay validates the write, charges the quota and calls `submitPaidWrite`.

Steps 1 to 3 run for every wallet first. Then all N step-4 requests go out at
once, and only those are timed. Each time is from sending the request to
reading the whole response. That includes the relay's checks, its retries on
`txBadSeq` / `TRY_AGAIN_LATER`, and its wait for the ledger. Real users never
arrive this tightly together, so the test shows the worst case.

## How the test wallets are made and funded

A headless script cannot sign up through an inbox or use a hardware passkey.
It does two things differently from a person at a browser. After that, it uses
the app's own routes.

| Step | How | Why it differs from a person |
| --- | --- | --- |
| Test user | `auth.admin.createUser({ email, email_confirm: true })` with the target's service-role key. Emails are `doqtri-loadtest+<tag>-<i>@example.com`. | No inbox to confirm a sign-up |
| Session | `auth.admin.generateLink({ type: "magiclink" })`, then `verifyOtp` with its token, stored in the same cookies `@supabase/ssr` writes for the app | No inbox, no captcha. The relay sees an ordinary email account's session. |
| Passkey | A software P-256 key (`soft-passkey.ts`), given to smart-account-kit through its `webAuthn` test hook | No authenticator to tap. The wallet contract's WebAuthn verifier checks every signature on-chain, the same as for a hardware passkey. |
| Wallet | The kit builds the deploy as `createPasskeyWallet` does. The script POSTs it to `/api/chain/relay`, which submits it through Channels and records `smart_wallets` and `wallet_passkeys`. | Same as the app |
| Funding | The relay starts a Friendbot top-up (9,990 test XLM) with every testnet deploy. The script waits until the wallet holds 500 XLM, the most one write may cost. If the top-up has not arrived within a minute, it calls `/api/chain/topup` once, like the account menu's Top up. | Same as the app |
| Note | `POST /api/notes` creates a fresh note in the user's personal workspace for every run | Same as the app |

The users, passkey keys and wallet addresses are kept in a state file, so a
second run reuses the same wallets. The default file is
`scripts/load-test/.state/<host>.json`, which git ignores. The file holds
private keys for testnet test wallets only. Never point the test at mainnet,
and do not commit the file.

The relay allows 3 wallet deploys per user and 200 in total per day
(`CHAIN_DEPLOYS_*_DAILY`). The first run at N=30 uses 30 of those. A wallet
pays about 20 test XLM per `register_document`, so it can make hundreds of
writes before it needs another top-up.

## Running it locally

The deployment needs a Supabase project with the migrations applied, plus
`DOQTRI_RELAYER_SECRET` and `CHANNELS_API_KEY`. Channels is used to deploy the
wallets. Paid writes do not use it.

A production build gives realistic latency. `next dev` compiles each route on
its first request.

```sh
# Terminal 1: the deployment, with its log saved for the error breakdown
npm run build && npm start 2>&1 | tee /tmp/doqtri-server.log

# Terminal 2: the same environment as the deployment
set -a; . ./.env.local; set +a
LOADTEST_BASE_URL=http://localhost:3000 \
LOADTEST_N=30 \
LOADTEST_SERVER_LOG=/tmp/doqtri-server.log \
  npm run load:paid-writes
```

The report is printed and saved as `scripts/load-test/.results/<time>.md`,
with the raw outcomes in `.json` next to it. Paste the `.md` into the Jira
comment.

## Running it against staging

Only do this on purpose. The script refuses any address other than localhost
unless `LOADTEST_ALLOW_REMOTE=1` is set.

- Use staging's `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`
  and `SUPABASE_SERVICE_ROLE_KEY`. Also set staging's
  `NEXT_PUBLIC_DOQTRI_RELAYER`: the wallet signs a call that names the
  relayer, and the relay refuses any other.
- Set `LOADTEST_PROTECTION_BYPASS` if Vercel Deployment Protection is on.
- Vercel's logs are not a local file, so 502s cannot be split by code during
  the run. Export the runtime logs for the run's time window to a file
  afterwards (dashboard, or `vercel logs`). Then rebuild the report with them:

```sh
LOADTEST_REPORT_FROM=scripts/load-test/.results/<time>.json \
LOADTEST_SERVER_LOG=staging-logs.txt \
  npm run load:paid-writes
```

## Reading the report

- **Outcome (HTTP status + reason):** one row per HTTP status and relay
  message, such as `ok` or `502 network rejected the transaction`.
- **Server log:** the relay sends the same 502 for every network rejection,
  so the code is only in its log line
  `[chain/relay] paid write rejected: <code>`. The report counts those lines
  as `txBadSeq`, `TRY_AGAIN_LATER` and other. It also counts `ended <status>`
  and simulation failures under other. Only each request's last attempt is
  logged, after up to two retries.
- **Relay latency:** p50, p95, min and max for all requests, and for the
  successful ones only.
- **Wallets that never reached the relay:** the step where preparing failed,
  such as sign-in, funding, note, connect wallet or sign write. These are not
  counted as relay failures.

## Settings

| Variable | Default | Meaning |
| --- | --- | --- |
| `LOADTEST_BASE_URL` | (required) | The deployment, e.g. `http://localhost:3000` |
| `LOADTEST_N` | `30` | Number of wallets, which is also the number of simultaneous writes (1 to 200) |
| `LOADTEST_SERVER_LOG` | none | The deployment's log file. Only lines written during the run are read. |
| `LOADTEST_STATE` | `.state/<host>.json` | Test users, passkeys and wallets reused between runs |
| `LOADTEST_OUT` | `.results/` | Where reports are written |
| `LOADTEST_LABEL` | none | Shown in the report, e.g. the commit under test |
| `LOADTEST_ALLOW_REMOTE` | off | `1` allows an address other than localhost |
| `LOADTEST_PROTECTION_BYPASS` | none | Sent as `x-vercel-protection-bypass` |
| `LOADTEST_SETUP_CONCURRENCY` | `3` | Wallets deployed at a time during setup |
| `LOADTEST_PREPARE_CONCURRENCY` | `5` | Wallets preparing their write at a time |
| `LOADTEST_EMAIL_PREFIX`, `LOADTEST_EMAIL_DOMAIN` | `doqtri-loadtest`, `example.com` | Test user emails |
| `LOADTEST_REPORT_FROM` | none | Rebuild a saved report with `LOADTEST_SERVER_LOG` instead of running |

The script also reads `NEXT_PUBLIC_SUPABASE_URL`,
`NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` and the
`NEXT_PUBLIC_*` Stellar settings. All of them must match the deployment.

## Checking the signing without a deployment

`npm run load:smoke` deploys one software-passkey wallet on testnet and funds
it. It signs one forwarded `register_document` the way the load test does, and
submits it with the relay's own `submitPaidWrite`. Every key is a fresh
throwaway, including the relayer, so no app secret or database is involved.
It leaves one junk document, owned by that throwaway wallet, in the testnet
registry.

## Files

- `paid-writes.load.ts`: the run: setup, preparation, the simultaneous send, the report
- `driver.ts`: network calls (Supabase admin, app routes, kit, RPC)
- `paid-write.ts`: the browser's forward wrapping, checked against the relay's validation in `paid-write.test.ts`
- `soft-passkey.ts`: the software authenticator
- `report.ts`: outcome rows, log parsing, percentiles and the Markdown report. The pure parts are tested in `npm test`.
- `smoke.load.ts`: the on-chain signing check

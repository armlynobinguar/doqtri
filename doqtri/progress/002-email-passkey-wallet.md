# 002 — Email sign-up with an automatic passkey wallet

**Status:** In progress — §0 spike, §1 email accounts, §2 schema done; §3 next
**Opened:** 2026-10-06
**Supersedes:** the wallet-only sign-in in `proxy.ts` ("not a separate email
sign-in") and `components/auth/login-form.tsx`. Freighter sign-in stays; email
is added beside it.

---

## Problem

Signing in requires a Stellar browser wallet. That rules out anyone without
Freighter (or equivalent) installed, and rules out phones entirely: Freighter
has no mobile browser extension.

## Verdict

Add email + password accounts. Each email account gets a **Soroban smart
wallet** (a contract account, `C…`) whose signer is a **passkey** created on the
user's device. Doqtri never holds a key. A relayer (OpenZeppelin Stellar
Channels) pays every fee, so email users never touch XLM.

Rejected:
- **Server-generated keypair** — custodial; a database or key leak exposes every wallet.
- **Key derived from the password** — the public key is on-chain, so weak
  passwords can be brute-forced offline; a password change forces a key change.
- **Embedded-wallet vendor** — avoidable vendor lock-in and per-user cost.

### Decisions this plan takes

| Question | Decision | Why |
|---|---|---|
| When is the wallet created? | Lazily, on the first on-chain action, not at sign-up | Users who never anchor cost nothing; the passkey prompt arrives with context |
| Who pays fees? | Doqtri, via OpenZeppelin Stellar Channels (Launchtube is discontinued) | A contract account cannot be a transaction source |
| Where is the wallet recorded? | New service-role tables, never `user_metadata` | `user_metadata` is writable by the user through `auth.updateUser` |
| Account linking (email ↔ Freighter) | Out of scope. They are separate vaults | Linking two auth methods to one vault is its own feature |
| Contract change? | None | `owner: Address` + `require_auth()` already accept a `C…` address and run its `__check_auth` (proven on testnet, §0) |
| Wallet contract | OpenZeppelin `stellar-accounts` smart account, the **canonical SDF deployment** (no upload of our own) | Audited (v0.5.0, v0.6.0 incl. `verifiers/webauthn.rs`, v0.7.0); MIT; already on testnet and mainnet |
| Client SDK | `smart-account-kit` (stellar/smart-account-kit) | Wraps WebAuthn, deploy payloads and auth-entry signing for these exact contracts. **Unaudited** — pin the version |
| Wallet policy | Default context rule with a **threshold policy, threshold = 1** | A rule without policies requires *every* signer, so adding a backup passkey would otherwise demand both |

### Tradeoffs (accepted)

- Email users' wallets live only inside Doqtri. Freighter cannot sign for them.
- Every write still needs one biometric prompt. GitHub **Sync** signs one
  transaction per node, so N nodes means N prompts (see [Deferred](#deferred)).
- Lose every passkey with no backup, and the on-chain wallet is unrecoverable.
  Notes stay safe (they are in Supabase); documents that wallet anchored can no
  longer be updated.
- Doqtri pays all fees and wallet rent. Abuse becomes a cost to Doqtri, which is
  why the relay route validates every call (§4).

---

## Blast radius

Everything below currently assumes the vault owner is a `G…` account that
signs through the wallet kit. "Breaks" means it fails or misbehaves for an
email user; "UX" means it works but shows the wrong thing.

### Auth and session

| Where | Today | Impact for email users |
|---|---|---|
| `proxy.ts:39-49` | Public routes are only `/` and `/login` | **Breaks.** The email-confirm and password-reset routes would redirect to `/` |
| `app/vault/layout.tsx:33-36` | Vault identity = `user_metadata.wallet_address`, else email | UX. It reads user-writable metadata (pre-existing issue; fix in passing) |
| `components/vault/vault-shell.tsx:50` | `sessionAddress` only if the identity matches `^G…` | Email users get `sessionAddress = null` |
| `components/vault/account-menu.tsx:43` | `if (!sessionAddress) return null` | **Breaks.** Email users get no account menu, and therefore **no way to sign out** (the only `signOut` is in `wallet-provider.tsx:156`) |
| `components/vault/settings-dialog.tsx:24` | `email.startsWith("G")` | Falls through to the email address. Fine |
| `lib/wallet-auth.ts:5` | Wallet users get the synthetic email `<g…>@stellar.doqtri.local` | **Security.** An email sign-up claiming that domain collides with a future wallet user. `app/api/auth/wallet/route.ts` step 2 would then hand that account to the wallet. Block the domain at sign-up |
| `backend/migrations/…create_wallet_accounts.sql` | `address` checked `^G…` | Unaffected. Smart wallets get their own table |

### Wallet and signing

| Where | Today | Impact |
|---|---|---|
| `components/vault/wallet-provider.tsx` (whole) | Wallet kit, Horizon balance poll, mismatch, `switchVault`, Friendbot `fund` | **Breaks.** None of it applies to a passkey wallet. Needs a second mode |
| `lib/wallet.ts` | Kit-only `signSorobanTx`, SEP-53 `signWalletMessage` | Unchanged; joined by a passkey signer |
| `lib/stellar/contract-client.ts:63-79` | `writeClient(publicKey)` uses the signer as **transaction source** + `signAndSend` | **Breaks.** A `C…` address cannot be a source or sign envelopes; it signs **auth entries** and the relayer submits |
| `lib/stellar/contract-client.ts:149-151, 226, 252, 274` | `assertFunded` / `assertCanPay` via Horizon before every write | **Breaks.** Horizon has no account for `C…`; fees are not the user's |
| `lib/stellar/horizon.ts` | `loadAccount(address)` | Throws for `C…` and would read as "ledger down" |
| `lib/stellar/errors.ts:24-38, 72-80` | Error copy names Freighter and Friendbot | UX. Needs passkey and relayer messages (`NotAllowedError` = the user cancelled) |
| `components/vault/ship-panel.tsx:62-65, 267-296, 410` | Buttons disabled while `balance.funded === false`; funding warning | **Breaks.** Would block every email user forever |
| `components/vault/ship-panel.tsx:143-198` | `ensureWallet()` then registry writes | Must route to wallet creation + passkey signing |
| `components/vault/github-links.tsx:57` | Sync signs `setNodeStatus` per node | Works; one passkey prompt per node |

### Public audit trail

| Where | Today | Impact |
|---|---|---|
| `lib/stellar/history.ts:10-11, 182-212` | History = Horizon `/accounts/{owner}/operations`, relying on "the owner is the transaction source" | **Breaks.** For a `C…` owner the source is a Channels account shared by everyone, and `/accounts/C…` does not exist. The audit page would show no versions |
| `app/d/[docId]/page.tsx:241, 365` | Shows owner; copy says "the owner's wallet signed" | Owner shows as `C…` (fine). Copy still true |
| `lib/stellar/anchored.ts`, `getDocumentTtl` | Ledger-key reads, owner-agnostic | Unaffected |
| `app/api/notes/[id]/route.ts:65-85` | Delete blocked when anchored | Unaffected |

### Copy, tests, ops

| Where | Impact |
|---|---|
| `components/landing/landing-page.tsx:126`, `components/auth/login-form.tsx`, `app/docs/page.tsx:115, 328` | Copy says "connect a wallet"; needs the email path |
| `backend/migrations/20261002000000_create_ai_usage.sql` (header) | Its threat model ("sign-in only needs a free keypair") now also covers free email sign-ups. Quota still applies; no change |
| `e2e/auth.setup.ts`, `e2e/helpers.ts` | Seed a wallet session only. Need an email-user setup + a Playwright virtual authenticator |
| Vercel preview deploys | Passkeys are bound to one domain (the WebAuthn RP ID). Previews cannot sign; a fixed staging domain is needed |
| Supabase Auth settings | Email provider, confirmation, SMTP, redirect URLs, captcha — all dashboard config, not in the repo |
| `contract/` | **No change** |

---

## Plan

### 0. Spike on testnet (go / no-go) — **Done 2026-10-06: GO**

Script: a Node run with a software P-256 authenticator injected into
`smart-account-kit` (`webAuthn` option), a local relay forwarding `{ func, auth }`
to Channels testnet (same shape as §4), and the testnet DoqtriRegistry
`CCB5DFZRFFDCIBV5H5KWO6UCVN4ZXIPUSXONMBA6HVF433SPO7YEWMSB`.

- [x] Wallet contract chosen: OZ smart account, canonical deployment
      (smart-account-kit `docs/deployments-protocol-27-2026-07-09.md`, built from
      `OpenZeppelin/stellar-contracts@1e513890`):

      | | testnet | mainnet |
      |---|---|---|
      | account wasm hash | `1b5f4534…997785a` | same |
      | WebAuthn verifier | `CC7EKIHQ…GPZIOM3F` | `CB7HENHJ…LOKRQ5YR` |
      | threshold policy | `CB3FATQK…RVROBCEG` | `CCEJBH26…COAZXJUF` |

- [x] Wallet deployed through Channels from a passkey; no Doqtri account
      funded anything. Address is derived from the credential ID (shared
      deterministic deployer), so a retried deploy lands on the same wallet.
- [x] `register_document(owner = C…)` signed with **one passkey prompt**,
      relayed through Channels, then `update_document` → on-chain `version: 2`,
      `owner = C…`. The registry contract needed no change.
- [x] Measured (testnet, actual `feeCharged`, all paid by Channels):

      | Call | XLM |
      |---|---|
      | wallet deploy (threshold-1 policy) | 0.078 |
      | first `register_document` from a new wallet | 0.355 |
      | next `register_document` | 0.206 |
      | `update_document` | 0.0026 |
      | same register from a plain `G…` owner (Freighter path) | 0.202 |

      Passkey verification itself adds ~0.004 XLM per write. The first write
      from a wallet also extends the wallet's own storage TTLs (~0.15 XLM).
      One run paid **2.92 XLM** on its first write. It went to TTL extensions;
      I could not pin down which entries, and a rerun cost 0.355. Treat these
      bumps as lumpy and occasional.
- [x] Mainnet simulation (free, nothing submitted): `register_document` 0.064 XLM
      (matches July's measured 0.063); wallet deploy 0.289 XLM simulated
      (simulation overshoots ~15%, so ≈0.25 actual).
- [x] Horizon: the write's source is a Channels account (`GD5XS5KU…`), and
      `/accounts/C…/operations` returns **400**. §5 is required, not optional.

Findings that change later sections:
- No wasm upload of our own (the ~10–25 XLM line is gone).
- The verifier does **not** check origin or RP ID hash on-chain (documented in
  `verifiers/webauthn.rs`). Phishing resistance comes from the browser binding
  passkeys to the domain, so the relay must still only accept Doqtri sessions.
- Channels keys are free (`/gen`), with a **per-key fee cap reset every 24 h**
  (`FEE_LIMIT_EXCEEDED`). TTL bumps like the 2.92 XLM one are what would hit it.
- `smart-account-kit` needs `@stellar/stellar-sdk ^16.3.0`; the app pins 16.1.0.
  Its `@creit-tech/stellar-wallets-kit` peer is optional.
- The kit and SDF's reference `relayer-proxy` are **unaudited**. The relay's
  validation rules should be ported from `relayer-proxy` and reviewed, not trusted.

### 1. Email accounts (no chain) — code done 2026-10-07, dashboard config pending

- [x] `app/(auth)/`: `/login` (wallet **or** email), `/signup`, `/forgot-password`,
      `/reset-password`; forms in `components/auth/email-auth-form.tsx` and
      `password-reset-forms.tsx`, against Supabase Auth from the browser client.
- [x] `app/auth/confirm/route.ts`: handles both PKCE `code` (default email
      template) and `token_hash` + `type`; `next` restricted to same-site paths
      (`lib/email-auth.ts` `safeNextPath`). Bad link → `/login?error=link`.
- [x] `proxy.ts`: `/signup`, `/forgot-password` public; `/auth/*` passes through;
      `/reset-password` needs the session the emailed link creates.
- [x] Reserved domain: sign-up refuses `@stellar.doqtri.local` client-side.
      Decided **against** the "before user created" hook: Supabase's docs do not
      say whether it also fires for admin `createUser`, which the wallet route
      uses, so it could break wallet sign-in. Instead the wallet route now only
      adopts a user that is in `wallet_accounts` or carries the service-role-only
      `app_metadata.doqtri_wallet` marker (set on create, on repair, and
      self-healed on every successful sign-in). Anything else at the wallet's
      email gets a 409, never the wallet.
- [x] `backend/migrations/20261007000000_backfill_wallet_accounts.sql`: maps the
      33 of 37 wallet users not yet in `wallet_accounts` (dry-run count checked
      against production). **Not applied yet.**
- [x] `app/vault/layout.tsx`: identity from the verified email
      (`walletAddressFromEmail`), not `user_metadata`. `VaultIdentity` type in
      `lib/types.ts` replaces the `email` string through the shell.
- [x] Email-mode `WalletProvider` (no kit loaded; `ensureWallet` throws
      `NO_WALLET`, `signOut`), email account menu with **Sign out**, settings
      dialog, ship panel notice + disabled buttons, GitHub Sync disabled.
- [x] Landing: "Sign up with email" next to "Open your vault".
- [x] Backfill migration applied to production 2026-10-07: 37/37 wallet users
      mapped, 0 address mismatches.
- [x] Turnstile: `components/auth/turnstile.tsx` (no npm dependency; site key in
      `NEXT_PUBLIC_TURNSTILE_SITE_KEY`), token sent on sign-up, password sign-in,
      reset, and resend; submit stays disabled until a token arrives.
- [x] Captcha vs wallet sign-in: Supabase's captcha also guards the password
      grant the wallet route uses server-side. The route now signs in with the
      service-role key, which supabase/auth exempts
      (`internal/api/middleware.go` `verifyCaptcha`: admin credentials skip the
      check). Refresh and PKCE grants are exempt too, so sessions and
      `/auth/confirm` are unaffected. **Deploy this before turning captcha on.**
- [x] Supabase dashboard (user, 2026-10-07): custom SMTP, Site URL `https://doqtri.xyz`.
- [ ] Supabase dashboard: Redirect URLs `https://doqtri.xyz/**` (+ staging, localhost),
      confirm email on, minimum password length 8, leaked-password protection
      on (security advisor flags it off), captcha → Turnstile secret.
- [ ] Signed-in email vault checked end to end (needs the dashboard config).

### 2. Wallet data model — **Done 2026-10-08, applied to production**

`backend/migrations/20261008000000_create_passkey_wallets.sql`. Changes from
the first draft of this section:

- **Every table carries `network`** (`testnet` | `mainnet`). Local dev runs on
  testnet against the same Supabase project production uses on mainnet, and a
  user's wallet has a different address per network. Keys are
  `(user_id, network)` and `(network, tx_hash)`.
- `smart_wallets` (owner select): `address` `C…`, `created_tx`. `on delete restrict`
  to `auth.users`: a user that owns an on-chain wallet is not silently deleted.
- `wallet_passkeys` (owner select): credential id, 65-byte uncompressed P-256
  key (checked), `rp_id`, `label`; FK to the wallet on the same network.
- `chain_writes` (**public select**, no `user_id` column): what the audit page
  reads for `C…` owners. Everything in it is already public on the ledger.
  FK to `documents` with `restrict`, matching the delete route's rule that
  anchored notes stay.
- `chain_usage` + `consume_chain_quota(user, network, kind, user_limit,
  global_limit, window)`: per-user **and** global caps per `deploy`/`write`,
  one transaction under an advisory lock; service role only.

Verified with a rolled-back dry run on production before applying: bad
address/key rejected, passkey without wallet rejected, anchored document
delete blocked, user cap (`scope = user`, retry 86400 s) and global cap
(`scope = global`) refuse, other network counted separately, anon and
authenticated cannot execute the function, RLS on all four tables.

### 3. Wallet creation

- [ ] `lib/passkey-wallet.ts` (client): one `SmartAccountKit` instance with
      `rpId = NEXT_PUBLIC_WEBAUTHN_RP_ID`, the canonical wasm/verifier/policy for the
      network, `indexerUrl: false` (Supabase is the index), `relayerUrl: "/api/chain/relay"`.
- [ ] `kit.createWallet(..., { autoSubmit: false, policies: [threshold 1] })` builds
      the passkey and the deploy `{ func, auth }`; the browser posts it to the relay.
- [ ] Relay, deploy branch (session required):
  - refuse if the user already has a wallet — return it instead
  - accept only one `createContractV2` with the canonical account wasm hash, one
    External WebAuthn signer on the canonical verifier, the threshold-1 policy,
    and the credential-derived salt (port these checks from `relayer-proxy`)
  - submit through Channels; insert `smart_wallets` + `wallet_passkeys`
  - per-user and global daily caps (reuse the `consume_ai_quota` pattern with a
    `chain_usage` table)
- [ ] Explain the passkey in the prompt before the browser dialog opens
      ("Your device will create a passkey. It is your wallet's key.").

### 4. Signing and relaying writes

- [ ] Split `contract-client.ts` writes behind a signer:
  - `FreighterSigner` — today's path, unchanged (`signAndSend`, funding preflight).
  - `PasskeySigner` — simulate with the relayer's public key as source, sign the
    `SorobanAuthorizationEntry` for the `C…` address with the passkey, POST
    `{ func, auth }` to the relay route. No Horizon funding checks.
- [ ] `POST /api/chain/relay` (server, session required). It is the fee faucet,
      so it validates everything before spending:
  - `func` is `invokeContract` on **exactly** `CONTRACT_ID`
  - function name ∈ `register_document | update_document | set_node_status`
  - the owner / signer address in `auth` is **this user's** `smart_wallets.address`
  - `doc_id` is a `documents.id` owned by this user (RLS read)
  - per-user rate limit and the global daily budget
  - submit via `@openzeppelin/relayer-plugin-channels` (server-side only; it
    CORS-fails in the browser), poll for the result, insert `chain_writes`, return `{ txHash, version }`
- [ ] `errors.ts`: passkey cancel (`NotAllowedError`), relay refused (quota),
      relay down, wallet archived. Freighter copy only on the Freighter path.

### 5. History for contract-account owners

- [ ] `lib/stellar/history.ts`: if `owner` starts with `C`, read the tx hashes
      for `doc_id` from `chain_writes` (server, admin client), fetch each from
      Horizon `/transactions/{hash}/operations`, and feed the existing
      `buildHistory` decoder. `G…` owners keep the account-feed path.
- [ ] The audit page states the trust change honestly: for these documents the
      list of writes comes from Doqtri's index, while each entry's content is
      verified against the ledger. A missing row hides a version; it cannot forge one.
- [ ] Optional hardening later: an independent indexer of the contract's
      `doqtri/*` events (RPC drops events after ~7 days, so it must run continuously).

### 6. Vault UI

- [ ] `wallet-provider.tsx`: two implementations behind the same context.
      Passkey mode has no kit subscription, mismatch, balance poll or Friendbot.
      Its `ensureWallet()` creates the wallet on first use (§3).
- [ ] `ship-panel.tsx`: funding gate and warning only in Freighter mode; the
      first anchor runs wallet creation inline.
- [ ] `account-menu.tsx`: email-mode menu — email, wallet address (copy,
      stellar.expert link), passkeys list, **Add backup passkey**, Sign out.
- [ ] Backup nudge after the first anchor until a second passkey exists.
- [ ] `github-links.tsx`: show "N approvals needed" before Sync in passkey mode.

### 7. Recovery

- [ ] **Add passkey**: a new WebAuthn credential, then an `add_signer` call on
      the wallet, authorised by an **existing** passkey, relayed via §4
      (allowlist the wallet's own `add_signer` for the caller's own wallet only).
- [ ] **Remove passkey**: same, refusing to remove the last one.
- [ ] Lost-all-passkeys path: documented, no on-chain recovery. The account and
      notes remain; new anchors require a new wallet (new owner), and the old
      documents stay read-only on-chain.

### 8. Tests

- [ ] Unit: relay validation (wrong contract, wrong fn, someone else's wallet,
      someone else's doc, over quota), attestation parsing, salt determinism,
      history merge for `C…` owners.
- [ ] e2e: email sign-up → confirm (admin API) → vault → create wallet → anchor,
      using Playwright's CDP virtual authenticator (`WebAuthn.addVirtualAuthenticator`, Chromium only).
- [ ] e2e: the existing wallet suite still passes untouched.
- [ ] Sign-up with `x@stellar.doqtri.local` is refused.

### 9. Rollout

- [ ] Testnet first: staging domain with its own RP ID; Channels testnet key.
- [ ] Mainnet: upload wallet wasm (one-time, see Cost), Channels mainnet key,
      monitor the sponsor balance, alert on the daily budget.
- [ ] Wallet rent: scheduled job extends TTL for wallet instances/signers of
      users active in the last N days; restore-on-demand path for archived ones.
- [ ] Docs page + landing copy.
- [ ] Add deps with `npx npm@10 install` (plain `npm install` breaks `npm ci` on Vercel).

---

## New configuration

| Name | Where | Purpose |
|---|---|---|
| `CHANNELS_API_KEY`, `CHANNELS_BASE_URL` | server env | OpenZeppelin Stellar Channels |
| `NEXT_PUBLIC_WEBAUTHN_RP_ID` | public env, per deploy | Passkey domain binding |
| `NEXT_PUBLIC_SMART_WALLET_WASM_HASH`, `NEXT_PUBLIC_WEBAUTHN_VERIFIER`, `NEXT_PUBLIC_THRESHOLD_POLICY` | public env, per network | Canonical wallet contracts (§0 table) |
| `CHAIN_DAILY_BUDGET`, `CHAIN_USER_DAILY_LIMIT` | server env | Relay and deploy caps |
| SMTP, captcha, redirect URLs, auth hook | Supabase dashboard | Email auth |

## Cost (measured in §0)

| Item | Mainnet | Who pays |
|---|---|---|
| Wallet wasm upload | none — canonical deployment reused | — |
| Wallet deploy, per user who anchors | ≈0.25 XLM (simulated 0.289) | Channels, within the per-key daily cap |
| `register_document` | 0.064 XLM + ~0.004 passkey overhead | Channels |
| First write per wallet | extra TTL extension (testnet 0.15 XLM; one run 2.9 XLM) | Channels |
| Channels service | free key; 24 h fee cap per key | — |
| Supabase email auth | free tier to 50k MAU; SMTP provider extra | Doqtri |

Risk: if traffic or TTL bumps exceed the Channels fair-use cap, writes fail with
`FEE_LIMIT_EXCEEDED`. Fallback is self-hosting OpenZeppelin Relayer (AGPL) with
a Doqtri-funded fee account.

## Open questions

1. ~~Wallet contract~~ — decided in §0: OpenZeppelin smart account.
2. Monthly XLM budget for sponsored fees, and what users see when it runs out.
3. Later: let an email user link Freighter, or a Freighter user add email?

## Deferred

- Batched node-status writes (needs a contract `set_node_statuses`), or a
  Doqtri-scoped session key on the smart account so Sync does not prompt per node.
- Independent event indexer for history (§5).
- Social/email-based recovery signers.

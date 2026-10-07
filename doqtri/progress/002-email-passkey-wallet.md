# 002 — Email sign-up with an automatic passkey wallet

**Status:** Shipped §0–§5 (production); §7 backup passkeys done on branch `feat/backup-passkeys`, verified on testnet
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

### 3. Wallet creation — **Done 2026-10-08 (testnet verified)**

- [x] `lib/stellar/smart-wallet-config.ts`: canonical wasm hash, per-network
      WebAuthn verifier and threshold policy, shared deployer seed, relay path.
- [x] `lib/passkey-wallet.ts`: lazy `SmartAccountKit` (`indexerUrl: false`,
      `relayerUrl: /api/chain/relay`); `createPasskeyWallet` = one passkey
      prompt, threshold-1 policy, resident key required.
- [x] `app/api/chain/relay/route.ts` (deploy branch): email session required;
      `{ func, auth }` only; refuses if the user already has a wallet on this
      network; `lib/stellar/relay-validation.ts` checks the exact kit deploy
      shape (canonical wasm, shared deployer, one External signer **on the
      canonical verifier**, exactly the threshold-1 policy, salt =
      sha256(credential id), one matching deployer auth entry) — stricter than
      SDF's reference proxy; `consume_chain_quota` (3/user, 200 global per day,
      env-tunable); simulation under `CHAIN_MAX_RESOURCE_FEE_STROOPS` (default
      0.5 XLM; the reference proxy's 0.1 XLM would refuse mainnet deploys);
      Channels submit; ledger confirmation; then `smart_wallets` +
      `wallet_passkeys` rows. The wallet address is computed from the deploy
      preimage, not taken from the client.
- [x] UI: email account menu shows the wallet (copy, stellar.expert) or
      "Create passkey wallet"; ship panel offers the same where anchoring would be.
      Anchor buttons stay disabled until §4.
- [x] Dependencies: `smart-account-kit` **0.8.0 pinned**, 
      `@openzeppelin/relayer-plugin-channels` 0.21.0 pinned,
      `@stellar/stellar-sdk` ^16.3.1 (installed with npm 10; `npm ci` checked).
- [x] Verified on testnet through the real UI: Chromium virtual authenticator
      → kit → relay → Channels → wallet `CDDBW7BX…VP4K` (tx `cdf96377…`, 0.0787 XLM
      paid by Channels, 18 s end to end). Ledger instance holds the canonical
      wasm, so the server-computed address is right. DB rows and quota row
      present. Relay refuses signed-out (401), wrong shape and bad XDR (400).
      Test account: `e2e-passkey@doqtri.test` (pre-confirmed via admin API).
- [ ] Mainnet: set `CHANNELS_API_KEY` (mainnet key) in Vercel Production before
      merging; until §4 ships, mainnet users can create a wallet but not use it.

### 4. Signing and relaying writes — **Done 2026-10-08 (testnet verified)**

- [x] `contract-client.ts`: the source address picks the signer. `G…` keeps
      the Freighter path (source, envelope signature, funding checks). `C…`
      simulates from the SDK's null account, skips funding checks, and calls
      `signAndRelay` (passkey signs the auth entry, relay submits); the new
      version is read from the confirmed transaction's return value.
- [x] Relay write branch: caller's wallet on this network required;
      `validateRegistryWrite` (exactly the registry contract, one of the three
      functions with the contract's argument shapes, `register_document` owner =
      caller's wallet, one auth entry from that wallet for exactly that call, no
      nested invocations); **note must be the caller's** (`documents.user_id`);
      `consume_chain_quota` writes (100/user, 5000 global per day); simulation
      cap; Channels; ledger confirmation; `chain_writes` row.
- [x] UI: `ensureWallet` returns the passkey wallet for email accounts; Register,
      Update, and node-status buttons and GitHub Sync work once a wallet exists.
- [x] Found and fixed during testing:
      - WebAuthn user ids are capped at 64 bytes and the kit builds them from
        `name:timestamp:random`; emails over ~28 bytes failed wallet creation.
        `passkeyUserName` caps the name (unit-tested incl. non-ASCII).
      - After a reload the kit re-verifies the wallet's birth before signing and
        needs an indexer for that. `GET /api/chain/indexer/api/lookup/<hex>`
        serves the kit's schema-2 format from Supabase (caller's own wallet
        only); the kit then verifies the claimed creation tx itself (RPC, then
        Horizon via `horizonUrl`).
      - The kit's `defaultPolicies` must list the threshold-1 policy or it
        rejects our wallets as having unexpected constructor policies.
      - Kit storage moved to IndexedDB: the verified connection survives
        reloads, so each write is **one** passkey prompt (was two after reload).
- [x] Verified on testnet through the real UI (fresh user, virtual
      authenticator): create wallet → reload → Register hash (tx `7afc38f1…`) →
      edit → Update hash (`6ade1de5…`, "Updated to v2"); one passkey signature
      per write; on-chain owner = the wallet, version 2; two `chain_writes` rows.
      Relay refuses someone else's note (403), another wallet as owner (403),
      unsigned auth (422 at simulation).
- Note: an unsigned or failing write still consumes one quota slot (quota is
  charged before simulation, to protect RPC as well as Channels).
- Test data: 9 `e2e-passkey…@doqtri.test` users, 6 testnet wallets, 7 notes in
  the production project. `on delete restrict` means removing them needs the
  wallet rows (testnet) deleted first.

### 5. History for contract-account owners — **Done 2026-10-08 (testnet verified)**

- [x] `lib/stellar/history.ts`: `C…` owners read their transaction hashes from
      `chain_writes` (public, anon key, so the same code runs on the audit
      page and in the vault), fetch each transaction's operations from Horizon
      in batches of 10 (at most 200 writes), restore ledger order by paging
      token (`inLedgerOrder`), and decode with the existing `buildHistory`.
      `G…` owners keep the owner-feed path unchanged.
- [x] The index only says where to look: the decoder keeps only successful
      calls to this registry for this document, so a bogus row cannot add a
      version (unit-tested).
- [x] Completeness: if the contract's version is higher than the versions
      found (a write made outside Doqtri, or one the index missed),
      `history.incomplete` is set; the audit page warns, stops numbering the
      listed versions, and the hash checker labels only the contract's current
      version.
- [x] Audit page: passkey-wallet owners are labelled as such, with a
      stellar.expert contract link.
- [x] Verified on testnet against three owners: passkey wallet fully indexed
      (v1/v2 with the right tx links, no warning); passkey wallet never indexed
      (warning, no misleading "Horizon unavailable"); Freighter owner (v1/v2
      from the owner feed, unchanged).
- Deferred: an independent event indexer, so the list does not depend on
  Doqtri's index at all.

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

### 7. Recovery: backup passkeys — **Done 2026-10-08 (testnet verified)**

- [x] **Add a passkey** (account menu → Passkeys, or the ship-panel reminder):
      the browser creates it — the user picks this device, a phone over the QR
      flow, or a security key — then a passkey the wallet already accepts
      approves `add_signer` (`kit.signers.addPasskey` + `signAndSubmitAdmin`).
- [x] **Remove a passkey**, approved by any remaining one; in-page
      confirmation; the last passkey's button is disabled and the relay refuses
      it (409) after checking the ledger.
- [x] Relay branch: `validateWalletAdmin` — `add_signer` / `remove_signer` on
      the **caller's own wallet** only, rule 0 only, adding only an External
      signer on the canonical verifier, one auth entry from the wallet for
      exactly that call. Reads the wallet's live signers
      (`lib/stellar/wallet-signers.ts`, `get_context_rule(0)`) to refuse
      duplicates, more than 10 passkeys, unknown signer ids (404), and removing
      the last one. Counts as a write in `chain_usage`. Keeps `wallet_passkeys`
      in step.
- [x] Signing with whichever passkey the device has: the kit signs with exactly
      one named passkey, so `connectWith` uses the stored session, else asks the
      user to pick a passkey once per device (kit discovery prompt).
- [x] Found during testing: the kit only connects a **backup** passkey on the
      device that added it (it keeps a local "approved secondary" record; on
      any other device it looks for a wallet derived from the backup and fails).
      `rememberWalletPasskeys` seeds those records from the server's list
      before the pick prompt, with the wallet's creation ledger and
      constructor-args hash read from the public creation transaction. The kit
      still verifies the creation on the ledger and that the chosen passkey is
      a live signer; the contract still verifies every signature.
- [x] Reminder: once a note is anchored from a wallet with one passkey, the ship
      panel offers "Add a backup passkey".
- [x] Passkeys are labelled by credential id and date (positions shift when
      one is removed).
- [x] Verified on testnet, two simulated devices: device 1 creates the wallet
      (A), anchors, sees the reminder, adds B (approved by A); device 2 holds
      **only B** and no session — updates the note (pick + sign), then removes A
      (approved by B); B is left, its remove button disabled; on-chain signer
      list matches the database. Relay refusals: last passkey 409, someone
      else's wallet 403, unknown signer 404. Testnet fees: `add_signer`
      0.0282 XLM, `remove_signer` 0.0031 XLM.
- Not built: a recovery key (Ed25519 words, canonical Ed25519 verifier) for
  users who want an offline backup. Losing every passkey still loses the wallet.

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

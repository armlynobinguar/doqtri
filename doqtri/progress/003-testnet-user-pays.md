# 003 — Testnet production and user-paid fees

**Status:** Built and verified on testnet (local); production switch pending (Part A env changes)
**Opened:** 2026-10-07
**Builds on:** [002-email-passkey-wallet.md](002-email-passkey-wallet.md)

---

## Problem

Every on-chain action by an email account (wallet deploy, register, update,
node status, passkey changes) is paid by OpenZeppelin Stellar Channels from a
free API key with an unpublished daily fee allowance, counted at each
transaction's *maximum* fee. With many email users, that allowance — or a
Channels outage — becomes the main way the product fails, and Doqtri cannot see
how close it is.

## Decisions

| Question | Decision | Why |
|---|---|---|
| Which network does production use? | **Testnet**, for now | No mainnet users to serve yet; testnet XLM is free (Friendbot) |
| Who pays for an email user's anchoring writes? | **The user's own wallet**, in XLM, atomically, through an OpenZeppelin **FeeForwarder** | Removes the Channels allowance from the write path; a write that can't be paid for doesn't happen |
| Who submits those writes? | **Doqtri's own relayer account**, straight to Stellar RPC | The forwarder needs a relayer that approves the call and receives the fee anyway; submitting from that account needs no extra signature and no Channels |
| How does a testnet wallet get XLM? | **Friendbot, automatically**: right after the wallet is created, and from a "Top up" button | Testnet XLM is free; mainnet would need a real funding flow (out of scope) |
| What stays sponsored by Channels? | Wallet deploy and passkey add/remove | A wallet can't pay before it exists; passkey changes are rare and quota-limited |
| Freighter users | Unchanged | They already pay their own fees |

## How a paid write works

The FeeForwarder (OpenZeppelin `stellar-fee-abstraction`, audited in the v0.6.0
report; example `fee-forwarder-permissionless`) exposes:

```
forward(fee_token, fee_amount, max_fee_amount, expiration_ledger,
        target_contract, target_fn, target_args, user, relayer) -> Val
```

1. The browser builds `forward(XLM, fee, max_fee, expiration, registry,
   "register_document", [owner, doc_id, hash], wallet, doqtri_relayer)`, with
   Doqtri's relayer as the transaction source.
2. Simulation returns one auth entry for the wallet: `forward` (over the fee
   token, max fee, expiration, target, function and arguments — **not** the
   exact fee or relayer), with sub-invocations `XLM.approve(wallet, forwarder,
   max_fee, expiration)` and the registry call. The relayer's own approval is
   implicit because it is the transaction source.
3. One passkey prompt signs the wallet's entry (unchanged UX); the kit posts
   `{ func, auth }` to `/api/chain/relay`.
4. The relay validates it, sets `fee_amount` to the transaction's actual cost
   (never above the user's `max_fee`), simulates, signs as the relayer
   account, submits to RPC, waits for the result.
5. On-chain, atomically: the wallet approves the forwarder, the forwarder moves
   `fee_amount` XLM from the wallet to Doqtri's relayer, then calls the
   registry. If the wallet can't pay, nothing happens.

Net effect for Doqtri: the relayer account pays the network fee and is repaid
the same amount (plus an optional margin) in the same transaction.

---

## Part A — Switching production to testnet

### What changes (Vercel, Production environment — done by the owner)

| Variable | New value |
|---|---|
| `NEXT_PUBLIC_NETWORK_PASSPHRASE` | `Test SDF Network ; September 2015`, or remove it (testnet is the default) |
| `NEXT_PUBLIC_CONTRACT_ID` | `CCB5DFZRFFDCIBV5H5KWO6UCVN4ZXIPUSXONMBA6HVF433SPO7YEWMSB`, or remove it |
| `NEXT_PUBLIC_SOROBAN_RPC_URL`, `NEXT_PUBLIC_HORIZON_URL`, `NEXT_PUBLIC_EXPERT_*`, `NEXT_PUBLIC_LAB_NETWORK` | Remove if set (they derive from the passphrase) |
| `CHANNELS_API_KEY` | A **testnet** key (`channels.openzeppelin.com/testnet/gen`) |
| New: `DOQTRI_RELAYER_SECRET`, `NEXT_PUBLIC_FEE_FORWARDER`, `NEXT_PUBLIC_DOQTRI_RELAYER` | See Part B |

`NEXT_PUBLIC_*` values are inlined at build time: redeploy after changing them.

### Blast radius of the switch

| Area | Effect | Action |
|---|---|---|
| Code | None: every network-dependent value derives from `NEXT_PUBLIC_NETWORK_PASSPHRASE` (`lib/stellar/config.ts`, `smart-wallet-config.ts`) | — |
| Email users' mainnet wallets (2) | Hidden: every wallet table is keyed by `network`, so the vault shows "Create passkey wallet" again. The mainnet rows stay in the database | Users create a testnet wallet (new passkey) |
| Documents anchored on mainnet (4 relayed + any Freighter ones) | The testnet registry has no record: the ship panel and audit page show "not anchored"; existing mainnet audit links say "No record … on this network" | Re-anchor on testnet if wanted |
| Freighter users | Must switch Freighter to Testnet; their testnet account needs Friendbot funding (button already exists on testnet) | Copy already says "Stellar testnet identity" |
| `chain_usage` quotas | Per network; testnet starts empty | — |
| Passkeys | Bound to `www.doqtri.xyz`, unaffected; but each network has its own wallet, so a new passkey is created for the testnet wallet | — |
| Kit's IndexedDB records for mainnet wallets | Ignored: the identity names the testnet wallet, and connecting matches on its address | — |
| Shared doc page | Network references (mainnet costs, contract IDs) | Update after the switch |

---

## Part B — User-paid fees on testnet

### New

| What | Where |
|---|---|
| Doqtri FeeForwarder contract (OpenZeppelin `fee-forwarder-permissionless`, pinned tag) | `contract/fee-forwarder/` (own workspace), deployed to testnet once |
| Doqtri relayer account (a `G…` key held only by the server; Friendbot-funded on testnet) | `DOQTRI_RELAYER_SECRET` (server), `NEXT_PUBLIC_DOQTRI_RELAYER` (its public key) |
| Direct submitter: build, simulate, sign as the relayer, send to RPC, poll; refills itself from Friendbot on testnet | `lib/stellar/direct-submit.ts` |
| Forwarded-write validation | `validateForwardedWrite` in `lib/stellar/relay-validation.ts` |
| Relay branch for `forward(...)` calls | `app/api/chain/relay/route.ts` |
| Browser: build the forwarded call; show the fee | `lib/stellar/contract-client.ts`, `lib/passkey-wallet.ts` |
| Wallet XLM balance (native token `balance(wallet)`) | `lib/stellar/wallet-balance.ts` |
| Auto-fund after wallet creation + "Top up" button (testnet only, `kit.fundWallet`, submitted directly — not through the relay or Channels) | `lib/passkey-wallet.ts`, account menu, ship panel |

### Affected

| Component | Change |
|---|---|
| `contract-client.ts` | `C…` writes wrap the registry call in `forward(...)`; Freighter `G…` path unchanged |
| `relay/route.ts` | New forwarded-write branch; direct registry writes from wallets are refused once forwarding is on (otherwise users could skip paying) |
| `relay-validation.ts` | New validator; existing ones unchanged |
| `history.ts` | Registry calls are now nested inside `forward`; the decoder must find them in the forwarder's arguments (or history shows nothing for new writes) |
| `chain_writes` | Unchanged shape; still one row per relayed write |
| Ship panel, account menu | Balance, fee shown before signing, "Top up", clear "not enough XLM" error |
| `smart-wallet-config.ts` | Forwarder address, native token contract, relayer address |
| Shared doc page, plan 002 | Costs and flows |

### Validation for forwarded writes

The relay accepts a forwarded write only if:
- `func` is `forward` on **our** forwarder;
- `fee_token` is the native XLM contract; `max_fee_amount` ≤ a sane cap; `expiration_ledger` in the near future;
- `target_contract` is the registry, `target_fn` one of the three registry functions, `target_args` pass the existing registry checks (owner = caller's wallet for register, note owned by the caller);
- `user` is the caller's wallet; `relayer` is Doqtri's relayer;
- exactly one auth entry, from the wallet, whose root is that `forward` call with exactly the two sub-invocations (`approve` on the XLM contract for the forwarder, and the registry call);
- the relay then sets `fee_amount` itself (actual cost, ≤ `max_fee_amount`).

### Phases

0. **Spike (testnet):** build and deploy the forwarder; fund a relayer account;
   from a real wallet, sign a forwarded `register_document` with the kit
   (relayer as source) and submit directly; confirm the fee moved and the
   document is registered; measure fees. **Go / no-go.**
1. Relayer account + direct submitter (with Friendbot refill and sequence
   retry).
2. Forwarder config + relay branch + validation + unit tests.
3. Browser: forwarded writes, fee shown, balance, auto-fund, Top up.
4. History decoding for forwarded writes.
5. End-to-end on testnet through the UI; then production env switch (Part A)
   and a real-device check.
6. Docs: plan, shared page.

## Results (2026-10-07)

- [x] **Spike: GO.** FeeForwarder built from `stellar-fee-abstraction =0.7.1`
      (published on soroban-sdk **25.3.2**, not the repo's 28 — matching it is
      required), deployed to testnet: `CCBBXJSS7DUT34QDJOMZLAYMYOT4Q73NUSY573G4STXFUBSYXDKUBUHV`
      (wasm `3178ab00…87a9`, 3.5 KB). Testnet and mainnet both run protocol 29.
- [x] Relayer account `GCY3QATELG5SQGVV56UF3RIXAFELDQTHP2PFLGG3SFJJETCGBEFUDB5M`
      (Friendbot-funded; key in the local `stellar` keystore as
      `doqtri-testnet-relayer`, and `DOQTRI_RELAYER_SECRET` in local `.env`).
- [x] Found during the spike:
      - the kit refuses a transaction whose **source** must authorize (it tries
        to sign as the shared deployer), so the relayer approves with its own
        address-credential entry instead, signed on the server;
      - the wallet checks **one context rule id per authorized call**: a
        forwarded write authorizes 3 (`forward`, `approve`, the registry call),
        else `ContextRuleIdsLengthMismatch` (#3014);
      - the browser signs with the kit's low-level `signAuthEntry` (the kit's
        `signAndSubmit` re-simulates and would fail on the relayer's unsigned
        entry).
- [x] Built: `fee-forwarder/` contract; `lib/stellar/direct-submit.ts`
      (measure with signatures in place → `fee_amount` = resource fee + 0.0001
      inclusion, ≤ the user's signed max → sign relayer entry → submit to RPC,
      retry on stale sequence, Friendbot refill below 1,000 XLM on testnet);
      `validateForwardedWrite` (+ shared `validateRegistryCall`); relay branch
      for `forward`, **unwrapped registry writes refused** where users pay;
      `lib/passkey-wallet.ts` `payAndRelay`; `/api/chain/topup` + 
      `lib/stellar/friendbot-topup.ts` (testnet, refused above 100 XLM);
      `lib/stellar/wallet-balance.ts`; history decodes registry calls inside
      `forward`; UI: balance and "Top up with test XLM" in the account menu,
      fee note, low-balance warning that disables anchoring, auto top-up after
      wallet creation.
- [x] Tests: 249 unit tests (new: 5 forwarded-write validation, 3 history).
- [x] End to end on testnet through the UI (virtual authenticator): create
      wallet → auto top-up 9,990 XLM → **register paid by the wallet** (one
      passkey signature; 0.4203 XLM, a wallet's first write) → **update**
      (0.0081 XLM) → two `chain_writes` rows → audit page v1/v2, no warning.
      Empty wallet: warning shown, Register disabled, Top up enables it. Relay
      refuses an unwrapped (unpaid) registry write (403) and a forwarded write
      for someone else's note (403). Writes did not touch Channels.
- Note: the relayer ends slightly ahead (+0.055 XLM on that register, +0.0014
  on the update): users are charged the *simulated* resource fee and Stellar
  refunds the unused part to the transaction source. The exact fee is only
  known after execution, so this ~10–15% is a margin, not a bug.

## Production switch checklist (owner, Vercel → Production)

1. `NEXT_PUBLIC_NETWORK_PASSPHRASE` → `Test SDF Network ; September 2015` (or remove).
2. `NEXT_PUBLIC_CONTRACT_ID` → `CCB5DFZRFFDCIBV5H5KWO6UCVN4ZXIPUSXONMBA6HVF433SPO7YEWMSB` (or remove).
3. Remove any `NEXT_PUBLIC_SOROBAN_RPC_URL`, `NEXT_PUBLIC_HORIZON_URL`, `NEXT_PUBLIC_EXPERT_*`, `NEXT_PUBLIC_LAB_NETWORK`.
4. `CHANNELS_API_KEY` → a **testnet** key.
5. Add `DOQTRI_RELAYER_SECRET` (server-only) = output of `stellar keys show doqtri-testnet-relayer` on the machine that created it.
6. Redeploy (public variables are baked in at build time).
7. Check: sign in by email, create a wallet (it tops up), register a note.

## Risks

- **The kit signing a forwarded call.** It signs whatever auth entry belongs to
  the wallet, but this is the first nested tree we give it. The spike proves it.
- **Sequence numbers.** One relayer account sends one transaction at a time;
  concurrent writes retry on a bad sequence. Fine at testnet scale; more
  relayer accounts later.
- **A user who skips paying.** Direct (unforwarded) registry writes from
  wallets must be refused by the relay once forwarding is live.
- **Mainnet later** needs a real way to get XLM into a contract wallet; not
  covered here.

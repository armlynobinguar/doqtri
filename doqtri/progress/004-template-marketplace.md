# 004 — Template marketplace with creator royalties

**Status:** Phases 1–3 built and tested on testnet; phase 4 (mainnet) prepared, not deployed
**Opened:** 2026-10-11 · **Checked against the codebase:** 2026-10-13
**Builds on:** template gallery (`4a7bad3f`), [002-email-passkey-wallet.md](002-email-passkey-wallet.md), [003-testnet-user-pays.md](003-testnet-user-pays.md)

---

## Progress

**Contract (2026-10-13).** `TemplateMarket` built in `market/` with 24 tests,
added to CI, and deployed to testnet:

| Field | Value |
|---|---|
| Contract ID | [`CA6YPRXQ2IFGACBFLKWEFETGLZ2C5R7DG5TTBKTTP4AVYOF3HFOSBCC2`](https://lab.stellar.org/r/testnet/contract/CA6YPRXQ2IFGACBFLKWEFETGLZ2C5R7DG5TTBKTTP4AVYOF3HFOSBCC2) |
| Admin | `GATIH76SLMO4USROC7KTUCNMBTBRSTGBVHCMNXLGEZRK4CKEFP5SLM2X` (`doqtri-testnet-deployer`) |
| Treasury | `GAZEM5SRGHBDZP7MFQ2XL6ZOPGKF2ARBCKQW2MKAGHMZ4ISIKHXIRHIX` (has a USDC trustline) |
| Split | 8500 / 500 / 1000 bps |
| Allowed tokens | XLM `CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC`, USDC (Circle testnet, issuer `GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5`) `CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA` |

Smoke test on testnet: a 3 XLM derivative sold for 2.55 / 0.15 / 0.30 as
designed ([buy tx](https://stellar.expert/explorer/testnet/tx/f01c6c1509b11765040880e48e0918c803b2abd1d37feb05529a61d5d1aba249)).

Measured testnet fees from a `G...` account (fee charged, or simulated resource fee):

| Call | Fee |
|---|---|
| `list_template` | 0.47–0.54 XLM |
| `buy` (3 transfers) | 0.142 XLM |
| `tip` | ~0.003 XLM (simulated) |
| `update_price` | ~0.002 XLM (simulated) |
| registry `register_document`, for comparison | ~0.31 XLM (simulated; ~0.04 in July) |

Testnet rent has risen since the registry was measured: creating a persistent
entry now dominates every write. **`list_template` exceeds
`MAX_USER_FEE_STROOPS` (0.5 XLM)**, so a passkey user's forwarded listing would
be refused today. Phase 1 has to give market calls their own cap or sponsor
listings. Mainnet fees ran ~5x below testnet for the registry; simulate on
mainnet before quoting.

Found while deploying: a `G...` creator (Freighter) needs a **USDC trustline
to receive USDC**, or every `buy` of their listing fails on the transfer to them.
Passkey (`C...`) wallets don't need one. The publish form must check this
before offering USDC.

**Phase 1 (2026-10-13), built and tested on testnet.** Free templates,
the Community tab and tips:

- `20261013000000_create_market.sql`: `market_templates`, `market_purchases`,
  `documents.source_template_id`, `chain_usage.kind` widened to `publish` and
  `market`, and `market_record_use()`. Applied to the Supabase project on
  2026-10-13 (recorded as version `20261013114543`).
- `/api/market/publish` → `publish/confirm`, `/api/market/templates`,
  `/api/market/claim`. Claim already checks `has_purchased` for paid
  templates; publishing paid ones is off (`PAID_TEMPLATES_ENABLED`) until the
  buy sheet ships.
- The relay accepts market calls, sponsored or forwarded. The forwarded
  validator was checked against a real testnet simulation of a forwarded
  `buy`: the tree is `forward → {approve, buy → transfer ×3}`, and a
  redirected split is refused. That `buy` simulated at 0.315 XLM.
- Market writes get their own fee cap, `MAX_MARKET_FEE_STROOPS` = 1 XLM,
  because listing exceeds the 0.5 XLM registry cap.
- UI: Starter / Community tabs in the gallery, "Tip creator", and **Publish as
  template** in the note's Stellar proof panel (it already saves the note and
  knows the wallet), not the note menu.

Changed from the plan:
- **No cover images and no public bucket.** Cards draw the mindmap from the
  template's headings, the same way starter templates are drawn.
- **Usage counts** live in `market_templates.uses`, bumped by `claim`.
- **Free templates use XLM** as their listing token, so tips need no trustline.

**Phases 2 and 3 (2026-10-13), built and tested on testnet.**

- Migration `20261014000000_market_reports_and_cuts.sql` (applied): each
  purchase stores its split (`creator_cut`, `parent_cut`, `treasury_cut`,
  `parent_creator_wallet`) so royalties need no indexer; `market_reports`;
  the advisor's RLS (`(select auth.uid())`) and foreign-key index fixes.
- Paid templates: the publish form takes a price in XLM or USDC (minimum 1 XLM
  / 0.50 USDC). The API refuses a USDC listing when the creator, or the
  parent's creator, can't receive USDC (a `G…` account without a trustline),
  since a sale pays everyone in one transaction and fails as a whole.
- Buy: a confirm sheet (`quoteBuy`) shows the split, the network fee and the
  balance, and simulates the buy first. `claim` reads price and listing from
  the contract, not the cache, and records Freighter purchases with their split.
  Already bought → "Use again" / "Add to vault".
- Earnings: per-template sales, earnings, tips, recent sales with
  transactions, derivatives, royalties, change price, delist / relist
  (`/api/market/sync` refreshes the cache from the chain), with search,
  filters and pagination.
- **One Templates page** (`/vault/templates`) replaced the gallery modal and
  the separate earnings page: tabs **Starter**, **Community** and **Yours**
  (the earnings view), kept in the URL (`?tab=`). The ribbon's Templates
  button and "New from template" open it; `/vault/earnings` redirects to the
  Yours tab; the account menus link to it as "Your templates".
- Reports: "Report copy" in the gallery; `/admin/reports` shows both sides,
  hash equality, heading overlap (`sectionSimilarity`) and which was listed
  on-chain first. Uphold hides the copy; hide / unhide per template.

**Testing.**
- `lib/market.testnet.test.ts` (opt-in, `MARKET_E2E=1`): signs in through the
  real wallet challenge and drives every flow against the deployed contract.
  It covers publish and confirm, the gallery, use, tip, derive, paid buy with
  the split recorded, a derivative sale paying a 5% royalty, earnings, price
  change, delist, reports, and the refusals (below minimum price, USDC without
  a trustline, someone else's note or template, mismatched listing,
  non-admin). Both tests pass.
- `e2e/marketplace.spec.ts` (Playwright): gallery tabs, publish pricing,
  earnings page, admin gate. All pass.
- **Not tested:** the passkey-wallet path through the relay in a browser (it
  needs a real passkey prompt). The relay's forwarded-market validator was
  checked against a real simulated forwarded `buy` instead. Also untested: a
  full USDC sale (no testnet USDC on the smoke keys), and the buy sheet driven
  by a real Freighter.
- Pre-existing, not from this work: `vault-shell.spec.ts` "the explorer/editor
  divider resizes" fails on `main` too (the markdown editor overlaps the 1px
  handle). CI skips e2e without its secrets, so it went unnoticed.

**Known gaps.**
- A Freighter buyer whose claim never succeeds isn't in `market_purchases`
  until they use the template, so that sale is missing from recent sales and
  royalties. The on-chain `sales` and `earned` totals are still right.
- Raising a free template's price goes straight to the chain, so there's no
  trustline check like the one publish does. The buy sheet's simulation still
  catches a creator who can't receive the token.
- "Report copy" picks the original from the currently loaded gallery list.

**Phase 4, mainnet: prepared, not deployed.** It needs the decisions under
"Before mainnet". Then:

1. Create the treasury as a multisig account with a USDC trustline, and decide
   who holds the admin key (ideally the same multisig).
2. `DRY_RUN=1 market/deploy.sh mainnet <source> <admin> <treasury>` to review,
   then run it without `DRY_RUN`. It builds, prints the wasm hash, deploys with
   the 85/5/10 split, and allows XLM
   (`CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA`) and USDC
   (`CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75`).
3. Upload cost: simulated at 19.03 XLM on 2026-10-13; it's usually charged
   ~15% under the simulation. Extend the code entry's TTL afterwards.
4. Set `NEXT_PUBLIC_MARKET_CONTRACT_ID` in production. Until then the
   marketplace stays off on mainnet. Supabase needs nothing: production uses
   the same project, and both migrations are applied.
5. Passkey users on mainnet have no FeeForwarder, so Channels sponsors market
   calls. A mainnet registry write simulates at 0.063 XLM (testnet 0.31), which
   puts a listing at roughly 0.11 XLM, under the 0.5 XLM Channels cap.
   Re-simulate after deploy.
6. Smoke-test with small amounts: list, buy, tip, and a USDC sale.

## Problem

The template gallery has 14 starter notes, all written by Doqtri. Users write
good plans too: grant proposals, launch checklists, sprint plans. Today they
have no way to share them as templates, and no reason to.

We want users to publish their notes as public templates and **earn when
someone uses them**. Payment happens on Stellar, wallet to wallet. When a buyer
improves a template and sells their version, the original creator keeps
earning a small share.

## Goals

- Any signed-in user can publish a note as a free or paid template.
- Buyers pay in one signed transaction. The contract splits the payment between
  the creator, the parent template's creator (if any) and the Doqtri treasury.
- Doqtri never holds user funds. Every split happens inside the contract call.
- Authorship is provable: the template's content hash and its first publish
  time are on-chain.
- It works for both wallet types: Freighter and other Stellar wallets
  (`G...` accounts that sign and submit their own transactions), and passkey
  smart wallets (email accounts, `C...` contracts that go through the relay).

## Non-goals

- **DRM.** A buyer can copy a purchased template anywhere. We prove who
  published first; we don't try to prevent copying.
- **Multi-level royalties.** Only the direct parent earns a share, never
  grandparents and further up (see "Why only one level").
- **Refunds, subscriptions, bundles, fiat payments.** Possible later; out of
  scope for v1.
- **Real money on testnet.** Testnet XLM and USDC have no value. Real earnings
  begin only when the marketplace ships on mainnet (phase 4).

## Decisions

| Question | Decision | Why |
|---|---|---|
| Separate contract or extend `DoqtriRegistry`? | **New `TemplateMarket` contract** in `market/` | Keeps the audited registry unchanged; the market can be upgraded or paused alone |
| Currency | **Stellar Asset Contract tokens on an admin allowlist** (`set_token`), set per listing; the UI offers **USDC** (default) and **XLM** | USDC keeps prices stable; XLM needs no trustline. The contract can't tell a SAC from any other contract, so without the allowlist a listing could point `buy` at an arbitrary `transfer` |
| Who holds the money | **Nobody.** `buy` transfers directly from buyer to each recipient | No custody, no payout system, no withdrawal bugs |
| Split | **Creator 85% / parent creator 5% / treasury 10%**. With no parent, the 5% goes to the creator (90%) | Simple, fair to derivatives, sustainable for Doqtri |
| Split values | Basis points stored in contract config, changeable by admin, **never applied retroactively to past sales** | Lets us tune fees without redeploying |
| Royalty depth | **One level** (direct parent only) | See below |
| Free templates | Listed on-chain with `price = 0` (authorship proof), but **used off-chain**: `claim` copies them without a `buy`, and uses are counted in Supabase. `buy` still accepts `price = 0` | A wallet prompt and a network fee for every free use is too much friction, and on mainnet each one would count against the Channels cap |
| Tips | Optional `tip(template_id, amount)`, 100% to the creator | Phase 1 of the rollout, and stays available afterwards |
| Where template content lives | Supabase, locked behind an on-chain purchase check | The chain stores proofs, not documents (same as the registry) |
| How passkey users pay network fees | **Same as registry writes**: wrapped in the FeeForwarder and sent by `/api/chain/relay` where a forwarder is deployed (testnet only today), otherwise sponsored through Channels | One fee path for every passkey write; see "Before mainnet" |
| Contract setup | **`__constructor`**, not `init` | Config is set in the deploy transaction, so nobody can front-run `init` |
| Upgrades | **None.** No `upgrade` function | An upgradeable contract gives the admin key full power, which breaks "the admin can never move funds". A fix ships as a new contract |
| Editing a listed template | **Not possible.** A new version is a new listing whose `parent` is the old one | No `update_hash`, no version tracking. The creator receives the parent cut too, so nothing is lost. Earlier buyers don't get the new version free |
| Minimum price | **Enforced by the API, per token** (e.g. 0.50 USDC). The contract only rejects negative prices | Thresholds can change without a redeploy |
| Derivatives of starter templates | **Royalty-free.** Starters aren't on-chain listings, so they can't be a `parent` | No code needed |
| How sales reach Supabase | **Write-through, re-verified by transaction hash**, like `chain_writes`. No event indexer | Doqtri doesn't run one (see "Events") |

### Why only one level

Paying every ancestor ("earn from everyone below you") gets complex, makes
prices hard to understand, and looks like a referral scheme to users and
regulators. One level rewards the original idea and keeps each sale readable:
"you pay 3 USDC: 2.55 to Ana, 0.15 to Ben (original author), 0.30 to Doqtri".

## User flows

### Publish

1. In a note's menu: **Publish as template**.
2. The form asks for: title, category (existing `TemplateCategory` from
   `lib/templates.ts`), short description, price and token (or Free), and a
   cover image (optional). The default cover is the mindmap, rendered with the
   existing PNG export (`components/vault/mindmap-paint.ts`, used by the
   studio) and uploaded to a new public storage bucket. The only bucket today
   is the private `uploads` bucket.
3. If the note was created from a marketplace template, the form shows
   "Derived from *X* by @ana — Ana earns 5% of each sale". The creator cannot
   remove this.
4. `POST /api/market/publish` freezes the note's markdown into a template
   snapshot, assigns the `template_id`, and returns its hash: `sha256Hex` from
   `lib/stellar/hash.ts`, the same function notes are anchored with. The client
   sends `list_template` with that id and hash. That's one wallet prompt: a
   Freighter signature, or a passkey approval sent through the relay.
5. The API confirms the on-chain listing matches the snapshot (see "Security"),
   then the template appears in the gallery under **Community**.

### Browse and preview

- The gallery is `TemplatesDialog` (`components/vault/templates-dialog.tsx`).
  Today it filters the static `TEMPLATES` array by category. It gets tabs:
  **Starter** (the current 14) and **Community** (fetched from Supabase).
- Each card shows: mindmap preview, title, creator, price, sales count,
  "Derived from" badge, and an **On-chain** link to the listing
  (`expertContractUrl` in `lib/stellar/config.ts`).
- Preview shows the mindmap and the headings only. Paragraph text stays hidden
  until purchase. Free templates show everything.
- Sort by: popular (sales), newest, price. Filter by category, free/paid.

### Buy and use

1. **Use template** on a paid card opens a confirm sheet with the split:
   price, who gets what, network fee estimate, and the buyer's balance in the
   listing's token. The existing checks only cover XLM:
   `xlmBalanceStroops` (`lib/stellar/wallet-balance.ts`) and the Freighter
   `preflight` fee check (`lib/stellar/contract-client.ts`). Both need to handle
   any token and check price plus fee.
2. If the balance or trustline is missing, the sheet says so before any wallet
   prompt. For XLM on testnet: passkey wallets use the existing
   `/api/chain/topup` (Friendbot, refused above 100 XLM), and Freighter users use
   Friendbot from the account menu. For testnet USDC, nothing exists yet, so the
   sheet links to an external faucet.
3. The buyer signs `buy`. Freighter users submit directly. Passkey users go
   through `/api/chain/relay`, wrapped in the FeeForwarder as in 003.
4. `POST /api/market/claim` verifies the purchase on-chain (`has_purchased`),
   then inserts a copy of the template into the buyer's `documents`, server-side
   and with the service role. It reuses the title de-duplication from
   `app/api/notes/route.ts` and sets `source_template_id` so a later re-publish
   links the parent. It can't go through `POST /api/notes`, because that takes
   the body from the browser and paid bodies never reach the browser before the
   check.
5. Already purchased → **Use again** creates another copy for free.

### Creator dashboard (`/vault/earnings`)

- Per template: sales, total earned, current price, derived templates and
  what they have earned you.
- Each sale links to its transaction on Stellar Expert (`expertTxUrl`).
- Actions: change price, delist, relist.

### Report a copy

- **Report** on any community template. The reporter picks the original.
- The admin page (`/admin/reports`) works like `/admin/promo`: gated by
  `isAdmin` (`DOQTRI_ADMINS`). It compares hashes and section similarity, plus
  the on-chain publish times. The earlier listing wins; the copy is hidden from
  the gallery (`hidden` flag in Supabase). The contract listing stays; the
  chain is not censored, only our UI.

## Contract: `TemplateMarket`

Same conventions as `DoqtriRegistry` (`contract/src/lib.rs`): `soroban-sdk 22`,
a `contracterror` enum, persistent storage, and the same TTL constants
(`TTL_THRESHOLD` 30 days → `TTL_EXTEND` 90 days, extended on every write).
New crate `doqtri-market` in `market/`, added to the root `Cargo.toml`
workspace. The FeeForwarder stays in its own workspace on soroban-sdk 25 and
needs no changes, since it forwards to any target.

### Types

```rust
pub struct Config {
    pub admin: Address,
    pub treasury: Address,
    pub creator_bps: u32,   // 8500
    pub parent_bps: u32,    //  500
    pub treasury_bps: u32,  // 1000   (sum must be 10000)
    pub paused: bool,
}

pub struct Template {
    pub creator: Address,
    pub content_hash: BytesN<32>,
    pub token: Address,          // Stellar Asset Contract (USDC or XLM)
    pub price: i128,             // in the token's smallest unit (7 decimals)
    pub parent: Option<String>,  // parent template_id
    pub parent_creator: Option<Address>, // copied at listing; `buy` never reads the parent
    pub listed: bool,
    pub sales: u32,
    pub earned: i128,            // total paid to the creator from sales
    pub tips: i128,
    pub created_at: u64,
    pub updated_at: u64,
}

pub enum DataKey {
    Config,                         // instance storage
    Token(Address),                 // instance storage: allowlisted token
    Template(String),               // template_id
    Purchase(String, Address),      // (template_id, buyer) -> u64 timestamp
}
```

### Functions

| Function | Auth | Description |
|---|---|---|
| `__constructor(admin, treasury, creator_bps, parent_bps, treasury_bps)` | — (at deploy) | Store config; fails if bps don't sum to 10000 |
| `list_template(creator, template_id, content_hash, token, price, parent)` | creator | New listing. Fails if the id exists, the price is negative, the token isn't allowed, or the parent doesn't exist |
| `update_price(template_id, price)` | creator | Change the price; earlier sales unaffected |
| `set_listed(template_id, listed)` | creator | Delist / relist. Delisted templates can't be bought |
| `buy(buyer, template_id, max_price)` | buyer | Pay and record the purchase (split below). `max_price` protects the buyer if the creator raises the price after the confirm sheet |
| `tip(from, template_id, amount)` | from | Send `amount` of the listing's token straight to the creator |
| `has_purchased(template_id, buyer) -> bool` | none | Read |
| `get_template(template_id) -> Template` | none | Read |
| `get_config() -> Config` | none | Read |
| `is_token_allowed(token) -> bool` | none | Read |
| `set_fees(creator_bps, parent_bps, treasury_bps)` | admin | Change the split for future sales |
| `set_treasury(treasury)` | admin | Change the treasury address |
| `set_paused(paused)` | admin | Stop listing, buying and tipping in an emergency; reads still work |
| `set_token(token, allowed)` | admin | Allow or disallow a token for new listings, sales and tips |

### `buy` split

```text
treasury_cut = price * treasury_bps / 10000
parent_cut   = parent exists ? price * parent_bps / 10000 : 0
creator_cut  = price - treasury_cut - parent_cut      // rounding remainder goes to the creator

token.transfer(buyer, creator,         creator_cut)
token.transfer(buyer, parent.creator,  parent_cut)    // skipped if 0
token.transfer(buyer, treasury,        treasury_cut)  // skipped if 0
```

Rules:
- A buyer can't buy their own template (`SelfPurchase`), and buying twice
  fails (`AlreadyPurchased`).
- If the parent creator is the creator themselves, the parent cut goes to the
  creator in a single transfer (same money).
- If the buyer is the parent creator, their own parent cut isn't transferred:
  they keep it.
- If the parent template was delisted, the parent creator is still paid. They
  wrote the original.
- `price = 0`: no transfers, purchase recorded, `sales` incremented.
- A token removed from the allowlist blocks sales and tips of listings that use
  it (`TokenNotAllowed`).
- `tip` with `amount <= 0` fails (`InvalidAmount`); tipping yourself fails
  (`SelfPurchase`).

Each `token.transfer` needs the buyer's authorization, so a `buy` (and a `tip`)
signed by a wallet has nested auth: `buy → transfer ×n`. The relay must accept
that shape (see "App changes").

### Errors

```rust
TemplateExists = 1, TemplateNotFound = 2, ParentNotFound = 3, NotListed = 4,
AlreadyPurchased = 5, SelfPurchase = 6, PriceTooHigh = 7, InvalidPrice = 8,
InvalidFees = 9, Paused = 10, TokenNotAllowed = 11, InvalidAmount = 12
```

### Events

`listed(template_id, creator, price, token, parent)`,
`price(template_id, price)`, `listing(template_id, listed)`, `sold(template_id,
buyer, price, creator_cut, parent_cut, treasury_cut)`, `tip(template_id, from, amount)`.
Topics follow the registry's shape (`(symbol_short!("doqtri"), symbol_short!("register"))`):
`("market", "<event>")`.

Doqtri runs **no event indexer**. `/api/chain/indexer` only answers
smart-account-kit's passkey-to-wallet lookup from Supabase, and it exists so we
don't have to run one. Sales reach Supabase the same way registry writes reach
`chain_writes`: whoever submits the transaction records its hash (the relay
route for passkey users; `claim` for Freighter users, who send their tx hash),
and every row is re-verified against the ledger by hash when it is read. The
chain stays the source of truth: `sales` and `earned` in Supabase are a cache
of `get_template`, which the dashboard can re-read.

## App changes

### What exists today

- **Relay** (`app/api/chain/relay/route.ts`): picks a handler by call target.
  `CONTRACT_ID` → a sponsored registry write. `FEE_FORWARDER` → `relayPaidWrite`,
  which assumes the forwarded target is the registry. Anything else → a wallet
  admin call. Writes are logged in `chain_writes`; `fn` is limited by CHECK to
  the 3 registry functions, and `document_id` is a required foreign key to
  `documents`. Rate limits come from `consume_chain_quota` over `chain_usage`,
  whose `kind` is limited by CHECK to `deploy | write`.
- **Relay validation** (`lib/stellar/relay-validation.ts`): `validateForwardedWrite`
  accepts only the registry as the forwarded target, exactly 2 sub-invocations
  (`approve`, the registry call) and no nested auth. `buy` and `tip` break all
  three rules.
- **FeeForwarder**: deployed on testnet only (`FORWARDERS` in
  `lib/stellar/smart-wallet-config.ts`). On mainnet, passkey writes are
  sponsored through Channels. User fees are capped at `MAX_USER_FEE_STROOPS`
  (0.5 XLM).
- **Config** (`lib/stellar/config.ts`): every `NEXT_PUBLIC_*` var must be read
  literally (Next.js inlining), and `CONTRACT_ID` refuses a testnet fallback on
  mainnet.
- **CI** (`.github/workflows/ci.yml`): runs `cargo test -p doqtri-registry` and
  builds `contract/` only.
- **Notes** are rows in `public.documents` (`id`, `user_id`, `title`,
  `markdown`). There is no `notes` table.

### Changes

| Area | Change |
|---|---|
| `market/` (new crate) | `TemplateMarket` contract + tests; added to the root workspace |
| `.github/workflows/ci.yml` | Add `cargo test -p doqtri-market`, build the market wasm and upload it as an artifact |
| `lib/stellar/config.ts` | `NEXT_PUBLIC_MARKET_CONTRACT_ID` (read literally, same mainnet guard as `CONTRACT_ID`) and the USDC SAC id per network |
| `lib/stellar/market-client.ts` | Build `list_template`, `update_price`, `set_listed`, `buy`, `tip`, and the reads. Same split as `contract-client.ts`: Freighter signs and sends with `preflight`, smart wallets go through the relay |
| `lib/stellar/relay-validation.ts` | New `validateMarketCall` (exact argument shapes; the wallet must be the `creator`/`buyer`/`from`) and a forwarded variant whose approval tree is `forward → {approve, <market fn> → transfer ×n}`, with every transfer from the wallet and to the recipients the contract will pay |
| `app/api/chain/relay/route.ts` | Dispatch market calls: sponsored where there's no forwarder; for `FEE_FORWARDER`, branch on the inner `target_contract`. Log to a market table instead of `chain_writes` |
| `MAX_USER_FEE_STROOPS` | Re-measure: `buy` with 3 transfers and nested auth costs more than a registry write and may exceed 0.5 XLM |
| `lib/stellar/wallet-balance.ts` | Read any SAC token's balance, not just `NATIVE_XLM` |
| `lib/templates.ts`, `components/vault/templates-dialog.tsx` | Starter + Community tabs; community cards load async |
| `app/api/market/*` | `publish` (snapshot, id, hash, on-chain match), `claim` (verify on-chain, insert into `documents`), `report` |
| `app/vault/earnings` | Creator dashboard |
| `components/vault/…` | Publish form, confirm-to-buy sheet, gallery tabs, "Derived from" badge |
| `app/admin/reports`, `components/admin/` | Reports queue, hide/unhide community templates, gated by `isAdmin` |
| Storage | Public bucket for template covers |

### Database (`doqtri/backend/migrations/`)

Migration files are named `YYYYMMDDHHMMSS_<name>.sql`.

```sql
-- 20261013000000_create_market.sql
market_templates (
  id text primary key,              -- same as on-chain template_id
  network text not null check (network in ('testnet', 'mainnet')),
  creator_id uuid references auth.users,
  creator_wallet text not null,     -- G... (wallet_accounts) or C... (smart_wallets)
  note_id uuid references public.documents(id) on delete set null,
  title text, category text, description text,
  body text not null,               -- the frozen snapshot
  content_hash text not null,       -- must equal the on-chain hash
  token text not null, price numeric not null,
  parent_id text references market_templates(id),
  sales int default 0, earned numeric default 0,  -- cache of get_template
  listed boolean default true, hidden boolean default false,
  created_at timestamptz default now()
);

market_purchases (template_id text, buyer_wallet text, tx_hash text,
                  amount numeric, created_at timestamptz,
                  primary key (template_id, buyer_wallet));

market_reports (id uuid primary key, template_id text, original_id text,
                reporter_id uuid, reason text, status text, created_at timestamptz);

-- documents: add source_template_id text (set when a note is created from a template)
-- chain_usage: widen the kind check to allow 'publish' (and 'market' if buys are rate-limited)
```

RLS: anyone can read listed, non-hidden templates **without `body`** (served
through a view); `body` is returned only by `/api/market/claim` after the
on-chain check. Only the creator can update their own rows' price/listing (and
the API re-checks the chain).

## Security and abuse

- **The chain decides, not the client.** `claim` never trusts the browser:
  it calls `has_purchased` (or reads the `sold` event by tx hash) before
  returning content.
- **Hash check on publish.** The API rejects a listing whose on-chain
  `content_hash` doesn't match the stored snapshot. The API also assigns the
  `template_id`, so ids listed directly on the contract never show up in the
  gallery.
- **Relay spending.** The relay pays network fees up front, so market calls are
  whitelisted as exactly as registry calls are: only `MARKET_CONTRACT_ID`, only
  its write functions, only the caller's own wallet, and only transfers the
  contract will make.
- **Price changes mid-purchase.** `max_price` makes `buy` fail rather than
  charge more than the buyer saw.
- **Spam listings.** Rate-limit `publish` per account through
  `consume_chain_quota` (new `publish` kind, configured like the
  `CHAIN_WRITES_*_DAILY` env vars). Email accounts are already confirmed by
  link (`/auth/confirm`); wallet accounts sign a challenge.
- **Stolen templates.** Report flow + earliest on-chain publish wins.
- **Admin key.** It can only change future fees, the treasury address and the
  pause flag. It can never move user funds or edit a listing.

## Rollout

| Phase | Network | Scope |
|---|---|---|
| 1. Tips ✅ | Testnet | "Tip the creator" on free community templates; publish as free template; gallery Community tab |
| 2. Paid templates ✅ | Testnet | `TemplateMarket` contract, buy flow, claim check, creator dashboard; run with the user testers |
| 3. Derivatives ✅ | Testnet | Parent royalties, "Derived from" badges, reports queue |
| 4. Mainnet (prepared) | Mainnet | USDC prices, creator terms, fee estimates before every write (roadmap item) |

## Before mainnet

- [ ] Creator terms: content ownership, what Doqtri may remove, the 10% fee
- [ ] Tax note for creators (earnings are their responsibility)
- [ ] Contract review / audit of `TemplateMarket`
- [ ] Treasury as a multisig account
- [ ] USDC trustline guidance for new wallets, and a trustline check for `G...`
      creators who list in USDC (they can't receive it otherwise)
- [ ] Passkey fees on mainnet: deploy the FeeForwarder there, or accept that
      Channels sponsors market calls (and count them against its daily cap)

## Tests

**Contract (`cargo test -p doqtri-market`)**
- [x] Split adds up to the price exactly, including rounding (prices like 1 and 3 stroops)
- [x] With parent: three transfers; without parent: creator gets creator + parent share
- [x] Free template: no transfers, purchase recorded
- [x] `AlreadyPurchased`, `SelfPurchase`, `NotListed`, `PriceTooHigh`, `Paused`
- [x] `ParentNotFound` on listing; delisted parent still paid on sale
- [x] Only the creator can update price/listing; only admin can change fees
- [x] Changing fees doesn't change already-recorded `earned`
- [x] Insufficient buyer balance → whole `buy` fails, nothing recorded

**App (Vitest + Playwright)**
- [x] Claim refuses without an on-chain purchase
- [x] Preview never includes paragraph text for paid templates
- [x] Re-publishing a note from a template sets `parent`
- [ ] Passkey user can buy through the relay (needs a browser passkey); [x] Freighter-style `G…` account can buy directly (testnet e2e)
- [x] Confirm sheet blocks the wallet prompt when the balance is too low
- [x] `relay-validation.test.ts`: forwarded `buy` accepted; rejected when a
      transfer goes to an unexpected recipient, the wallet isn't the buyer, or
      the target isn't the market contract
- [x] Forwarded registry writes still pass unchanged

## Open questions

All three resolved 2026-10-13; see the Decisions table (minimum price, editing
a listed template, derivatives of starter templates).

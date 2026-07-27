<p align="center">
  <img src="doqtri/image/doqtri-logo.png" alt="Doqtri" width="120" height="120" />
</p>

<h1 align="center">Doqtri</h1>

<p align="center">
  <strong>Living documents → executable mindmaps → on-chain proof</strong>
</p>

<p align="center">
  Compile plans into mindmaps, track Planned → Verified build status, and anchor
  every version hash on <a href="https://stellar.org">Stellar</a> so “planned vs shipped” is ledger-true.
</p>

<p align="center">
  <a href="https://lab.stellar.org/r/testnet/contract/CCB5DFZRFFDCIBV5H5KWO6UCVN4ZXIPUSXONMBA6HVF433SPO7YEWMSB"><img src="https://img.shields.io/badge/Stellar-Testnet_Contract-7D00FF?style=for-the-badge&logo=stellar&logoColor=white" alt="Stellar testnet" /></a>
  <a href="#license"><img src="https://img.shields.io/badge/License-MIT-1FA971?style=for-the-badge" alt="MIT" /></a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Rust-000000?style=flat-square&logo=rust&logoColor=white" alt="Rust" />
  <img src="https://img.shields.io/badge/Soroban-7D00FF?style=flat-square&logo=stellar&logoColor=white" alt="Soroban" />
  <img src="https://img.shields.io/badge/Next.js-000000?style=flat-square&logo=nextdotjs&logoColor=white" alt="Next.js" />
  <img src="https://img.shields.io/badge/React-20232A?style=flat-square&logo=react&logoColor=61DAFB" alt="React" />
  <img src="https://img.shields.io/badge/TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript" />
  <img src="https://img.shields.io/badge/Freighter-0B0D10?style=flat-square&logo=stellar&logoColor=white" alt="Freighter" />
</p>

---

## Problem

Teams plan in living documents — Google Docs, Notion, markdown vaults — then
ship work in n8n, Make, Retool, Langflow, and scattered repos.

That creates a trust gap:

- **Plans and reality diverge.** The doc says “done”; the workflow was never built.
- **Progress is unverifiable.** “Shipped” badges live in private app state anyone can edit.
- **No shared receipt.** Stakeholders can’t independently check what version of the plan
  was active, or which mindmap nodes actually went live.
- **Audit trails rot.** Screenshots and status meetings don’t survive handoffs, vendor
  churn, or “we’ll update the doc later.”

In short: **you can’t cryptographically prove planned vs shipped.**

## Solution

**Doqtri** is Obsidian for executable plans — with Stellar as the proof layer.

| Layer | What it does |
| --- | --- |
| **Vault + editor** | Write the living plan in markdown; `##` headings compile into a mindmap |
| **Executable mindmap** | Each node tracks lifecycle: Planned → Building → Built → Verified |
| **Ship panel** | Attach the builder (n8n / Make / Retool / Langflow) and artifact ref |
| **DoqtriRegistry (Soroban)** | Anchor SHA-256 doc hashes + node status on Stellar with owner auth |
| **Public audit** | Anyone opens `/d/[docId]` and reads the ledger — not your database |

**Result:** every semantic change bumps an on-chain version; every shipped node
leaves a receipt. Planned vs shipped stops being a slide and becomes a fact.

## Vision

Most roadmaps live in docs. Most “shipped” badges live in app state. Those two
worlds drift apart.

**Doqtri** closes the gap:

1. Watch a living source (Docs, Notion, markdown).
2. Compile it into a typed, executable mindmap.
3. When a node is scaffolded into n8n / Make / Retool / Langflow, record build status.
4. Anchor document content hashes and node lifecycle on Stellar Soroban so
   anyone can verify progress from the ledger — not a private database.

> Planned vs shipped becomes a receipt, not a marketing claim.

---

## Features

### On-chain registry (`contract/`)

- **Document versions** — SHA-256 content hash per `doc_id`, version increments on every semantic update
- **Node build status** — `Planned → Building → Built → Verified` with tool name + artifact ref
- **Owner auth** — every write requires `require_auth()` on the document owner
- **Persistent storage + TTL** — 30-day threshold, extend to 90 days on write
- **Events** — `(doqtri, register|update|node)` with **`doc_id` payload**

### App (`doqtri/frontend` + `doqtri/backend`)

- Obsidian-style **vault**: markdown notes, wikilinks, global graph + per-doc mindmap
- Supabase Auth (email/password) + RLS on `documents`
- **Ingest** / **regenerate** via OpenAI (`/api/ingest`, `/api/regenerate`)
- Private Storage bucket for uploads (`doqtri/backend/migrations/`)
- Deploy target: Vercel Root Directory = `doqtri/frontend`

### Legacy / chain (`web/`, `contract/`)

- `web/` — previous Freighter + Soroban UI (kept for reference, not primary)
- `contract/` — DoqtriRegistry on Stellar testnet (still built in CI)

---

## Deployed contract (Stellar Testnet)

| Field | Value |
| --- | --- |
| **Network** | Stellar Testnet |
| **Contract ID** | [`CCB5DFZRFFDCIBV5H5KWO6UCVN4ZXIPUSXONMBA6HVF433SPO7YEWMSB`](https://lab.stellar.org/r/testnet/contract/CCB5DFZRFFDCIBV5H5KWO6UCVN4ZXIPUSXONMBA6HVF433SPO7YEWMSB) |
| **CLI alias** | `doqtri` |
| **WASM hash** | `ef0124a4a22b60ba1f4e0e41823d31b175d90d38b1ba034970e58e0cf4e0e252` |

**Explorer links**

- [Open in Stellar Lab](https://lab.stellar.org/r/testnet/contract/CCB5DFZRFFDCIBV5H5KWO6UCVN4ZXIPUSXONMBA6HVF433SPO7YEWMSB)
- [Deploy transaction (Expert)](https://stellar.expert/explorer/testnet/tx/8b65276712032e15a2094b75c0818c5b87556b91782b9612ffad8836084d916a)
- [WASM upload transaction (Expert)](https://stellar.expert/explorer/testnet/tx/5da4263b7e01b3c5be44b093bc6105aec07f20e4157b5231516c980dd4933cbd)

### User testing — 20 users · 60 transactions

Product test on Stellar **testnet** against
[`CCB5DFZRFFDCIBV5H5KWO6UCVN4ZXIPUSXONMBA6HVF433SPO7YEWMSB`](https://lab.stellar.org/r/testnet/contract/CCB5DFZRFFDCIBV5H5KWO6UCVN4ZXIPUSXONMBA6HVF433SPO7YEWMSB).
Each tester registered a plan, updated its content hash, then synced mindmap node `ship` → Built.
Every wallet and transaction link opens on Stellar Expert for inspection.

#### Users

| # | User | Wallet | Plan | Register tx | Update tx | Node sync tx |
| -: | --- | --- | --- | --- | --- | --- |
| 1 | Juan dela Cruz | [View wallet](https://stellar.expert/explorer/testnet/account/GDKM7G5VBSYXCDA4FOTUKX3JHEZDRBRMZYFAB4HQDNKGER527DLMFAID) | `juan-dela-cruz-plan` | [Register](https://stellar.expert/explorer/testnet/tx/76660ff1c3171b23de30ec39272565d970f9307b13714249d23accf7f3e8f918) | [Update](https://stellar.expert/explorer/testnet/tx/f5b89e6fe0e6c04e4ea2e9d5d7c9e22f02c0e3cf7f73ebb4cb59381009ec633a) | [Node sync](https://stellar.expert/explorer/testnet/tx/f07ed7ba2324a68d7bf3814adf629e2397a414cce1a94c5892ee5617da6bb8cc) |
| 2 | Maria Santos | [View wallet](https://stellar.expert/explorer/testnet/account/GBYLDXL5USFYWEZ7H2QDMDZUVUUWGM5WNRYTZCDSF2UU4HBSFAZCE247) | `maria-santos-plan` | [Register](https://stellar.expert/explorer/testnet/tx/0f73e33db5ceb47ba61eec9548b07758990cd3506af1daacf9a77764c65387b0) | [Update](https://stellar.expert/explorer/testnet/tx/ee4052921ac2a24ae0292a6b566070097a0d43f2a3961b922bd7bf0c29a6439f) | [Node sync](https://stellar.expert/explorer/testnet/tx/962d4ef62d9bbe0dbaeb122a4b285dfceab1501a3799a662c94d85bfc8671c4a) |
| 3 | Andres Reyes | [View wallet](https://stellar.expert/explorer/testnet/account/GBCQOZZWFF4E6GMSVBJLUTCKCDCAQMXB55F2QMC4EI5YTEPZJZCG4MRM) | `andres-reyes-plan` | [Register](https://stellar.expert/explorer/testnet/tx/fcbf67026d79c39071c4e0c07c51886f23f5acf48b3c534a826305bafe384e24) | [Update](https://stellar.expert/explorer/testnet/tx/6324c5363f1430b8ccc1ed5a431bc33af080502ef6cb4b72265c06aa18accbb3) | [Node sync](https://stellar.expert/explorer/testnet/tx/24eace29bda7e695c01e37ea2aaeb73915934b63f7ad0d96afb537c4970a93fe) |
| 4 | Ana Villanueva | [View wallet](https://stellar.expert/explorer/testnet/account/GB4FD7FMPXV42ZH5KR2PWOSLCAWDOKHWAPIUW3JN2MYK4KAUVDBHRW2C) | `ana-villanueva-plan` | [Register](https://stellar.expert/explorer/testnet/tx/b9a4d647c44686cc3d1570d2332c82b99db90b664b67c418b832ec066a0c9662) | [Update](https://stellar.expert/explorer/testnet/tx/7d33933e7edb1066f9ee5059a63dc2f2c45bf75d8a0da975ea5aac9bf394867e) | [Node sync](https://stellar.expert/explorer/testnet/tx/80410c9e044e5b93eeefe718bf01d3d28c47db120f62cd9fada8ec9ed0d6e235) |
| 5 | Carlo Mendoza | [View wallet](https://stellar.expert/explorer/testnet/account/GAXM35JCHI5X73TGML2DHGL6EUVSPPD5N5ODZEJVEBKXOCTC3O6UKLEI) | `carlo-mendoza-plan` | [Register](https://stellar.expert/explorer/testnet/tx/86ecab829a23c44a4462e0970b4af6e232828713421c9dd85f658fbd993002d7) | [Update](https://stellar.expert/explorer/testnet/tx/ac5723cc370a92bd86c5e8c9da151b8f3e28e1d2b18c61229074a4241085bc37) | [Node sync](https://stellar.expert/explorer/testnet/tx/0a3cb486c3f9dee2637efc6d50dae55b43439306a22388b945b25a40e1f1db92) |
| 6 | Rosa Garcia | [View wallet](https://stellar.expert/explorer/testnet/account/GAPBM3DIGTU6NO3REL4V5RHT2HMYWDTQT3XMQ2ONUX6BE5DADFDLVLTI) | `rosa-garcia-plan` | [Register](https://stellar.expert/explorer/testnet/tx/7c9ffd7849595a72a6308d1eed85cd41f9b9159c685ba4c8ec5db29f616374d1) | [Update](https://stellar.expert/explorer/testnet/tx/0d2d27122bd97db0cecd133bc3394204f46d8ba06f3d13ec5a892f8e4a97e1a2) | [Node sync](https://stellar.expert/explorer/testnet/tx/66e4513cc5573bf74479f700d01213f4018a1af144b33d3881d29705f83ba27c) |
| 7 | Miguel Ramos | [View wallet](https://stellar.expert/explorer/testnet/account/GAYOREX22YE6TDZLR4MZ42K25CDHOAYS62OOLVJX25MBBI4HOBTVAC42) | `miguel-ramos-plan` | [Register](https://stellar.expert/explorer/testnet/tx/8c758727c27a18eb3d213f13e9d83c790664d485373d6a69c25735dc8ebee6e0) | [Update](https://stellar.expert/explorer/testnet/tx/b28f4192906308c83a1a53996f0f80e3c4ad4a6289bb707e0cf1c8a4c3c8da09) | [Node sync](https://stellar.expert/explorer/testnet/tx/84ba314f2e7f4297ba1c3d58b91f3bfcdc1fbb72a5fb7b25a4bce2ba8541c418) |
| 8 | Liza Fernandez | [View wallet](https://stellar.expert/explorer/testnet/account/GBRHL7U7TT3CL7QFOHUHQHZCYF5FCNGII2NKQ3EOYIIPPB2MNBZU55QB) | `liza-fernandez-plan` | [Register](https://stellar.expert/explorer/testnet/tx/3bcc5653035861446b19ea90f7efbd5e181cb0d6023c3fb96ced02a8f2e1821b) | [Update](https://stellar.expert/explorer/testnet/tx/50f682a413bce78029fb73f31b76e3e7daf3ae09b97a78a146da57f014cbdcf0) | [Node sync](https://stellar.expert/explorer/testnet/tx/efed7a91f34b160bb9b9143b54103f9607acba5580ad8cfd0b349770b73aa2e9) |
| 9 | Paolo Cruz | [View wallet](https://stellar.expert/explorer/testnet/account/GDP75NPLNTJNC5DUKL6HSQVKEFLU4SBUSQ3ZEI2Q2R7QIJ6PBP23GFIR) | `paolo-cruz-plan` | [Register](https://stellar.expert/explorer/testnet/tx/af3473ea649d1b43288f3b357c275cde604dac6bf164cc0e8e53eb32354e793d) | [Update](https://stellar.expert/explorer/testnet/tx/18f09011dbd4713073c3845d712cd42d600df69806a24077d33e9bf63f72f48d) | [Node sync](https://stellar.expert/explorer/testnet/tx/349b4829a7c90212bd939d4dc7af7e9481262834e1313528ae48cccca2c0b603) |
| 10 | Sofia Navarro | [View wallet](https://stellar.expert/explorer/testnet/account/GCE64EOGRJ4XIQGXEZU4ZBM32STWB6ZSIRIFUTCXWYEFZZVNRTBRB47L) | `sofia-navarro-plan` | [Register](https://stellar.expert/explorer/testnet/tx/c4859cc4a5a199068fb40947944532456f9a8582ea3c915efea40eab13c9a095) | [Update](https://stellar.expert/explorer/testnet/tx/ea977b04c6fb6f4eecdf57be1af1c4c8f6f80f7261d6dae5523bc32468fd5451) | [Node sync](https://stellar.expert/explorer/testnet/tx/8d102e7e8814092f536c7823430c4cdab97052b5154b70aa73a211ebb2344d0d) |
| 11 | Diego Lopez | [View wallet](https://stellar.expert/explorer/testnet/account/GBAWLUDHRAGO6WMM5POOG5XEFCODIV37L3IB7GBHYN7EMUFXMPBRYTLY) | `diego-lopez-plan` | [Register](https://stellar.expert/explorer/testnet/tx/73354fce4899429b63a5852540888d010f9286c754b7ce8e444e4c146bd11796) | [Update](https://stellar.expert/explorer/testnet/tx/a553c63c107aee77690dfadd86b37239bd98ad3d230f916491edff84083e31af) | [Node sync](https://stellar.expert/explorer/testnet/tx/84fb4f66703c7167fe4e7cfbe30c780f9310224b7cecc3a4f5f9bdf6f7a92b21) |
| 12 | Carmen Bautista | [View wallet](https://stellar.expert/explorer/testnet/account/GAR6JXETC4J67PCF5U45Y2YKO4KOINXA6R7FX5R4MNTKDV5APPHN4QFA) | `carmen-bautista-plan` | [Register](https://stellar.expert/explorer/testnet/tx/35cf4a276e5f1f32aadf0c8ba5c09f62740c83ed5d8f04c10cb0145b2a04a0b2) | [Update](https://stellar.expert/explorer/testnet/tx/714a2d89714eff9b6da426055e2af286c9bdfcbdacd5c91cbe1d5ebd2b11eb14) | [Node sync](https://stellar.expert/explorer/testnet/tx/38cbab0119fb118ebee487b0dc05112478f9d2c68fcc0583c232f5ae05ae6264) |
| 13 | Rafael Torres | [View wallet](https://stellar.expert/explorer/testnet/account/GDSO6A75G22MM3TSMQH3VZOCP7IYIZKEN6YKT75NFZXX5YN4R3O5C6ST) | `rafael-torres-plan` | [Register](https://stellar.expert/explorer/testnet/tx/f1d731f233ec29f2d45d4e81f6809463677fa1ccfbb9bab0908383eaf11efe1c) | [Update](https://stellar.expert/explorer/testnet/tx/fc7a95dc0a6cd11fb21f7e22710c410c93cce3caf37d820dc34dded76356e022) | [Node sync](https://stellar.expert/explorer/testnet/tx/f88a823f7910faccd80c92dc226cbfdda027c6a10799583e6814009d0285a248) |
| 14 | Isabel Gomez | [View wallet](https://stellar.expert/explorer/testnet/account/GBHRVGSESCJAHILBNEGQQRNHEFSQ6LFOWYNQCRMFKREXQAIDKCALBVIE) | `isabel-gomez-plan` | [Register](https://stellar.expert/explorer/testnet/tx/5f1964669c8f8c229cd77096dcf03d5f73aa7c4318abbafb69aed33269b57fed) | [Update](https://stellar.expert/explorer/testnet/tx/816358b8d4ee628d8010df53f48b6c42c17c24431d8b9d42d3c05a43d2f873e1) | [Node sync](https://stellar.expert/explorer/testnet/tx/d3372fc2d3692d1939badea1faefdaecd12378f2550dcfe5b6961ff6f4a897d5) |
| 15 | Antonio Rivera | [View wallet](https://stellar.expert/explorer/testnet/account/GAQDYI5TPUFH67WKQIDNO77KIUCWEYTNV5UTZDU3M2PWATFAUXHDZE6B) | `antonio-rivera-plan` | [Register](https://stellar.expert/explorer/testnet/tx/f9cd0af103a2e0289f3013167079b61dc927d01cbbd4059cf245f0feb8ca8720) | [Update](https://stellar.expert/explorer/testnet/tx/8ba13e84291389a60d82f79fd14f1e2af78f011ca087eff5c1d5aa8b6a8f541c) | [Node sync](https://stellar.expert/explorer/testnet/tx/be47ca0eae9c435296f6f7a31a2dfbe3ac4a975b2d575c707b9b701571ee1bde) |
| 16 | Patricia Flores | [View wallet](https://stellar.expert/explorer/testnet/account/GBCSIVSOTVGPXKFWFJ3P5IEF7B3IXQRODS7Q67BPBNEJHV2PZRH3T3J5) | `patricia-flores-plan` | [Register](https://stellar.expert/explorer/testnet/tx/a394d5b28c3ca6dd25c44247300695e64c28b5a87cf8a03af099b974dd73d27d) | [Update](https://stellar.expert/explorer/testnet/tx/77d35af4854fa6e5666434618b9ed9b79b74705e43feff3ec8a33328591d6c97) | [Node sync](https://stellar.expert/explorer/testnet/tx/c233b11dbcf26bf858cd86c1f594c0931b291f4c341c849badb0c76d9103c2df) |
| 17 | Gabriel Castro | [View wallet](https://stellar.expert/explorer/testnet/account/GCQCZPZLE6NQQOK7Y6DIVSTAP6N5NZQIB5CDDNGX2TYTWN2E3AUG54WD) | `gabriel-castro-plan` | [Register](https://stellar.expert/explorer/testnet/tx/e5cfb4f893a124bde8fc37a59143ce379295237f774805739bfc5986a1618277) | [Update](https://stellar.expert/explorer/testnet/tx/1c9a79d8e776b819b26f687b43abde0b97329ea0487a0c7b2f3b8e87517f6d0f) | [Node sync](https://stellar.expert/explorer/testnet/tx/b0a99c5c0df51886c25a735175b28ada389f37e720fd06b6dd70f7164c1bea51) |
| 18 | Elena Morales | [View wallet](https://stellar.expert/explorer/testnet/account/GAP522ZNDQ7D5NP47WPIMANCKMLCAUJ7FROUH57ILOBHKVQDS5CWVWAF) | `elena-morales-plan` | [Register](https://stellar.expert/explorer/testnet/tx/858a5eea944601ec4657be97dfdcb0952233f08303a79f7d51b0383753593013) | [Update](https://stellar.expert/explorer/testnet/tx/82be53f36800939657baa160eb886a42d899df22c0fc33ef2c30e3c422457a77) | [Node sync](https://stellar.expert/explorer/testnet/tx/430258c693754364edab6011a33dbc159e150bb17020fc9039f87e0bcf84e4b8) |
| 19 | Francis Aquino | [View wallet](https://stellar.expert/explorer/testnet/account/GDOHGKDU5BGPWNXJ3SIVQUIZQRJBKH54XVUO2WXSRXBPETQU6BL3O5AV) | `francis-aquino-plan` | [Register](https://stellar.expert/explorer/testnet/tx/4a38f6bd560d4b343b3b6095c8e434270ed25442f702a5b19af041db3e34ea02) | [Update](https://stellar.expert/explorer/testnet/tx/23570c2d6d4d7276871eeff62304dc71d637ca1f0086e22f2bb29196b98b9d1c) | [Node sync](https://stellar.expert/explorer/testnet/tx/c07f0062a5136139f6dc4b026dc4546be63304e9fc01a9f8b8a8fab2b0b9eccf) |
| 20 | Bianca Domingo | [View wallet](https://stellar.expert/explorer/testnet/account/GB25SYZ3DUB3LRU2SPTVQ33A45AJ55YPCEBHZTFAQJHTBIO4RLN362VQ) | `bianca-domingo-plan` | [Register](https://stellar.expert/explorer/testnet/tx/4bb03cc7839b6c418c5b002bfc3413c191fd7582dc64784224dd1770f9a1d8e7) | [Update](https://stellar.expert/explorer/testnet/tx/c06a49f6d46964e28d6b9f74d25686780ea6c2cb4d1e866b22493d85132e6d8e) | [Node sync](https://stellar.expert/explorer/testnet/tx/d38fc311441e004a001a5f3783a8690f5d1bdcdbfa3d774a88a8e09db1b57d4f) |

---
## Stellar wallet integration (testnet)

End-to-end wallet flow on **Stellar Testnet**, verified on-chain.

### 1. Wallet setup

Freighter installed and switched to **Stellar Testnet**, account funded from
Friendbot with **10,000 XLM**.

<img src="docs/wallet/01-freighter-testnet.png" alt="Freighter on Stellar Testnet funded with 10,000 XLM" width="360" />

| Field | Value |
| --- | --- |
| Network | Stellar Testnet |
| Account | [`GB7KVJMPJDVI6NTRNENAMFGYQAZVRI266B4BZ4UMN2RA2NBHFOB6ZC5D`](https://stellar.expert/explorer/testnet/account/GB7KVJMPJDVI6NTRNENAMFGYQAZVRI266B4BZ4UMN2RA2NBHFOB6ZC5D) |
| Created | 2026-07-27 11:03:17 UTC |
| Initial balance | 10,000 XLM |

### 2. Wallet connection

Connect and disconnect are implemented in the app via
[Stellar Wallets Kit](https://stellarwalletskit.dev/) pinned to `Networks.TESTNET`
(Freighter plus the other default modules).

![Doqtri landing page with Connect wallet](docs/wallet/02-connect-wallet.png)

| Behavior | Code |
| --- | --- |
| **Connect** — opens the wallet modal, returns the public key | `connectWallet()` in `doqtri/frontend/lib/wallet.ts` |
| Session exchange — public key → Supabase session | `doqtri/frontend/app/api/auth/wallet/route.ts` |
| Connect button + redirect to `/vault` | `doqtri/frontend/components/auth/login-form.tsx` |
| **Disconnect** — kit disconnect + Supabase sign-out | `disconnectWallet()` in `lib/wallet.ts`, called from `components/vault/settings-dialog.tsx` |
| Live address changes | `onWalletState()` (kit `STATE_UPDATED` event) |

The kit is imported lazily inside each function because it touches `localStorage`
during module evaluation, which breaks server rendering of client components.

### 3. Balance handling

The connected account's XLM balance, read from testnet Horizon and shown on
Stellar Expert after the transaction below:

![Account balance on Stellar Expert testnet](docs/wallet/03-balance.png)

**Balance after send:** `9,999.9053473 XLM` — 10,000 minus the 2 XLM payment and fees.

> **Status:** the balance is fetched and verified on-chain, but it is not yet
> rendered in the Doqtri UI — there is no balance component in
> `doqtri/frontend/` today. Wiring `@stellar/stellar-sdk` (already a dependency)
> to a Horizon `loadAccount` call and displaying it in the vault header is the
> remaining piece.

### 4. Transaction flow

A 2 XLM payment signed with Freighter on testnet:

![Successful transaction on Stellar Expert testnet](docs/wallet/04-transaction.png)

| Field | Value |
| --- | --- |
| **Status** | ✅ Successful |
| **Transaction hash** | [`38a1ccf5a26e236756c961e2a8e26ecb56856c91fff7f90b8dd0d9b72bedac4e`](https://stellar.expert/explorer/testnet/tx/38a1ccf5a26e236756c961e2a8e26ecb56856c91fff7f90b8dd0d9b72bedac4e) |
| Ledger | 3826447 |
| Processed | 2026-07-27 11:13:09 UTC |
| Amount | 2 XLM |
| From → To | `GB7KVJ…B6ZC5D` → `GCPF…4YUN` |
| Fee charged | 0.00001 XLM |

> **Status:** the payment was built and signed through Freighter on testnet and
> confirmed on-chain. In-app send UI (amount form, pending spinner, success /
> failure state, hash link) is not implemented in `doqtri/frontend/` yet — the
> transaction-feedback pattern described under **Web app** above lives in the
> legacy `web/` frontend.

---

## Tech stack

| Layer | Package | Badge |
| --- | --- | --- |
| Smart contracts | [soroban-sdk](https://crates.io/crates/soroban-sdk) `22` | ![Soroban](https://img.shields.io/badge/soroban--sdk-22-7D00FF?logo=rust&logoColor=white) |
| Contract language | [Rust](https://www.rust-lang.org/) | ![Rust](https://img.shields.io/badge/Rust-stable-black?logo=rust) |
| CLI / deploy | [Stellar CLI](https://developers.stellar.org/docs/tools/cli) | ![Stellar](https://img.shields.io/badge/stellar--cli-25+-7D00FF?logo=stellar&logoColor=white) |
| Frontend | [Next.js](https://nextjs.org/) `15` + [React](https://react.dev/) `19` | ![Next.js](https://img.shields.io/badge/Next.js-15-black?logo=nextdotjs) |
| Language | [TypeScript](https://www.typescriptlang.org/) | ![TS](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white) |
| Chain client | [@stellar/stellar-sdk](https://www.npmjs.com/package/@stellar/stellar-sdk) | ![SDK](https://img.shields.io/badge/stellar--sdk-16-7D00FF?logo=stellar&logoColor=white) |
| Wallet | [@creit.tech/stellar-wallets-kit](https://www.npmjs.com/package/@creit.tech/stellar-wallets-kit) + Freighter | ![Freighter](https://img.shields.io/badge/Freighter-wallet-0B0D10?logo=stellar&logoColor=white) |
| Fonts | Instrument Sans · Outfit · IBM Plex Mono | ![Fonts](https://img.shields.io/badge/fonts-Google_Fonts-4285F4?logo=googlefonts&logoColor=white) |

---

## Repository layout

```text
doqtri/                          # git repo root
├── doqtri/
│   ├── frontend/                # PRIMARY app (Next.js vault + mindmap)
│   └── backend/                 # Supabase migrations + AI prompts
├── contract/                    # Soroban DoqtriRegistry (optional chain layer)
├── web/                         # LEGACY Stellar landing (not deployed)
├── Cargo.toml
├── .github/workflows/
└── README.md
```

See also [`doqtri/README.md`](./doqtri/README.md) and [`doqtri/SPEC.md`](./doqtri/SPEC.md).

---

## Architecture

```text
  Upload / note        doqtri/frontend           Supabase
 ┌──────────┐         ┌────────────────┐       ┌─────────────┐
 │ PDF/DOCX │ ingest  │ vault editor   │──────►│ documents   │
 │ markdown ├────────►│ graph+mindmap  │       │ + Storage   │
 └──────────┘         │ /api/* + AI    │       └─────────────┘
                      └────────────────┘
```

---

## Contract interface

| Function | Auth | Description |
| --- | --- | --- |
| `register_document(owner, doc_id, content_hash)` | owner | Anchor a new document at version `1` |
| `update_document(doc_id, new_hash)` | owner | Anchor a new hash; returns incremented version |
| `set_node_status(doc_id, node_id, status, tool, artifact_ref)` | owner | Record node lifecycle |
| `get_document(doc_id)` | none | Read anchored document state |
| `get_node(doc_id, node_id)` | none | Read a node’s build record |

**Node statuses:** `Planned` · `Building` · `Built` · `Verified`

**Storage keys:** `DataKey::Doc(doc_id)` · `DataKey::Node(doc_id, node_id)`  
**TTL:** threshold 30 days → extend to 90 days on every write (`1 day = 17280` ledgers)

---

## Quick start — app (`doqtri/frontend`)

Prerequisites: Node 20+, Supabase project + OpenAI key.

```bash
cd doqtri/frontend
cp .env.example .env.local   # fill anon key, service_role, OPENAI_API_KEY
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) → `/login` → vault.

```bash
npm test
npm run build
npm run start
```

**Deploy (Vercel):** set Root Directory to `doqtri/frontend`, then add the env vars from `.env.example`.

Backend SQL lives in `doqtri/backend/migrations/` (already applied on the Doqtri Supabase project).

> Legacy Freighter UI: `web/` (not the primary app).

---

## Quick start — contract

Prerequisites:

- Rust stable + `rustup target add wasm32v1-none`
- [Stellar CLI](https://developers.stellar.org/docs/tools/cli)

```bash
# from repo root
cargo test -p doqtri-registry

cd contract
stellar contract build
```

WASM (workspace layout):

`target/wasm32v1-none/release/doqtri_registry.wasm`

### Deploy (testnet)

```bash
# one-time identity
stellar keys generate alice --network testnet --fund

stellar contract deploy \
  --wasm ../target/wasm32v1-none/release/doqtri_registry.wasm \
  --source alice \
  --network testnet \
  --alias doqtri
```

### Invoke (live contract)

```bash
CONTRACT=CCB5DFZRFFDCIBV5H5KWO6UCVN4ZXIPUSXONMBA6HVF433SPO7YEWMSB

stellar contract invoke \
  --id $CONTRACT --source alice --network testnet -- \
  register_document \
  --owner alice \
  --doc_id "doqtri-launch-plan" \
  --content_hash 0101010101010101010101010101010101010101010101010101010101010101

stellar contract invoke \
  --id $CONTRACT --source alice --network testnet -- \
  set_node_status \
  --doc_id "doqtri-launch-plan" \
  --node_id "node-weekly-report" \
  --status '"Built"' \
  --tool "n8n" \
  --artifact_ref "wf_8Xk2p"

stellar contract invoke \
  --id $CONTRACT --source alice --network testnet -- \
  get_document --doc_id "doqtri-launch-plan"
```

---

## CI

GitHub Actions (`.github/workflows/ci.yml`):

1. **Test** — `cargo test -p doqtri-registry`
2. **Build WASM** — install Stellar CLI, `stellar contract build`, upload artifact

---

## Roadmap (near-term)

- [ ] Register / update documents from the web UI (signed Freighter txs)
- [ ] Sync real mindmap nodes from a source document pipeline
- [ ] Mainnet deploy + contract verification
- [ ] Public audit page by `doc_id`

---

## License

MIT — see project root.

<p align="center">
  <img src="web/public/favicon.svg" alt="Doqtri" width="72" height="72" />
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
  <a href="https://lab.stellar.org/r/testnet/contract/CBWQV275C4MXYKRTFGAUD6FUJX2UHOE7D6LSKTTYYQ7ZBPM3KJSAQZWH"><img src="https://img.shields.io/badge/Stellar-Testnet_Contract-7D00FF?style=for-the-badge&logo=stellar&logoColor=white" alt="Stellar testnet" /></a>
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
- **Events** — `(doqtri, register|update|node)` with **`doc_id` payload** (matches web vault sync)

### Web app (`web/`)

- Dark, Zed-inspired landing with sticky interactive mindmap
- Multi-wallet connection via [Stellar Wallets Kit](https://stellarwalletskit.dev/) (Freighter, Albedo, Hana, Lobstr, Rabet, xBull, Klever, OneKey, and Bitget)
- **Vault**: local plans + **sync from chain** (contract events / owner filter)
- Markdown → mindmap with nested `##` / `###` / `####`, drag nodes, layout persisted
- **Tx UX**: pending spinner, Stellar Expert link, clear Freighter / funding / network errors
- **Ship panel**: funded-account check, idempotent register→update, Freighter-signed writes
- **Public audit** at `/d/[docId]` from vault snapshot (not demo-only) + copy audit URL
- Typed contract client from WASM bindings (`web/src/lib/bindings/`)
- Env-only `NEXT_PUBLIC_CONTRACT_ID` in production (see `web/.env.example`)
- CI: `npm ci && npm run build` + Playwright smoke (vault gate, create doc)

---

## Deployed contract (Stellar Testnet)

| Field | Value |
| --- | --- |
| **Network** | Stellar Testnet |
| **Contract ID** | [`CBWQV275C4MXYKRTFGAUD6FUJX2UHOE7D6LSKTTYYQ7ZBPM3KJSAQZWH`](https://lab.stellar.org/r/testnet/contract/CBWQV275C4MXYKRTFGAUD6FUJX2UHOE7D6LSKTTYYQ7ZBPM3KJSAQZWH) |
| **CLI alias** | `doqtri` |
| **WASM hash** | `ef0124a4a22b60ba1f4e0e41823d31b175d90d38b1ba034970e58e0cf4e0e252` |

**Explorer links**

- [Open in Stellar Lab](https://lab.stellar.org/r/testnet/contract/CBWQV275C4MXYKRTFGAUD6FUJX2UHOE7D6LSKTTYYQ7ZBPM3KJSAQZWH)
- [Deploy transaction (Expert)](https://stellar.expert/explorer/testnet/tx/5bdea82068e45bf2da6f84c969e8ce9eafeb892eab852a214b8a420a193098f9)
- [WASM upload transaction (Expert)](https://stellar.expert/explorer/testnet/tx/5da4263b7e01b3c5be44b093bc6105aec07f20e4157b5231516c980dd4933cbd)

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
doqtri/
├── contract/          # Soroban crate: DoqtriRegistry
│   └── src/
│       ├── lib.rs     # contract + storage + events
│       └── test.rs    # unit tests
├── web/               # Next.js App Router frontend
│   └── src/
│       ├── app/       # pages, layout, OG image
│       ├── components/
│       ├── data/      # demo mindmap
│       └── lib/       # WASM bindings + Freighter + vault sync
├── Cargo.toml         # workspace + ed25519-dalek git pin (Soroban host)
├── .github/workflows/ # CI: cargo test + WASM + web build/Playwright
└── README.md
```

---

## Architecture

```text
  Living doc          Doqtri backend           Stellar testnet
 ┌──────────┐        ┌──────────────┐        ┌─────────────────┐
 │ Notion / │  hash  │ mindmap +    │ invoke │ DoqtriRegistry  │
 │ Docs /   ├───────►│ status sync  ├───────►│ versions+nodes  │
 │ markdown │        │              │        └────────┬────────┘
 └──────────┘        └──────────────┘                 │
                                                      │ read
                      ┌──────────────┐                │
                      │ web/ (Next)  │◄───────────────┘
                      │ Freighter    │
                      │ mindmap UI   │
                      └──────────────┘
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

## Quick start — web

Prerequisites: Node 20+ and a supported Stellar wallet (such as [Freighter](https://freighter.app/)).

```bash
cd web
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

- **Connect wallet** → choose a supported Stellar wallet → redirects to **`/vault`**
- Create a plan → write markdown (`##` / `###` headings become nested nodes) → **Register** / **Update hash**
- Select a node → set status/tool/artifact → **Sync to Stellar** (explorer link on success)
- **Copy audit URL** or share **`/d/[docId]`** for public audit

```bash
cp .env.example .env.local   # set NEXT_PUBLIC_CONTRACT_ID
npm run build                # production build
npm run start
npm run test:e2e             # Playwright smoke (after build)
```

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
CONTRACT=CBWQV275C4MXYKRTFGAUD6FUJX2UHOE7D6LSKTTYYQ7ZBPM3KJSAQZWH

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

/**
 * The marketplace end to end on testnet (progress/004): real sign-in, real
 * contract calls, real API routes. Opt-in — it needs a dev server on :3000,
 * three funded testnet keys, and it writes testnet rows to Supabase:
 *
 *   set -a; . ./.env; set +a
 *   MARKET_E2E=1 E2E_CREATOR_SECRET=… E2E_BUYER_SECRET=… E2E_THIRD_SECRET=… \
 *     npx vitest run lib/market.testnet.test.ts
 *
 * E2E_LOG (optional) names a file to append a readable trace to.
 */
import { appendFileSync } from "node:fs";
import { createServerClient } from "@supabase/ssr";
import { Keypair } from "@stellar/stellar-sdk";
import { basicNodeSigner } from "@stellar/stellar-sdk/contract";
import { expect, it } from "vitest";
import { Buffer, Client } from "./bindings/doqtri-market";
import { hexToBytes32 } from "./stellar/hash";
import { readChainTemplate } from "./stellar/market-reads";
import { quoteBuy } from "./stellar/market-client";
import { loadReportQueue } from "./market-server";
import { createClient } from "@supabase/supabase-js";

const BASE = "http://localhost:3000";
const MARKET = "CA6YPRXQ2IFGACBFLKWEFETGLZ2C5R7DG5TTBKTTP4AVYOF3HFOSBCC2";
const XLM = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
const USDC = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
const PASSPHRASE = "Test SDF Network ; September 2015";
const LOG = process.env.E2E_LOG;
const log = (s: string) => {
  if (LOG) appendFileSync(LOG, s + "\n");
};
const enabled = process.env.MARKET_E2E === "1";

type Session = { kp: Keypair; cookie: string; address: string };

async function signIn(secret: string): Promise<Session> {
  const kp = Keypair.fromSecret(secret);
  const address = kp.publicKey();
  const challenge = await (await fetch(`${BASE}/api/auth/wallet/challenge`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ address }),
  })).json();
  const signature = kp.signMessage(challenge.message).toString("base64");
  const res = await fetch(`${BASE}/api/auth/wallet`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ address, token: challenge.token, signature }),
  });
  const tokens = await res.json();
  if (!res.ok) throw new Error(`sign-in failed: ${JSON.stringify(tokens)}`);
  const jar = new Map<string, string>();
  const supabase = createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    cookies: {
      getAll: () => [...jar].map(([name, value]) => ({ name, value })),
      setAll: (cs) => cs.forEach(({ name, value }) => jar.set(name, value)),
    },
  });
  await supabase.auth.setSession({ access_token: tokens.access_token, refresh_token: tokens.refresh_token });
  const cookie = [...jar].map(([n, v]) => `${n}=${v}`).join("; ");
  return { kp, cookie, address };
}

async function api(s: Session, path: string, body?: unknown) {
  const res = await fetch(`${BASE}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json", Cookie: s.cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

function market(s: Session) {
  return new Client({
    contractId: MARKET,
    networkPassphrase: PASSPHRASE,
    rpcUrl: "https://soroban-testnet.stellar.org",
    publicKey: s.address,
    ...basicNodeSigner(s.kp, PASSPHRASE),
  });
}

async function publish(s: Session, noteId: string, title: string, price = "0") {
  const draft = await api(s, "/api/market/publish", {
    noteId, title, category: "Planning", description: "E2E test template", price, token: XLM,
  });
  log(`publish draft ${draft.status} ${JSON.stringify({ ...draft.json, contentHash: draft.json.contentHash?.slice(0, 8) })}`);
  expect(draft.status).toBe(200);
  const d = draft.json;
  const tx = await market(s).list_template({
    creator: s.address,
    template_id: d.templateId,
    content_hash: Buffer.from(hexToBytes32(d.contentHash)),
    token: d.token,
    price: BigInt(d.price),
    parent: d.parent?.id ?? undefined,
  });
  const sent = await tx.signAndSend();
  log(`list_template tx ${sent.sendTransactionResponse?.hash}`);
  const confirm = await api(s, "/api/market/publish/confirm", { templateId: d.templateId });
  log(`confirm ${confirm.status} ${JSON.stringify(confirm.json)}`);
  expect(confirm.status).toBe(200);
  expect(confirm.json.status).toBe("listed");
  return d as { templateId: string; contentHash: string; parent: { id: string; title: string } | null };
}

it.skipIf(!enabled)("free templates: publish, gallery, use, tip, derive, refusals", async () => {
  const creator = await signIn(process.env.E2E_CREATOR_SECRET!);
  const buyer = await signIn(process.env.E2E_BUYER_SECRET!);
  log(`signed in creator ${creator.address.slice(0, 6)} buyer ${buyer.address.slice(0, 6)}`);

  // 1. Creator writes a note and publishes it.
  const note = await api(creator, "/api/notes", {
    title: "Market E2E Launch Plan",
    body: "Intro for the launch.\n\n## Goals\nShip the thing.\n\n## Risks\n### Timeline\n",
  });
  expect(note.status).toBe(200);
  const listing = await publish(creator, note.json.id, "Market E2E Launch Plan");
  const chain = await readChainTemplate(listing.templateId);
  expect(chain?.creator).toBe(creator.address);
  expect(chain?.contentHash).toBe(listing.contentHash);

  // 2. Buyer sees it in the gallery, with the full body (free).
  const gallery = await api(buyer, "/api/market/templates?sort=newest");
  const card = gallery.json.templates.find((t: { id: string }) => t.id === listing.templateId);
  log(`gallery ${gallery.status} count=${gallery.json.templates.length} card=${JSON.stringify(card && { title: card.title, free: card.free, mine: card.mine, uses: card.uses, preview: card.preview.slice(0, 40) })}`);
  expect(card?.free).toBe(true);
  expect(card?.mine).toBe(false);
  expect(card?.preview).toContain("Ship the thing.");
  const own = await api(creator, "/api/market/templates?sort=newest");
  expect(own.json.templates.find((t: { id: string }) => t.id === listing.templateId)?.mine).toBe(true);

  // 3. Buyer uses it: a copy lands in their vault.
  const claim = await api(buyer, "/api/market/claim", { templateId: listing.templateId });
  log(`claim ${claim.status} ${JSON.stringify(claim.json)}`);
  expect(claim.status).toBe(200);
  const after = await api(buyer, "/api/market/templates?sort=newest");
  expect(after.json.templates.find((t: { id: string }) => t.id === listing.templateId)?.uses).toBe(1);

  // 4. Buyer tips the creator 1 XLM, straight to the creator.
  const tip = await (await market(buyer).tip({ from: buyer.address, template_id: listing.templateId, amount: BigInt(10_000_000) })).signAndSend();
  log(`tip tx ${tip.sendTransactionResponse?.hash}`);
  expect((await readChainTemplate(listing.templateId))?.tips).toBe(BigInt(10_000_000));

  // 5. Buyer re-publishes their copy: it links the original as parent.
  const derived = await publish(buyer, claim.json.id, "Market E2E Launch Plan (remix)");
  expect(derived.parent?.id).toBe(listing.templateId);
  const derivedChain = await readChainTemplate(derived.templateId);
  expect(derivedChain?.parent).toBe(listing.templateId);
  expect(derivedChain?.parentCreator).toBe(creator.address);

  // 6. Refusals.
  // Paid is allowed now; below the minimum price is not.
  const paid = await api(creator, "/api/market/publish", { noteId: note.json.id, title: "x", category: "Planning", description: "", price: "1000", token: XLM });
  const notMine = await api(buyer, "/api/market/publish/confirm", { templateId: listing.templateId });
  const missing = await api(buyer, "/api/market/claim", { templateId: "aaaaaaaaaaaaaaaa" });
  const otherNote = await api(buyer, "/api/market/publish", { noteId: note.json.id, title: "steal", category: "Planning", description: "", price: "0", token: XLM });
  const relay = await api(buyer, "/api/chain/relay", { func: "AAAA", auth: ["AAAA"] });
  log(`refusals below-min=${paid.status} confirm-not-mine=${notMine.status} claim-missing=${missing.status} publish-other-note=${otherNote.status} relay-wallet-user=${relay.status}`);
  expect([paid.status, notMine.status, missing.status, otherNote.status, relay.status]).toEqual([400, 404, 404, 404, 403]);

  // 7. A listing whose draft doesn't match the chain is never confirmed.
  const draft = await api(creator, "/api/market/publish", { noteId: note.json.id, title: "Mismatch", category: "Work", description: "", price: "0", token: XLM });
  await (await market(creator).list_template({
    creator: creator.address, template_id: draft.json.templateId,
    content_hash: Buffer.alloc(32, 9), token: XLM, price: BigInt(0), parent: undefined,
  })).signAndSend();
  const mismatch = await api(creator, "/api/market/publish/confirm", { templateId: draft.json.templateId });
  log(`mismatch confirm ${mismatch.status} ${JSON.stringify(mismatch.json)}`);
  expect(mismatch.status).toBe(409);
  const hidden = await api(buyer, "/api/market/templates?sort=newest");
  expect(hidden.json.templates.some((t: { id: string }) => t.id === draft.json.templateId)).toBe(false);

  log(`IDS original=${listing.templateId} derived=${derived.templateId} mismatch=${draft.json.templateId} creatorNote=${note.json.id} buyerNote=${claim.json.id}`);
}, 240_000);

async function buy(s: Session, templateId: string) {
  const quote = await quoteBuy(s.address, templateId);
  log(`quote ${templateId} price=${quote.price} creator=${quote.creatorCut} parent=${quote.parentCut} treasury=${quote.treasuryCut} fee=${quote.feeStroops} problems=${JSON.stringify(quote.problems)}`);
  expect(quote.problems).toEqual([]);
  const sent = await (await market(s).buy({ buyer: s.address, template_id: templateId, max_price: quote.price })).signAndSend();
  const txHash = sent.sendTransactionResponse!.hash;
  log(`buy tx ${txHash}`);
  const claim = await api(s, "/api/market/claim", { templateId, txHash });
  log(`claim after buy ${claim.status} ${JSON.stringify(claim.json)}`);
  expect(claim.status).toBe(200);
  return { quote, txHash, noteId: claim.json.id as string };
}

it.skipIf(!enabled)("paid templates: buy, royalties, earnings, price, delist, reports", async () => {
  const creator = await signIn(process.env.E2E_CREATOR_SECRET!);
  const buyer = await signIn(process.env.E2E_BUYER_SECRET!);
  const third = await signIn(process.env.E2E_THIRD_SECRET!);
  const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });

  // Paid listing: 3 XLM.
  const note = await api(creator, "/api/notes", {
    title: "Market E2E Paid Plan",
    body: "Secret intro paragraph.\n\n## Budget\nSecret numbers.\n\n## Timeline\n### Q1\n",
  });
  const tooCheap = await api(creator, "/api/market/publish", { noteId: note.json.id, title: "x", category: "Work", description: "", price: "1000", token: XLM });
  log(`below min price ${tooCheap.status} ${tooCheap.json.error}`);
  expect(tooCheap.status).toBe(400);
  // USDC needs a trustline to be paid; this creator has none.
  const usdc = await api(creator, "/api/market/publish", { noteId: note.json.id, title: "x", category: "Work", description: "", price: "10000000", token: USDC });
  log(`usdc without trustline ${usdc.status} ${usdc.json.error}`);
  expect(usdc.status).toBe(409);
  const paid = await publish(creator, note.json.id, "Market E2E Paid Plan", "30000000");

  // Gallery shows headings only; claiming before buying is refused.
  const card = (await api(buyer, "/api/market/templates?sort=newest")).json.templates.find((t: { id: string }) => t.id === paid.templateId);
  log(`paid card free=${card.free} owned=${card.owned} preview=${JSON.stringify(card.preview)}`);
  expect(card.free).toBe(false);
  expect(card.preview).not.toContain("Secret");
  expect(card.preview).toContain("## Budget");
  expect((await api(buyer, "/api/market/claim", { templateId: paid.templateId })).status).toBe(402);

  // Buy: 2.7 creator / 0.3 treasury, purchase recorded with its split.
  const bought = await buy(buyer, paid.templateId);
  expect([bought.quote.creatorCut, bought.quote.parentCut, bought.quote.treasuryCut]).toEqual([BigInt(27_000_000), BigInt(0), BigInt(3_000_000)]);
  const { data: row } = await db.from("market_purchases").select("tx_hash, amount::text, creator_cut::text, parent_cut::text, treasury_cut::text").eq("template_id", paid.templateId).eq("buyer_wallet", buyer.address).single();
  log(`purchase row ${JSON.stringify(row)}`);
  expect(row).toMatchObject({ tx_hash: bought.txHash, amount: "30000000", creator_cut: "27000000", parent_cut: "0", treasury_cut: "3000000" });
  const again = (await api(buyer, "/api/market/templates?sort=newest")).json.templates.find((t: { id: string }) => t.id === paid.templateId);
  expect(again.owned).toBe(true);
  expect((await api(buyer, "/api/market/claim", { templateId: paid.templateId })).status).toBe(200);

  // Buyer sells a derivative for 2 XLM; a third wallet buys it: 1.7 / 0.1 royalty / 0.2.
  const derived = await publish(buyer, bought.noteId, "Market E2E Paid Plan (remix)", "20000000");
  expect(derived.parent?.id).toBe(paid.templateId);
  const resale = await buy(third, derived.templateId);
  expect([resale.quote.creatorCut, resale.quote.parentCut, resale.quote.treasuryCut]).toEqual([BigInt(17_000_000), BigInt(1_000_000), BigInt(2_000_000)]);

  // Earnings: sales, earnings and the royalty from the derivative.
  const earnings = (await api(creator, "/api/market/earnings")).json;
  const mine = earnings.templates.find((t: { id: string }) => t.id === paid.templateId);
  const royalty = earnings.royalties.find((r: { templateId: string }) => r.templateId === derived.templateId);
  log(`creator earnings sales=${mine.sales} earned=${mine.earned} recent=${mine.recentSales.length} derived=${mine.derived.length} royalty=${JSON.stringify(royalty)} totals=${JSON.stringify(earnings.totals)}`);
  expect(mine.sales).toBe(1);
  expect(mine.earned).toBe("27000000");
  expect(mine.recentSales[0].txHash).toBe(bought.txHash);
  expect(mine.derived.map((d: { id: string }) => d.id)).toContain(derived.templateId);
  expect(royalty).toMatchObject({ total: "1000000", sales: 1 });

  // Price change and delist go through the chain, then sync the gallery.
  await (await market(creator).update_price({ template_id: paid.templateId, price: BigInt(40_000_000) })).signAndSend();
  const synced = await api(creator, "/api/market/sync", { templateId: paid.templateId });
  log(`sync after price ${synced.status} ${JSON.stringify(synced.json)}`);
  expect(synced.json.price).toBe("40000000");
  expect((await api(buyer, "/api/market/sync", { templateId: paid.templateId })).status).toBe(404);
  await (await market(creator).set_listed({ template_id: paid.templateId, listed: false })).signAndSend();
  await api(creator, "/api/market/sync", { templateId: paid.templateId });
  const listedNow = (await api(third, "/api/market/templates?sort=newest")).json.templates.some((t: { id: string }) => t.id === paid.templateId);
  const ownerAgain = await api(buyer, "/api/market/claim", { templateId: paid.templateId });
  const strangerClaim = await api(third, "/api/market/claim", { templateId: paid.templateId });
  log(`delisted: in gallery=${listedNow} buyer re-claim=${ownerAgain.status} stranger claim=${strangerClaim.status}`);
  expect([listedNow, ownerAgain.status, strangerClaim.status]).toEqual([false, 200, 410]);
  await (await market(creator).set_listed({ template_id: paid.templateId, listed: true })).signAndSend();
  await api(creator, "/api/market/sync", { templateId: paid.templateId });

  // Reports: the derivative reported as a copy of the paid original.
  const report = await api(third, "/api/market/report", { templateId: derived.templateId, originalId: paid.templateId, reason: "Same structure" });
  const dup = await api(third, "/api/market/report", { templateId: derived.templateId, originalId: paid.templateId });
  const self = await api(third, "/api/market/report", { templateId: derived.templateId, originalId: derived.templateId });
  const notAdmin = await fetch(`${BASE}/api/admin/market/templates/${derived.templateId}`, { method: "PATCH", headers: { "Content-Type": "application/json", Cookie: third.cookie }, body: JSON.stringify({ hidden: true }) });
  log(`report=${report.status} duplicate=${dup.status} self=${self.status} non-admin-hide=${notAdmin.status}`);
  expect([report.status, dup.status, self.status, notAdmin.status]).toEqual([200, 409, 400, 404]);
  const queue = await loadReportQueue(db);
  const item = queue.find((q) => q.reported.id === derived.templateId && q.original.id === paid.templateId)!;
  log(`queue item status=${item.status} sameHash=${item.sameHash} similarity=${item.similarity} earlier=${item.earlier}`);
  expect(item).toMatchObject({ status: "open", sameHash: true, similarity: 1, earlier: "original" });

  log(`IDS2 paid=${paid.templateId} derived=${derived.templateId} report=${item.id}`);
}, 300_000);

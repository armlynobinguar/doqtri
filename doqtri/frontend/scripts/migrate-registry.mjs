/**
 * Copies every anchored document and node from one DoqtriRegistry to another
 * (registry v2), keeping owner, hash, version, node count and node records.
 *
 *   ADMIN_SECRET=S... node scripts/migrate-registry.mjs <from-contract> <to-contract> [--dry-run] [--workers=6]
 *
 * - Which documents and nodes exist is read from stellar.expert's list of the
 *   old contract's storage. That list is only used to find keys: every value
 *   is read again from the old contract over Stellar RPC before it is copied.
 * - Each copy is the new contract's admin-only import_document / import_node,
 *   authorized by ADMIN_SECRET (the new contract's admin). The transactions
 *   are sent from throwaway testnet accounts funded by Friendbot, one per
 *   worker, because the network takes one pending transaction per account.
 * - Safe to run again: documents and nodes already in the new contract are
 *   skipped, so a run that stopped halfway is finished by the next one, and a
 *   last run right before switching the app picks up only what's new. (A
 *   document already copied isn't re-copied if it changed since.)
 *
 * Testnet only for now (the RPC, passphrase, Friendbot and stellar.expert below).
 */
import { Keypair, Networks, contract, rpc, scValToNative, xdr } from "@stellar/stellar-sdk";

const RPC_URL = process.env.SOROBAN_RPC_URL || "https://soroban-testnet.stellar.org";
const PASSPHRASE = Networks.TESTNET;
const EXPERT = "https://api.stellar.expert/explorer/testnet";
const FRIENDBOT = "https://friendbot.stellar.org";

const args = process.argv.slice(2);
const [from, to] = args.filter((a) => !a.startsWith("--"));
const dryRun = args.includes("--dry-run");
const workers = Number(args.find((a) => a.startsWith("--workers="))?.split("=")[1] ?? 6);
if (!from || !to) {
  console.error("usage: ADMIN_SECRET=S... node scripts/migrate-registry.mjs <from> <to> [--dry-run] [--workers=6]");
  process.exit(1);
}
if (!dryRun && !process.env.ADMIN_SECRET) {
  console.error("ADMIN_SECRET is required (or pass --dry-run).");
  process.exit(1);
}

const server = new rpc.Server(RPC_URL);

/** Every storage key of the old contract, decoded: ["Doc", id] or ["Node", id, node]. */
async function listKeys(contractId) {
  const keys = [];
  let url = `${EXPERT}/contract-data/${contractId}?limit=200&order=asc`;
  for (;;) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`stellar.expert ${res.status} for ${url}`);
    const body = await res.json();
    const records = body._embedded?.records ?? [];
    for (const r of records) {
      try {
        const key = scValToNative(xdr.ScVal.fromXDR(r.key, "base64"));
        if (Array.isArray(key) && (key[0] === "Doc" || key[0] === "Node")) keys.push(key);
      } catch {
        // The contract instance and anything else that isn't a Doc or Node key.
      }
    }
    if (records.length < 200) return keys;
    url = `https://api.stellar.expert${body._links.next.href}`;
  }
}

const reader = (contractId) => contract.Client.from({ contractId, networkPassphrase: PASSPHRASE, rpcUrl: RPC_URL });

/** A read call's value, or null when the contract answers with an error (e.g. not found). */
async function read(tx) {
  const result = (await tx).result;
  if (result && typeof result === "object" && "isOk" in result) return result.isOk() ? result.unwrap() : null;
  return result ?? null;
}

/** Sends a signed transaction and checks once a second until a ledger includes it. */
async function sendAndConfirm(tx) {
  const sent = await server.sendTransaction(tx.signed);
  if (sent.status !== "PENDING" && sent.status !== "DUPLICATE") {
    throw new Error(`send failed: ${sent.status} ${JSON.stringify(sent.errorResult ?? "")}`);
  }
  const result = await server.pollTransaction(sent.hash, { attempts: 30 });
  if (result.status !== rpc.Api.GetTransactionStatus.SUCCESS) throw new Error(`tx ${sent.hash}: ${result.status}`);
  return sent.hash;
}

/** One sending account: builds the call, has the admin authorize it, signs as source, sends. */
async function makeWorker(admin) {
  const source = Keypair.random();
  const funded = await fetch(`${FRIENDBOT}?addr=${source.publicKey()}`);
  if (!funded.ok) throw new Error(`Friendbot failed for a worker account (${funded.status})`);
  const client = await contract.Client.from({
    contractId: to,
    networkPassphrase: PASSPHRASE,
    rpcUrl: RPC_URL,
    publicKey: source.publicKey(),
    ...contract.basicNodeSigner(source, PASSPHRASE),
  });
  const adminSigner = contract.basicNodeSigner(admin, PASSPHRASE);
  return async (build) => {
    const tx = await build(client);
    await tx.signAuthEntries({ address: admin.publicKey(), signAuthEntry: adminSigner.signAuthEntry });
    // Re-simulate with the admin's signature in place, for the real resource fee.
    await tx.simulate();
    await tx.sign();
    return sendAndConfirm(tx);
  };
}

async function main() {
  const keys = await listKeys(from);
  const docIds = [...new Set(keys.filter((k) => k[0] === "Doc").map((k) => k[1]))];
  const nodesByDoc = new Map();
  for (const [, docId, nodeId] of keys.filter((k) => k[0] === "Node")) {
    if (!nodesByDoc.has(docId)) nodesByDoc.set(docId, []);
    nodesByDoc.get(docId).push(nodeId);
  }
  console.log(`found ${docIds.length} documents and ${keys.length - docIds.length} nodes in ${from}`);

  const old = await reader(from);
  const fresh = await reader(to);
  let admin = null;
  if (!dryRun) {
    admin = Keypair.fromSecret(process.env.ADMIN_SECRET);
    const onChainAdmin = await read(fresh.admin());
    if (onChainAdmin !== admin.publicKey()) throw new Error(`ADMIN_SECRET is not ${to}'s admin (${onChainAdmin})`);
  }

  const totals = { docs: 0, nodes: 0, skipped: 0, missing: 0, failed: 0 };

  /** Copies one document (if needed) and whichever of its nodes the new contract lacks. */
  async function migrate(docId, send) {
    // Authoritative values come from the old contract itself.
    const doc = await read(old.get_document({ doc_id: docId }));
    if (!doc) {
      console.warn(`  ${docId}: not readable on ${from} (expired?), skipped`);
      totals.missing++;
      return;
    }
    const present = Boolean(await read(fresh.get_document({ doc_id: docId })));
    const nodes = [];
    for (const nodeId of nodesByDoc.get(docId) ?? []) {
      if (present && (await read(fresh.get_node({ doc_id: docId, node_id: nodeId })))) continue;
      const record = await read(old.get_node({ doc_id: docId, node_id: nodeId }));
      if (record) nodes.push([nodeId, record]);
    }
    if (present && nodes.length === 0) {
      totals.skipped++;
      return;
    }
    if (dryRun) {
      console.log(`  ${docId}: v${doc.version}${present ? " (already there)" : ""}, ${nodes.length} node(s) to copy`);
      if (!present) totals.docs++;
      totals.nodes += nodes.length;
      return;
    }
    try {
      if (!present) {
        await send((c) => c.import_document({ doc_id: docId, doc }));
        totals.docs++;
      }
      for (const [nodeId, record] of nodes) {
        await send((c) => c.import_node({ doc_id: docId, node_id: nodeId, record }));
        totals.nodes++;
      }
      console.log(`  ${docId}: v${doc.version}${present ? " (finished)" : ""}, ${nodes.length} node(s)`);
    } catch (error) {
      console.error(`  ${docId}: failed: ${error?.message ?? error}`);
      totals.failed++;
    }
  }

  const queue = [...docIds];
  const senders = dryRun ? [null] : await Promise.all(Array.from({ length: workers }, () => makeWorker(admin)));
  await Promise.all(
    senders.map(async (send) => {
      for (let docId = queue.shift(); docId !== undefined; docId = queue.shift()) await migrate(docId, send);
    }),
  );

  console.log(
    `${dryRun ? "would copy" : "copied"} ${totals.docs} documents and ${totals.nodes} nodes; ` +
      `${totals.skipped} already complete, ${totals.missing} unreadable, ${totals.failed} failed`,
  );
  if (totals.failed) process.exit(1);
}

await main();

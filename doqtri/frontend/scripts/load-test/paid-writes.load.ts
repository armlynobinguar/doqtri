/**
 * Paid-write load test (DOQ-2, WP-4.1): N test email accounts, each with its
 * own passkey wallet, prepare one paid write each and then send all N to
 * /api/chain/relay at the same moment. The report (success count, outcome
 * per HTTP status and reason, the relay log's txBadSeq / TRY_AGAIN_LATER
 * split, p50/p95 latency) is the baseline the relay pool (DOQ-1) is measured
 * against.
 *
 * Not part of `npm test`: it runs only through its own vitest config, needs a
 * running deployment and its Supabase keys, and spends testnet XLM. How to
 * run it, and how the wallets are made and funded: README.md next to this
 * file.
 */
import { existsSync, mkdirSync, openSync, readFileSync, readSync, statSync, closeSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { it } from "vitest";
import { IS_MAINNET } from "@/lib/stellar/config";
import {
  adminClient,
  connectTestWallet,
  createNote,
  deployTestWallet,
  ensureTestUser,
  prepareForwardedWrite,
  registerCall,
  sendPaidWrite,
  signIn,
  waitForFunds,
  type RelayBody,
  type Session,
  type Target,
  type WalletRecord,
} from "./driver";
import {
  formatReport,
  parseServerLog,
  parseTimingLines,
  runPool,
  summarize,
  type PrepareFailure,
  type RunMeta,
  type ServerLogCounts,
  type WriteOutcome,
} from "./report";
import { createSoftPasskey, restoreSoftPasskey, saveSoftPasskey, type SavedSoftPasskey } from "./soft-passkey";

const HERE = dirname(new URL(import.meta.url).pathname);

type StateWallet = { email: string; userId: string; passkey: SavedSoftPasskey; wallet: WalletRecord | null };
type State = { target: string; wallets: StateWallet[] };
type Results = { summary: ReturnType<typeof summarize>; outcomes: WriteOutcome[]; prepareFailures: PrepareFailure[] };

function config() {
  const baseUrl = process.env.LOADTEST_BASE_URL?.trim().replace(/\/$/, "");
  if (!baseUrl) throw new Error("Set LOADTEST_BASE_URL to the deployment under test, e.g. http://localhost:3000.");
  const host = new URL(baseUrl).hostname;
  if (!["localhost", "127.0.0.1"].includes(host) && process.env.LOADTEST_ALLOW_REMOTE !== "1") {
    throw new Error(`${baseUrl} is not local. Set LOADTEST_ALLOW_REMOTE=1 to load-test a remote deployment.`);
  }
  if (IS_MAINNET) throw new Error("The load test spends real fees on mainnet; it runs on testnet only.");
  const n = Number(process.env.LOADTEST_N ?? 30);
  if (!Number.isInteger(n) || n < 1 || n > 200) throw new Error("LOADTEST_N must be a whole number from 1 to 200.");
  const bypass = process.env.LOADTEST_PROTECTION_BYPASS?.trim();
  const target: Target = { baseUrl, headers: bypass ? { "x-vercel-protection-bypass": bypass } : {} };
  return {
    target,
    n,
    statePath: process.env.LOADTEST_STATE?.trim() || join(HERE, ".state", `${host}.json`),
    outDir: process.env.LOADTEST_OUT?.trim() || join(HERE, ".results"),
    serverLog: process.env.LOADTEST_SERVER_LOG?.trim() || null,
    setupConcurrency: Number(process.env.LOADTEST_SETUP_CONCURRENCY ?? 3) || 3,
    prepareConcurrency: Number(process.env.LOADTEST_PREPARE_CONCURRENCY ?? 5) || 5,
    emailPrefix: process.env.LOADTEST_EMAIL_PREFIX?.trim() || "doqtri-loadtest",
    emailDomain: process.env.LOADTEST_EMAIL_DOMAIN?.trim() || "example.com",
    label: process.env.LOADTEST_LABEL?.trim() || undefined,
  };
}

function loadState(path: string, target: string): State {
  if (!existsSync(path)) return { target, wallets: [] };
  const state = JSON.parse(readFileSync(path, "utf8")) as State;
  if (state.target !== target) throw new Error(`${path} holds wallets for ${state.target}, not ${target}. Use another LOADTEST_STATE.`);
  return state;
}

function saveState(path: string, state: State): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
}

/** How far the server log has grown, so the run reads only its own lines. */
function logSize(path: string | null): number {
  return path && existsSync(path) ? statSync(path).size : 0;
}

function readLogFrom(path: string | null, offset: number): { counts: ServerLogCounts; text: string } | null {
  if (!path || !existsSync(path)) return null;
  const size = statSync(path).size;
  const buffer = Buffer.alloc(Math.max(0, size - offset));
  const fd = openSync(path, "r");
  try {
    readSync(fd, buffer, 0, buffer.length, offset);
  } finally {
    closeSync(fd);
  }
  const text = buffer.toString("utf8");
  return { counts: parseServerLog(text), text };
}

/** Creates the test users and wallets the state file is missing, up to N. */
async function ensureWallets(cfg: ReturnType<typeof config>, state: State): Promise<void> {
  const admin = adminClient();
  const runTag = Date.now().toString(36);
  while (state.wallets.length < cfg.n) {
    const i = state.wallets.length;
    const email = `${cfg.emailPrefix}+${runTag}-${i}@${cfg.emailDomain}`;
    state.wallets.push({ email, userId: await ensureTestUser(admin, email), passkey: saveSoftPasskey(createSoftPasskey()), wallet: null });
    saveState(cfg.statePath, state);
  }
  const missing = state.wallets.slice(0, cfg.n).filter((w) => !w.wallet);
  if (missing.length) console.log(`Deploying ${missing.length} test wallets through the relay…`);
  await runPool(missing, cfg.setupConcurrency, async (entry) => {
    const session = await signIn(admin, entry.email);
    entry.wallet = await deployTestWallet(cfg.target, session, restoreSoftPasskey(entry.passkey));
    saveState(cfg.statePath, state);
    console.log(`  ${entry.email} → ${entry.wallet.address}`);
  });
}

/** Everything before the measured request, per wallet: sign in, top up, note, signed write. */
async function prepareAll(cfg: ReturnType<typeof config>, state: State, startedAt: string) {
  const admin = adminClient();
  const prepared: { wallet: number; session: Session; body: RelayBody }[] = [];
  const failures: PrepareFailure[] = [];
  await runPool(state.wallets.slice(0, cfg.n), cfg.prepareConcurrency, async (entry, wallet) => {
    let step = "sign-in";
    try {
      const session = await signIn(admin, entry.email);
      step = "funding";
      await waitForFunds(cfg.target, session, entry.wallet!.address);
      step = "note";
      const note = await createNote(cfg.target, session, `Load test ${startedAt} #${wallet}`);
      step = "connect wallet";
      const passkey = restoreSoftPasskey(entry.passkey);
      const kit = await connectTestWallet(passkey, entry.wallet!, cfg.target.baseUrl);
      step = "sign write";
      const body = await prepareForwardedWrite(kit, entry.wallet!.address, await registerCall(entry.wallet!.address, note.id, note.markdown));
      prepared.push({ wallet, session, body });
    } catch (error) {
      failures.push({ wallet, step, error: (error as Error).message });
    }
  });
  return { prepared, failures };
}

function writeResults(cfg: ReturnType<typeof config>, results: Results, name: string): string {
  mkdirSync(cfg.outDir, { recursive: true });
  const base = join(cfg.outDir, name);
  writeFileSync(`${base}.json`, JSON.stringify(results, null, 2) + "\n");
  writeFileSync(`${base}.md`, formatReport(results.summary));
  return base;
}

/**
 * LOADTEST_REPORT_FROM=<results .json> rebuilds a report with a server log
 * fetched after the run (a remote deployment's logs, say) instead of running.
 */
const reportFrom = process.env.LOADTEST_REPORT_FROM?.trim();

it.skipIf(Boolean(reportFrom))("paid writes: N concurrent relay requests from N wallets", async () => {
  const cfg = config();
  const state = loadState(cfg.statePath, cfg.target.baseUrl);
  await ensureWallets(cfg, state);

  const startedAt = new Date().toISOString();
  console.log(`Preparing ${cfg.n} signed paid writes…`);
  const { prepared, failures } = await prepareAll(cfg, state, startedAt);

  console.log(`Sending ${prepared.length} paid writes to ${cfg.target.baseUrl}/api/chain/relay at once…`);
  const offset = logSize(cfg.serverLog);
  const t0 = performance.now();
  const outcomes: WriteOutcome[] = await Promise.all(
    prepared.map(async ({ wallet, session, body }) => ({ wallet, ...(await sendPaidWrite(cfg.target, session, body)) })),
  );
  const wallMs = performance.now() - t0;
  // Give a piped dev server a moment to flush its last log lines.
  await new Promise((resolve) => setTimeout(resolve, 1_000));

  const meta: RunMeta = { target: cfg.target.baseUrl, startedAt, n: cfg.n, deployment: cfg.label };
  const log = readLogFrom(cfg.serverLog, offset);
  const summary = summarize(meta, outcomes, failures, log?.counts ?? null, wallMs, parseTimingLines(log?.text ?? ""));
  const base = writeResults(cfg, { summary, outcomes, prepareFailures: failures }, startedAt.replace(/[:.]/g, "-"));
  console.log(`\n${formatReport(summary)}\nSaved ${base}.md and .json`);
});

it.skipIf(!reportFrom)("paid writes: rebuild a saved report with a server log", () => {
  const results = JSON.parse(readFileSync(reportFrom!, "utf8")) as Results;
  const log = process.env.LOADTEST_SERVER_LOG?.trim();
  if (!log) throw new Error("Set LOADTEST_SERVER_LOG to the deployment's log for the run's time window.");
  const { summary: old, outcomes, prepareFailures } = results;
  const text = readFileSync(log, "utf8");
  const summary = summarize(
    { target: old.target, startedAt: old.startedAt, n: old.n, deployment: old.deployment },
    outcomes,
    prepareFailures,
    parseServerLog(text),
    old.wallMs,
    parseTimingLines(text),
  );
  const md = reportFrom!.replace(/\.json$/, "") + ".with-log.md";
  writeFileSync(md, formatReport(summary));
  console.log(`\n${formatReport(summary)}\nSaved ${md}`);
});

import {
  Account,
  BASE_FEE,
  Contract,
  nativeToScVal,
  Networks,
  rpc,
  scValToNative,
  StrKey,
  TransactionBuilder,
  type xdr,
} from "@stellar/stellar-sdk";
import { IS_MAINNET, RPC_URL } from "@/lib/stellar/config";
import type { NodeStatus } from "@/lib/stellar/types";

/**
 * qdit's `milestone_proof` contract, read from doqtri (WP-2.8).
 * docs/integration/CONTRACT.md is the reference; section numbers point into
 * it.
 *
 * The chain is the truth (D-04): qdit's webhook and its API's `status` only
 * say that something may have changed. Before the ship panel suggests a
 * status for a heading linked to a milestone, doqtri reads the milestone's
 * record itself, with `get_milestone_status(project_id, milestone_id)` on
 * the contract the project names (`chain.contract_id`, section 7), over
 * Stellar RPC on the project's network. It is a simulation: free, unsigned,
 * and needing no qdit token, which is what lets the webhook read it too.
 *
 * Also here, because both sides of a signature need them: the D-19 mapping
 * from the record's status to a node status, and the `artifact_ref` grammar
 * the signed record carries (section 10).
 */

export type QditChainNetwork = "testnet" | "mainnet";

/** A project's chain as qdit reports it (section 7): null until it is registered. */
export type ProjectChain = { network: QditChainNetwork; contractId: string };

/** milestone_proof's MilestoneStatus. */
export type MilestoneChainStatus = "Proposed" | "Submitted" | "Approved" | "Rejected";

const CHAIN_STATUSES: readonly MilestoneChainStatus[] = ["Proposed", "Submitted", "Approved", "Rejected"];

/** milestone_proof's MilestoneRecord, as much of it as doqtri uses. */
export type MilestoneChainRecord = {
  status: MilestoneChainStatus;
  /** Submissions so far, from 1; approve and reject keep it (section 10's `@v`). */
  version: number;
  proofHash: string;
  submitter: string;
  /** Ledger time of the submission, in seconds. */
  timestamp: number;
};

/**
 * One read. `record` is null when the contract has no record of the
 * milestone (MilestoneNotFound: nothing submitted yet). `ledger` is the
 * ledger the RPC answered at, which orders reads (D-25).
 */
export type MilestoneChainRead = { ledger: number; record: MilestoneChainRecord | null };

export class QditChainError extends Error {
  constructor(
    /** `unreachable`: RPC down or slow, try again. `invalid`: bad input. `bad_response`: an answer doqtri can't read. */
    readonly kind: "unreachable" | "invalid" | "bad_response" | "contract",
    message: string,
  ) {
    super(message);
    this.name = "QditChainError";
  }
}

const UUID_LC = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isProjectChain(value: unknown): value is ProjectChain {
  const chain = value as Partial<ProjectChain> | null;
  return (
    !!chain &&
    (chain.network === "testnet" || chain.network === "mainnet") &&
    typeof chain.contractId === "string" &&
    StrKey.isValidContract(chain.contractId)
  );
}

// ---------------------------------------------------------------------------
// D-19 and the artifact_ref grammar (section 10)
// ---------------------------------------------------------------------------

const NODE_STATUS_FOR: Record<MilestoneChainStatus, NodeStatus> = {
  Proposed: "Planned",
  Submitted: "Built",
  Approved: "Verified",
  Rejected: "Building",
};

/** The node status a milestone's chain record stands for (D-19); no record is Planned. */
export function nodeStatusForMilestone(status: MilestoneChainStatus | null): NodeStatus {
  return status ? NODE_STATUS_FOR[status] : "Planned";
}

/** The tool a heading's record names when its status came from its qdit milestone. */
export const QDIT_TOOL = "qdit";

export type QditArtifactRef = {
  network: QditChainNetwork;
  contractId: string;
  projectId: string;
  milestoneId: string;
  /** MilestoneRecord.version at signing time, a u32 >= 1. */
  version: number;
};

const ARTIFACT_REF =
  /^qdit:(testnet|mainnet):(C[A-Z2-7]{55}):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})@v([1-9][0-9]{0,9})$/;
const U32_MAX = 4_294_967_295;

/**
 * `qdit:<network>:<contract-id>:<project-id>/<milestone-id>@v<version>`.
 * Throws on anything the grammar refuses (uppercase ids included), so a
 * record that a third party could not check is never signed.
 */
export function qditArtifactRef(ref: QditArtifactRef): string {
  const text = `qdit:${ref.network}:${ref.contractId}:${ref.projectId}/${ref.milestoneId}@v${ref.version}`;
  if (!parseQditArtifactRef(text)) throw new QditChainError("invalid", "That milestone can't be named on chain.");
  return text;
}

/** The parts of a `qdit:` artifact_ref, or null when it does not follow the grammar. */
export function parseQditArtifactRef(text: string): QditArtifactRef | null {
  const m = ARTIFACT_REF.exec(text);
  if (!m) return null;
  const version = Number(m[5]);
  if (version > U32_MAX || !StrKey.isValidContract(m[2])) return null;
  return { network: m[1] as QditChainNetwork, contractId: m[2], projectId: m[3], milestoneId: m[4], version };
}

// ---------------------------------------------------------------------------
// Reading the record
// ---------------------------------------------------------------------------

const PASSPHRASE: Record<QditChainNetwork, string> = { testnet: Networks.TESTNET, mainnet: Networks.PUBLIC };
const DEFAULT_RPC: Record<QditChainNetwork, string> = {
  testnet: "https://soroban-testnet.stellar.org",
  mainnet: "https://mainnet.sorobanrpc.com",
};

/**
 * The RPC to read `network` through: QDIT_CHAIN_RPC_URL_TESTNET or
 * QDIT_CHAIN_RPC_URL_MAINNET when set, else doqtri's own RPC when the
 * project is on doqtri's network, else the same public default doqtri uses.
 */
export function qditChainRpcUrl(network: QditChainNetwork, env: NodeJS.ProcessEnv = process.env): string {
  const override = (network === "testnet" ? env.QDIT_CHAIN_RPC_URL_TESTNET : env.QDIT_CHAIN_RPC_URL_MAINNET)?.trim();
  if (override) return override;
  if ((network === "mainnet") === IS_MAINNET) return RPC_URL;
  return DEFAULT_RPC[network];
}

/** A simulation's outcome: the return value, or the host's error text. */
export type SimulationOutcome = { ledger: number; retval: xdr.ScVal } | { ledger: number; error: string };

export type SimulateCall = (call: {
  rpcUrl: string;
  networkPassphrase: string;
  contractId: string;
  method: string;
  args: xdr.ScVal[];
  timeoutMs: number;
}) => Promise<SimulationOutcome>;

/** Any account works as the source of a simulation; this one cannot exist. */
const NULL_ACCOUNT = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

/** Simulates through Stellar RPC. Throws QditChainError("unreachable") on transport failure or timeout. */
export const simulateOverRpc: SimulateCall = async ({ rpcUrl, networkPassphrase, contractId, method, args, timeoutMs }) => {
  const server = new rpc.Server(rpcUrl, { allowHttp: rpcUrl.startsWith("http://localhost") });
  const tx = new TransactionBuilder(new Account(NULL_ACCOUNT, "0"), { fee: BASE_FEE, networkPassphrase })
    .addOperation(new Contract(contractId).call(method, ...args))
    .setTimeout(30)
    .build();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const sim = await Promise.race([
      server.simulateTransaction(tx),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new QditChainError("unreachable", "Stellar RPC did not answer in time.")), timeoutMs);
      }),
    ]);
    if (rpc.Api.isSimulationError(sim)) return { ledger: sim.latestLedger, error: sim.error };
    const retval = (sim as rpc.Api.SimulateTransactionSuccessResponse).result?.retval;
    if (!retval) throw new QditChainError("bad_response", "Stellar RPC returned no result.");
    return { ledger: sim.latestLedger, retval };
  } catch (error) {
    if (error instanceof QditChainError) throw error;
    throw new QditChainError("unreachable", "Stellar RPC could not be reached.");
  } finally {
    clearTimeout(timer);
  }
};

const CONTRACT_ERROR = /Error\(Contract, #(\d+)\)/;
/** milestone_proof's Error::MilestoneNotFound. */
const MILESTONE_NOT_FOUND = 3;

function asStatus(value: unknown): MilestoneChainStatus | null {
  // A unit enum variant comes back as ["Approved"] (an ScVec of one symbol).
  const name = Array.isArray(value) && value.length === 1 ? value[0] : value;
  return typeof name === "string" && (CHAIN_STATUSES as readonly string[]).includes(name)
    ? (name as MilestoneChainStatus)
    : null;
}

/** A MilestoneRecord's native form, checked against the ids it was read for. */
export function decodeMilestoneRecord(
  native: unknown,
  expect: { projectId: string; milestoneId: string },
): MilestoneChainRecord {
  const r = native as Record<string, unknown> | null;
  const status = asStatus(r?.status);
  const version = Number(r?.version);
  const hash = r?.proof_hash;
  if (
    !r ||
    !status ||
    !Number.isInteger(version) ||
    version < 1 ||
    version > U32_MAX ||
    !(hash instanceof Uint8Array) ||
    hash.length !== 32 ||
    r.project_id !== expect.projectId ||
    r.milestone_id !== expect.milestoneId
  ) {
    throw new QditChainError("bad_response", "milestone_proof returned a record doqtri can't read.");
  }
  return {
    status,
    version,
    proofHash: Array.from(hash, (b) => b.toString(16).padStart(2, "0")).join(""),
    submitter: String(r.submitter ?? ""),
    timestamp: Number(r.timestamp ?? 0),
  };
}

export type ReadMilestoneDeps = {
  simulate?: SimulateCall;
  rpcUrl?: (network: QditChainNetwork) => string;
  timeoutMs?: number;
};

/**
 * The milestone's record on its project's contract, read now. Ids are
 * lowercase UUIDs as qdit sends them, the same strings qdit registered the
 * record under.
 */
export async function readMilestoneRecord(
  chain: ProjectChain,
  projectId: string,
  milestoneId: string,
  deps: ReadMilestoneDeps = {},
): Promise<MilestoneChainRead> {
  if (!isProjectChain(chain) || !UUID_LC.test(projectId) || !UUID_LC.test(milestoneId)) {
    throw new QditChainError("invalid", "That isn't a milestone doqtri can look up on chain.");
  }
  const outcome = await (deps.simulate ?? simulateOverRpc)({
    rpcUrl: (deps.rpcUrl ?? qditChainRpcUrl)(chain.network),
    networkPassphrase: PASSPHRASE[chain.network],
    contractId: chain.contractId,
    method: "get_milestone_status",
    args: [nativeToScVal(projectId, { type: "string" }), nativeToScVal(milestoneId, { type: "string" })],
    timeoutMs: deps.timeoutMs ?? 5_000,
  });
  if ("error" in outcome) {
    const code = CONTRACT_ERROR.exec(outcome.error)?.[1];
    if (code !== undefined && Number(code) === MILESTONE_NOT_FOUND) return { ledger: outcome.ledger, record: null };
    if (code !== undefined) throw new QditChainError("contract", `milestone_proof refused the read (error #${code}).`);
    // Not the contract's own error: a missing contract, a bad network, an RPC hiccup.
    throw new QditChainError("unreachable", "milestone_proof could not be read on chain.");
  }
  let native: unknown;
  try {
    native = scValToNative(outcome.retval);
  } catch {
    throw new QditChainError("bad_response", "milestone_proof returned a record doqtri can't read.");
  }
  return { ledger: outcome.ledger, record: decodeMilestoneRecord(native, { projectId, milestoneId }) };
}

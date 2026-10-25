import { SignerAddress } from "@/components/audit/signer-address";
import { StatusTag } from "@/components/ui/status-tag";
import type {
  ApprovedStep,
  PlanStep,
  PlanVersion,
  ProofChain,
  StepState,
  SubmittedStep,
  UncheckedReason,
  VerifiedStep,
} from "@/lib/integrations/qdit-proof-chain";
import { qditAddressUrl, qditExplorerUrl } from "@/lib/integrations/qdit-receipts";
import type { QditArtifactRef } from "@/lib/integrations/qdit-chain";
import { CONTRACT_ID, expertContractUrl, expertTxUrl } from "@/lib/stellar/config";
import { removalInEffect, type SignerRemoval } from "@/lib/stellar/signers";

/**
 * The full proof chain under a qdit receipt (WP-3.3): CONTRACT.md section
 * 12's four facts as an ordered list, plan version, submitted, approved,
 * verified, each with its state in words (never colour alone), the ledger
 * or time where known, and the transaction or, where no transaction is on
 * record, the contract's page and why it is not on record. Folded by default
 * inside the receipt; the data and its states are in
 * lib/integrations/qdit-proof-chain.ts. Rendered only inside the receipts,
 * so only with NEXT_PUBLIC_QDIT_INTEGRATION=1.
 */

const LINK = "text-primary underline-offset-2 hover:underline";

const STATE_TAG: Record<StepState, { tone: "verified" | "planned" | "warning"; text: string }> = {
  done: { tone: "verified", text: "Done" },
  pending: { tone: "planned", text: "Pending" },
  unchecked: { tone: "warning", text: "Could not check" },
};

const TITLES = {
  plan: "Plan version",
  submitted: "Submitted",
  approved: "Approved",
  verified: "Verified",
} as const;

/** UTC, to the minute, from ledger seconds or an ISO time. */
function utc(value: number | string): string {
  const date = typeof value === "number" ? new Date(value * 1000) : new Date(value);
  return date.toISOString().slice(0, 16).replace("T", " ") + " UTC";
}

function short(hash: string): string {
  return `${hash.slice(0, 8)}…${hash.slice(-8)}`;
}

function Tx({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a className={LINK} href={href} target="_blank" rel="noreferrer">
      {children}
    </a>
  );
}

/**
 * Where no transaction is on record: the contract's page, and why (section
 * 12). Doqtri never records submissions, so that one is a fact, not the
 * window; an approval it records may have been missed, as WP-3.1 words it.
 */
function NoTx({ what, milestone: ref }: { what: "submission" | "approval"; milestone: QditArtifactRef }) {
  const contract = (
    <Tx href={qditExplorerUrl(ref.network, "contract", ref.contractId)}>contract&apos;s history on Stellar Expert</Tx>
  );
  if (what === "submission") {
    return (
      <span data-testid="chain-no-tx">
        Doqtri does not record submission transactions; the {contract} lists it.
      </span>
    );
  }
  return (
    <span data-testid="chain-no-tx">
      Doqtri has no record of the approval transaction: it may be older than Stellar RPC&apos;s event window (about 7
      days), or Doqtri did not see it in time. The {contract} lists it.
    </span>
  );
}

function Version({ label, v }: { label: string; v: PlanVersion }) {
  return (
    <span className="block">
      {label} <strong className="text-foreground">v{v.version}</strong> · SHA-256{" "}
      <span className="font-mono" title={v.contentHash}>
        {short(v.contentHash)}
      </span>
      {v.closedAt ? <> · anchored {utc(v.closedAt)}</> : null}
      {v.txHash ? (
        <>
          {" · "}
          <Tx href={expertTxUrl(v.txHash)}>anchoring transaction →</Tx>
        </>
      ) : null}
    </span>
  );
}

function PlanBody({ step, updatedAt }: { step: PlanStep; updatedAt: number }) {
  const { current, signedAt } = step;
  if (!signedAt) {
    return (
      <>
        <Version label="Current plan version" v={current} />
        <span className="block">
          Last updated {utc(updatedAt)}. Which plan version was in effect when this heading was signed is not in the
          history read just now.
        </span>
      </>
    );
  }
  if (signedAt.version === current.version) return <Version label="Signed at the current plan version" v={current} />;
  return (
    <>
      <Version label="Signed at plan version" v={signedAt} />
      <Version label="Current plan version" v={current} />
      <span className="block">The plan has been anchored again since this heading was signed.</span>
    </>
  );
}

function uncheckedText(reason: UncheckedReason, step: SubmittedStep | ApprovedStep): string {
  const v = step.version != null ? `v${step.version}` : "the version it names";
  switch (reason) {
    case "unreachable":
      return "qdit's milestone_proof contract could not be read just now. This says nothing about the milestone; try again in a moment.";
    case "invalid_ref":
      return "The record's artifact_ref does not follow the integration contract's grammar, so there is nothing to check.";
    case "link":
      return "Doqtri could not read its own records just now to check which qdit contract this record may name.";
    case "mismatch":
      return "This record does not match a qdit project and contract registered in Doqtri for this note, so the contract it names was not read.";
    case "missing":
      return `qdit's contract has no record of this milestone, though this heading was signed against ${v}.`;
    case "older":
      return `qdit's contract holds v${step.chain?.version}, older than ${v}, the version this heading was signed against.`;
  }
}

function SubmittedBody({ step, milestone: ref }: { step: SubmittedStep; milestone: QditArtifactRef | null }) {
  if (step.state === "unchecked" || !ref || !step.chain) {
    return <span className="block">{uncheckedText(step.reason ?? "missing", step)}</span>;
  }
  const { chain } = step;
  const asOf = step.ledger != null ? ` as of ledger ${step.ledger.toLocaleString("en-US")}` : "";
  if (step.state === "pending") {
    return (
      <span className="block">
        qdit&apos;s contract holds v{chain.version} as Proposed{asOf}: not submitted yet.
      </span>
    );
  }
  return (
    <>
      <span className="block">
        {step.newer ? (
          <>
            v{step.version} was submitted; the chain now holds a newer submission,{" "}
            <strong className="text-foreground">v{chain.version}</strong> ({chain.status})
          </>
        ) : (
          <>
            <strong className="text-foreground">v{chain.version}</strong> submitted, now {chain.status}
          </>
        )}
        {asOf}.
      </span>
      <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span>
          Proof hash{" "}
          <span className="font-mono" title={chain.proofHash}>
            {short(chain.proofHash)}
          </span>
        </span>
        {chain.submitter ? (
          <span className="inline-flex items-center gap-1">
            · by <SignerAddress address={chain.submitter} href={qditAddressUrl(ref.network, chain.submitter)} />
          </span>
        ) : null}
        {/* Ledger time is never 0 on a real network; the Soroban test host leaves it there. */}
        {chain.timestamp > 0 ? <span>· at {utc(chain.timestamp)}</span> : null}
      </span>
      <span className="block">
        <NoTx what="submission" milestone={ref} />
      </span>
    </>
  );
}

function ApprovedBody({ step, milestone: ref }: { step: ApprovedStep; milestone: QditArtifactRef | null }) {
  if (step.state === "unchecked" || !ref || !step.chain) {
    return <span className="block">Not checked: the submission above could not be checked.</span>;
  }
  const { chain } = step;
  const tx = step.txHash ? (
    <>
      <Tx href={qditExplorerUrl(ref.network, "tx", step.txHash)}>
        Approval transaction{step.newer ? ` of v${chain.version}` : ""} →
      </Tx>
      {step.txLedger != null ? ` (ledger ${step.txLedger.toLocaleString("en-US")})` : null}
    </>
  ) : null;
  if (step.state === "done") {
    return (
      <span className="block">
        Approved at <strong className="text-foreground">v{chain.version}</strong>, the version this heading was signed
        against. {tx ?? <NoTx what="approval" milestone={ref} />}
      </span>
    );
  }
  if (step.newer) {
    return (
      <span className="block">
        v{step.version} is not the approved version: the milestone was resubmitted as v{chain.version}, which the chain
        now says is {chain.status}. {tx}
      </span>
    );
  }
  return (
    <span className="block">
      {chain.status === "Rejected"
        ? `Rejected at v${chain.version}: not approved.`
        : `Not approved yet: the chain says ${chain.status} at v${chain.version}.`}
    </span>
  );
}

function VerifiedBody({
  step,
  approved,
  removals,
}: {
  step: VerifiedStep;
  approved: ApprovedStep;
  removals: readonly SignerRemoval[];
}) {
  const { signing } = step;
  // D-16: the same flag the version history shows for this signature.
  const removal = signing?.signer ? removalInEffect(signing.signer, signing.closedAt, removals) : null;
  const what =
    step.state === "done" ? (
      <>
        Signed <strong className="text-foreground">Verified</strong> in Doqtri with tool &quot;qdit&quot;, against the
        approved v{approved.version}.
      </>
    ) : step.state === "unchecked" ? (
      approved.chain && approved.state !== "unchecked" ? (
        <>
          Signed as Verified; the chain now says {approved.chain.status} at v{approved.chain.version}, so this heading
          is not shown as verified.
        </>
      ) : (
        <>Signed as Verified, but the approval above could not be checked, so this heading is not shown as verified.</>
      )
    ) : approved.state === "done" ? (
      <>qdit approved v{approved.version}; Doqtri&apos;s record still says {step.status}, not yet signed Verified.</>
    ) : (
      <>Doqtri&apos;s record says {step.status}: not signed Verified.</>
    );
  const at = step.updatedAt != null && step.updatedAt > 0 ? utc(step.updatedAt) : signing ? utc(signing.closedAt) : null;
  return (
    <>
      <span className="block">{what}</span>
      <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
        {signing?.signer ? (
          <span className="inline-flex items-center gap-1">
            Signed by <SignerAddress address={signing.signer} owner={signing.signerFrom === "owner"} />
          </span>
        ) : null}
        {removal ? (
          <StatusTag
            tone="danger"
            data-testid="chain-signed-after-removal"
            title={`Doqtri removed this wallet from the note's workspace ${utc(removal.removedAt)}, before this was signed`}
          >
            Signed after removal
          </StatusTag>
        ) : null}
        {at ? <span>· recorded {at}</span> : null}
        {signing ? (
          <span>
            · <Tx href={expertTxUrl(signing.txHash)}>signing transaction →</Tx>
          </span>
        ) : (
          <span>· its transaction was not in the history read just now</span>
        )}
      </span>
    </>
  );
}

export function ProofChainView({
  chain,
  docId,
  milestone: ref,
  updatedAt,
  removals,
}: {
  chain: ProofChain;
  docId: string;
  /** The receipt's parsed artifact_ref; null when it does not parse. */
  milestone: QditArtifactRef | null;
  /** The Document's own update time (seconds). */
  updatedAt: number;
  /** The note's signer removals (D-16), as the page read them. */
  removals: readonly SignerRemoval[];
}) {
  const [plan, submitted, approved, verified] = chain.steps;
  // Only a ref checked against the note's linked project is offered as qdit's.
  const { qditContract } = chain;
  const bodies = [
    <PlanBody key="plan" step={plan} updatedAt={updatedAt} />,
    <SubmittedBody key="submitted" step={submitted} milestone={ref} />,
    <ApprovedBody key="approved" step={approved} milestone={ref} />,
    <VerifiedBody key="verified" step={verified} approved={approved} removals={removals} />,
  ];
  return (
    <details data-testid="proof-chain" className="text-[12px]">
      <summary className="text-primary cursor-pointer select-none">
        Full proof chain: {chain.done} of 4 steps done
      </summary>
      <ol className="mt-2 grid list-decimal gap-2.5 pl-5" aria-label="Proof chain, from plan version to verified">
        {chain.steps.map((step, i) => (
          <li key={step.key} data-testid={`chain-step-${step.key}`} data-state={step.state} className="pl-1">
            <span className="flex flex-wrap items-center gap-2">
              <span className="text-foreground font-medium">{TITLES[step.key]}</span>
              <StatusTag tone={STATE_TAG[step.state].tone}>{STATE_TAG[step.state].text}</StatusTag>
            </span>
            <span className="text-muted-foreground mt-0.5 grid gap-0.5">{bodies[i]}</span>
          </li>
        ))}
      </ol>
      <p data-testid="chain-check-yourself" className="text-muted-foreground mt-2.5">
        How to check this yourself: open each link above on Stellar Expert, then read the current state on the{" "}
        <Tx href={expertContractUrl(CONTRACT_ID)}>DoqtriRegistry contract</Tx> (
        <span className="font-mono break-all">
          get_document(&quot;{docId}&quot;), get_node(&quot;{docId}&quot;, &quot;{chain.nodeId}&quot;)
        </span>
        ){qditContract ? (
          <>
            {" "}and{" "}
            <Tx href={qditExplorerUrl(qditContract.network, "contract", qditContract.contractId)}>
              qdit&apos;s milestone_proof contract
            </Tx>{" "}
            (
            <span className="font-mono break-all">
              get_milestone_status(&quot;{qditContract.projectId}&quot;, &quot;{qditContract.milestoneId}&quot;)
            </span>
            )
          </>
        ) : null}
        .
      </p>
    </details>
  );
}

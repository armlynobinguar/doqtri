import { buildMindmap, type MindmapNode } from "@/lib/mindmap";

/**
 * Which linked headings moved or were renamed in a save (WP-2.5, R-03).
 *
 * Node ids are positional (`h0`, `h1`, ... in document order, lib/mindmap.ts),
 * so inserting a heading shifts every id after it, and a link made against
 * `h3` would silently point at a different heading. Every save therefore
 * compares each link's stored `(node_id, node_label)` with the saved
 * headings, following docs/integration/CONTRACT.md section 11, moves before
 * renames, labels compared after trimming, case-sensitive:
 *
 *   1. the heading at the link's id still reads its label: keep;
 *   2. the label appears at exactly one other id: it moved there;
 *   3. at more than one other id: ambiguous, the owner relinks;
 *   4. nowhere, and the id still exists: the heading was renamed;
 *   5. nowhere, and the id is gone: the heading was deleted.
 *
 * Structure settles what labels alone cannot, when the text before the save
 * is known: the old and new heading lists are aligned (a longest common
 * subsequence of their labels), so a heading that kept its label is found
 * among several of the same name by where it sits, and a rename is the one
 * new heading that took the old one's place between the same unchanged
 * neighbours. Without it, a heading inserted above a renamed one would make
 * rule 4 rename the milestone after the inserted heading. Where structure
 * cannot decide either, the link is ambiguous rather than guessed.
 *
 * Two links never end up on one heading: a move or rename onto a heading
 * another link keeps, or that two links both claim, is downgraded to
 * ambiguous and stays where it was; a flagged link in a mover's way is
 * parked past the last heading.
 *
 * Pure: the save route applies the result (lib/integrations/qdit-linking.ts).
 */

export type Heading = { id: string; label: string; depth: number };

/** The note's headings in document order, without the root (the title). */
export function headingsOf(title: string, markdown: string): Heading[] {
  const out: Heading[] = [];
  const walk = (nodes: MindmapNode[], depth: number) => {
    for (const node of nodes) {
      out.push({ id: node.id, label: node.label.trim(), depth });
      walk(node.children, depth + 1);
    }
  };
  walk(buildMindmap(title, markdown).children, 1);
  // buildMindmap numbers headings in document order; the walk is depth-first
  // in that same order, so `out` is already sorted by position.
  return out;
}

export type RemapLink = {
  id: string;
  provider: "github" | "qdit";
  nodeId: string;
  nodeLabel: string;
  qditState?: QditLinkState | null;
};

export type QditLinkState = "linked" | "pending" | "ambiguous" | "broken" | "conflict";

export type RemapOutcome =
  | { kind: "keep" }
  | { kind: "move"; to: string }
  | { kind: "rename"; to: string; label: string }
  | { kind: "ambiguous" }
  | { kind: "deleted" }
  /** A GitHub link whose heading was renamed or deleted: left alone, shown as moved. */
  | { kind: "stale" }
  /** Moved out of another link's way to an id with no heading, still flagged. */
  | { kind: "park"; to: string; as: "ambiguous" | "deleted" | "stale" };

/** Above this many label comparisons the alignment is skipped (labels only). */
const MAX_ALIGNMENT_CELLS = 4_000_000;

/**
 * Pairs old heading indexes with new ones whose labels are equal, keeping
 * order (a longest common subsequence). Null when the lists are too long to
 * align cheaply.
 */
export function alignHeadings(before: Heading[], after: Heading[]): Map<number, number> | null {
  const n = before.length;
  const m = after.length;
  if (n * m > MAX_ALIGNMENT_CELLS) return null;
  // lcs[i][j]: length of the LCS of before[i..] and after[j..].
  const lcs: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] =
        before[i].label === after[j].label ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const pairs = new Map<number, number>();
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (before[i].label === after[j].label) {
      pairs.set(i, j);
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      i++;
    } else {
      j++;
    }
  }
  return pairs;
}

type Structure = {
  /** Old index of each old heading id. */
  oldIndex: Map<string, number>;
  pairs: Map<number, number>;
  /** New index paired with each old index, in both directions. */
  newPaired: Set<number>;
  before: Heading[];
};

function structureOf(before: Heading[] | null, after: Heading[]): Structure | null {
  if (!before) return null;
  const pairs = alignHeadings(before, after);
  if (!pairs) return null;
  return {
    oldIndex: new Map(before.map((h, i) => [h.id, i])),
    pairs,
    newPaired: new Set(pairs.values()),
    before,
  };
}

/**
 * The new heading that took the place of old heading `oi`, which has no
 * counterpart of the same label: the unpaired new headings between the same
 * paired neighbours, matched by position when both sides of that gap hold
 * the same number of unpaired headings. `deleted` when the gap is empty on
 * the new side; null when the counts differ and nothing can be said.
 */
function replacementOf(s: Structure, oi: number, after: Heading[]): number | "deleted" | null {
  let lo = oi - 1;
  while (lo >= 0 && !s.pairs.has(lo)) lo--;
  let hi = oi + 1;
  while (hi < s.before.length && !s.pairs.has(hi)) hi++;
  const newLo = lo >= 0 ? s.pairs.get(lo)! : -1;
  const newHi = hi < s.before.length ? s.pairs.get(hi)! : after.length;

  const oldGap: number[] = [];
  for (let k = lo + 1; k < hi; k++) oldGap.push(k);
  const newGap: number[] = [];
  for (let k = newLo + 1; k < newHi; k++) if (!s.newPaired.has(k)) newGap.push(k);

  if (newGap.length === 0) return "deleted";
  if (newGap.length !== oldGap.length) return null;
  return newGap[oldGap.indexOf(oi)];
}

function decide(
  link: RemapLink,
  after: Heading[],
  byId: Map<string, number>,
  idsByLabel: Map<string, string[]>,
  s: Structure | null,
): RemapOutcome {
  const label = link.nodeLabel.trim();
  const at = byId.get(link.nodeId);
  // 1. Still there.
  if (at !== undefined && after[at].label === label) return { kind: "keep" };

  // The old text, when it agrees with the stored link, tells where the
  // heading sat; otherwise (the link was already stale) only labels count.
  const oi = s?.oldIndex.get(link.nodeId);
  const known = s && oi !== undefined && s.before[oi].label === label ? oi : undefined;

  const others = (idsByLabel.get(label) ?? []).filter((id) => id !== link.nodeId);
  // 2. Moved.
  if (others.length === 1) return { kind: "move", to: others[0] };
  // 3. Several candidates: the alignment may know which one it is.
  if (others.length > 1) {
    if (known !== undefined) {
      const paired = s!.pairs.get(known);
      if (paired !== undefined && others.includes(after[paired].id)) return { kind: "move", to: after[paired].id };
    }
    return { kind: "ambiguous" };
  }

  // 4 and 5. The label is gone.
  if (known !== undefined) {
    const replaced = replacementOf(s!, known, after);
    if (replaced === "deleted") return { kind: "deleted" };
    if (replaced === null) return { kind: "ambiguous" };
    return { kind: "rename", to: after[replaced].id, label: after[replaced].label };
  }
  if (at !== undefined) return { kind: "rename", to: link.nodeId, label: after[at].label };
  return { kind: "deleted" };
}

/** Where a link ends up: its own id unless the outcome changes it. */
function target(link: RemapLink, outcome: RemapOutcome): string {
  if (outcome.kind === "move" || outcome.kind === "rename" || outcome.kind === "park") return outcome.to;
  return link.nodeId;
}

/**
 * What a provider follows. GitHub links follow where their heading went, so
 * an inserted or deleted heading does not leave them on the wrong id (and in
 * the way of a qdit link moving there); a renamed or deleted heading still
 * shows as moved in the ship panel and is relinked by hand, as before, so a
 * GitHub link never takes a new label and is never flagged.
 */
function effective(link: RemapLink, outcome: RemapOutcome): RemapOutcome {
  if (link.provider !== "github") return outcome;
  if (outcome.kind === "move" || outcome.kind === "keep") return outcome;
  if (outcome.kind === "rename" && outcome.to !== link.nodeId) return { kind: "move", to: outcome.to };
  return { kind: "stale" };
}

/**
 * A qdit link already flagged waits for the owner to relink it: its stored
 * id may be a parking id, or a heading that has nothing to do with it any
 * more, so "the label is gone but the id exists" says nothing about a
 * rename. Its heading coming back (keep, or a unique move) still counts.
 */
function settled(link: RemapLink, outcome: RemapOutcome): RemapOutcome {
  const flagged = link.qditState === "ambiguous" || link.qditState === "broken" || link.qditState === "conflict";
  if (link.provider !== "qdit" || !flagged || outcome.kind !== "rename") return outcome;
  return link.qditState === "broken" ? { kind: "deleted" } : { kind: "ambiguous" };
}

type Yielding = Extract<RemapOutcome, { kind: "ambiguous" | "deleted" | "stale" }>;

/** A link whose own heading is gone or unclear: it gives way to one moving onto its id. */
function yields(o: RemapOutcome): o is Yielding {
  return o.kind === "ambiguous" || o.kind === "deleted" || o.kind === "stale";
}

function hIndex(id: string): number {
  const m = /^h(\d+)$/.exec(id);
  return m ? Number(m[1]) : -1;
}

/**
 * Each link's outcome for the headings `after` the save. `before` is the
 * note's headings as the save found them, or null if not known.
 */
export function planRemap(
  links: RemapLink[],
  after: Heading[],
  before: Heading[] | null = null,
): Map<string, RemapOutcome> {
  const byId = new Map(after.map((h, i) => [h.id, i]));
  const idsByLabel = new Map<string, string[]>();
  for (const h of after) idsByLabel.set(h.label, [...(idsByLabel.get(h.label) ?? []), h.id]);
  const s = structureOf(before, after);

  const plan = new Map<string, RemapOutcome>();
  for (const link of links) {
    // The root is the note's title: it never moves, and its label is the
    // note's title, not a heading's.
    if (link.nodeId === "root") {
      plan.set(link.id, { kind: "keep" });
      continue;
    }
    plan.set(link.id, effective(link, settled(link, decide(link, after, byId, idsByLabel, s))));
  }

  // A rename is only a rename if no other link moved onto that heading
  // (moves first): otherwise this link's heading is gone.
  const moveTargets = new Set([...plan.values()].flatMap((o) => (o.kind === "move" ? [o.to] : [])));
  for (const link of links) {
    const o = plan.get(link.id)!;
    if (o.kind === "rename" && moveTargets.has(o.to)) plan.set(link.id, { kind: "deleted" });
  }

  // No two links on one heading. A link that keeps its heading holds it, and
  // whoever moves onto it stays where it was, flagged. Otherwise a single
  // link moving onto an id wins it, and two or more stay. A flagged link in
  // the way is parked on an id past the last heading, where no heading is,
  // so that deleting a heading lets every linked heading after it move up.
  let nextPark = Math.max(after.length, ...links.map((l) => hIndex(l.nodeId) + 1));
  const byLink = new Map(links.map((l) => [l.id, l]));
  const demote = (link: RemapLink): RemapOutcome =>
    link.provider === "github" ? { kind: "stale" } : { kind: "ambiguous" };
  for (;;) {
    const holders = new Map<string, string[]>();
    for (const link of links) {
      const id = target(link, plan.get(link.id)!);
      holders.set(id, [...(holders.get(id) ?? []), link.id]);
    }
    let changed = false;
    for (const ids of holders.values()) {
      if (ids.length < 2) continue;
      const firm = ids.some((id) => plan.get(id)!.kind === "keep");
      const movers = ids.filter((id) => ["move", "rename"].includes(plan.get(id)!.kind));
      // Flagged before any demotion below: a demoted mover goes back to its
      // own id, not this one.
      const flagged = ids.filter((id) => yields(plan.get(id)!));
      if (firm || movers.length > 1) {
        for (const id of movers) plan.set(id, demote(byLink.get(id)!));
        if (movers.length > 0) changed = true;
      }
      if (firm || movers.length === 1) {
        for (const id of flagged) {
          const o = plan.get(id) as Yielding;
          plan.set(id, { kind: "park", to: `h${nextPark++}`, as: o.kind });
          changed = true;
        }
      }
    }
    if (!changed) break;
  }
  return plan;
}

/** One row of apply_node_link_remap()'s p_changes. */
export type RemapChange = {
  id: string;
  node_id: string;
  node_label?: string;
  qdit_state?: QditLinkState;
};

/**
 * The database changes for a plan: only rows that change. A qdit link that
 * moves or is renamed becomes `pending` until qdit has been told; one that
 * reads right again after being flagged is re-sent too, since nothing says
 * what qdit holds for it now.
 */
export function remapChanges(links: RemapLink[], plan: Map<string, RemapOutcome>): RemapChange[] {
  const changes: RemapChange[] = [];
  for (const link of links) {
    const o = plan.get(link.id);
    if (!o) continue;
    const qdit = link.provider === "qdit";
    const state = link.qditState ?? null;
    switch (o.kind) {
      case "keep":
        if (qdit && (state === "ambiguous" || state === "broken" || state === "conflict")) {
          changes.push({ id: link.id, node_id: link.nodeId, qdit_state: "pending" });
        }
        break;
      case "move":
        changes.push({ id: link.id, node_id: o.to, ...(qdit ? { qdit_state: "pending" as const } : {}) });
        break;
      case "rename":
        changes.push({ id: link.id, node_id: o.to, node_label: o.label, qdit_state: "pending" });
        break;
      case "ambiguous":
        if (state !== "ambiguous") changes.push({ id: link.id, node_id: link.nodeId, qdit_state: "ambiguous" });
        break;
      case "deleted":
        if (state !== "broken") changes.push({ id: link.id, node_id: link.nodeId, qdit_state: "broken" });
        break;
      case "stale":
        break;
      case "park":
        changes.push({
          id: link.id,
          node_id: o.to,
          ...(qdit ? { qdit_state: o.as === "ambiguous" ? ("ambiguous" as const) : ("broken" as const) } : {}),
        });
        break;
    }
  }
  return changes;
}

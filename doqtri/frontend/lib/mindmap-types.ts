import { buildMindmap, type MindmapNode } from "@/lib/mindmap";

/**
 * A node in a document's concept mindmap.
 *
 * `kind` is derived from depth rather than meaning — root, then themes, then
 * concepts, then details — so the canvas can size and color nodes without
 * walking back up the tree.
 */
export type ConceptKind = "root" | "theme" | "concept" | "detail";

export type ConceptNode = {
  id: string;
  label: string;
  kind: ConceptKind;
  /** One line, shown on hover. Optional: the model omits it for thin nodes. */
  summary?: string;
  children: ConceptNode[];
};

/**
 * What is stored in `documents.mindmap`.
 *
 * `concepts` is the flattened, canonicalized label list. It is stored rather
 * than recomputed because it is the join key for the global mindmap, which
 * reads many rows at once and should not have to walk every tree to merge them.
 */
export type DocMindmap = {
  version: 1;
  root: ConceptNode;
  concepts: string[];
};

/** The tree shape the model is asked to return, before ids are assigned. */
export type RawConceptNode = {
  label: string;
  summary?: string;
  children?: RawConceptNode[];
};

/** Matches the caps stated in the extraction schema; also enforced here. */
export const MAX_DEPTH = 3;
export const MAX_CHILDREN = 7;

export const KIND_BY_DEPTH: ConceptKind[] = ["root", "theme", "concept", "detail"];

function kindForDepth(depth: number): ConceptKind {
  return KIND_BY_DEPTH[Math.min(depth, KIND_BY_DEPTH.length - 1)];
}

/** Concept labels are matched case- and whitespace-insensitively, like titles. */
export function normalizeConcept(label: string): string {
  return label.trim().toLowerCase().replace(/\s+/g, " ");
}

/** Every label under `node`, excluding the root, deduped, in document order. */
export function flattenConcepts(root: ConceptNode): string[] {
  const seen = new Set<string>();
  const labels: string[] = [];

  function walk(node: ConceptNode) {
    for (const child of node.children) {
      const key = normalizeConcept(child.label);
      if (key.length > 0 && !seen.has(key)) {
        seen.add(key);
        labels.push(child.label.trim());
      }
      walk(child);
    }
  }

  walk(root);
  return labels;
}

/**
 * Turns the model's raw tree into a `DocMindmap`, assigning stable ids and
 * clamping depth and breadth.
 *
 * The caps are in the JSON schema too, but a model that overshoots them should
 * degrade to a smaller map rather than fail the whole ingest, so they are
 * enforced again here.
 */
export function toDocMindmap(title: string, raw: RawConceptNode): DocMindmap {
  let counter = 0;

  function build(node: RawConceptNode, depth: number): ConceptNode {
    const children =
      depth >= MAX_DEPTH
        ? []
        : (node.children ?? [])
            .filter((child) => child.label.trim().length > 0)
            .slice(0, MAX_CHILDREN)
            .map((child) => build(child, depth + 1));

    const summary = node.summary?.trim();

    return {
      id: depth === 0 ? "root" : `c${counter++}`,
      label: node.label.trim(),
      kind: kindForDepth(depth),
      ...(summary ? { summary } : {}),
      children,
    };
  }

  // The model is told to use the document title as the root, but it renames it
  // often enough that the stored title wins — the two must agree for the global
  // mindmap to attach concepts to the right document.
  const root = build({ ...raw, label: title }, 0);

  return { version: 1, root, concepts: flattenConcepts(root) };
}

/**
 * Validates a `documents.mindmap` value read back from Postgres.
 *
 * Returns null rather than throwing for anything unrecognized: a malformed or
 * older-version row is not an error, it just means the caller falls back to the
 * heading tree.
 */
export function parseDocMindmap(value: unknown): DocMindmap | null {
  if (!value || typeof value !== "object") return null;

  const candidate = value as Partial<DocMindmap>;
  if (candidate.version !== 1) return null;

  const root = parseNode(candidate.root, 0);
  if (!root) return null;

  const concepts = Array.isArray(candidate.concepts)
    ? candidate.concepts.filter((label): label is string => typeof label === "string")
    : flattenConcepts(root);

  return { version: 1, root, concepts };
}

function parseNode(value: unknown, depth: number): ConceptNode | null {
  if (!value || typeof value !== "object") return null;

  const candidate = value as Partial<ConceptNode>;
  if (typeof candidate.id !== "string" || typeof candidate.label !== "string") {
    return null;
  }
  if (candidate.label.trim().length === 0) return null;

  const children =
    depth >= MAX_DEPTH || !Array.isArray(candidate.children)
      ? []
      : candidate.children
          .map((child) => parseNode(child, depth + 1))
          .filter((child): child is ConceptNode => child !== null);

  return {
    id: candidate.id,
    label: candidate.label,
    kind: kindForDepth(depth),
    ...(typeof candidate.summary === "string" && candidate.summary.length > 0
      ? { summary: candidate.summary }
      : {}),
    children,
  };
}

/**
 * The fallback map: the heading hierarchy, shaped as a concept tree.
 *
 * Used when a document has no stored mindmap — extraction failed, has not run
 * yet, or the row predates the feature. It is thin by design; the whole reason
 * the stored map exists is that headings alone say very little about a flat
 * document.
 */
export function mindmapFromHeadings(title: string, markdown: string): DocMindmap {
  const root = convert(buildMindmap(title, markdown), 0);
  return { version: 1, root, concepts: flattenConcepts(root) };
}

function convert(node: MindmapNode, depth: number): ConceptNode {
  return {
    id: node.id,
    label: node.label,
    kind: kindForDepth(depth),
    children:
      depth >= MAX_DEPTH
        ? []
        : node.children.map((child) => convert(child, depth + 1)),
  };
}

import { parseLinks } from "@/lib/wikilinks";
import {
  mindmapFromHeadings,
  normalizeConcept,
  type ConceptNode,
  type DocMindmap,
} from "@/lib/mindmap-types";
import type { MapNode, MindmapGraph } from "@/lib/mindmap-graph";
import type { Doc } from "@/lib/types";

/**
 * The vault-wide mindmap: every document's concepts in one map, merged on
 * concept name.
 *
 * This is not the vault graph with more nodes. The vault graph relates whole
 * documents through the links written inside them; this relates the *ideas*
 * inside them, so two notes that never link to each other still meet at a
 * concept they both discuss.
 *
 * Three kinds of node come out of it: documents, concepts, and concepts that
 * more than one document reaches — the hubs, which are the only thing here that
 * a single-document vault cannot produce.
 */

const DOC_PREFIX = "doc:";
const CONCEPT_PREFIX = "concept:";

/**
 * What a document contributes when it has no stored mindmap.
 *
 * The heading tree first, since it at least reflects the document's own
 * structure. When there are no headings either, the `[[wikilinks]]` are the
 * only concept-level signal the markdown carries, so they attach directly to
 * the document as a flat ring.
 */
function fallbackTree(doc: Doc): DocMindmap {
  const headings = mindmapFromHeadings(doc.title, doc.markdown);
  if (headings.root.children.length > 0) return headings;

  const seen = new Set<string>();
  const children: ConceptNode[] = [];

  for (const target of parseLinks(doc.markdown)) {
    const key = normalizeConcept(target);
    if (key.length === 0 || seen.has(key)) continue;
    seen.add(key);
    children.push({
      id: `${doc.id}-link-${children.length}`,
      label: target,
      kind: "theme",
      children: [],
    });
  }

  return {
    version: 1,
    root: { id: "root", label: doc.title, kind: "root", children },
    concepts: children.map((child) => child.label),
  };
}

export function buildGlobalMindmap(docs: Doc[]): MindmapGraph {
  // A concept whose name is also a document's title is that document, not a
  // separate idea — the same resolution the vault graph does for [[links]].
  const docIdByTitle = new Map<string, string>();
  for (const doc of docs) {
    docIdByTitle.set(normalizeConcept(doc.title), doc.id);
  }

  const nodes = new Map<string, MapNode>();
  const links: MindmapGraph["links"] = [];
  const seenLinks = new Set<string>();
  /** Which documents reach each concept, which is what promotes it to a hub. */
  const reachedBy = new Map<string, Set<string>>();

  function addLink(source: string, target: string) {
    if (source === target) return;
    const key = `${source} ${target}`;
    if (seenLinks.has(key)) return;
    seenLinks.add(key);
    links.push({ source, target });
  }

  for (const doc of docs) {
    const docNodeId = `${DOC_PREFIX}${doc.id}`;
    nodes.set(docNodeId, {
      id: docNodeId,
      label: doc.title,
      kind: "document",
      depth: 0,
      href: `/vault/${doc.id}/mindmap`,
    });
  }

  for (const doc of docs) {
    const docNodeId = `${DOC_PREFIX}${doc.id}`;
    const tree = doc.mindmap ?? fallbackTree(doc);

    function walk(node: ConceptNode, parentId: string, depth: number) {
      for (const child of node.children) {
        const key = normalizeConcept(child.label);
        if (key.length === 0) continue;

        const otherDocId = docIdByTitle.get(key);
        let childId: string;

        if (otherDocId !== undefined && otherDocId !== doc.id) {
          // The concept is another note. Point at it rather than duplicating
          // its title as a concept node.
          childId = `${DOC_PREFIX}${otherDocId}`;
        } else if (otherDocId === doc.id) {
          // A concept named after its own document: skip the node, keep the
          // subtree, so the map does not grow a self-loop.
          walk(child, parentId, depth);
          continue;
        } else {
          childId = `${CONCEPT_PREFIX}${key}`;
          const existing = nodes.get(childId);

          if (existing) {
            // Keep the shallowest position: a concept that is a theme in one
            // note should not be buried because another note nests it deeper.
            existing.depth = Math.min(existing.depth, depth);
            if (!existing.summary && child.summary) existing.summary = child.summary;
          } else {
            nodes.set(childId, {
              id: childId,
              label: child.label.trim(),
              kind: "concept",
              depth,
              ...(child.summary ? { summary: child.summary } : {}),
            });
          }

          const owners = reachedBy.get(childId) ?? new Set<string>();
          owners.add(doc.id);
          reachedBy.set(childId, owners);
        }

        addLink(parentId, childId);
        walk(child, childId, depth + 1);
      }
    }

    walk(tree.root, docNodeId, 1);
  }

  for (const [conceptId, owners] of reachedBy) {
    if (owners.size < 2) continue;
    const node = nodes.get(conceptId);
    if (node) node.kind = "hub";
  }

  return { nodes: [...nodes.values()], links };
}

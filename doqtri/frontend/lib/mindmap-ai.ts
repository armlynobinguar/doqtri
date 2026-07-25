import OpenAI from "openai";
import { parseLinks } from "@/lib/wikilinks";
import {
  MAX_CHILDREN,
  MAX_DEPTH,
  toDocMindmap,
  type DocMindmap,
  type RawConceptNode,
} from "@/lib/mindmap-types";

/**
 * Concept extraction for the document mindmap.
 *
 * Separate from lib/openai.ts on purpose: that module owns the markdown
 * conversion, which is the thing the user edits. This one owns a derived view
 * that is allowed to fail — every caller treats an error here as "no mindmap
 * yet", never as a failed ingest.
 */

function client(): OpenAI {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "OPENAI_API_KEY is not set. Add it to .env.local to enable mindmap extraction.",
    );
  }
  return new OpenAI({ apiKey });
}

function model(): string {
  return process.env.OPENAI_MODEL || "gpt-4o";
}

/**
 * Very long documents are truncated before extraction.
 *
 * The mindmap wants the shape of the argument, not every sentence of it, and a
 * whole 200-page PDF in the prompt costs far more than the map is worth. The
 * heading structure that survives truncation is the part that matters most.
 */
const MAX_INPUT_CHARS = 60_000;

const INSTRUCTIONS = [
  "You build a mindmap of a single document.",
  "Return the document's ideas as a tree: top-level nodes are its major themes,",
  "their children are the concepts each theme covers, and one more level may add",
  "specific details. Label the root with the document's own subject.",
  `Use at most ${MAX_DEPTH} levels below the root and at most ${MAX_CHILDREN} children per node.`,
  "Labels are noun phrases of five words or fewer. Summaries are one short sentence,",
  "or null when the label already says everything.",
  "Map what the document actually says. Do not add outside knowledge, and do not",
  "invent themes to fill the tree — a thin document gets a small map.",
].join(" ");

/**
 * The node shape at each level, built outward from the leaves.
 *
 * Written as explicit nesting rather than a recursive `$ref` so the depth cap
 * is structural: the model cannot return a fourth level because the schema has
 * nowhere to put one. Strict mode requires every property to be listed in
 * `required`, so optional fields are nullable instead of absent.
 */
function nodeSchema(children: Record<string, unknown> | null): Record<string, unknown> {
  const properties: Record<string, unknown> = {
    label: { type: "string", description: "Noun phrase, five words or fewer." },
    summary: {
      type: ["string", "null"],
      description: "One short sentence, or null.",
    },
  };

  if (children) {
    properties.children = { type: "array", maxItems: MAX_CHILDREN, items: children };
  }

  return {
    type: "object",
    additionalProperties: false,
    properties,
    required: Object.keys(properties),
  };
}

const MINDMAP_SCHEMA = nodeSchema(
  nodeSchema(nodeSchema(nodeSchema(null))),
) as Record<string, unknown>;

/** What the model returns: `summary` is null rather than absent under strict mode. */
type ModelNode = {
  label: string;
  summary: string | null;
  children?: ModelNode[];
};

function toRaw(node: ModelNode): RawConceptNode {
  return {
    label: node.label,
    ...(node.summary ? { summary: node.summary } : {}),
    children: (node.children ?? []).map(toRaw),
  };
}

/**
 * Extracts the concept mindmap for one document.
 *
 * Throws on an API error or unusable response. Callers decide what that means;
 * at ingest it means the document is saved without a mindmap.
 */
export async function extractMindmap(params: {
  title: string;
  markdown: string;
}): Promise<DocMindmap> {
  const { title, markdown } = params;

  if (markdown.trim().length === 0) {
    throw new Error("Cannot build a mindmap from an empty note.");
  }

  const openai = client();
  const body = markdown.slice(0, MAX_INPUT_CHARS);

  // The markdown already has [[wikilinks]] on its key concepts. Handing those
  // back to the model keeps the mindmap's vocabulary and the vault graph's
  // vocabulary the same, which is what lets the global mindmap join them.
  const vocabulary = [...new Set(parseLinks(body))].slice(0, 60);
  const vocabularyLine =
    vocabulary.length > 0
      ? `\n\nPrefer these existing concept names where they fit: ${vocabulary.join(", ")}.`
      : "";

  const response = await openai.responses.create({
    model: model(),
    instructions: INSTRUCTIONS,
    text: {
      format: {
        type: "json_schema",
        name: "document_mindmap",
        strict: true,
        schema: MINDMAP_SCHEMA,
      },
    },
    input: [
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: `Document title: ${title}\n\n${body}${vocabularyLine}`,
          },
        ],
      },
    ],
  });

  let parsed: ModelNode;
  try {
    parsed = JSON.parse(response.output_text) as ModelNode;
  } catch {
    throw new Error("The model returned a mindmap that could not be parsed.");
  }

  if (typeof parsed?.label !== "string") {
    throw new Error("The model returned a mindmap with no root.");
  }

  const mindmap = toDocMindmap(title, toRaw(parsed));
  if (mindmap.root.children.length === 0) {
    throw new Error("The model returned an empty mindmap.");
  }

  return mindmap;
}

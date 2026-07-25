import OpenAI from "openai";
import { parseOffice } from "officeparser";
import { cleanExtractedMarkdown } from "@/lib/extracted-markdown";

/** Verbatim from the spec. */
const INGEST_INSTRUCTIONS = [
  "Convert this document to clean, faithful Markdown.",
  "Use `#`/`##`/`###` headings to reflect the document's structure.",
  "Wrap key concepts and named entities in `[[double brackets]]`, and add",
  "`[[wikilinks]]` between clearly related topics.",
  "Do not invent content. Output only Markdown, no commentary.",
].join(" ");

/** Verbatim from the spec, with the note titles interpolated. */
function regenerateInstructions(titles: string[]): string {
  const list = titles.length > 0 ? titles.join(", ") : "(none yet)";
  return [
    "Improve the structure of this Markdown note: tighten the heading",
    "hierarchy and add relevant `[[wikilinks]]`.",
    `Prefer linking to these existing notes: ${list}.`,
    "Preserve the author's meaning. Output only Markdown.",
  ].join(" ");
}

function client(): OpenAI {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "OPENAI_API_KEY is not set. Add it to .env.local to enable ingest and regenerate.",
    );
  }
  return new OpenAI({ apiKey });
}

function model(): string {
  return process.env.OPENAI_MODEL || "gpt-4o";
}

/**
 * Strips a ```markdown fence if the model wrapped its whole answer in one,
 * which it does intermittently despite "output only Markdown".
 */
function unfence(text: string): string {
  const trimmed = text.trim();
  const match = /^```(?:markdown|md)?\n([\s\S]*?)\n?```$/.exec(trimmed);
  return (match ? match[1] : trimmed).trim();
}

export type UploadKind = "pdf" | "docx" | "pptx" | "text";

/**
 * Which ingestion path a file takes.
 *
 * PDFs go to the model as a file so it can use layout and any images. DOCX and
 * PPTX are not accepted by OpenAI's file input, so their text is extracted
 * locally first and sent as text. Plain text is sent as-is.
 */
export function classifyUpload(filename: string, mimeType: string): UploadKind | null {
  const extension = filename.toLowerCase().match(/\.([^.]+)$/)?.[1] ?? "";

  if (extension === "pdf" || mimeType === "application/pdf") return "pdf";
  if (extension === "docx") return "docx";
  if (extension === "pptx") return "pptx";
  if (extension === "txt" || extension === "md" || mimeType.startsWith("text/")) {
    return "text";
  }
  return null;
}

/**
 * Pulls the text out of a DOCX/PPTX so it can be sent as a text prompt.
 *
 * `fileType` is required rather than optional: officeparser's magic-byte
 * auto-detection is documented as unreliable when parsing from a buffer, and it
 * does fail inside the bundled route. The extension already told us the format,
 * so the hint is authoritative here.
 */
async function extractOfficeText(
  bytes: Uint8Array,
  fileType: "docx" | "pptx",
): Promise<string> {
  const ast = await parseOffice(bytes, { fileType });
  const { value } = await ast.to("md");
  const raw = typeof value === "string" ? value : String(value);
  return cleanExtractedMarkdown(raw);
}

/**
 * Converts an uploaded document to markdown with headings and [[wikilinks]].
 * Returns markdown only — the caller owns persistence.
 */
export async function markdownFromDocument(params: {
  filename: string;
  mimeType: string;
  bytes: Uint8Array;
  kind: UploadKind;
}): Promise<string> {
  const { filename, bytes, kind } = params;
  const openai = client();

  if (kind === "pdf") {
    const base64 = Buffer.from(bytes).toString("base64");
    const response = await openai.responses.create({
      model: model(),
      instructions: INGEST_INSTRUCTIONS,
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_file",
              filename,
              file_data: `data:application/pdf;base64,${base64}`,
            },
          ],
        },
      ],
    });
    return unfence(response.output_text);
  }

  const text =
    kind === "docx" || kind === "pptx"
      ? await extractOfficeText(bytes, kind)
      : Buffer.from(bytes).toString("utf8");

  if (text.trim().length === 0) {
    throw new Error("No text could be extracted from that document.");
  }

  const response = await openai.responses.create({
    model: model(),
    instructions: INGEST_INSTRUCTIONS,
    input: [{ role: "user", content: [{ type: "input_text", text }] }],
  });

  return unfence(response.output_text);
}

/**
 * Rewrites a note's structure and links. The user's existing note titles are
 * passed in so the model links to notes that actually exist rather than
 * inventing ghost targets.
 */
export async function improveMarkdown(params: {
  markdown: string;
  titles: string[];
}): Promise<string> {
  const { markdown, titles } = params;
  const openai = client();

  const response = await openai.responses.create({
    model: model(),
    instructions: regenerateInstructions(titles),
    input: [{ role: "user", content: [{ type: "input_text", text: markdown }] }],
  });

  const improved = unfence(response.output_text);
  if (improved.length === 0) {
    throw new Error("The model returned an empty note; keeping your version.");
  }
  return improved;
}

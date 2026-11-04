/**
 * A stand-in OpenAI for doqtri's e2e suite (DOQ-18).
 *
 * The app calls OpenAI's Responses API through the official SDK, which reads
 * OPENAI_BASE_URL. playwright.config.ts points that here, so upload, the AI
 * formatting pass, Regenerate and Build mindmap run end to end without a real
 * token being spent.
 *
 * What it answers:
 * - POST /v1/responses: a Response whose output_text depends on the request.
 *   - text.format.name "document_mindmap": a small concept tree as JSON.
 *   - text.format.name "promo_rating": a valid middling rating as JSON.
 *   - instructions starting "Improve the structure" (Regenerate): the note
 *     with OPENAI_STUB_REGENERATE_MARK on top.
 *   - anything else (the ingest formatting pass): the text it was sent, with
 *     OPENAI_STUB_FORMAT_MARK on top, or a fixed note for a PDF. Text that
 *     holds OPENAI_STUB_FAIL_MARKER gets a 500 instead.
 * - GET /v1/models: an empty list (the /admin/ops health probe).
 * - GET /__stub/health, GET /__stub/calls, POST /__stub/reset: for the specs.
 *
 * Every request must carry the e2e key; any other key gets a 401, as OpenAI
 * would answer. Unknown paths get a 404 and are counted, so a spec can see
 * the app asked for something the stub does not know.
 *
 * Run with `node e2e/openai-stub/server.mts`; Node strips the types. It
 * imports only node: built-ins so it needs no build step.
 */
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

const PORT = Number(process.env.OPENAI_STUB_PORT ?? 4020);
const API_KEY = required("OPENAI_STUB_API_KEY");
const FAIL_MARKER = required("OPENAI_STUB_FAIL_MARKER");
const FORMAT_MARK = required("OPENAI_STUB_FORMAT_MARK");
const REGENERATE_MARK = required("OPENAI_STUB_REGENERATE_MARK");
const MINDMAP_THEME = required("OPENAI_STUB_MINDMAP_THEME");

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`openai stub: ${name} is required`);
  return value;
}

type Kind = "format" | "format-pdf" | "format-failed" | "regenerate" | "mindmap" | "promo-rating" | "models" | "unknown";
const calls: Record<Kind, number> = {
  format: 0,
  "format-pdf": 0,
  "format-failed": 0,
  regenerate: 0,
  mindmap: 0,
  "promo-rating": 0,
  models: 0,
  unknown: 0,
};

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}

/** OpenAI's error envelope. */
function openaiError(res: ServerResponse, status: number, message: string, code: string | null = null) {
  send(res, status, { error: { message, type: "invalid_request_error", param: null, code } });
}

type ContentPart = { type?: string; text?: string };
type InputMessage = { content?: ContentPart[] };

/** The user's text parts, joined, and whether a file (a PDF) was attached. */
function readInput(body: Record<string, unknown>): { text: string; hasFile: boolean } {
  const input = Array.isArray(body.input) ? (body.input as InputMessage[]) : [];
  const parts = input.flatMap((message) => (Array.isArray(message.content) ? message.content : []));
  return {
    text: parts
      .filter((part) => part.type === "input_text" && typeof part.text === "string")
      .map((part) => part.text)
      .join("\n"),
    hasFile: parts.some((part) => part.type === "input_file"),
  };
}

/** A Response object with one assistant message; the SDK derives output_text from it. */
function response(model: unknown, text: string) {
  return {
    id: `resp_${randomUUID().replace(/-/g, "")}`,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: "completed",
    model: typeof model === "string" ? model : "e2e-stub-model",
    output: [
      {
        type: "message",
        id: `msg_${randomUUID().replace(/-/g, "")}`,
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text, annotations: [] }],
      },
    ],
    usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
  };
}

function mindmapJson(): string {
  const leaf = (label: string) => ({ label, summary: null, children: [] });
  return JSON.stringify({
    label: "Stub mindmap root",
    summary: null,
    children: [
      { label: MINDMAP_THEME, summary: "Built by the e2e OpenAI stub.", children: [leaf("First stub idea"), leaf("Second stub idea")] },
      { label: "Another stub theme", summary: null, children: [leaf("Third stub idea")] },
    ],
  });
}

function ratingJson(): string {
  const criterion = { score: 3, note: "Scored by the e2e OpenAI stub." };
  return JSON.stringify({
    criteria: { structure: criterion, depth: criterion, clarity: criterion, relevance: criterion, originality: criterion },
    summary: "Scored by the e2e OpenAI stub.",
    flags: [],
  });
}

function formatName(body: Record<string, unknown>): string | null {
  const text = body.text as { format?: { name?: unknown } } | undefined;
  return typeof text?.format?.name === "string" ? text.format.name : null;
}

async function responses(req: IncomingMessage, res: ServerResponse) {
  const body = await readJson(req);
  const format = formatName(body);
  const instructions = typeof body.instructions === "string" ? body.instructions : "";
  const { text, hasFile } = readInput(body);

  if (format === "document_mindmap") {
    calls.mindmap++;
    return send(res, 200, response(body.model, mindmapJson()));
  }
  if (format === "promo_rating") {
    calls["promo-rating"]++;
    return send(res, 200, response(body.model, ratingJson()));
  }
  if (instructions.startsWith("Improve the structure")) {
    calls.regenerate++;
    return send(res, 200, response(body.model, `${REGENERATE_MARK}\n\n${text}`));
  }
  if (hasFile) {
    calls["format-pdf"]++;
    return send(res, 200, response(body.model, `# PDF note\n\n${FORMAT_MARK}\n\nThe stub read the attached PDF.`));
  }
  if (text.includes(FAIL_MARKER)) {
    calls["format-failed"]++;
    return openaiError(res, 500, "The e2e OpenAI stub failed this request on purpose.", "server_error");
  }
  calls.format++;
  return send(res, 200, response(body.model, `${FORMAT_MARK}\n\n${text}`));
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  try {
    if (url.pathname === "/__stub/health") return send(res, 200, { ok: true });
    if (url.pathname === "/__stub/calls" && req.method === "GET") return send(res, 200, calls);
    if (url.pathname === "/__stub/reset" && req.method === "POST") {
      for (const kind of Object.keys(calls) as Kind[]) calls[kind] = 0;
      return send(res, 200, calls);
    }

    if (req.headers.authorization !== `Bearer ${API_KEY}`) {
      return openaiError(res, 401, "Incorrect API key provided (the e2e OpenAI stub accepts only its own key).", "invalid_api_key");
    }
    if (url.pathname === "/v1/responses" && req.method === "POST") return await responses(req, res);
    if (url.pathname === "/v1/models" && req.method === "GET") {
      calls.models++;
      return send(res, 200, { object: "list", data: [] });
    }

    calls.unknown++;
    console.error(`[openai stub] no handler for ${req.method} ${url.pathname}`);
    return openaiError(res, 404, `The e2e OpenAI stub does not answer ${req.method} ${url.pathname}.`);
  } catch (error) {
    console.error("[openai stub]", error);
    return openaiError(res, 500, "The e2e OpenAI stub crashed on this request.");
  }
});

server.listen(PORT, "localhost", () => {
  console.log(`[openai stub] listening on http://localhost:${PORT}`);
});

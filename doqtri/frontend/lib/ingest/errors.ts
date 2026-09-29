/**
 * Typed ingest failures. Client-safe: the upload dialog maps `code` to copy and
 * to whether a retry is worth offering, so the codes are the contract between
 * /api/ingest and the UI — not the free-text `message`.
 */
export const INGEST_ERROR_CODES = [
  "NOT_SIGNED_IN",
  "NO_FILE",
  "EMPTY_FILE",
  "TOO_LARGE",
  "UNSUPPORTED",
  "NOT_FOUND",
  "EXTRACT_FAILED",
  "EXTRACT_TIMEOUT",
  "NO_TEXT",
  "MODEL_FAILED",
  "MODEL_TIMEOUT",
  "EMPTY_OUTPUT",
  "SAVE_FAILED",
  "CONNECTION_LOST",
] as const;

export type IngestErrorCode = (typeof INGEST_ERROR_CODES)[number];

type ErrorCopy = { message: string; retryable: boolean; rawFallback?: boolean };

/**
 * `rawFallback` marks failures where the extracted text is fine and only the AI
 * formatting pass failed, so "import without AI formatting" is a real option.
 */
export const INGEST_ERRORS: Record<IngestErrorCode, ErrorCopy> = {
  NOT_SIGNED_IN: { message: "Your session expired. Reconnect your wallet and try again.", retryable: false },
  NO_FILE: { message: "No file was uploaded.", retryable: false },
  EMPTY_FILE: { message: "That file is empty.", retryable: false },
  TOO_LARGE: { message: "That file is larger than 20 MB.", retryable: false },
  UNSUPPORTED: { message: "Unsupported file type. Use PDF, DOCX, PPTX, or text.", retryable: false },
  NOT_FOUND: { message: "That upload is no longer available. Upload the file again.", retryable: false },
  EXTRACT_FAILED: { message: "The file could not be read. It may be corrupt or password-protected.", retryable: true },
  EXTRACT_TIMEOUT: { message: "Reading the file took too long.", retryable: true },
  NO_TEXT: { message: "No text could be found in that document. Scanned pages are not supported yet.", retryable: false },
  MODEL_FAILED: { message: "The AI formatting step failed.", retryable: true, rawFallback: true },
  MODEL_TIMEOUT: { message: "The AI formatting step took too long.", retryable: true, rawFallback: true },
  EMPTY_OUTPUT: { message: "The conversion produced an empty note.", retryable: true, rawFallback: true },
  SAVE_FAILED: { message: "The note could not be saved to your vault.", retryable: true },
  CONNECTION_LOST: { message: "The connection dropped before the import finished.", retryable: true },
};

/** Thrown inside the pipeline; the route turns it into an `error` event. */
export class IngestFailure extends Error {
  readonly code: IngestErrorCode;
  constructor(code: IngestErrorCode, detail?: string) {
    super(detail ?? INGEST_ERRORS[code].message);
    this.code = code;
    this.name = "IngestFailure";
  }
}

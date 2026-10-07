"use client";

import { useState } from "react";
import { FileIcon } from "lucide-react";
import { sha256Hex, sha256HexBytes } from "@/lib/stellar/hash";

type Version = { version: number; contentHash: string };

type Result = { hash: string; source: string; match: number | null };

/**
 * Recomputes SHA-256 in the browser and compares it with every anchored
 * version. Nothing is uploaded: the file or text never leaves this page.
 *
 * A dropped file is hashed as raw bytes, exactly like `sha256sum`. Pasted text
 * is hashed as UTF-8, exactly like the app hashes a note before anchoring.
 */
export function HashCheck({
  versions,
  currentVersion,
}: {
  versions: Version[];
  currentVersion: number;
}) {
  const [text, setText] = useState("");
  const [dragging, setDragging] = useState(false);
  const [result, setResult] = useState<Result | null>(null);

  function compare(hash: string, source: string) {
    const hit = versions.find((v) => v.contentHash === hash);
    setResult({ hash, source, match: hit ? hit.version : null });
  }

  async function checkFile(file: File) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    compare(await sha256HexBytes(bytes), file.name);
  }

  async function checkText() {
    if (!text) return;
    compare(await sha256Hex(text), "pasted text");
  }

  return (
    <div className="grid gap-3">
      <label
        className={`flex cursor-pointer flex-col items-center gap-1.5 rounded-2xl border border-dashed bg-[var(--glass)] px-4 py-7 text-center text-[13px] transition-colors ${
          dragging
            ? "border-foreground/60 bg-[var(--glass-strong)]"
            : "border-[var(--glass-hi)] hover:border-foreground/40 hover:bg-[var(--glass-strong)]"
        }`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          const file = e.dataTransfer.files?.[0];
          if (file) void checkFile(file);
        }}
      >
        <FileIcon className="text-foreground size-5" strokeWidth={1.5} />
        <span>Drop the .md file you received, or click to choose it</span>
        <span className="text-muted-foreground text-[12px]">
          Hashed locally in your browser — nothing is uploaded
        </span>
        <input
          type="file"
          className="sr-only"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void checkFile(file);
            e.target.value = "";
          }}
        />
      </label>

      <div className="grid gap-2">
        <textarea
          className="placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/50 min-h-24 rounded-xl border border-[var(--glass-lo)] bg-[var(--glass)] px-3 py-2 shadow-[inset_0_1px_0_0_var(--glass-hi)] font-mono text-[12px] outline-none focus-visible:ring-3"
          placeholder="…or paste the document text"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <button
          type="button"
          disabled={!text}
          onClick={() => void checkText()}
          className="text-foreground h-8 justify-self-start rounded-full border border-[var(--glass-lo)] bg-[var(--glass)] px-4 text-[12px] font-medium shadow-[inset_0_1px_0_0_var(--glass-hi)] transition-colors hover:border-[var(--glass-hi)] hover:bg-[var(--glass-strong)] disabled:opacity-50"
        >
          Check pasted text
        </button>
      </div>

      {result ? (
        <div
          role="status"
          className={`glass rounded-xl border-l-2 px-4 py-3 text-[13px] ${
            result.match != null ? "border-l-success" : "border-l-destructive"
          }`}
        >
          {result.match != null ? (
            <p className="text-success font-medium">
              Match — {result.source} is anchored version v{result.match}
              {result.match === currentVersion ? " (current)" : " (superseded)"}.
            </p>
          ) : (
            <p className="text-destructive font-medium">
              No match — {result.source} does not equal any anchored version.
            </p>
          )}
          <p className="text-muted-foreground mt-1 font-mono text-[11px] break-all">
            sha256 {result.hash}
          </p>
          {result.match == null ? (
            <p className="text-muted-foreground mt-1 text-[12px]">
              Any change counts, including Windows (CRLF) line endings or a
              trailing newline added by an editor.
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

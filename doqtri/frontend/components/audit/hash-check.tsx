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
        className={`border-border flex cursor-pointer flex-col items-center gap-1.5 rounded-lg border border-dashed px-4 py-6 text-center text-[13px] transition-colors ${
          dragging ? "border-primary bg-primary/5" : "hover:bg-muted/40"
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
        <FileIcon className="text-muted-foreground size-5" />
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
          className="border-border bg-background min-h-24 rounded-md border px-3 py-2 font-mono text-[12px]"
          placeholder="…or paste the document text"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <button
          type="button"
          disabled={!text}
          onClick={() => void checkText()}
          className="bg-secondary text-secondary-foreground hover:bg-secondary/80 h-8 justify-self-start rounded-md px-3 text-[12px] font-medium disabled:opacity-50"
        >
          Check pasted text
        </button>
      </div>

      {result ? (
        <div
          role="status"
          className={`rounded-md border px-3 py-2 text-[13px] ${
            result.match != null
              ? "border-emerald-500/40 bg-emerald-500/10"
              : "border-red-500/40 bg-red-500/10"
          }`}
        >
          {result.match != null ? (
            <p className="font-medium text-emerald-400">
              Match — {result.source} is anchored version v{result.match}
              {result.match === currentVersion ? " (current)" : " (superseded)"}.
            </p>
          ) : (
            <p className="font-medium text-red-400">
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

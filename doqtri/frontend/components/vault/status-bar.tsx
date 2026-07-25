"use client";

export type SaveState = "idle" | "saving" | "saved" | "error";

const SAVE_LABEL: Record<SaveState, string> = {
  idle: "",
  saving: "Saving…",
  saved: "Saved",
  error: "Save failed",
};

export function StatusBar({
  noteCount,
  wordCount,
  saveState = "idle",
}: {
  noteCount: number;
  wordCount?: number;
  saveState?: SaveState;
}) {
  return (
    <footer className="bg-sidebar border-border text-label flex h-6 shrink-0 items-center gap-4 border-t px-3 text-[11px] select-none">
      <span className="tabular-nums">
        {noteCount} {noteCount === 1 ? "note" : "notes"}
      </span>
      {wordCount !== undefined && (
        <span className="tabular-nums">
          {wordCount} {wordCount === 1 ? "word" : "words"}
        </span>
      )}
      {saveState !== "idle" && (
        <span
          className={saveState === "error" ? "text-destructive" : undefined}
          role="status"
        >
          {SAVE_LABEL[saveState]}
        </span>
      )}
      <span className="ml-auto">Cursor Dark</span>
    </footer>
  );
}

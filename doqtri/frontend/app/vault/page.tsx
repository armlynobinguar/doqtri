import { DoqtriMark } from "@/components/brand/doqtri-mark";

export default function VaultIndexPage() {
  return (
    <div className="bg-grid flex h-full items-center justify-center px-8">
      <div className="flex max-w-[380px] flex-col items-center gap-3 text-center">
        <DoqtriMark className="text-foreground/80 mb-2 w-20" title="" />
        <p className="text-foreground text-[15px] font-semibold tracking-tight max-lg:text-[17px]">No note open</p>
        <p className="text-muted-foreground text-[14px] leading-relaxed lg:hidden">
          Open <span className="text-foreground">Notes</span> below to pick one,
          or tap <span className="text-foreground">+</span> to start a new note.
          Headings become the mindmap as you write.
        </p>
        <p className="text-muted-foreground text-[12.5px] leading-relaxed max-lg:hidden">
          Create a note with{" "}
          <kbd className="border-input bg-card text-muted-foreground rounded border px-1 py-0.5 font-mono text-[11px]">
            ⌘N
          </kbd>
          , jump with{" "}
          <kbd className="border-input bg-card text-muted-foreground rounded border px-1 py-0.5 font-mono text-[11px]">
            ⌘K
          </kbd>
          , or upload a document. Headings become the mindmap as you write.
        </p>
      </div>
    </div>
  );
}

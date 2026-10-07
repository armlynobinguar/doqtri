import { DoqtriMark } from "@/components/brand/doqtri-mark";

export default function VaultIndexPage() {
  return (
    <div className="bg-grid flex h-full items-center justify-center px-8">
      <div className="flex max-w-[400px] flex-col items-center gap-3 text-center">
        <div className="icon-tile mb-3 size-24 rounded-3xl">
          <DoqtriMark className="text-foreground/85 w-16" title="" />
        </div>
        <p className="display text-[34px] max-lg:text-[30px]">No note open</p>
        <p className="text-muted-foreground text-[14px] leading-relaxed lg:hidden">
          Open <span className="text-foreground">Notes</span> below to pick one,
          or tap <span className="text-foreground">+</span> to start a new note.
          Headings become the mindmap as you write.
        </p>
        <p className="text-muted-foreground text-[12.5px] leading-relaxed max-lg:hidden">
          Create a note with{" "}
          <kbd className="text-foreground/80 rounded-md border border-[var(--glass-lo)] bg-[var(--glass-strong)] px-1.5 py-0.5 font-mono text-[11px] shadow-[inset_0_1px_0_0_var(--glass-hi)]">
            ⌘N
          </kbd>
          , jump with{" "}
          <kbd className="text-foreground/80 rounded-md border border-[var(--glass-lo)] bg-[var(--glass-strong)] px-1.5 py-0.5 font-mono text-[11px] shadow-[inset_0_1px_0_0_var(--glass-hi)]">
            ⌘K
          </kbd>
          , or upload a document. Headings become the mindmap as you write.
        </p>
      </div>
    </div>
  );
}

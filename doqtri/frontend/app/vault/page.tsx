export default function VaultIndexPage() {
  return (
    <div className="flex h-full items-center justify-center px-8">
      <div className="flex max-w-[380px] flex-col gap-2 text-center">
        <p className="text-muted-foreground text-[13px]">No note open</p>
        <p className="text-label text-[12px] leading-relaxed">
          Create a note with{" "}
          <kbd className="border-border bg-secondary text-muted-foreground rounded border px-1 py-0.5 font-mono text-[11px]">
            ⌘N
          </kbd>
          , jump with{" "}
          <kbd className="border-border bg-secondary text-muted-foreground rounded border px-1 py-0.5 font-mono text-[11px]">
            ⌘K
          </kbd>
          , or upload a document. Headings become the mindmap as you write.
        </p>
      </div>
    </div>
  );
}

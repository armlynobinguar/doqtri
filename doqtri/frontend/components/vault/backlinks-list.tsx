"use client";

import Link from "next/link";
import { useMemo } from "react";
import { CornerDownLeftIcon } from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { buildBacklinks } from "@/lib/wikilinks";
import type { Doc } from "@/lib/types";

/** Notes that link to the active note, derived from their markdown. */
export function BacklinksList({
  docs,
  activeId,
}: {
  docs: Doc[];
  activeId: string;
}) {
  const backlinks = useMemo(
    () => buildBacklinks(docs, activeId),
    [docs, activeId],
  );

  return (
    <div
      data-testid="backlinks"
      className="border-border flex h-[136px] shrink-0 flex-col border-t"
    >
      <header className="flex h-7 shrink-0 items-center gap-1.5 px-3">
        <span className="text-label text-[11px] font-medium tracking-wider uppercase">
          Backlinks
        </span>
        <span className="text-label text-[11px] tabular-nums">
          {backlinks.length}
        </span>
      </header>

      <ScrollArea className="min-h-0 flex-1">
        {backlinks.length === 0 ? (
          <p className="text-label px-3 pb-2 text-[12px] leading-relaxed">
            No other note links here yet.
          </p>
        ) : (
          <ul className="pb-2">
            {backlinks.map((doc) => (
              <li key={doc.id}>
                <Link
                  href={`/vault/${doc.id}`}
                  className="text-muted-foreground hover:bg-secondary hover:text-foreground flex items-center gap-1.5 px-3 py-1 text-[12.5px] transition-colors"
                >
                  <CornerDownLeftIcon
                    className="size-3 shrink-0 opacity-50"
                    strokeWidth={1.75}
                  />
                  <span className="truncate">{doc.title}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </ScrollArea>
    </div>
  );
}

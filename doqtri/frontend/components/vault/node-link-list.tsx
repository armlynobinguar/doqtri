"use client";

import type { ReactNode } from "react";
import { XIcon } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { LinkableNode } from "@/lib/node-links";

/**
 * The link list the ship panel shows for each provider (WP-2.5): a section
 * with a header, one card per linked heading, and a heading picker for the
 * next link. Split out of github-links.tsx, whose markup it keeps; each
 * provider (GitHub, qdit) fills the cards and the form with its own parts.
 */

export function LinkSection({
  icon,
  title,
  action,
  children,
  testId,
}: {
  icon: ReactNode;
  title: string;
  /** Right of the title, e.g. GitHub's Check. */
  action?: ReactNode;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <section className="border-border grid gap-2 border-t pt-3" data-testid={testId}>
      <div className="flex items-center justify-between">
        <span className="text-foreground flex items-center gap-1.5 font-medium">
          {icon}
          {title}
        </span>
        {action ?? null}
      </div>
      {children}
    </section>
  );
}

/** The cards, or `empty` when there are none. */
export function LinkList({ empty, children, count }: { empty: ReactNode; children: ReactNode; count: number }) {
  if (count === 0) return <p className="text-muted-foreground text-[11px] leading-snug">{empty}</p>;
  return <ul className="grid gap-1.5">{children}</ul>;
}

/** One linked heading: its label, an unlink button when allowed, and the provider's details below. */
export function LinkItemShell({
  label,
  removeLabel,
  onRemove,
  children,
}: {
  label: string;
  removeLabel: string;
  /** Omitted: no unlink button (the user cannot change links). */
  onRemove?: () => void;
  children: ReactNode;
}) {
  return (
    <li className="glass grid gap-1 rounded-xl px-2.5 py-2">
      <div className="flex items-start justify-between gap-2">
        <span className="text-foreground truncate text-[12px]" title={label}>
          {label}
        </span>
        {onRemove ? (
          <button
            type="button"
            aria-label={removeLabel}
            className="text-muted-foreground hover:text-foreground shrink-0"
            onClick={onRemove}
          >
            <XIcon className="size-3.5" />
          </button>
        ) : null}
      </div>
      {children}
    </li>
  );
}

/** Which heading the next link is for. */
export function HeadingSelect({
  nodes,
  value,
  onChange,
  label = "Heading to link",
}: {
  nodes: LinkableNode[];
  value: string;
  onChange: (id: string) => void;
  label?: string;
}) {
  return (
    <Select
      value={value}
      onValueChange={(next) => next && onChange(next as string)}
      items={Object.fromEntries(nodes.map((n) => [n.id, n.label]))}
    >
      <SelectTrigger aria-label={label} className="h-8 text-[12px] max-lg:h-10 max-lg:text-base">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {nodes.map((n) => (
          <SelectItem key={n.id} value={n.id}>
            {n.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** The ship panel's text input style, shared by the providers' forms. */
export const LINK_INPUT_CLASS =
  "text-foreground focus-visible:border-ring focus-visible:ring-ring/50 h-8 max-lg:h-10 max-lg:text-base rounded-[10px] border border-[var(--glass-lo)] bg-[var(--glass)] min-w-0 flex-1 px-2.5 shadow-[inset_0_1px_0_0_var(--glass-hi)] outline-none focus-visible:ring-3";

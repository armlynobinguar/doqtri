"use client";

import {
  FilesIcon,
  SearchIcon,
  NetworkIcon,
  BrainIcon,
  SettingsIcon,
} from "lucide-react";
import Link from "next/link";
import { DoqtriMark } from "@/components/brand/doqtri-mark";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export type RibbonAction = "files" | "search" | "graph" | "mindmap" | "settings";

const ITEMS: { id: RibbonAction; label: string; Icon: typeof FilesIcon }[] = [
  { id: "files", label: "Files", Icon: FilesIcon },
  { id: "search", label: "Quick switcher  ⌘K", Icon: SearchIcon },
  { id: "graph", label: "Graph view", Icon: NetworkIcon },
  { id: "mindmap", label: "Global mindmap", Icon: BrainIcon },
  { id: "settings", label: "Settings", Icon: SettingsIcon },
];

export function Ribbon({
  active,
  onAction,
}: {
  active?: RibbonAction;
  onAction: (action: RibbonAction) => void;
}) {
  return (
    <nav
      aria-label="Primary"
      className="bg-sidebar border-border flex w-12 shrink-0 flex-col items-center gap-1 border-r py-2"
    >
      <Link
        href="/"
        aria-label="Doqtri home"
        className="text-foreground focus-visible:ring-ring mb-2 flex size-9 items-center justify-center rounded-lg focus-visible:ring-1 focus-visible:outline-hidden"
      >
        <DoqtriMark className="size-7" glow={false} title="" />
      </Link>
      {ITEMS.map(({ id, label, Icon }) => (
        <Tooltip key={id}>
          <TooltipTrigger
            aria-label={label}
            onClick={() => onAction(id)}
            className={cn(
              "text-sidebar-foreground/70 hover:text-foreground hover:bg-sidebar-accent relative flex size-8 items-center justify-center rounded-md transition-colors",
              "focus-visible:ring-ring focus-visible:ring-1 focus-visible:outline-hidden",
              active === id &&
                "text-foreground bg-sidebar-accent before:bg-primary before:absolute before:top-1.5 before:bottom-1.5 before:-left-2 before:w-0.5 before:rounded-full",
            )}
          >
            <Icon className="size-[17px]" strokeWidth={1.75} />
          </TooltipTrigger>
          <TooltipContent side="right">{label}</TooltipContent>
        </Tooltip>
      ))}
    </nav>
  );
}

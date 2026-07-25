"use client";

import { FilesIcon, SearchIcon, NetworkIcon, SettingsIcon } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export type RibbonAction = "files" | "search" | "graph" | "settings";

const ITEMS: { id: RibbonAction; label: string; Icon: typeof FilesIcon }[] = [
  { id: "files", label: "Files", Icon: FilesIcon },
  { id: "search", label: "Quick switcher  ⌘K", Icon: SearchIcon },
  { id: "graph", label: "Graph view", Icon: NetworkIcon },
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
      className="bg-sidebar border-border flex w-11 shrink-0 flex-col items-center gap-1 border-r py-2"
    >
      {ITEMS.map(({ id, label, Icon }) => (
        <Tooltip key={id}>
          <TooltipTrigger
            aria-label={label}
            onClick={() => onAction(id)}
            className={cn(
              "text-sidebar-foreground/70 hover:text-foreground hover:bg-sidebar-accent flex size-8 items-center justify-center rounded-md transition-colors",
              "focus-visible:ring-ring focus-visible:ring-1 focus-visible:outline-hidden",
              active === id && "text-foreground bg-sidebar-accent",
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

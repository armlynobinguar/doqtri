"use client";

import {
  FilesIcon,
  SearchIcon,
  NetworkIcon,
  BrainIcon,
  LayoutTemplateIcon,
  SettingsIcon,
  ShieldIcon,
  ImageIcon,
  FlagIcon,
  GiftIcon,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { DoqtriMark } from "@/components/brand/doqtri-mark";
import { AccountMenu, type AccountPage } from "@/components/vault/account-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export type RibbonAction = "files" | "search" | "templates" | "graph" | "mindmap" | "referrals" | "settings";

const ITEMS: { id: RibbonAction; label: string; Icon: typeof FilesIcon }[] = [
  { id: "files", label: "Files", Icon: FilesIcon },
  { id: "search", label: "Quick switcher  ⌘K", Icon: SearchIcon },
  { id: "templates", label: "Templates", Icon: LayoutTemplateIcon },
  { id: "graph", label: "Graph view", Icon: NetworkIcon },
  { id: "mindmap", label: "Global mindmap", Icon: BrainIcon },
  { id: "referrals", label: "Referrals", Icon: GiftIcon },
  { id: "settings", label: "Settings", Icon: SettingsIcon },
];

/**
 * The ribbon action a route belongs to. While the referral dashboard isn't live,
 * `/vault/referrals` is a 404 like any other unknown note, so nothing marks it.
 */
export function ribbonRouteAction(segment: string | undefined, referralsLive: boolean): RibbonAction | undefined {
  if (segment === "mindmap" || segment === "graph" || segment === "templates") return segment;
  return segment === "referrals" && referralsLive ? segment : undefined;
}

const BUTTON =
  "text-sidebar-foreground/70 hover:text-foreground relative flex size-9 items-center justify-center rounded-[10px] border border-transparent transition-colors hover:bg-[var(--glass)] focus-visible:ring-ring focus-visible:ring-1 focus-visible:outline-hidden";

const ACTIVE =
  "text-foreground bg-sidebar-accent border-[var(--glass-lo)] shadow-[inset_0_1px_0_0_var(--glass-hi)] before:bg-foreground before:absolute before:top-2 before:bottom-2 before:-left-[7px] before:w-0.5 before:rounded-full before:shadow-[0_0_8px_var(--foreground)]";

export function Ribbon({
  active,
  onAction,
  isAdmin = false,
  referralsLive = false,
  accountPage,
}: {
  active?: RibbonAction;
  onAction: (action: RibbonAction) => void;
  isAdmin?: boolean;
  /** The referral dashboard exists (lib/referral-dashboard.ts). */
  referralsLive?: boolean;
  /** On an account page (profile, members): the profile button shows as current. */
  accountPage?: AccountPage;
}) {
  return (
    <nav
      aria-label="Primary"
      className="bg-sidebar border-border hidden w-14 shrink-0 flex-col items-center gap-1.5 border-r py-3 lg:flex"
    >
      <Link
        href="/"
        aria-label="Doqtri home"
        className="text-foreground focus-visible:ring-ring mb-2 flex size-9 items-center justify-center rounded-lg focus-visible:ring-1 focus-visible:outline-hidden"
      >
        <DoqtriMark className="size-7" glow={false} title="" />
      </Link>
      {ITEMS.filter(({ id }) => id !== "referrals" || referralsLive).map(({ id, label, Icon }) => (
        <Tooltip key={id}>
          <TooltipTrigger
            aria-label={label}
            onClick={() => onAction(id)}
            className={cn(BUTTON, active === id && ACTIVE)}
          >
            <Icon className="size-[17px]" strokeWidth={1.5} />
          </TooltipTrigger>
          <TooltipContent side="right">{label}</TooltipContent>
        </Tooltip>
      ))}
      {/* The foot: staff tools, then the profile button, which opens the
          account popover (profile, members, apps, wallet, Log out). It stays
          reachable when the notes sidebar is collapsed. */}
      <div className="mt-auto flex flex-col items-center gap-1.5">
        {isAdmin && <AdminMenu />}
        <AccountMenu
          variant="icon"
          side="right"
          align="end"
          current={accountPage}
          className={cn(BUTTON, accountPage && ACTIVE)}
        />
      </div>
    </nav>
  );
}

/**
 * Staff only, pinned to the ribbon's foot. The admin pages live outside the
 * vault and 404 for everyone else, so this is a shortcut, not the gate.
 */
function AdminMenu() {
  const router = useRouter();
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger
          render={<DropdownMenuTrigger />}
          aria-label="Admin"
          data-testid="ribbon-admin"
          className={BUTTON}
        >
          <ShieldIcon className="size-[17px]" strokeWidth={1.5} />
        </TooltipTrigger>
        <TooltipContent side="right">Admin</TooltipContent>
      </Tooltip>
      <DropdownMenuContent side="right" align="end" className="w-48">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Admin</DropdownMenuLabel>
          <DropdownMenuItem onClick={() => router.push("/admin/reports")}>
            <FlagIcon strokeWidth={1.5} />
            Template reports
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => router.push("/admin/promo")}>
            <ImageIcon strokeWidth={1.5} />
            Promo entries
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => router.push("/admin/referrals")}>
            <GiftIcon strokeWidth={1.5} />
            Referrals
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

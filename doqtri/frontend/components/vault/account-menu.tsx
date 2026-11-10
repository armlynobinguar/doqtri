"use client";

import { useState } from "react";
import {
  ArrowLeftRightIcon,
  CheckIcon,
  CopyIcon,
  DropletIcon,
  ExternalLinkIcon,
  KeyRoundIcon,
  Loader2Icon,
  LogOutIcon,
  PlugIcon,
  RefreshCwIcon,
  StoreIcon,
  UserRoundIcon,
  UsersIcon,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useLegalLive } from "@/components/legal/legal-live";
import { SignUpNotice } from "@/components/legal/legal-links";
import { useNavigate } from "@/components/vault/navigation";
import { useWallet } from "@/components/vault/wallet-provider";
import { qditIntegrationEnabled } from "@/lib/integrations/qdit-config";
import { expertContractUrl, IS_MAINNET, MARKET_CONTRACT_ID } from "@/lib/stellar/config";
import { PasskeysDialog } from "@/components/vault/passkeys-dialog";
import { USER_PAYS_FEES } from "@/lib/stellar/smart-wallet-config";
import { formatXlm as formatStroops } from "@/lib/stellar/wallet-balance";
import { shortenAddress } from "@/lib/wallet";
import { cn } from "@/lib/utils";

/** Below this much spendable XLM a register (~0.055 XLM) is at risk. */
const LOW_BALANCE_XLM = 0.2;

function formatXlm(value: number): string {
  return value.toLocaleString(undefined, { maximumFractionDigits: 2, minimumFractionDigits: 2 });
}

/** The account pages the menu links to; the current one is ticked. */
export type AccountPage = "profile" | "members" | "apps";

type Placement = {
  side: "top" | "right" | "bottom" | "left";
  align: "start" | "center" | "end";
};

/**
 * How the menu is opened: the profile icon at the foot of the desktop ribbon,
 * or the ringed avatar in the phone's top bar. Both open the same popover.
 */
type Variant = "icon" | "avatar";

/**
 * The vault's account surface: one popover with the account pages (profile,
 * members, connected apps), the wallet and its balance, and the only Log out.
 */
export function AccountMenu({
  className,
  side = "top",
  align = "start",
  current,
  variant = "icon",
}: {
  className?: string;
  side?: Placement["side"];
  align?: Placement["align"];
  current?: AccountPage;
  variant?: Variant;
}) {
  const wallet = useWallet();
  const legalLive = useLegalLive();
  const [busy, setBusy] = useState(false);
  const { sessionAddress, walletAddress, mismatch, balance, balanceError } = wallet;

  if (wallet.identity.kind === "email") {
    return (
      <EmailAccountMenu
        className={className}
        side={side}
        align={align}
        current={current}
        variant={variant}
        email={wallet.identity.email}
        smartWallet={wallet.identity.smartWallet}
      />
    );
  }
  if (!sessionAddress) return null;

  const connected = walletAddress !== null && !mismatch;
  const low = balance?.funded === true && balance.spendable < LOW_BALANCE_XLM;
  const unfunded = balance?.funded === false;

  const balanceLabel = balanceError
    ? "balance unavailable"
    : balance === null
      ? "…"
      : balance.funded
        ? `${formatXlm(balance.balance)} XLM`
        : "unfunded";

  async function act(label: string, task: () => Promise<void>) {
    setBusy(true);
    try {
      await task();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : `${label} failed`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <DropdownMenu>
      <AccountTrigger
        variant={variant}
        className={className}
        label={`Account: ${shortenAddress(sessionAddress)}, ${balanceLabel}`}
        tone={connected ? "ok" : "warn"}
        active={current !== undefined}
      />

      <DropdownMenuContent side={side} align={align} className="w-64 text-[13px]">
        <DropdownMenuGroup>
          <DropdownMenuLabel>
            Vault wallet · {IS_MAINNET ? "Mainnet" : "Testnet"}
          </DropdownMenuLabel>
          <DropdownMenuItem
            onClick={() =>
              void navigator.clipboard
                .writeText(sessionAddress)
                .then(() => toast.success("Address copied"))
            }
          >
            <CopyIcon />
            <span className="font-mono">{shortenAddress(sessionAddress)}</span>
            <span className="text-muted-foreground ml-auto text-[11px]">copy</span>
          </DropdownMenuItem>
        </DropdownMenuGroup>

        <DropdownMenuSeparator />
        <PageItems current={current} />
        <DropdownMenuSeparator />

        <DropdownMenuGroup>
          <DropdownMenuLabel>Balance</DropdownMenuLabel>
          <div className="grid gap-0.5 px-1.5 pb-1 text-[12px]">
            {balance?.funded ? (
              <>
                <span data-testid="xlm-balance">{formatXlm(balance.balance)} XLM total</span>
                <span className={cn("text-muted-foreground", low && "text-warning")}>
                  {formatXlm(balance.spendable)} XLM spendable after reserve
                </span>
              </>
            ) : (
              <span className="text-warning" data-testid="xlm-balance">
                {balanceError
                  ? "Could not reach Horizon."
                  : unfunded
                    ? "Not funded yet — transactions will fail."
                    : "Loading…"}
              </span>
            )}
          </div>
          <DropdownMenuItem disabled={busy} onClick={() => void act("Refresh", wallet.refreshBalance)}>
            <RefreshCwIcon />
            Refresh balance
          </DropdownMenuItem>
          <EarningsItem />
          {!IS_MAINNET && (unfunded || low) ? (
            <DropdownMenuItem
              disabled={busy}
              onClick={() =>
                void act("Friendbot", async () => {
                  await wallet.fund();
                  toast.success("Funded with Friendbot");
                })
              }
            >
              <DropletIcon />
              Fund with Friendbot
            </DropdownMenuItem>
          ) : null}
        </DropdownMenuGroup>

        {walletAddress === null || mismatch ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              {walletAddress === null ? (
                <DropdownMenuItem disabled={busy} onClick={() => void act("Reconnect", wallet.reconnect)}>
                  <PlugIcon />
                  Reconnect wallet
                </DropdownMenuItem>
              ) : (
                <>
                  <DropdownMenuLabel className="text-warning">
                    Wallet is on {shortenAddress(walletAddress)}
                  </DropdownMenuLabel>
                  <DropdownMenuItem disabled={busy} onClick={() => void act("Switch", wallet.switchVault)}>
                    <ArrowLeftRightIcon />
                    Switch vault to {shortenAddress(walletAddress)}
                  </DropdownMenuItem>
                  {/* Switching to a wallet with no account creates one. */}
                  {legalLive && <SignUpNotice className="px-2 py-1.5" />}
                </>
              )}
            </DropdownMenuGroup>
          </>
        ) : null}

        <DropdownMenuSeparator />
        <LogOutItem />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Email accounts: who is signed in and their passkey wallet (or the way to
 * create one). No balance: the relay pays every fee.
 */
function EmailAccountMenu({
  email,
  smartWallet,
  className,
  side,
  align,
  current,
  variant,
}: {
  email: string;
  smartWallet: { address: string; passkeys: unknown[] } | null;
  className?: string;
  current?: AccountPage;
  variant: Variant;
} & Placement) {
  const wallet = useWallet();
  const [creating, setCreating] = useState(false);
  const [passkeysOpen, setPasskeysOpen] = useState(false);
  const [toppingUp, setToppingUp] = useState(false);

  async function topUp() {
    setToppingUp(true);
    try {
      await wallet.topUp();
      toast.success("Wallet topped up with test XLM");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "The top-up failed. Try again.");
    } finally {
      setToppingUp(false);
    }
  }

  async function createWallet() {
    setCreating(true);
    try {
      await wallet.createSmartWallet();
      toast.success("Passkey wallet created");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Your wallet could not be created.");
    } finally {
      setCreating(false);
    }
  }

  return (
    <>
      <DropdownMenu>
        <AccountTrigger
          variant={variant}
          className={className}
          label={`Account: ${email}`}
          tone="ok"
          active={current !== undefined}
        />

        <DropdownMenuContent side={side} align={align} className="w-64 text-[13px]">
          <DropdownMenuGroup>
            <DropdownMenuLabel>Signed in with email</DropdownMenuLabel>
            <div className="truncate px-1.5 pb-1 text-[12px]" title={email}>
              {email}
            </div>
          </DropdownMenuGroup>

          <DropdownMenuSeparator />
          <PageItems current={current} />
          <DropdownMenuSeparator />

          <DropdownMenuGroup>
            <DropdownMenuLabel>Passkey wallet · {IS_MAINNET ? "Mainnet" : "Testnet"}</DropdownMenuLabel>
            {smartWallet ? (
              <>
                <DropdownMenuItem
                  onClick={() =>
                    void navigator.clipboard
                      .writeText(smartWallet.address)
                      .then(() => toast.success("Address copied"))
                  }
                >
                  <CopyIcon />
                  <span className="font-mono">{shortenAddress(smartWallet.address)}</span>
                  <span className="text-muted-foreground ml-auto text-[11px]">copy</span>
                </DropdownMenuItem>
                {USER_PAYS_FEES ? (
                <>
                  <div className="grid gap-0.5 px-1.5 pb-1 text-[12px]" data-testid="wallet-xlm">
                    <span>
                      {wallet.walletXlm === null ? "Balance …" : `${formatStroops(wallet.walletXlm)} XLM`}
                    </span>
                    <span className="text-muted-foreground">Pays the network fee for each write you anchor.</span>
                  </div>
                  <DropdownMenuItem
                    disabled={toppingUp}
                    closeOnClick={false}
                    data-testid="top-up"
                    onClick={() => void topUp()}
                  >
                    {toppingUp ? <Loader2Icon className="animate-spin" /> : <DropletIcon />}
                    {toppingUp ? "Topping up…" : "Top up with test XLM"}
                  </DropdownMenuItem>
                </>
              ) : null}
              <EarningsItem />
              <DropdownMenuItem data-testid="open-passkeys" onClick={() => setPasskeysOpen(true)}>
                  <KeyRoundIcon />
                  Passkeys
                  <span className="text-muted-foreground ml-auto text-[11px] tabular-nums">
                    {smartWallet.passkeys.length}
                    {smartWallet.passkeys.length < 2 ? " · add a backup" : ""}
                  </span>
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => window.open(expertContractUrl(smartWallet.address), "_blank", "noopener")}
                >
                  <ExternalLinkIcon />
                  View on stellar.expert
                </DropdownMenuItem>
              </>
            ) : (
              <>
                <div className="text-muted-foreground px-1.5 pb-1 text-[12px]">
                  A wallet unlocked by your fingerprint, face, or device PIN. It lets you anchor notes
                  on Stellar; Doqtri covers the fees.
                </div>
                <DropdownMenuItem
                  disabled={creating}
                  data-testid="create-passkey-wallet"
                  closeOnClick={false}
                  onClick={() => void createWallet()}
                >
                  {creating ? <Loader2Icon className="animate-spin" /> : <KeyRoundIcon />}
                  {creating ? "Creating wallet…" : "Create passkey wallet"}
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuGroup>

          <DropdownMenuSeparator />
          <LogOutItem />
        </DropdownMenuContent>
      </DropdownMenu>
      <PasskeysDialog open={passkeysOpen} onOpenChange={setPasskeysOpen} />
    </>
  );
}

/** The creator's own templates and earnings: the Templates page's "Yours" tab (progress/004). */
function EarningsItem() {
  const router = useRouter();
  if (!MARKET_CONTRACT_ID) return null;
  return (
    <DropdownMenuItem data-testid="open-earnings" onClick={() => router.push("/vault/templates?tab=yours")}>
      <StoreIcon />
      Your templates
    </DropdownMenuItem>
  );
}

/**
 * What opens the menu: the ribbon's profile icon (desktop) or the top bar's
 * ringed avatar (phones), each with the wallet's state as a dot on its rim.
 */
function AccountTrigger({
  variant,
  className,
  label,
  tone,
  active,
}: {
  variant: Variant;
  className?: string;
  label: string;
  tone: "ok" | "warn";
  /** On an account page: the avatar shows as current. The ribbon styles its own. */
  active: boolean;
}) {
  if (variant === "avatar") {
    return (
      <DropdownMenuTrigger
        aria-label={label}
        data-testid="mobile-profile"
        className={cn(
          "group focus-visible:ring-ring flex size-10 shrink-0 items-center justify-center rounded-lg focus-visible:ring-1 focus-visible:outline-hidden",
          className,
        )}
      >
        {/* Ringed, so it reads as "you" rather than as one more tool icon. */}
        <span
          className={cn(
            "relative flex size-8 items-center justify-center rounded-full border transition-colors",
            active
              ? "text-foreground border-[var(--glass-hi)] bg-[var(--glass-strong)] shadow-[inset_0_1px_0_0_var(--glass-hi)]"
              : "text-sidebar-foreground border-[var(--glass-lo)] bg-[var(--glass)] group-hover:text-foreground group-aria-expanded:text-foreground",
          )}
        >
          <UserRoundIcon className="size-[18px]" strokeWidth={1.5} />
          <StatusDot tone={tone} className="-right-0.5 -bottom-0.5 size-2.5" />
        </span>
      </DropdownMenuTrigger>
    );
  }
  return (
    <Tooltip>
      <TooltipTrigger
        render={<DropdownMenuTrigger />}
        aria-label={label}
        data-testid="ribbon-profile"
        className={className}
      >
        <span className="relative flex">
          <UserRoundIcon className="size-[17px]" strokeWidth={1.5} />
          <StatusDot tone={tone} className="-right-1 -bottom-0.5 size-2" />
        </span>
      </TooltipTrigger>
      <TooltipContent side="right">Account</TooltipContent>
    </Tooltip>
  );
}

/** Green when the wallet can sign, amber when it needs attention. */
function StatusDot({ tone, className }: { tone: "ok" | "warn"; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "ring-sidebar pointer-events-none absolute rounded-full ring-2",
        tone === "ok" ? "bg-success" : "bg-warning",
        className,
      )}
    />
  );
}

/** Profile, members and (with the qdit integration on) connected apps. */
function PageItems({ current }: { current?: AccountPage }) {
  const navigate = useNavigate();
  const pages: { id: AccountPage; href: string; label: string; Icon: typeof UserRoundIcon; testId: string }[] = [
    { id: "profile", href: "/vault/profile", label: "Profile & settings", Icon: UserRoundIcon, testId: "open-profile" },
    { id: "members", href: "/vault/workspace/members", label: "Workspace members", Icon: UsersIcon, testId: "open-members" },
    ...(qditIntegrationEnabled()
      ? [{ id: "apps" as const, href: "/vault/profile?tab=apps", label: "Connected apps", Icon: PlugIcon, testId: "open-apps" }]
      : []),
  ];
  return (
    <DropdownMenuGroup>
      {pages.map(({ id, href, label, Icon, testId }) => (
        <DropdownMenuItem
          key={id}
          data-testid={testId}
          aria-current={current === id ? "page" : undefined}
          onClick={() => navigate(href)}
        >
          <Icon />
          {label}
          {current === id ? <CheckIcon className="text-muted-foreground ml-auto" aria-hidden /> : null}
        </DropdownMenuItem>
      ))}
    </DropdownMenuGroup>
  );
}

/**
 * The one way out. Wallet accounts also drop the wallet connection
 * (`disconnect`); email accounts only end the session. Stays open while it
 * works, so the press visibly answers.
 */
function LogOutItem() {
  const wallet = useWallet();
  const [busy, setBusy] = useState(false);

  async function logOut() {
    setBusy(true);
    try {
      await (wallet.identity.kind === "wallet" ? wallet.disconnect() : wallet.signOut());
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Log out failed");
      setBusy(false);
    }
  }

  return (
    <DropdownMenuItem
      variant="destructive"
      disabled={busy}
      closeOnClick={false}
      data-testid="log-out"
      onClick={() => void logOut()}
    >
      {busy ? <Loader2Icon className="animate-spin" /> : <LogOutIcon />}
      {busy ? "Logging out…" : "Log out"}
    </DropdownMenuItem>
  );
}

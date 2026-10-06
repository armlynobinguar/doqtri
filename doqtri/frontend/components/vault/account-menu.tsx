"use client";

import { useState } from "react";
import {
  ArrowLeftRightIcon,
  CopyIcon,
  DropletIcon,
  ExternalLinkIcon,
  KeyRoundIcon,
  Loader2Icon,
  LogOutIcon,
  PlugIcon,
  RefreshCwIcon,
} from "lucide-react";
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
import { useWallet } from "@/components/vault/wallet-provider";
import { expertContractUrl, IS_MAINNET } from "@/lib/stellar/config";
import { shortenAddress } from "@/lib/wallet";
import { cn } from "@/lib/utils";

/** Below this much spendable XLM a register (~0.055 XLM) is at risk. */
const LOW_BALANCE_XLM = 0.2;

function formatXlm(value: number): string {
  return value.toLocaleString(undefined, { maximumFractionDigits: 2, minimumFractionDigits: 2 });
}

/**
 * The vault's account surface, in the status bar: which wallet owns the vault,
 * whether it is connected, what it can spend, and the one place to disconnect.
 */
export function AccountMenu({ className }: { className?: string }) {
  const wallet = useWallet();
  const [busy, setBusy] = useState(false);
  const { sessionAddress, walletAddress, mismatch, balance, balanceError } = wallet;

  if (wallet.identity.kind === "email") {
    return (
      <EmailAccountMenu
        className={className}
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
      <DropdownMenuTrigger
        aria-label="Account"
        data-testid="account-menu"
        className={cn(
          "hover:text-foreground focus-visible:ring-ring -mr-1.5 flex h-5 items-center gap-1.5 rounded px-1.5 tabular-nums focus-visible:ring-1 focus-visible:outline-hidden",
          className,
        )}
      >
        <span
          aria-hidden
          className={cn(
            "size-1.5 rounded-full",
            connected ? "bg-success shadow-[0_0_6px_var(--success)]" : "bg-warning",
          )}
        />
        <span className="font-mono">{shortenAddress(sessionAddress)}</span>
        <span aria-hidden>·</span>
        <span
          data-testid="xlm-balance"
          className={cn((low || unfunded || balanceError) && "text-warning")}
        >
          {balanceLabel}
        </span>
      </DropdownMenuTrigger>

      <DropdownMenuContent side="top" align="end" className="w-64 text-[13px]">
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

        <DropdownMenuGroup>
          <DropdownMenuLabel>Balance</DropdownMenuLabel>
          <div className="grid gap-0.5 px-1.5 pb-1 text-[12px]">
            {balance?.funded ? (
              <>
                <span>{formatXlm(balance.balance)} XLM total</span>
                <span className={cn("text-muted-foreground", low && "text-warning")}>
                  {formatXlm(balance.spendable)} XLM spendable after reserve
                </span>
              </>
            ) : (
              <span className="text-warning">
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

        <DropdownMenuSeparator />

        <DropdownMenuGroup>
          {walletAddress === null ? (
            <DropdownMenuItem disabled={busy} onClick={() => void act("Reconnect", wallet.reconnect)}>
              <PlugIcon />
              Reconnect wallet
            </DropdownMenuItem>
          ) : mismatch ? (
            <>
              <DropdownMenuLabel className="text-warning">
                Wallet is on {shortenAddress(walletAddress)}
              </DropdownMenuLabel>
              <DropdownMenuItem disabled={busy} onClick={() => void act("Switch", wallet.switchVault)}>
                <ArrowLeftRightIcon />
                Switch vault to {shortenAddress(walletAddress)}
              </DropdownMenuItem>
            </>
          ) : null}
          <DropdownMenuItem
            variant="destructive"
            disabled={busy}
            onClick={() => void act("Disconnect", wallet.disconnect)}
          >
            <LogOutIcon />
            Disconnect
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Email accounts: who is signed in, their passkey wallet (or the way to create
 * one), and the way out. No balance: the relay pays every fee.
 */
function EmailAccountMenu({
  email,
  smartWallet,
  className,
}: {
  email: string;
  smartWallet: { address: string } | null;
  className?: string;
}) {
  const wallet = useWallet();
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);

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

  async function signOut() {
    setBusy(true);
    try {
      await wallet.signOut();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Sign out failed");
      setBusy(false);
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label="Account"
        data-testid="account-menu"
        className={cn(
          "hover:text-foreground focus-visible:ring-ring -mr-1.5 flex h-5 max-w-56 items-center gap-1.5 rounded px-1.5 focus-visible:ring-1 focus-visible:outline-hidden",
          className,
        )}
      >
        <span aria-hidden className="bg-success size-1.5 shrink-0 rounded-full shadow-[0_0_6px_var(--success)]" />
        <span className="truncate">{email}</span>
      </DropdownMenuTrigger>

      <DropdownMenuContent side="top" align="end" className="w-64 text-[13px]">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Signed in with email</DropdownMenuLabel>
          <div className="truncate px-1.5 pb-1 text-[12px]" title={email}>
            {email}
          </div>
        </DropdownMenuGroup>

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

        <DropdownMenuItem variant="destructive" disabled={busy} onClick={() => void signOut()}>
          <LogOutIcon />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

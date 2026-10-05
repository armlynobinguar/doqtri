"use client";

import { useState } from "react";
import {
  ArrowLeftRightIcon,
  CopyIcon,
  DropletIcon,
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
import { IS_MAINNET } from "@/lib/stellar/config";
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
export function AccountMenu() {
  const wallet = useWallet();
  const [busy, setBusy] = useState(false);
  const { sessionAddress, walletAddress, mismatch, balance, balanceError } = wallet;

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
        className="hover:text-foreground focus-visible:ring-ring -mr-1.5 flex h-5 items-center gap-1.5 rounded px-1.5 tabular-nums focus-visible:ring-1 focus-visible:outline-hidden"
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

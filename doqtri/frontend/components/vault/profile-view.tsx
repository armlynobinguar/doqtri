"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  CheckIcon,
  CopyIcon,
  DropletIcon,
  ExternalLinkIcon,
  GiftIcon,
  KeyRoundIcon,
  Loader2Icon,
  LogOutIcon,
  MailIcon,
  PlugIcon,
  RefreshCwIcon,
  Settings2Icon,
  StoreIcon,
  TriangleAlertIcon,
  UserRoundIcon,
  WalletIcon,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { StatusTag } from "@/components/ui/status-tag";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PasskeysDialog } from "@/components/vault/passkeys-dialog";
import { usePreferences } from "@/components/vault/preferences";
import type { Preferences } from "@/lib/preferences";
import { useWallet } from "@/components/vault/wallet-provider";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { expertAddressUrl, expertTxUrl, HORIZON_URL, IS_MAINNET, MARKET_CONTRACT_ID } from "@/lib/stellar/config";
import { MAX_USER_FEE_STROOPS, NETWORK, USER_PAYS_FEES } from "@/lib/stellar/smart-wallet-config";
import { formatXlm } from "@/lib/stellar/wallet-balance";
import { shortenAddress } from "@/lib/wallet";
import { cn } from "@/lib/utils";

type Activity = { hash: string; label: string; detail: string | null; at: string; ok: boolean };

const WRITE_LABELS: Record<string, string> = {
  register_document: "Registered a note",
  update_document: "Anchored a new version",
  anchor: "Anchored a note",
  set_node_status: "Synced a mindmap node",
  // Team notes (WP-1.4): written as a workspace editor.
  anchor_as: "Anchored a team note",
  update_document_as: "Anchored a new version of a team note",
  set_node_status_as: "Synced a team note's mindmap node",
  assign_document: "Shared a note with its workspace",
  unassign_document: "Took a note out of its workspace",
};

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function formatLumens(value: number): string {
  return value.toLocaleString(undefined, { maximumFractionDigits: 2, minimumFractionDigits: 2 });
}

async function copy(text: string, what: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(`${what} copied`);
  } catch {
    toast.error(`Could not copy ${what.toLowerCase()}`);
  }
}

/**
 * Recent on-chain writes. A passkey wallet's writes are sent from shared
 * relay accounts, so Horizon can't list them by owner; they come from
 * chain_writes (public, like the ledger itself). A Freighter account is the
 * transaction source, so Horizon lists them directly.
 */
async function loadActivity(address: string): Promise<Activity[]> {
  if (address.startsWith("C")) {
    const supabase = createSupabaseBrowserClient();
    const { data, error } = await supabase
      .from("chain_writes")
      .select("tx_hash, fn, created_at, document_id")
      .eq("network", NETWORK)
      .eq("owner", address)
      .order("created_at", { ascending: false })
      .limit(10);
    if (error) throw new Error(error.message);
    const rows = data ?? [];
    const ids = [...new Set(rows.map((r) => r.document_id as string))];
    const { data: docs } = ids.length
      ? await supabase.from("documents").select("id, title").in("id", ids)
      : { data: [] as { id: string; title: string }[] };
    const titles = new Map((docs ?? []).map((d) => [d.id as string, d.title as string]));
    return rows.map((r) => ({
      hash: r.tx_hash as string,
      label: WRITE_LABELS[r.fn as string] ?? "Wrote on-chain",
      detail: titles.get(r.document_id as string) ?? null,
      at: r.created_at as string,
      ok: true,
    }));
  }
  const res = await fetch(`${HORIZON_URL}/accounts/${address}/transactions?order=desc&limit=10`);
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`Horizon answered ${res.status}`);
  const body = (await res.json()) as {
    _embedded?: { records?: { hash: string; created_at: string; successful: boolean; operation_count: number }[] };
  };
  return (body._embedded?.records ?? []).map((t) => ({
    hash: t.hash,
    label: t.successful ? "Transaction" : "Failed transaction",
    detail: `${t.operation_count} operation${t.operation_count === 1 ? "" : "s"}`,
    at: t.created_at,
    ok: t.successful,
  }));
}

/**
 * The ledger transaction that put this account on Stellar: a passkey wallet's
 * deploy (made in the setup step right after sign-up), or the transaction that
 * created a Freighter account (Friendbot funds a new testnet account
 * automatically on first sign-in).
 */
async function loadOnChainSince(address: string, createdTx: string | null): Promise<{ hash: string; at: string } | null> {
  if (createdTx) {
    const res = await fetch(`${HORIZON_URL}/transactions/${createdTx}`);
    if (!res.ok) return { hash: createdTx, at: "" };
    const body = (await res.json()) as { created_at: string };
    return { hash: createdTx, at: body.created_at };
  }
  if (!address.startsWith("G")) return null;
  const res = await fetch(`${HORIZON_URL}/accounts/${address}/operations?order=asc&limit=1`);
  if (!res.ok) return null;
  const body = (await res.json()) as { _embedded?: { records?: { transaction_hash: string; created_at: string }[] } };
  const first = body._embedded?.records?.[0];
  return first ? { hash: first.transaction_hash, at: first.created_at } : null;
}

/** The user's referral link and how many accounts signed up through it. */
export type ReferralSummary = { url: string; referred: number };

const PROFILE_TABS = ["account", "wallet", "preferences", "invite"] as const;
type ProfileTab = (typeof PROFILE_TABS)[number];
const isProfileTab = (value: string | null): value is ProfileTab =>
  PROFILE_TABS.includes(value as ProfileTab);

/** The one thing the wallet needs from the user right now, if anything. */
type Attention = {
  tone: "warning" | "info";
  text: string;
  action?: { label: string; icon: React.ComponentType; run: () => void; testId?: string };
};

export function ProfileView({
  joinedAt,
  referral,
  workspaceId,
}: {
  joinedAt: string;
  referral: ReferralSummary | null;
  /** The active workspace, whose notes the vault shows and this page counts (WP-1.7). */
  workspaceId: string;
}) {
  const wallet = useWallet();
  const { identity } = wallet;
  const smartWallet = identity.kind === "email" ? identity.smartWallet : null;
  const address = identity.kind === "wallet" ? identity.address : (smartWallet?.address ?? null);

  const [noteCount, setNoteCount] = useState<number | null>(null);
  const [activity, setActivity] = useState<Activity[] | null>(null);
  const [activityError, setActivityError] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [passkeysOpen, setPasskeysOpen] = useState(false);
  const [onChainSince, setOnChainSince] = useState<{ hash: string; at: string } | null | undefined>(undefined);
  const [prefs, setPreference] = usePreferences();
  const [savedAt, setSavedAt] = useState(0);

  // The tab lives in the URL (`?tab=`), so other screens can link to it.
  const router = useRouter();
  const requestedTab = useSearchParams().get("tab");
  const tab: ProfileTab =
    isProfileTab(requestedTab) && (requestedTab !== "invite" || referral) ? requestedTab : "account";
  function setTab(next: ProfileTab) {
    router.replace(next === "account" ? "/vault/profile" : `/vault/profile?tab=${next}`, { scroll: false });
  }

  /** Applies a preference and briefly shows that it was saved. */
  function savePreference(change: Parameters<typeof setPreference>[0]) {
    setPreference(change);
    setSavedAt(Date.now());
  }
  useEffect(() => {
    if (!savedAt) return;
    const timer = setTimeout(() => setSavedAt(0), 2000);
    return () => clearTimeout(timer);
  }, [savedAt]);
  const createdTx = smartWallet?.createdTx ?? null;
  // Funded later (auto-fund, top-up): look again when the balance changes.
  const fundedKey = identity.kind === "wallet" ? String(wallet.balance?.funded ?? "") : "";

  useEffect(() => {
    if (!address) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      void loadOnChainSince(address, createdTx)
        .then((since) => {
          if (!cancelled) setOnChainSince(since);
        })
        .catch(() => {
          if (!cancelled) setOnChainSince(null);
        });
    }, 0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [address, createdTx, fundedKey]);

  const refreshActivity = useCallback(async () => {
    if (!address) return;
    try {
      setActivity(await loadActivity(address));
      setActivityError(false);
    } catch {
      setActivityError(true);
    }
  }, [address]);

  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      void createSupabaseBrowserClient()
        .from("documents")
        .select("id", { count: "exact", head: true })
        .eq("workspace_id", workspaceId)
        .then(({ count }) => {
          if (!cancelled) setNoteCount(count ?? 0);
        });
      void refreshActivity();
    }, 0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [refreshActivity, workspaceId]);

  async function act(name: string, task: () => Promise<void>, done?: string) {
    setBusy(name);
    try {
      await task();
      if (done) toast.success(done);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : `${name} failed`);
    } finally {
      setBusy(null);
    }
  }

  // One line on whether this wallet can anchor right now.
  const status: { tone: "verified" | "warning" | "info" | "planned"; label: string } = !address
    ? { tone: "planned", label: "No wallet yet" }
    : wallet.preparingWallet
      ? { tone: "info", label: "Getting ready" }
      : wallet.walletReady
        ? { tone: "verified", label: "Ready to anchor" }
        : { tone: "warning", label: "Needs XLM for fees" };

  const balanceText =
    identity.kind === "wallet"
      ? wallet.balanceError
        ? "Unavailable"
        : wallet.balance === null
          ? "…"
          : wallet.balance.funded
            ? `${formatLumens(wallet.balance.balance)} XLM`
            : "Not funded"
      : wallet.walletXlm === null
        ? "…"
        : `${formatXlm(wallet.walletXlm)} XLM`;

  const balanceDetail =
    identity.kind === "wallet"
      ? wallet.balance?.funded
        ? `${formatLumens(wallet.balance.spendable)} XLM spendable after the account reserve`
        : "An account needs XLM before it can pay network fees."
      : USER_PAYS_FEES
        ? `Each write pays its network fee from here, never more than ${formatXlm(MAX_USER_FEE_STROOPS)} XLM.`
        : "Doqtri pays the network fee for every write.";

  const lowOrEmpty =
    identity.kind === "wallet"
      ? wallet.balance?.funded === false || (wallet.balance?.funded === true && wallet.balance.spendable < 0.2)
      : USER_PAYS_FEES && wallet.walletXlm !== null && wallet.walletXlm < BigInt(100) * BigInt(10_000_000);

  const createWallet = () =>
    void act("Create wallet", async () => void (await wallet.createSmartWallet()), "Passkey wallet created");
  const topUp = () => void act("Top up", wallet.topUp, "Wallet topped up with test XLM");
  const fund = () => void act("Friendbot", wallet.fund, "Funded with Friendbot");
  const reconnect = () => void act("Reconnect", wallet.reconnect);

  // The most important thing to fix first; shown above the tabs.
  const attention: Attention | null =
    identity.kind === "email" && !address
      ? {
          tone: "info",
          text: "Your notes save without a wallet. Create one to anchor them on Stellar; it opens with your fingerprint, face or device PIN.",
          action: { label: "Create passkey wallet", icon: KeyRoundIcon, run: createWallet, testId: "attention-create-wallet" },
        }
      : identity.kind === "wallet" && wallet.mismatch
        ? { tone: "warning", text: "Freighter is set to a different account than this vault. Switch it back in Freighter to anchor." }
        : identity.kind === "wallet" && wallet.walletAddress === null
          ? {
              tone: "info",
              text: "Freighter isn't connected in this browser, so anchoring is paused.",
              action: { label: "Reconnect Freighter", icon: PlugIcon, run: reconnect },
            }
          : lowOrEmpty
            ? {
                tone: "warning",
                text: "Your wallet is low on XLM, so anchoring may fail.",
                action: IS_MAINNET
                  ? undefined
                  : identity.kind === "email" && USER_PAYS_FEES
                    ? { label: "Top up with test XLM", icon: DropletIcon, run: topUp }
                    : identity.kind === "wallet"
                      ? { label: "Fund with Friendbot", icon: DropletIcon, run: fund }
                      : undefined,
              }
            : smartWallet && smartWallet.passkeys.length < 2
              ? {
                  tone: "info",
                  text: "Add a backup passkey on another device, so losing this one can't lock you out of your wallet.",
                  action: { label: "Add a backup passkey", icon: KeyRoundIcon, run: () => setPasskeysOpen(true) },
                }
              : null;

  const displayName = identity.kind === "email" ? identity.email : shortenAddress(identity.address);
  const memberSince = new Date(joinedAt).toLocaleDateString(undefined, { month: "long", year: "numeric" });

  return (
    <div className="h-full overflow-y-auto" data-testid="profile-page">
      <main className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-6 sm:px-8 sm:py-8">
        <section className="glass flex flex-wrap items-center gap-x-4 gap-y-3 rounded-2xl px-4 py-4 sm:px-5">
          <span
            aria-hidden
            className="bg-primary/15 grid size-12 shrink-0 place-items-center rounded-full text-lg font-semibold"
          >
            {identity.kind === "email" ? (identity.email[0] ?? "?").toUpperCase() : <WalletIcon className="size-5" strokeWidth={1.5} />}
          </span>
          <div className="min-w-[12rem] flex-1">
            <p className="text-muted-foreground text-[12px]">Profile &amp; settings</p>
            <h1 className="truncate text-lg font-semibold" title={identity.kind === "email" ? identity.email : identity.address}>
              {displayName}
            </h1>
            <p className="text-muted-foreground text-[12px]">
              Member since {memberSince} · {noteCount === null ? "…" : noteCount === 1 ? "1 note" : `${noteCount} notes`} ·{" "}
              {IS_MAINNET ? "Stellar Mainnet" : "Stellar Testnet"}
            </p>
          </div>
          <div className="flex w-full items-center justify-between gap-2 sm:w-auto sm:justify-end">
            <StatusTag tone={status.tone} data-testid="wallet-status">
              {status.label}
            </StatusTag>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="text-destructive"
              disabled={busy !== null}
              onClick={() => void act("Sign out", identity.kind === "wallet" ? wallet.disconnect : wallet.signOut)}
            >
              <LogOutIcon />
              {identity.kind === "wallet" ? "Disconnect" : "Sign out"}
            </Button>
          </div>
        </section>

        {attention ? (
          <div
            role="status"
            data-testid="profile-attention"
            className={cn(
              "flex flex-wrap items-center gap-3 rounded-xl border px-4 py-3 text-[13px]",
              attention.tone === "warning" ? "border-warning/40 bg-warning/10" : "border-[var(--glass-lo)] bg-[var(--glass)]",
            )}
          >
            {attention.tone === "warning" ? (
              <TriangleAlertIcon className="text-warning size-4 shrink-0" />
            ) : (
              <WalletIcon className="text-muted-foreground size-4 shrink-0" strokeWidth={1.5} />
            )}
            <span className="min-w-0 flex-1">{attention.text}</span>
            {attention.action ? (
              <Button
                type="button"
                size="sm"
                disabled={busy !== null || wallet.preparingWallet}
                data-testid={attention.action.testId}
                onClick={attention.action.run}
              >
                {busy ? <Loader2Icon className="animate-spin" /> : <attention.action.icon />}
                {attention.action.label}
              </Button>
            ) : null}
          </div>
        ) : null}

        <Tabs value={tab} onValueChange={(value) => setTab(value as ProfileTab)}>
          {/* On phones the labels alone fit; the icons come back from sm up. */}
          <TabsList className="h-9 w-full sm:w-fit max-sm:[&_svg]:hidden">
            <TabsTrigger value="account" data-testid="profile-tab-account">
              <UserRoundIcon />
              Account
            </TabsTrigger>
            <TabsTrigger value="wallet" data-testid="profile-tab-wallet">
              <WalletIcon />
              Wallet
              {attention ? <span className="bg-warning size-1.5 rounded-full" aria-label="needs attention" /> : null}
            </TabsTrigger>
            <TabsTrigger value="preferences" data-testid="profile-tab-preferences">
              <Settings2Icon />
              Preferences
            </TabsTrigger>
            {referral ? (
              <TabsTrigger value="invite" data-testid="profile-tab-invite">
                <GiftIcon />
                Invite
              </TabsTrigger>
            ) : null}
          </TabsList>
        </Tabs>

        {tab === "account" ? (
          <>
            <Section title="Account" icon={identity.kind === "email" ? MailIcon : WalletIcon}>
              <Row label="Signed in with">
                {identity.kind === "email" ? "Email and passkey" : "Freighter wallet"}
              </Row>
              {identity.kind === "email" ? (
                <Row label="Email">
                  <span className="truncate" title={identity.email}>
                    {identity.email}
                  </span>
                </Row>
              ) : null}
              <Row label="Member since">{new Date(joinedAt).toLocaleDateString(undefined, { dateStyle: "long" })}</Row>
              <Row label="On Stellar since" help="When your wallet first appeared on the Stellar ledger.">
                {!address ? (
                  <span className="text-muted-foreground">Recorded when you create your wallet</span>
                ) : onChainSince === undefined ? (
                  "…"
                ) : onChainSince === null ? (
                  <span className="text-muted-foreground">
                    {identity.kind === "wallet" ? "Recorded once the account is funded" : "Not found on the ledger yet"}
                  </span>
                ) : (
                  <span className="flex flex-wrap items-center gap-x-2" data-testid="on-chain-since">
                    {onChainSince.at ? formatDate(onChainSince.at) : "Recorded"}
                    <a
                      href={expertTxUrl(onChainSince.hash)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-muted-foreground hover:text-foreground font-mono text-[12px]"
                    >
                      tx {onChainSince.hash.slice(0, 6)}…{onChainSince.hash.slice(-4)}
                    </a>
                  </span>
                )}
              </Row>
              <Row label="Notes">{noteCount === null ? "…" : noteCount}</Row>
              <Row label="Network">{IS_MAINNET ? "Stellar Mainnet" : "Stellar Testnet"}</Row>
            </Section>
            {MARKET_CONTRACT_ID ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="self-start"
                render={<Link href="/vault/templates?tab=yours" />}
              >
                <StoreIcon />
                Your templates &amp; earnings
              </Button>
            ) : null}
          </>
        ) : null}

        {tab === "wallet" ? (
          <>
            <Section title="Wallet" icon={WalletIcon}>
              <p className="text-muted-foreground text-[13px]">
                Your wallet signs every anchor, so each receipt on Stellar is provably yours.
              </p>
              {address ? (
                <>
                  <Row
                    label="Type"
                    help={
                      identity.kind === "email"
                        ? "Opens with your passkey: your fingerprint, face or device PIN. No seed phrase."
                        : "An account you control in the Freighter browser extension."
                    }
                  >
                    {identity.kind === "email" ? "Passkey wallet" : "Freighter account"}
                  </Row>
                  <Row label="Address">
                    <span className="flex min-w-0 items-center gap-1.5">
                      <span className="truncate font-mono text-[12px]" data-testid="wallet-address" title={address}>
                        {address}
                      </span>
                      <Button
                        type="button"
                        size="icon-sm"
                        variant="ghost"
                        aria-label="Copy address"
                        onClick={() => void copy(address, "Address")}
                      >
                        <CopyIcon />
                      </Button>
                    </span>
                  </Row>
                  {identity.kind === "wallet" ? (
                    <Row label="Freighter">
                      {wallet.walletAddress === null
                        ? "Not connected in this browser"
                        : wallet.mismatch
                          ? "Connected to a different account"
                          : "Connected"}
                    </Row>
                  ) : null}
                  <Row label="Balance">
                    <span className="grid">
                      <span className={cn("tabular-nums", lowOrEmpty && "text-warning")} data-testid="profile-balance">
                        {balanceText}
                      </span>
                      <span className="text-muted-foreground text-[12px]">{balanceDetail}</span>
                    </span>
                  </Row>
                  {smartWallet ? (
                    <Row label="Passkeys" help="Each passkey can open this wallet. Keep at least two, on different devices.">
                      {smartWallet.passkeys.length}
                      {smartWallet.passkeys.length < 2 ? (
                        <span className="text-warning ml-1.5 text-[12px]">no backup yet</span>
                      ) : null}
                    </Row>
                  ) : null}

                  <div className="flex flex-wrap items-center gap-2 pt-1">
                    {smartWallet ? (
                      <Button type="button" size="sm" variant="outline" onClick={() => setPasskeysOpen(true)}>
                        <KeyRoundIcon />
                        Manage passkeys
                      </Button>
                    ) : null}
                    {!IS_MAINNET && identity.kind === "email" && USER_PAYS_FEES ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={busy !== null || wallet.preparingWallet}
                        data-testid="profile-top-up"
                        onClick={topUp}
                      >
                        {busy === "Top up" ? <Loader2Icon className="animate-spin" /> : <DropletIcon />}
                        Top up with test XLM
                      </Button>
                    ) : null}
                    {!IS_MAINNET && identity.kind === "wallet" ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={busy !== null || wallet.preparingWallet}
                        onClick={fund}
                      >
                        {busy === "Friendbot" ? <Loader2Icon className="animate-spin" /> : <DropletIcon />}
                        Fund with Friendbot
                      </Button>
                    ) : null}
                    {identity.kind === "wallet" && wallet.walletAddress === null ? (
                      <Button type="button" size="sm" variant="outline" disabled={busy !== null} onClick={reconnect}>
                        <PlugIcon />
                        Reconnect Freighter
                      </Button>
                    ) : null}
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      aria-label="Refresh balance and activity"
                      disabled={busy !== null}
                      onClick={() => void act("Refresh", async () => {
                        await wallet.refreshBalance();
                        await refreshActivity();
                      })}
                    >
                      {busy === "Refresh" ? <Loader2Icon className="animate-spin" /> : <RefreshCwIcon />}
                      Refresh
                    </Button>
                    <a
                      href={expertAddressUrl(address)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-[12px]"
                    >
                      View on stellar.expert
                      <ExternalLinkIcon className="size-3" />
                    </a>
                  </div>
                </>
              ) : (
                <Button
                  type="button"
                  size="sm"
                  className="justify-self-start"
                  disabled={busy !== null}
                  data-testid="profile-create-wallet"
                  onClick={createWallet}
                >
                  {busy === "Create wallet" ? <Loader2Icon className="animate-spin" /> : <KeyRoundIcon />}
                  {busy === "Create wallet" ? "Creating wallet…" : "Create passkey wallet"}
                </Button>
              )}
            </Section>

            {address ? (
              <Section title="Recent on-chain activity" icon={ExternalLinkIcon}>
                {activityError ? (
                  <p className="text-muted-foreground text-[13px]">Activity couldn&apos;t be loaded right now.</p>
                ) : activity === null ? (
                  <p className="text-muted-foreground text-[13px]">Loading…</p>
                ) : activity.length === 0 ? (
                  <p className="text-muted-foreground text-[13px]" data-testid="activity-empty">
                    Nothing yet. Save &amp; anchor a note and its receipt shows up here.
                  </p>
                ) : (
                  <ul className="divide-border -my-1 divide-y text-[13px]" data-testid="activity-list">
                    {activity.map((a) => (
                      <li key={a.hash} className="flex items-center gap-3 py-2">
                        <span className="grid min-w-0 flex-1">
                          <span className={cn(!a.ok && "text-warning")}>{a.label}</span>
                          <span className="text-muted-foreground truncate text-[12px]">
                            {a.detail ? `${a.detail} · ` : ""}
                            {formatDate(a.at)}
                          </span>
                        </span>
                        <a
                          href={expertTxUrl(a.hash)}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-muted-foreground hover:text-foreground font-mono text-[12px]"
                        >
                          {a.hash.slice(0, 6)}…{a.hash.slice(-4)}
                        </a>
                      </li>
                    ))}
                  </ul>
                )}
              </Section>
            ) : null}
          </>
        ) : null}

        {tab === "preferences" ? (
          <Section
            title="Preferences"
            icon={Settings2Icon}
            aside={
              <span aria-live="polite" className="text-muted-foreground flex items-center gap-1 text-[12px]">
                {savedAt ? (
                  <>
                    <CheckIcon className="size-3.5" />
                    Saved
                  </>
                ) : null}
              </span>
            }
          >
            <Row label="Theme" help="Auto follows your device. The graph and mindmap canvases stay dark.">
              <Choice
                label="Theme"
                value={prefs.theme}
                options={[
                  ["dark", "Dark"],
                  ["light", "Light"],
                  ["system", "Auto"],
                ]}
                onChange={(theme) => savePreference({ theme })}
              />
            </Row>
            <Row label="Editor text" help="The size of the text you write in notes.">
              <Choice
                label="Editor text size"
                value={prefs.textSize}
                options={[
                  ["small", "Small"],
                  ["medium", "Medium"],
                  ["large", "Large"],
                ]}
                onChange={(textSize) => savePreference({ textSize })}
              />
            </Row>
            <Row label="Reduce motion" help="Turns off animations and transitions across Doqtri.">
              <Switch
                label="Reduce motion"
                checked={prefs.reduceMotion}
                testId="pref-reduce-motion"
                onChange={(reduceMotion) => savePreference({ reduceMotion })}
              />
            </Row>
            <p className="text-muted-foreground text-[12px]">
              Changes apply right away. They&apos;re saved in this browser and to your account, so a new browser
              picks them up after you sign in.
            </p>
          </Section>
        ) : null}

        {tab === "invite" && referral ? (
          <Section title="Invite friends" icon={GiftIcon}>
            <p className="text-muted-foreground text-[13px]">
              Share your link. Anyone who opens it and then creates an account is counted as your referral.
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <span
                className="glass min-w-0 flex-1 truncate rounded-lg px-3 py-2 font-mono text-[12px]"
                data-testid="referral-link"
                title={referral.url}
              >
                {referral.url}
              </span>
              <Button type="button" size="sm" onClick={() => void copy(referral.url, "Referral link")}>
                <CopyIcon />
                Copy link
              </Button>
            </div>
            <Row label="Signed up">
              <span data-testid="referral-count">
                {referral.referred === 1 ? "1 person" : `${referral.referred} people`}
              </span>
            </Row>
          </Section>
        ) : null}
      </main>
      {smartWallet ? <PasskeysDialog open={passkeysOpen} onOpenChange={setPasskeysOpen} /> : null}
    </div>
  );
}

function Section({
  title,
  icon: Icon,
  aside,
  children,
}: {
  title: string;
  icon: React.ComponentType<{ className?: string; strokeWidth?: number }>;
  aside?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="glass grid gap-3 rounded-2xl px-4 py-4 sm:px-5">
      <div className="flex items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-[15px] font-medium">
          <Icon className="text-muted-foreground size-4" strokeWidth={1.5} />
          {title}
        </h2>
        {aside}
      </div>
      <div className="grid gap-2.5">{children}</div>
    </section>
  );
}

function Row({ label, help, children }: { label: string; help?: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[7.5rem_minmax(0,1fr)] items-start gap-3 text-[13px] max-sm:grid-cols-1 max-sm:gap-0.5">
      <span className="text-muted-foreground">{label}</span>
      <span className="min-w-0">
        {children}
        {help ? <span className="text-muted-foreground mt-1 block text-[12px]">{help}</span> : null}
      </span>
    </div>
  );
}

/** An on/off switch: clearer than a checkbox for a setting that applies at once. */
function Switch({
  label,
  checked,
  testId,
  onChange,
}: {
  label: string;
  checked: boolean;
  testId?: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      data-testid={testId}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors",
        checked ? "bg-primary border-transparent" : "border-[var(--glass-lo)] bg-[var(--glass)]",
      )}
    >
      <span
        className={cn(
          "bg-background size-3.5 rounded-full shadow transition-transform",
          checked ? "translate-x-[18px]" : "translate-x-[3px]",
        )}
      />
    </button>
  );
}

function Choice<T extends Preferences[keyof Preferences] & string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: [T, string][];
  onChange: (value: T) => void;
}) {
  return (
    <span role="radiogroup" aria-label={label} className="glass inline-flex rounded-lg p-0.5">
      {options.map(([option, text]) => (
        <button
          key={option}
          type="button"
          role="radio"
          aria-checked={value === option}
          data-testid={`pref-${label.toLowerCase().replace(/\s+/g, "-")}-${option}`}
          onClick={() => onChange(option)}
          className={cn(
            "rounded-md px-3 py-1 text-[12px] transition-colors",
            value === option ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {text}
        </button>
      ))}
    </span>
  );
}

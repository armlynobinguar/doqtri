"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { CheckIcon, Loader2Icon, PlugIcon, RefreshCwIcon, TriangleAlertIcon, UnplugIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { StatusTag } from "@/components/ui/status-tag";
import {
  connectedAppsPath,
  describeQditOutcome,
  qditAccountName,
  type QditConnectionSummary,
} from "@/lib/integrations/connected-apps";
import { cn } from "@/lib/utils";

export type ConnectedAppsData = {
  /** The user's qdit connection, or null if they never connected. */
  qdit: QditConnectionSummary | null;
  /** The status could not be read (e.g. the migration is not applied yet). */
  unavailable?: boolean;
};

const CONNECT_URL = "/api/integrations/qdit/connect";

/**
 * Connected apps in the profile (WP-2.3): the user's own qdit connection,
 * with connect, reconnect and disconnect. Rendered only when
 * NEXT_PUBLIC_QDIT_INTEGRATION=1 (the profile page decides).
 *
 * Connect and reconnect are plain links to the connect route, which sends
 * the browser through qdit's consent and back here with `?qdit=<outcome>`;
 * this component says what happened and then drops it from the URL.
 */
export function ConnectedApps({ data }: { data: ConnectedAppsData }) {
  const router = useRouter();
  const params = useSearchParams();
  const [notice] = useState(() => describeQditOutcome(params.get("qdit"), params.get("reason"), data.qdit));
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const cleaned = useRef(false);

  // The outcome is shown once; a reload should not repeat it.
  useEffect(() => {
    if (cleaned.current || !params.get("qdit")) return;
    cleaned.current = true;
    router.replace(connectedAppsPath(), { scroll: false });
  }, [params, router]);

  const qdit = data.qdit;
  const status = qdit?.status ?? "revoked";

  async function disconnect() {
    setBusy(true);
    try {
      const res = await fetch("/api/integrations/qdit/disconnect", { method: "POST" });
      const body = (await res.json().catch(() => ({}))) as { error?: string; revoked_in_qdit?: boolean };
      if (!res.ok) throw new Error(body.error ?? "Couldn't disconnect qdit.");
      toast.success(
        body.revoked_in_qdit
          ? "qdit is disconnected."
          : "qdit is disconnected here. To remove Doqtri from qdit too, revoke it under Authorized apps in qdit's settings.",
      );
      setConfirming(false);
      router.refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Couldn't disconnect qdit.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="glass grid gap-3 rounded-2xl px-4 py-4 sm:px-5" data-testid="connected-apps">
      <div className="flex items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-[15px] font-medium">
          <PlugIcon className="text-muted-foreground size-4" strokeWidth={1.5} />
          Connected apps
        </h2>
      </div>

      {notice ? (
        <div
          role="status"
          data-testid="qdit-outcome"
          className={cn(
            "flex items-start gap-2 rounded-xl border px-3 py-2 text-[13px]",
            notice.tone === "warning" ? "border-warning/40 bg-warning/10" : "border-[var(--glass-lo)] bg-[var(--glass)]",
          )}
        >
          {notice.tone === "warning" ? (
            <TriangleAlertIcon className="text-warning mt-0.5 size-4 shrink-0" />
          ) : (
            <CheckIcon className="mt-0.5 size-4 shrink-0" />
          )}
          <span>{notice.text}</span>
        </div>
      ) : null}

      <div className="grid gap-2.5 rounded-xl border border-[var(--glass-lo)] px-3 py-3" data-testid="connected-app-qdit">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0">
            <p className="text-[14px] font-medium">qdit</p>
            <p className="text-muted-foreground text-[12px]">
              Link plans to qdit projects, and create milestones from headings.
            </p>
          </div>
          <StatusTag
            tone={status === "connected" ? "verified" : status === "needs_reconnect" ? "warning" : "planned"}
            data-testid="qdit-status"
          >
            {status === "connected" ? "Connected" : status === "needs_reconnect" ? "Reconnect needed" : "Not connected"}
          </StatusTag>
        </div>

        {qdit && status !== "revoked" ? (
          <div className="grid grid-cols-[7.5rem_minmax(0,1fr)] gap-x-3 gap-y-1 text-[13px] max-sm:grid-cols-1">
            <span className="text-muted-foreground">Account</span>
            <span className="truncate" title={qdit.subject} data-testid="qdit-account">
              {qditAccountName(qdit)}
            </span>
            <span className="text-muted-foreground">Connected</span>
            <span>{new Date(qdit.connectedAt).toLocaleDateString(undefined, { dateStyle: "long" })}</span>
          </div>
        ) : null}

        {status === "needs_reconnect" ? (
          <p className="text-[12px]">
            qdit no longer accepts this connection: it was revoked in qdit, or it expired. Reconnect to keep
            linking plans.
          </p>
        ) : null}
        {data.unavailable ? (
          <p className="text-muted-foreground text-[12px]">The connection status couldn&apos;t be loaded.</p>
        ) : null}

        <div className="flex flex-wrap items-center gap-2">
          {status === "connected" ? null : (
            <Button type="button" size="sm" render={<a href={CONNECT_URL} />} data-testid="qdit-connect">
              {status === "needs_reconnect" ? <RefreshCwIcon /> : <PlugIcon />}
              {status === "needs_reconnect" ? "Reconnect qdit" : "Connect qdit"}
            </Button>
          )}
          {status !== "revoked" ? (
            confirming ? (
              <>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="text-destructive"
                  disabled={busy}
                  onClick={() => void disconnect()}
                  data-testid="qdit-disconnect-confirm"
                >
                  {busy ? <Loader2Icon className="animate-spin" /> : <UnplugIcon />}
                  Disconnect
                </Button>
                <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => setConfirming(false)}>
                  Cancel
                </Button>
              </>
            ) : (
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => setConfirming(true)}
                data-testid="qdit-disconnect"
              >
                <UnplugIcon />
                Disconnect
              </Button>
            )
          ) : null}
        </div>
        {confirming ? (
          <p className="text-muted-foreground text-[12px]">
            Doqtri stops acting in qdit for you. Projects and milestones in qdit stay as they are.
          </p>
        ) : null}
      </div>
    </section>
  );
}

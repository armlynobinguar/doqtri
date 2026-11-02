"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { CheckIcon, ChevronDownIcon, Loader2Icon, PlugIcon, RefreshCwIcon, TriangleAlertIcon, UnplugIcon } from "lucide-react";
import { toast } from "sonner";
import { QditMark } from "@/components/brand/qdit-mark";
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
  // Only a live connection has details and a Disconnect to show. A connection
  // that needs reconnecting opens by default, so its fix is in view.
  const expandable = status !== "revoked";
  const [open, setOpen] = useState(status === "needs_reconnect");

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
      setOpen(false);
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

      <div
        className={cn(
          "overflow-hidden rounded-xl border border-[var(--glass-lo)] transition-colors",
          open && "bg-[var(--glass)]",
        )}
        data-testid="connected-app-qdit"
      >
        {/* The whole row opens the details. A never-connected app has nothing
            to show there, so its row carries the Connect button instead. */}
        <div className="flex items-center gap-3 px-3 py-2.5">
          <button
            type="button"
            className="-my-1 -ml-1 flex min-w-0 flex-1 items-center gap-3 rounded-lg py-1 pl-1 text-left outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-default"
            aria-expanded={expandable ? open : undefined}
            aria-controls={expandable ? "connected-app-qdit-details" : undefined}
            disabled={!expandable}
            onClick={() => setOpen((v) => !v)}
            data-testid="qdit-toggle"
          >
            <span
              aria-hidden
              className="grid size-9 shrink-0 place-items-center rounded-[10px] border border-[var(--glass-lo)] bg-[var(--glass)] shadow-[inset_0_1px_0_0_var(--glass-hi)]"
            >
              <QditMark className="size-5" />
            </span>
            <span className="grid min-w-0 flex-1">
              <span className="flex items-center gap-2">
                <span className="text-[14px] font-medium">qdit</span>
                <StatusTag
                  tone={status === "connected" ? "verified" : status === "needs_reconnect" ? "warning" : "planned"}
                  data-testid="qdit-status"
                >
                  {status === "connected" ? "Connected" : status === "needs_reconnect" ? "Reconnect needed" : "Not connected"}
                </StatusTag>
              </span>
              <span className="text-muted-foreground truncate text-[12px]">
                {qdit && status !== "revoked" ? (
                  <>
                    <span title={qdit.subject} data-testid="qdit-account">
                      {qditAccountName(qdit)}
                    </span>
                    {" · since "}
                    {new Date(qdit.connectedAt).toLocaleDateString(undefined, { dateStyle: "medium" })}
                  </>
                ) : (
                  "Link plans to qdit projects."
                )}
              </span>
            </span>
            {expandable ? (
              <ChevronDownIcon
                aria-hidden
                className={cn("text-muted-foreground size-4 shrink-0 transition-transform", open && "rotate-180")}
              />
            ) : null}
          </button>
          {status === "revoked" ? (
            <Button type="button" size="sm" render={<a href={CONNECT_URL} />} data-testid="qdit-connect">
              <PlugIcon />
              Connect
            </Button>
          ) : null}
        </div>

        {expandable && open ? (
          <div
            id="connected-app-qdit-details"
            className="grid gap-2.5 border-t border-[var(--glass-lo)] px-3 py-3"
            data-testid="qdit-details"
          >
            <p className="text-muted-foreground text-[12px]">
              Link plans to qdit projects, and create milestones from headings.
            </p>
            {status === "needs_reconnect" ? (
              <p className="text-[12px]">
                qdit no longer accepts this connection: it was revoked in qdit, or it expired. Reconnect to keep
                linking plans.
              </p>
            ) : null}
            {confirming ? (
              <p className="text-muted-foreground text-[12px]">
                Doqtri stops acting in qdit for you. Projects and milestones in qdit stay as they are. Removing
                Doqtri&apos;s access in qdit too is best effort: to be sure, revoke it under Authorized apps in qdit.
              </p>
            ) : null}
            <div className="flex flex-wrap items-center gap-2">
              {status === "needs_reconnect" && !confirming ? (
                <Button type="button" size="sm" render={<a href={CONNECT_URL} />} data-testid="qdit-connect">
                  <RefreshCwIcon />
                  Reconnect qdit
                </Button>
              ) : null}
              {confirming ? (
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
                  className="text-destructive"
                  onClick={() => setConfirming(true)}
                  data-testid="qdit-disconnect"
                >
                  <UnplugIcon />
                  Disconnect
                </Button>
              )}
            </div>
          </div>
        ) : null}
        {data.unavailable ? (
          <p className="text-muted-foreground border-t border-[var(--glass-lo)] px-3 py-2 text-[12px]">
            The connection status couldn&apos;t be loaded.
          </p>
        ) : null}
      </div>
    </section>
  );
}

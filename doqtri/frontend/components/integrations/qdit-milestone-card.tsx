"use client";

import { useEffect, useRef, useState } from "react";
import { ExternalLinkIcon, Loader2Icon, LockIcon, PlugIcon, RefreshCwIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { StatusTag } from "@/components/ui/status-tag";
import {
  anchorLabel,
  anchorTxUrl,
  cardStateFromResponse,
  formatDueDate,
  NO_ACCESS_TEXT,
  NODE_STATUS_FOR,
  QDIT_STATUS_LABEL,
  QDIT_STATUS_TONE,
  safeHttpUrl,
  type MilestoneCardState,
} from "@/lib/integrations/qdit-milestone-card";

/**
 * A linked heading's qdit milestone (WP-2.6): title, qdit's status and the
 * node status it maps to (D-19), project, due date, the newest anchor
 * record and a link out to qdit. Shown only with NEXT_PUBLIC_QDIT_INTEGRATION=1
 * (its callers decide). The states and what each shows are in
 * lib/integrations/qdit-milestone-card.ts.
 *
 * The milestone is read through /api/integrations/qdit/milestones/[id], as
 * the user, once the card scrolls into view: each card is a request to qdit,
 * and a note can link many headings. A caller that already knows the user's
 * connection passes it, and a card without a usable one asks nothing.
 */

const API = "/api/integrations/qdit/milestones";
const CONNECT_URL = "/api/integrations/qdit/connect";

/** As the ship panel knows it; undefined lets the route find out. */
export type CardConnection = "loading" | "connected" | "needs_reconnect" | "none";

const LINK_CLASS = "text-muted-foreground inline-flex items-center gap-1 text-[11px] hover:underline";

export function QditMilestoneCard({
  milestoneId,
  connection,
  showTitle = true,
  fallbackUrl,
}: {
  milestoneId: string;
  connection?: CardConnection;
  /** Off where the heading's own label already stands above the card. */
  showTitle?: boolean;
  /** The qdit page doqtri stored for the link, offered when the card can't load. */
  fallbackUrl?: string | null;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [fetched, setFetched] = useState<{ key: string; state: MilestoneCardState } | null>(null);
  const key = `${milestoneId}#${attempt}`;
  const asks = visible && (connection === undefined || connection === "connected");

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        setVisible(true);
        observer.disconnect();
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!asks) return;
    const controller = new AbortController();
    void (async () => {
      let state: MilestoneCardState;
      try {
        const res = await fetch(`${API}/${encodeURIComponent(milestoneId)}`, { signal: controller.signal });
        const body: unknown = await res.json().catch(() => null);
        state = cardStateFromResponse(res.status, body, res.headers.get("retry-after"));
      } catch {
        if (controller.signal.aborted) return;
        state = { state: "error", message: "Doqtri couldn't reach the server. Try again.", retryAfterSeconds: null };
      }
      if (!controller.signal.aborted) setFetched({ key, state });
    })();
    return () => controller.abort();
  }, [asks, milestoneId, key]);

  const state: MilestoneCardState =
    connection === "none" || connection === "needs_reconnect"
      ? { state: "not_connected", connection }
      : fetched?.key === key
        ? fetched.state
        : { state: "loading" };

  return (
    <div ref={ref}>
      <QditMilestoneCardView
        state={state}
        showTitle={showTitle}
        fallbackUrl={fallbackUrl}
        onRetry={() => setAttempt((n) => n + 1)}
      />
    </div>
  );
}

/** The card for a state, without fetching: what the tests render. */
export function QditMilestoneCardView({
  state,
  showTitle = true,
  fallbackUrl,
  onRetry,
}: {
  state: MilestoneCardState;
  showTitle?: boolean;
  fallbackUrl?: string | null;
  onRetry?: () => void;
}) {
  // Not for no-access: qdit would only say the same thing again.
  const outLink =
    state.state === "not_connected" || state.state === "error" ? safeHttpUrl(fallbackUrl ?? null) : null;
  return (
    <div data-testid="qdit-milestone-card" data-state={state.state} className="grid gap-1 text-[11px] leading-snug">
      {state.state === "loading" ? (
        <p className="text-muted-foreground inline-flex items-center gap-1.5" aria-busy="true">
          <Loader2Icon className="size-3 animate-spin" />
          Loading the milestone from qdit…
        </p>
      ) : state.state === "loaded" ? (
        <Loaded milestone={state.milestone} showTitle={showTitle} />
      ) : state.state === "no_access" ? (
        <p className="text-muted-foreground inline-flex items-center gap-1.5">
          <LockIcon className="size-3 shrink-0" />
          {NO_ACCESS_TEXT}
        </p>
      ) : state.state === "not_connected" ? (
        <div className="grid gap-1.5">
          <p className="text-muted-foreground">
            {state.connection === "needs_reconnect"
              ? "Your qdit connection has expired or was revoked. Reconnect to see this milestone."
              : "Connect your qdit account to see this milestone."}
          </p>
          <Button
            size="sm"
            variant="outline"
            className="h-6 justify-self-start px-2 text-[11px] max-lg:h-9"
            nativeButton={false}
            render={<a href={CONNECT_URL} />}
          >
            <PlugIcon />
            {state.connection === "needs_reconnect" ? "Reconnect qdit" : "Connect qdit"}
          </Button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-1.5">
          <p className="text-muted-foreground min-w-0 flex-1">
            {state.message}
            {state.retryAfterSeconds ? ` (about ${state.retryAfterSeconds}s)` : ""}
          </p>
          {onRetry ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-6 px-1.5 text-[11px] max-lg:h-9 max-lg:px-2.5"
              onClick={onRetry}
            >
              <RefreshCwIcon />
              Retry
            </Button>
          ) : null}
        </div>
      )}
      {outLink ? (
        <a href={outLink} target="_blank" rel="noreferrer noopener" className={`${LINK_CLASS} justify-self-start`}>
          Open in qdit
          <ExternalLinkIcon className="size-3" />
        </a>
      ) : null}
    </div>
  );
}

function Loaded({
  milestone,
  showTitle,
}: {
  milestone: Extract<MilestoneCardState, { state: "loaded" }>["milestone"];
  showTitle: boolean;
}) {
  const { status, anchor } = milestone;
  return (
    <>
      {showTitle ? (
        <span className="text-foreground truncate text-[12px] font-medium" title={milestone.title}>
          {milestone.title}
        </span>
      ) : null}
      <div className="flex flex-wrap items-center gap-1.5">
        <StatusTag tone={status ? QDIT_STATUS_TONE[status] : "planned"} title="The milestone's status in qdit">
          {status ? QDIT_STATUS_LABEL[status] : "Unknown status"}
        </StatusTag>
        {status ? (
          <span
            className="text-muted-foreground"
            title="The node status this maps to. Doqtri reads the chain before it suggests or signs one."
          >
            Node: {NODE_STATUS_FOR[status]}
          </span>
        ) : null}
      </div>
      <p className="text-muted-foreground truncate">
        {milestone.project.name}
        {milestone.due_date ? ` · Due ${formatDueDate(milestone.due_date)}` : ""}
      </p>
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
        {anchor ? (
          <a
            href={anchorTxUrl(anchor)}
            target="_blank"
            rel="noreferrer noopener"
            className={LINK_CLASS}
            title="qdit's newest record of this milestone on chain"
          >
            {anchorLabel(anchor)}
            <ExternalLinkIcon className="size-3" />
          </a>
        ) : (
          <span className="text-muted-foreground">Not on chain yet</span>
        )}
        {milestone.url ? (
          <a href={milestone.url} target="_blank" rel="noreferrer noopener" className={LINK_CLASS}>
            Open in qdit
            <ExternalLinkIcon className="size-3" />
          </a>
        ) : null}
      </div>
    </>
  );
}

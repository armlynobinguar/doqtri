import type { ReferralDashboard } from "@/lib/referral-dashboard";

/** What one read of a page of the list comes back with. */
export type ReferralsRead = { kind: "ready"; data: ReferralDashboard } | { kind: "error"; message: string };

export type ReferralsState = {
  /** What's on screen: the last page that loaded, kept when a later one fails. */
  data: ReferralDashboard | null;
  busy: boolean;
  /** Why the last read failed. Stays up during a retry, so the button pressed doesn't vanish under it. */
  error: string | null;
  /** The page asked for last, which is the one a retry asks for again. */
  page: number;
};

export type ReferralsPager = {
  subscribe: (listener: () => void) => () => void;
  getState: () => ReferralsState;
  goTo: (page: number) => Promise<void>;
  retry: () => Promise<void>;
};

/**
 * The dashboard's paging, apart from React so that it can be tested without a
 * DOM, which the unit tests don't have. Only the newest request counts: an older
 * one answering late is dropped, whichever way it went.
 */
export function createReferralsPager(read: (page: number) => Promise<ReferralsRead>): ReferralsPager {
  let state: ReferralsState = { data: null, busy: true, error: null, page: 1 };
  let latest = 0;
  const listeners = new Set<() => void>();

  function set(next: ReferralsState) {
    state = next;
    for (const listener of listeners) listener();
  }

  async function goTo(page: number) {
    const request = ++latest;
    set({ ...state, busy: true, page });
    const result = await read(page);
    if (request !== latest) return;
    set(
      result.kind === "ready"
        ? // The server's page, not the one asked for: past the end it answers with the last.
          { data: result.data, busy: false, error: null, page: result.data.page }
        : { ...state, busy: false, error: result.message },
    );
  }

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getState: () => state,
    goTo,
    retry: () => goTo(state.page),
  };
}

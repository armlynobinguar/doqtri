/**
 * Serialises a note's writes so they land in the order they were made.
 *
 * Autosave and "Save & anchor" both write the same row. Run concurrently, an
 * older autosave could finish after the anchor's save and leave Supabase
 * holding text other than what was hashed on-chain. Queuing them keeps the
 * last write the newest one.
 */
export type SaveQueue = {
  /** Writes `text` after any write already in flight; a no-op when it is already saved. */
  save(text: string): Promise<void>;
  /** Adopts `text` as saved without writing it, for text the server already has. */
  markSaved(text: string): void;
  /**
   * Runs `task` after any write in flight, and holds the writes queued
   * meanwhile until it settles: for another write of the same row (a rename
   * that rewrites the title heading) that must not race a save.
   *
   * A write queued while the task was pending does not write the text it was
   * given, which predates the task's own write (it would put the old heading
   * back). When its turn comes it writes `current()`, the editor's text then,
   * and nothing when that is already saved.
   */
  run<T>(task: () => Promise<T>, current: () => string): Promise<T>;
  /** The last text known to be stored. */
  readonly saved: string;
};

export function createSaveQueue(
  initial: string,
  write: (text: string) => Promise<void>,
): SaveQueue {
  let saved = initial;
  let tail: Promise<unknown> = Promise.resolve();
  // The run() tasks not yet settled, and the newest one's `current`.
  let pendingRuns = 0;
  let pendingCurrent: (() => string) | null = null;

  return {
    save(given) {
      const redirect = pendingRuns > 0 ? pendingCurrent : null;
      const run = async () => {
        const text = redirect ? redirect() : given;
        if (text === saved) return;
        await write(text);
        saved = text;
      };
      // A failed write must not wedge the writes queued behind it.
      const next = tail.then(run, run);
      tail = next.catch(() => {});
      return next;
    },
    markSaved(text) {
      saved = text;
    },
    run(task, current) {
      pendingRuns += 1;
      pendingCurrent = current;
      const settle = () => {
        pendingRuns -= 1;
        if (pendingRuns === 0) pendingCurrent = null;
      };
      const next = tail.then(task, task).finally(settle);
      tail = next.catch(() => {});
      return next;
    },
    get saved() {
      return saved;
    },
  };
}

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
  /** The last text known to be stored. */
  readonly saved: string;
};

export function createSaveQueue(
  initial: string,
  write: (text: string) => Promise<void>,
): SaveQueue {
  let saved = initial;
  let tail: Promise<unknown> = Promise.resolve();

  return {
    save(text) {
      const run = async () => {
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
    get saved() {
      return saved;
    },
  };
}

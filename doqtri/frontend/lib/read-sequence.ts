/**
 * Keeps a stale reload from overwriting newer state (DOQ-33, WP-1.7).
 *
 * Screens that show a change before the server confirms it reload after the
 * write, without waiting. Reloads can then overlap, and answers can arrive
 * out of order: a reload started before a later write succeeded would bring
 * that write's row back. Each reload takes a ticket when it starts; a
 * successful write, or a newer reload, moves the sequence on; a reload whose
 * ticket is no longer current drops its result. Pure and browser-safe.
 */
export class ReadSequence {
  private current = 0;

  /** Starts a read. Pass the ticket to isCurrent() once its answer lands. */
  start(): number {
    this.current += 1;
    return this.current;
  }

  /** Something changed that reads already in flight cannot have seen. */
  invalidate(): void {
    this.current += 1;
  }

  /** Whether nothing has started or changed since `ticket` was taken. */
  isCurrent(ticket: number): boolean {
    return ticket === this.current;
  }
}

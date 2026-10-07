"use client";

import { LockIcon } from "lucide-react";

/**
 * The lock beside a focused node. Pressing it keeps that node's branch lit
 * until it is unlocked — here, or from the toolbar.
 *
 * It follows the node every frame, so the renderer moves it with
 * `placeLockButton` rather than through React state: a render per frame would
 * be far more work than writing one transform.
 */
export function FocusLockButton({
  buttonRef,
  onToggle,
  onPointerEnter,
}: {
  buttonRef: React.Ref<HTMLButtonElement>;
  onToggle: () => void;
  /** Reaching the button must not count as leaving the node. */
  onPointerEnter: () => void;
}) {
  return (
    <button
      ref={buttonRef}
      type="button"
      onClick={onToggle}
      onPointerEnter={onPointerEnter}
      style={{ display: "none" }}
      aria-label="Lock highlight"
      title="Lock this highlight"
      className="in-data-[zen=true]:invisible glass-float text-foreground data-[locked=true]:bg-accent data-[locked=true]:text-background absolute top-0 left-0 z-10 items-center justify-center rounded-full backdrop-blur transition-colors hover:bg-[var(--glass-strong)] size-6 pointer-coarse:size-8"
    >
      <LockIcon className="size-3 pointer-coarse:size-3.5" strokeWidth={2.2} />
    </button>
  );
}

/**
 * Shows the lock at a point (page pixels within the canvas container) or hides
 * it when there is nothing focused. Writes to the DOM only when something
 * actually changed.
 */
export function placeLockButton(
  button: HTMLButtonElement | null,
  at: { x: number; y: number } | null,
  locked: boolean,
) {
  if (!button) return;
  if (!at) {
    if (button.style.display !== "none") button.style.display = "none";
    return;
  }
  const transform = `translate(${Math.round(at.x)}px, ${Math.round(at.y)}px)`;
  if (button.style.transform !== transform) button.style.transform = transform;
  if (button.style.display !== "flex") button.style.display = "flex";
  const state = String(locked);
  if (button.dataset.locked !== state) {
    button.dataset.locked = state;
    const label = locked ? "Unlock highlight" : "Lock highlight";
    button.setAttribute("aria-label", label);
    button.title = locked ? "Unlock this highlight" : "Lock this highlight";
  }
}

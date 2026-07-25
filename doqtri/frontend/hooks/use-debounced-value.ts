"use client";

import { useEffect, useState } from "react";

/**
 * Trails `value` by `delayMs`. Used to keep the force-graph simulation and the
 * Supabase write off the keystroke path.
 */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [settled, setSettled] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);

  return settled;
}

import type { OpsCheck, OpsStatus } from "@/lib/ops/types";

/** Worst first: what is broken, then what could not be read, then what needs a look. */
export const STATUS_RANK: Readonly<Record<OpsStatus, number>> = {
  crit: 0,
  unknown: 1,
  warn: 2,
  ok: 3,
  off: 4,
};

export function worst(statuses: OpsStatus[]): OpsStatus {
  return statuses.reduce<OpsStatus>((a, b) => (STATUS_RANK[b] < STATUS_RANK[a] ? b : a), "off");
}

/** Worst first; checks of equal status keep their order. */
export function sortChecks(checks: OpsCheck[]): OpsCheck[] {
  return checks
    .map((check, i) => ({ check, i }))
    .sort((a, b) => STATUS_RANK[a.check.status] - STATUS_RANK[b.check.status] || a.i - b.i)
    .map(({ check }) => check);
}

export type Limits = { warn: number; crit: number };

/** For what runs out (a balance, days left): below crit is crit, below warn is warn. */
export function lowIsBad(value: number, { warn, crit }: Limits): OpsStatus {
  if (value < crit) return "crit";
  if (value < warn) return "warn";
  return "ok";
}

/** For what piles up (a share of a cap, an age, a count): at or above crit is crit. */
export function highIsBad(value: number, { warn, crit }: Limits): OpsStatus {
  if (value >= crit) return "crit";
  if (value >= warn) return "warn";
  return "ok";
}

/** used as a percentage of cap, 0 for a cap of 0. */
export function percent(used: number, cap: number): number {
  return cap > 0 ? (used / cap) * 100 : 0;
}

/** Seconds since an ISO time, or null when there is none. */
export function ageSeconds(iso: string | null | undefined, nowMs: number): number | null {
  if (!iso) return null;
  const at = Date.parse(iso);
  return Number.isNaN(at) ? null : Math.max(0, (nowMs - at) / 1000);
}

export function formatAge(seconds: number): string {
  if (seconds < 90) return `${Math.round(seconds)} s`;
  if (seconds < 90 * 60) return `${Math.round(seconds / 60)} min`;
  if (seconds < 48 * 3600) return `${Math.round(seconds / 3600)} h`;
  return `${Math.round(seconds / 86400)} d`;
}

export function formatCount(n: number): string {
  return n.toLocaleString("en-US");
}

export function formatXlm(n: number): string {
  return `${n.toLocaleString("en-US", { maximumFractionDigits: n < 100 ? 2 : 0 })} XLM`;
}

const UNITS = ["B", "KB", "MB", "GB", "TB"];

export function formatBytes(bytes: number): string {
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toLocaleString("en-US", { maximumFractionDigits: unit === 0 ? 0 : 1 })} ${UNITS[unit]}`;
}

/** G…ABCD: enough of a public key to tell accounts apart. */
export function shortKey(key: string): string {
  return key.length > 12 ? `${key.slice(0, 4)}…${key.slice(-4)}` : key;
}

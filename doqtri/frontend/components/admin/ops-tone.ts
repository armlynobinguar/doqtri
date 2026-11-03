import type { OpsStatus } from "@/lib/ops/types";

/** The StatusTag tone for each ops status. */
export const OPS_TONE: Record<OpsStatus, "verified" | "warning" | "danger" | "info" | "planned"> = {
  ok: "verified",
  warn: "warning",
  crit: "danger",
  unknown: "info",
  off: "planned",
};

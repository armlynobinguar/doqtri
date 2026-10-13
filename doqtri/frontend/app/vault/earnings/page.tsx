import { redirect } from "next/navigation";

/** Earnings moved into the template page's "Yours" tab. */
export default function EarningsPage() {
  redirect("/vault/templates?tab=yours");
}

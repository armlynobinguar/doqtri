import type { Metadata } from "next";
import { Suspense } from "react";
import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { TemplatesView } from "@/components/vault/templates-view";

export const metadata: Metadata = {
  title: "Templates · Doqtri",
  robots: { index: false },
};

/**
 * Starter templates, the community marketplace and the creator's own
 * templates with their earnings, on one page (progress/004). A static
 * segment, so it wins over `[docId]`; it renders inside the vault shell,
 * which provides the wallet for buying, tipping and listing changes.
 */
export default async function TemplatesPage() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  return (
    <Suspense>
      <TemplatesView />
    </Suspense>
  );
}

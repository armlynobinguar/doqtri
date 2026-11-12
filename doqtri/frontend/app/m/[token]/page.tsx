import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { SharedMindmap } from "@/components/share/shared-mindmap";
import { loadMindmapShare } from "@/lib/mindmap-share-server";

/*
 * A shared mindmap link (WP-4.7, DOQ-53): the global mindmap one press of
 * "Send to qdit hackathon" sent, frozen, for anyone with the link, signed in
 * or not. proxy.ts has already turned a malformed, unknown or revoked token
 * into a real 404; the notFound() below covers a link revoked in between.
 *
 * Read on every request (a revoke is a 404 at once), through the anon
 * mindmap_share() RPC: labels, kinds, depths, links and the sender's style
 * only, with node ids made opaque before they reach the browser
 * (opaqueIds). No markdown, no note ids, no links into the vault. Never indexed, and
 * no Referer leaves the page, since the URL is the secret.
 */

export const metadata: Metadata = {
  title: "Shared mindmap · Doqtri",
  description: "A read-only Doqtri mindmap, shared by link.",
  robots: { index: false, follow: false, nocache: true, googleBot: { index: false, follow: false } },
  referrer: "no-referrer",
};

export default async function SharedMindmapPage(props: PageProps<"/m/[token]">) {
  await connection();
  const { token } = await props.params;
  const share = await loadMindmapShare(token);
  if (!share) notFound();
  return <SharedMindmap graph={share.graph} style={share.style} createdAt={share.createdAt} />;
}

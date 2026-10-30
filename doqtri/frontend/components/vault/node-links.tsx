"use client";

import { useCallback, useState } from "react";
import { GitHubLinks } from "@/components/vault/github-links";
import { QditLinks } from "@/components/vault/qdit-links";
import { qditIntegrationEnabled } from "@/lib/integrations/qdit-config";
import type { LinkableNode, LinkProvider } from "@/lib/node-links";

/**
 * The ship panel's links, one section per provider (WP-2.5): GitHub, and
 * qdit when NEXT_PUBLIC_QDIT_INTEGRATION=1. Each provider loads and writes
 * its own rows; this keeps the one rule they share, that a heading has one
 * link of one provider (D-08), by telling each which headings the others
 * have linked. The database enforces it too (unique (document_id, node_id)).
 */
export function NodeLinks({
  docId,
  title,
  nodes,
  anchored,
  canSign,
  signerLoading = false,
  onSynced,
  onSave,
}: {
  docId: string;
  /** The note's title (the mindmap's root), for qdit roll-ups. */
  title: string;
  nodes: LinkableNode[];
  anchored: boolean;
  canSign: boolean;
  /** True while the user's standing on this note loads: GitHub Sync stays disabled. */
  signerLoading?: boolean;
  onSynced: () => void;
  onSave: () => Promise<string>;
}) {
  const [linked, setLinked] = useState<Record<LinkProvider, string[]>>({ github: [], qdit: [] });
  const onGitHub = useCallback((ids: string[]) => setLinked((l) => ({ ...l, github: ids })), []);
  const onQdit = useCallback((ids: string[]) => setLinked((l) => ({ ...l, qdit: ids })), []);
  const qdit = qditIntegrationEnabled();
  const nodesKey = nodes.map((n) => `${n.id}:${n.label}`).join("\n");

  return (
    <>
      <GitHubLinks
        key={docId}
        docId={docId}
        nodes={nodes}
        anchored={anchored}
        canSign={canSign}
        signerLoading={signerLoading}
        onSynced={onSynced}
        taken={qdit ? linked.qdit : []}
        onLinkedChange={onGitHub}
      />
      {qdit ? (
        <QditLinks
          key={`qdit-${docId}`}
          docId={docId}
          title={title}
          nodes={nodes}
          nodesKey={nodesKey}
          taken={linked.github}
          onLinkedChange={onQdit}
          onSave={onSave}
          canSign={canSign}
          onSynced={onSynced}
        />
      ) : null}
    </>
  );
}

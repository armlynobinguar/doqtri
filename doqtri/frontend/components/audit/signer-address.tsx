"use client";

import { useState } from "react";
import { CheckIcon, CopyIcon } from "lucide-react";
import { expertAddressUrl } from "@/lib/stellar/config";
import { shortAddress } from "@/lib/stellar/signers";

/**
 * A signer's wallet address on the audit page: shortened, with the whole
 * address on hover, a link to its explorer page and a copy button. Only the
 * address: member names are not published (WP-1.8). `href` replaces the
 * explorer link, for an address on another network than doqtri's (a qdit
 * submitter, WP-3.1).
 */
export function SignerAddress({ address, owner = false, href }: { address: string; owner?: boolean; href?: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard blocked: the full address is still in the link's title.
    }
  }

  return (
    <span className="inline-flex items-center gap-1">
      <a
        className="text-foreground/85 font-mono underline-offset-2 hover:underline"
        href={href ?? expertAddressUrl(address)}
        target="_blank"
        rel="noreferrer"
        title={address}
      >
        {shortAddress(address)}
      </a>
      {owner ? <span className="text-muted-foreground">(owner)</span> : null}
      <button
        type="button"
        onClick={copy}
        className="text-muted-foreground hover:text-foreground inline-flex size-5 items-center justify-center rounded"
        aria-label={copied ? "Address copied" : `Copy address ${address}`}
        title={copied ? "Copied" : "Copy address"}
      >
        {copied ? <CheckIcon className="size-3" /> : <CopyIcon className="size-3" />}
      </button>
    </span>
  );
}

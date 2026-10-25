/**
 * How the app names an account that has been deleted (D-63, WP-1.11).
 *
 * Deleting an account anonymises it and keeps its content: its notes, its
 * personal workspace when that holds notes or other members, its community
 * templates and its purchases stay, with no reference left to the account
 * (20261026100000_account_deletion_anonymises.sql). Where the app would name
 * that account it says "Former user", as Confluence and Jira do. Wallet
 * addresses stay where they were shown: the wallet is the on-chain identity
 * that signed and was paid, and the public audit page has only ever shown
 * signers by address.
 *
 * Pure, so the browser, the server and the tests share it.
 */
import { shortAddress } from "@/lib/market";

export const FORMER_USER = "Former user";

/**
 * Who a community template is by: its creator's wallet, shortened, with
 * "Former user" ahead of it once the creator's account is deleted
 * (market_templates.creator_id null).
 */
export function templateAuthor(template: { creatorWallet: string; creatorGone?: boolean }): string {
  const wallet = shortAddress(template.creatorWallet);
  return template.creatorGone ? `${FORMER_USER} · ${wallet}` : wallet;
}

/**
 * A personal workspace whose creator deleted their account: kept, nobody
 * owns it, and its members keep their roles (workspaces.created_by null).
 */
export function isFormerPersonalWorkspace(workspace: { is_personal: boolean; created_by: string | null }): boolean {
  return workspace.is_personal && workspace.created_by === null;
}

/** What the members screen says in such a workspace, in place of the personal-workspace note. */
export const FORMER_PERSONAL_WORKSPACE_NOTE =
  `This was the personal workspace of a ${FORMER_USER.toLowerCase()}, who deleted their account. ` +
  "Its notes stay here and members keep their roles, but nobody owns it any more and nobody can become its owner.";

import { createHash } from "node:crypto";
import { Keypair } from "@stellar/stellar-sdk";

/**
 * The address of the default e2e session's wallet (E2E_KEYPAIR in helpers.ts),
 * which playwright.config.ts lists in DOQTRI_ADMINS for the e2e dev server
 * (DOQ-18). Kept apart from helpers.ts so the config does not import app code.
 */
export const E2E_ADMIN_WALLET = Keypair.fromRawEd25519Seed(
  createHash("sha256").update("doqtri-e2e-wallet").digest(),
).publicKey();

/**
 * A second admin, for the referral payouts spec (DOQ-26): another admin must see
 * "Being paid by" and be unable to start a payout someone else holds. The label
 * is what e2eKeypair() in wallet-session.ts takes, which derives the same key.
 */
export const E2E_SECOND_ADMIN_LABEL = "doqtri-e2e-second-admin";
export const E2E_SECOND_ADMIN_WALLET = Keypair.fromRawEd25519Seed(
  createHash("sha256").update(E2E_SECOND_ADMIN_LABEL).digest(),
).publicKey();

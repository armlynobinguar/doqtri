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

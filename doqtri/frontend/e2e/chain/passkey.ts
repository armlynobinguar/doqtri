import type { CDPSession, Page } from "@playwright/test";

/**
 * A platform passkey for one page, from Chromium's virtual authenticator
 * (CDP WebAuthn domain), so the app's real "Create passkey" and signing
 * prompts run without a person (DOQ-19).
 *
 * The authenticator belongs to the page's target. A user who needs a second
 * page gets the same credentials copied over with `carryTo`, as a synced
 * passkey would appear on another tab.
 */
export type VirtualPasskey = {
  session: CDPSession;
  authenticatorId: string;
  /** Credentials the authenticator holds now (one after wallet setup). */
  credentials(): Promise<WebAuthnCredential[]>;
  /** A new page in the same context, holding the same credentials. */
  carryTo(page: Page): Promise<VirtualPasskey>;
};

type WebAuthnCredential = {
  credentialId: string;
  isResidentCredential: boolean;
  rpId?: string;
  privateKey: string;
  userHandle?: string;
  signCount: number;
};

export async function addVirtualPasskey(page: Page): Promise<VirtualPasskey> {
  const session = await page.context().newCDPSession(page);
  await session.send("WebAuthn.enable");
  const { authenticatorId } = await session.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      // Answers every prompt at once, as a tap would.
      automaticPresenceSimulation: true,
    },
  });
  const passkey: VirtualPasskey = {
    session,
    authenticatorId,
    async credentials() {
      const { credentials } = await session.send("WebAuthn.getCredentials", { authenticatorId });
      return credentials as WebAuthnCredential[];
    },
    async carryTo(other: Page) {
      const next = await addVirtualPasskey(other);
      for (const credential of await passkey.credentials()) {
        await next.session.send("WebAuthn.addCredential", { authenticatorId: next.authenticatorId, credential });
      }
      return next;
    },
  };
  return passkey;
}

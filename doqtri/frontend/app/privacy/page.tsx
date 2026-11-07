import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { TERMS_PATH } from "@/components/legal/legal-links";
import { LegalList, LegalPage, LegalTable, MailLink, type LegalSection } from "@/components/legal/legal-page";
import { legalOperatorName } from "@/lib/legal";
import {
  AGE_CLAUSE,
  ONCHAIN_PERMANENCE_CLAUSE,
  PRIVACY_EMAIL,
  REFERRAL_DELETION_CLAUSE,
  REFERRER_VIEW_CLAUSE,
} from "@/lib/legal-copy";

export const metadata: Metadata = {
  title: "Privacy Policy · Doqtri",
  description: "What Doqtri collects, why, who sees it, what stays public on Stellar, and your rights.",
};

function sections(operator: string): LegalSection[] {
  return [
    {
      id: "who",
      title: "Who we are",
      body: (
        <>
          <p>
            Doqtri is operated by <b>{operator}</b>, the personal information controller for Doqtri under the
            Philippine Data Privacy Act of 2012 (Republic Act No. 10173). There is no registered company behind
            Doqtri.
          </p>
          <p>
            Contact us by email only, at <MailLink address={PRIVACY_EMAIL} />. A person is designated as accountable
            for our compliance with the Act. Ask at that address and we will tell you who they are.
          </p>
        </>
      ),
    },
    {
      id: "collect",
      title: "What we collect",
      body: (
        <>
          <LegalTable
            head={["Kind", "What it is"]}
            rows={[
              [
                "Account",
                "Your email address, or for a wallet sign-in your wallet address and a placeholder email made from it. Your sign-up date and your display preferences (theme, text size, reduced motion). Supabase Auth handles your password. We do not ask for a display name or a profile picture.",
              ],
              [
                "Wallets and passkeys",
                "Stellar wallet addresses, the creation transaction of a passkey wallet, and for each passkey its credential id, public key, site and any label. Passkey private keys and biometrics stay on your device.",
              ],
              [
                "Content",
                "Notes (title, text, mindmap), uploaded files and their names, import status and errors, mindmap styles, templates you publish, template purchases (wallet, amount, transaction), copy reports you file, and promo entries (screenshots, caption, the contact details you give, an AI score and a review status).",
              ],
              [
                "Workspaces",
                "Workspace names, members and roles, invites (the wallet address or email address invited, which may be someone else's), ownership transfers, and a record of when a member lost the right to sign, with the wallet addresses they had then.",
              ],
              [
                "Referrals",
                "Your referral code, who referred whom, how the code arrived (link, QR code or typed in) and when, activity counts and rewards. To be paid, your name and either an XLM address with an optional memo or e-wallet details (provider, account name, number and notes, as text; no QR images). The record of each payout. Any feedback you choose to give.",
              ],
              [
                "Usage",
                "How many AI requests and on-chain writes you make, for daily limits. Wallet top-ups. Edit locks, which show who is editing a note.",
              ],
              [
                "Integrations",
                "If you connect qdit: your qdit account id and username or display name, the granted scopes, and encrypted access and refresh tokens, plus the qdit projects and milestones you link. If you link a mindmap node to GitHub: the repository and the issue or pull request number.",
              ],
              [
                "Technical logs",
                "Our own database tables have no field for IP addresses. Our hosting and database providers process IP addresses and request details to run the service, and may log them.",
              ],
            ]}
          />
        </>
      ),
    },
    {
      id: "why",
      title: "Why we use it",
      body: (
        <>
          <p>
            Section 12 of the Act lists the conditions that allow personal information to be processed. This table
            names the one we rely on for each purpose.
          </p>
          <LegalTable
            head={["Purpose", "Legal basis"]}
            rows={[
              ["Running your account, vault and workspaces", "Necessary to provide the service you signed up for"],
              ["Anchoring your notes on Stellar and showing audit pages, when you ask", "Necessary to provide the service"],
              ["The AI features you use: import, Regenerate and Build mindmap", "Necessary to provide the service"],
              ["The template marketplace: listing, sales, earnings and reports", "Necessary to provide the service"],
              ["The referral program: counting activity, reviewing rewards and paying them", "Necessary to perform the program's terms"],
              ["Connecting qdit or GitHub, when you ask", "Necessary to provide the service"],
              ["Rating promo screenshots with AI to order the review queue, and running the promo", "Your consent, given when you submit an entry"],
              ["Showing a testimonial publicly", "Your consent, which you can withdraw"],
              ["Daily limits, bot checks, abuse and copy reports, and keeping the service secure", "Our legitimate interest in keeping the service working and fair"],
              ["Keeping payout records for accounting", "Our legitimate interest in accurate accounts, and any legal duty that applies"],
            ]}
          />
        </>
      ),
    },
    {
      id: "public",
      title: "What is public and permanent",
      body: (
        <>
          <p>{ONCHAIN_PERMANENCE_CLAUSE} Your note text and titles are never written to it. What is written:</p>
          <LegalList
            items={[
              <>
                <b>For each anchored note:</b> its document id, content hash, version and node count, the owner&rsquo;s
                wallet address, and when it changed.
              </>,
              <>
                <b>For each mindmap node:</b> its node id (such as <code>h3</code>), status, tool name and artifact
                reference. The tool name and artifact reference are what you type, so keep personal information out of
                them.
              </>,
              <>
                <b>For on-chain workspaces:</b> the workspace id, and each member&rsquo;s wallet address and role.
              </>,
              <>
                <b>For the template marketplace:</b> each template&rsquo;s id, content hash, creator wallet, price,
                token and parent, its sales and tip totals, and which wallets bought it.
              </>,
              <>Every transaction, with the wallet that signed it, as with any Stellar transaction.</>,
            ]}
          />
          <p>
            We also keep a publicly readable list of the on-chain writes sent through our relay: the network,
            transaction hash, note id, function, owner wallet, status and time. It holds nothing that is not already
            on the ledger or the audit page.
          </p>
          <p>
            Each anchored note has a public audit page at <code>/d/&lt;note id&gt;</code>, open to anyone without
            signing in. It shows the ledger data above for that note, flags entries signed after a signer was removed
            from the workspace and, when the note is linked to qdit, shows its milestone receipts. Headings appear only
            if you turn on <b>Show headings on public page</b> and your note still matches the anchored version
            exactly.
          </p>
          <p>The landing page shows totals, such as sign-ups and documents created. It names no one.</p>
        </>
      ),
    },
    {
      id: "who-sees",
      title: "Who sees your data",
      body: (
        <>
          <LegalList
            items={[
              <>
                <b>Workspace members</b> see the notes in that workspace and its member list, according to their role.
                Notes in your personal workspace are private to you unless you add someone.
              </>,
              <>
                <b>Other signed-in users</b> see templates you publish, including their full text, in the template
                gallery. Signed-out visitors do not.
              </>,
              <>
                <b>Referrers.</b> {REFERRER_VIEW_CLAUSE}
              </>,
              <>
                <b>Admins</b>, the staff accounts we name in our server settings, see referred users in full for review,
                payout details, promo entries with the entrant&rsquo;s email or wallet and contact details, and copy
                reports.
              </>,
              <>
                <b>Testimonials</b> appear publicly only if you opt in and an admin approves them. A reward never
                depends on giving one.
              </>,
              <>
                <b>People who run Doqtri</b> have technical access to the database and file storage.
              </>,
            ]}
          />
        </>
      ),
    },
    {
      id: "providers",
      title: "Service providers",
      body: (
        <>
          <p>We use these services to run Doqtri.</p>
          <LegalTable
            head={["Provider", "What it does", "What it receives"]}
            rows={[
              ["Supabase", "Database, file storage, sign-in, and account emails for confirmation and password reset", "The data listed under What we collect. Account emails go out through the email service set up in Supabase"],
              ["Vercel", "Hosts the app and runs scheduled jobs", "Every request to the app, with its IP address, and the server's logs"],
              ["OpenAI", "Import, formatting, mindmaps and promo ratings", "PDFs as the file itself, and other imports as their extracted text. On Regenerate, the note's text and your other note titles. On Build mindmap and at import, the note's title and text. For promo entries, your screenshots and caption"],
              ["OpenZeppelin Channels", "Submits passkey wallets' on-chain writes and pays their fees", "The contract call and its signatures, which are public once on the ledger"],
              ["Stellar Horizon and RPC nodes", "Reading the ledger and sending transactions", "Wallet addresses and transactions, and your IP address when your browser calls them directly"],
              ["Stellar Friendbot", "Funds new testnet wallets with test XLM", "The wallet address"],
              ["stellar.expert", "Public contract statistics, and the explorer pages we link to", "Our server sends only contract addresses. If you open a link, stellar.expert sees your visit"],
              ["GitHub", "Reads the status of an issue or pull request you link", "The repository and number"],
              ["qdit", "Connected projects and milestones, only if you connect it", "An authorisation request, then the note id, title and URL when you link a note, and milestone changes you make from Doqtri"],
              ["Cloudflare Turnstile", "A bot check on email sign-up, sign-in and password reset, when switched on", "Its script runs in your browser, and Cloudflare receives the signals it collects there"],
              ["Your wallet app", "Signs sign-in messages and transactions", "The messages and transactions you approve. Your wallet is your own service, under its own terms"],
            ]}
          />
          <p>
            Some of these providers may store or process your data outside the Philippines. Under Section 21 of the
            Act, we stay responsible for personal information we send to them.
          </p>
        </>
      ),
    },
    {
      id: "cookies",
      title: "Cookies and local storage",
      body: (
        <>
          <p>
            Doqtri&rsquo;s code contains no analytics or advertising SDK and no tracking pixels. We use only what the
            app needs:
          </p>
          <LegalTable
            head={["Name", "Where", "What it does", "How long"]}
            rows={[
              ["Supabase session (sb-…)", "Cookie", "Keeps you signed in", "Until you sign out or the session ends"],
              ["doqtri_ref", "Cookie", "Remembers a referral code until you sign up", "30 days, or until the referral is recorded"],
              ["doqtri_ws", "Cookie", "Remembers your active workspace", "1 year"],
              ["qdit connection state", "Cookie", "Protects the qdit connection step", "10 minutes"],
              ["doqtri.preferences", "Local storage", "Theme, text size and reduced motion", "Until cleared"],
              ["doqtri:returning", "Local storage", "Sends a returning visitor to sign-in", "Until cleared"],
              ["@StellarWalletsKit/…", "Local storage", "Which wallet you chose", "Until cleared"],
              ["Dismissed notices", "Local storage", "Promo and legal notices you closed", "Until cleared"],
              ["Earnings page size and demo mindmap style", "Local storage", "Small display choices", "Until cleared"],
              ["doqtri.walletSetupDismissed", "Session storage", "Wallet setup prompt you closed", "Until the tab closes"],
              ["Passkey wallet session", "IndexedDB", "Reconnects your passkey wallet without a second prompt", "7 days"],
            ]}
          />
        </>
      ),
    },
    {
      id: "retention",
      title: "Retention and deletion",
      body: (
        <>
          <p>
            We keep your data while your account exists. We have not set a fixed retention period for it. You can
            delete a note yourself, along with its archived original, unless it is anchored or linked to a qdit
            project.
          </p>
          <p>
            There is no delete button for accounts yet. To delete yours, email <MailLink address={PRIVACY_EMAIL} /> and
            we will confirm it is you. If you want your notes gone too, delete them first, because notes stay after an
            account is deleted.
          </p>
          <p>
            <b>What goes with the account:</b>
          </p>
          <LegalList
            items={[
              "Your email address, profile data, sign-in sessions and display preferences.",
              "The link from your wallets and passkeys to your account, including passkey public keys.",
              "Your qdit connection and its tokens. The authorisation on qdit's side stays until you revoke it there. Pressing Disconnect under Connected apps before deleting also tries to revoke it.",
              "Invites to and from you, edit locks, usage counts, top-ups, mindmap styles, promo entries, copy reports, pending ownership transfers, your referral code and referral records, and imports that never became a note.",
              "Your payout details.",
            ]}
          />
          <p>
            <b>What stays, no longer tied to your account except where noted:</b>
          </p>
          <LegalList
            items={[
              "Every note you wrote, in every workspace, with its import record and original file, and its links to qdit and GitHub.",
              "Your personal workspace, renamed “Former user”, when it holds a note or another member. It has no owner, and its other members keep their access. An empty one is deleted.",
              "Free templates you published, still listed and shown as by “Former user” with their creator wallet. Paid templates are hidden from the gallery, but buyers can still copy what they bought. Drafts never confirmed on chain are deleted.",
              "Your template purchases, by wallet address, so sales and royalties still add up.",
              "The record of on-chain writes, and the record of when a member lost the right to sign, with their account id and wallet addresses, which audit pages use to check signatures.",
              "Everything on the Stellar ledger.",
            ]}
          />
          <p>
            <b>Referrals.</b> {REFERRAL_DELETION_CLAUSE}
          </p>
          <p>
            <b>Files.</b> Files sit in separate storage and deleting an account does not remove them automatically.
            Originals of kept notes stay with those notes. Ask us in your deletion request to remove other uploads,
            such as failed imports, and your promo screenshots.
          </p>
          <p>
            <b>Team workspaces.</b> If you are the last owner of a team workspace, it passes to its longest-standing
            admin. If it has no admin, we cannot delete the account until you make another member an owner or an admin.
          </p>
        </>
      ),
    },
    {
      id: "rights",
      title: "Your rights",
      body: (
        <>
          <p>Under the Act, including Sections 16 and 18, you can:</p>
          <LegalList
            items={[
              "be told whether we process your personal information, and how;",
              "get reasonable access to it;",
              "dispute errors and have them corrected;",
              "have your data suspended, withdrawn, blocked, removed or destroyed in the cases the Act sets out;",
              "be indemnified for damages from inaccurate, unlawful or unauthorised use of your data;",
              "get a copy of your data in a structured, commonly used electronic format.",
            ]}
          />
          <p>
            Email <MailLink address={PRIVACY_EMAIL} /> to use any of these. We cannot change or remove what is already
            on the Stellar ledger, because nobody can.
          </p>
          <p>You can also complain to the National Privacy Commission.</p>
        </>
      ),
    },
    {
      id: "children",
      title: "Children",
      body: (
        <p>
          {AGE_CLAUSE} If you think someone under that age has an account, tell us at{" "}
          <MailLink address={PRIVACY_EMAIL} />.
        </p>
      ),
    },
    {
      id: "changes",
      title: "Changes to this policy",
      body: (
        <p>
          When this policy changes, we update the date at the top of this page. If a change is significant, we also say
          so in the app. The <Link href={TERMS_PATH}>Terms of Service</Link> cover how you may use Doqtri.
        </p>
      ),
    },
  ];
}

export default function PrivacyPage() {
  const operator = legalOperatorName();
  if (!operator) notFound();
  return (
    <LegalPage
      tag="Privacy"
      title="Privacy Policy"
      lede="What Doqtri collects, why, who sees it, what stays public on Stellar for good, and what you can do about it."
      sections={sections(operator)}
      other={{ href: TERMS_PATH, label: "Terms of Service" }}
    />
  );
}

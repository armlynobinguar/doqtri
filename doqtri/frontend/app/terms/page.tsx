import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { PRIVACY_PATH } from "@/components/legal/legal-links";
import { LegalList, LegalPage, MailLink, type LegalSection } from "@/components/legal/legal-page";
import { legalOperatorName, legalPagesLive } from "@/lib/legal";
import {
  AGE_CLAUSE,
  KEPT_CONTENT_CLAUSE,
  MINIMUM_AGE,
  ONCHAIN_PERMANENCE_CLAUSE,
  PRIVACY_EMAIL,
  REFERRAL_DELETION_CLAUSE,
  REFERRAL_LIMIT_EMAIL,
  REFERRER_VIEW_CLAUSE,
  TAX_CLAUSE,
  TESTIMONIAL_CLAUSE,
} from "@/lib/legal-copy";
import { REFERRAL_ACTIVITY_THRESHOLD, REFERRAL_REWARD_LIMIT, REFERRAL_REWARD_PHP } from "@/lib/referral-program";

/** Empty with the gate off, so the 404 says nothing about the document. */
export function generateMetadata(): Metadata {
  if (!legalPagesLive()) return {};
  return {
    title: "Terms of Service · Doqtri",
    description: "The rules for using Doqtri, its template marketplace, AI features and referral program.",
  };
}

function sections(operator: string): LegalSection[] {
  return [
    {
      id: "who",
      title: "Who we are",
      body: (
        <p>
          Doqtri is operated by <b>{operator}</b> (&ldquo;we&rdquo;). There is no registered company behind Doqtri.
          Contact us by email only: <MailLink address={PRIVACY_EMAIL} /> for privacy requests, and{" "}
          <MailLink address={REFERRAL_LIMIT_EMAIL} /> to ask for a higher referral limit. By creating an account or
          using Doqtri, you agree to these terms.
        </p>
      ),
    },
    {
      id: "eligibility",
      title: "Eligibility",
      body: (
        <p>
          {AGE_CLAUSE} By creating an account you confirm you are {MINIMUM_AGE} or older and able to agree to these
          terms.
        </p>
      ),
    },
    {
      id: "accounts",
      title: "Accounts and wallets",
      body: (
        <>
          <p>
            You are responsible for your account, your wallet and your passkeys, and for what is done with them. We
            never hold your wallet&rsquo;s keys or your passkeys, so we cannot recover them, and we cannot undo a
            transaction you signed.
          </p>
          <p>
            If you lose every passkey on a passkey wallet, you lose the ability to sign for that wallet. Add a backup
            passkey while you can.
          </p>
        </>
      ),
    },
    {
      id: "testnet",
      title: "The service runs on Stellar testnet",
      body: (
        <p>
          Doqtri runs on the Stellar test network. Testnet can be interrupted or reset, and a reset removes accounts
          and data from that network. Testnet assets, including test XLM and test USDC, have no value. Referral rewards
          are the exception: they are real payments we make, separately from testnet.
        </p>
      ),
    },
    {
      id: "onchain",
      title: "On-chain records",
      body: (
        <p>
          {ONCHAIN_PERMANENCE_CLAUSE} That includes content hashes, node ids and statuses, tool names, artifact
          references, wallet addresses and marketplace activity. The{" "}
          <Link href={`${PRIVACY_PATH}#public`}>Privacy Policy</Link> lists what is written. Don&rsquo;t put personal
          information or anything secret in the tool names or artifact references you type. Syncing a status from GitHub
          writes the issue, pull request or commit URL, which names the repository, even a private one.
        </p>
      ),
    },
    {
      id: "content",
      title: "Your content",
      body: (
        <>
          <p>
            You own your notes and uploads. You give us the rights we need to store, process, display and send them as
            the service requires, including to the providers in the Privacy Policy. You confirm you have the right to
            put your content into Doqtri.
          </p>
          <p>
            Some things are not private. Anyone can open the audit page at <code>/d/&lt;note id&gt;</code> and read
            on-chain data. Every signed-in user can see the full text of a free template you publish, and the headings of a
            paid one. Your workspace&rsquo;s members see its notes.
          </p>
        </>
      ),
    },
    {
      id: "marketplace",
      title: "Template marketplace",
      body: (
        <>
          <LegalList
            items={[
              <>
                <b>Creators.</b> You may publish only what you have the right to publish, free or priced in XLM or USDC
                at or above the app&rsquo;s minimum price. You can change a price, delist and relist. Publishing puts the
                template&rsquo;s content hash, price and your wallet on the ledger.
              </>,
              <>
                <b>Buyers.</b> A purchase is a Stellar transaction that lets you copy the template into your vault. We
                cannot reverse it. Once you have bought a template you can copy it again, even if it is later delisted
                or hidden.
              </>,
              <>
                <b>Fees and royalties.</b> On a paid sale the contract sends 10% to the Doqtri treasury and 90% to the
                creator. If the template derives from another creator&rsquo;s template, 5% of the price goes to that
                creator out of the 90%. These rates can change, for future sales only. Tips go straight to the creator
                with no Doqtri fee.
              </>,
              <>
                <b>Reports and removal.</b> Any signed-in user can report a template as a copy of another. An admin
                compares them and may hide the copy from the gallery. We may also hide a template that breaks these
                terms. Hiding affects only Doqtri&rsquo;s gallery. The contract listing stays on the ledger.
              </>,
            ]}
          />
        </>
      ),
    },
    {
      id: "ai",
      title: "AI features",
      body: (
        <p>
          Import, Regenerate, Build mindmap and promo ratings send your content to OpenAI for processing, as the Privacy
          Policy describes. AI output can be wrong or incomplete, so check it before you rely on it or anchor it. AI
          features have daily limits.
        </p>
      ),
    },
    {
      id: "integrations",
      title: "Integrations",
      body: (
        <p>
          qdit, GitHub and your wallet app are separate services under their own terms. Connecting qdit lets Doqtri act
          for you there within the access you grant. Disconnecting in Doqtri may not remove that access on qdit&rsquo;s
          side; you can revoke it in qdit.
        </p>
      ),
    },
    {
      id: "acceptable-use",
      title: "Acceptable use",
      body: (
        <>
          <p>You must not:</p>
          <LegalList
            items={[
              "use Doqtri for anything illegal, or to store or share illegal content;",
              "harass or harm others, or infringe their rights;",
              "attack, overload or try to get around the relay, the fees it charges or covers, daily limits or bot checks;",
              "create fake accounts, or use more than one account to gain a reward or get around a limit;",
              "try to reach data or accounts that are not yours.",
            ]}
          />
        </>
      ),
    },
    {
      id: "referrals",
      title: "Referral program",
      body: (
        <>
          <LegalList
            items={[
              <>
                <b>Reward.</b> You earn {REFERRAL_REWARD_PHP} PHP for each person you refer who makes{" "}
                {REFERRAL_ACTIVITY_THRESHOLD} or more successful on-chain activities. An activity is a successful call to
                a Doqtri contract, counted from when the referral was recorded. Wallet deployment and pending or failed
                transactions don&rsquo;t count. Once a referral is eligible it stays eligible, even after a testnet
                reset. There is one reward per wallet per network.
              </>,
              <>
                <b>Limit.</b> Each referrer can earn up to {REFERRAL_REWARD_LIMIT} rewards. The first{" "}
                {REFERRAL_REWARD_LIMIT} referrals to qualify count. To ask for more, email{" "}
                <MailLink address={REFERRAL_LIMIT_EMAIL} />.
              </>,
              <>
                <b>Payment.</b> We pay manually, and only after you complete the payout questionnaire, within 30 days of
                the referral becoming eligible or the questionnaire being complete, whichever is later.
              </>,
              <>
                <b>How you are paid.</b> In XLM at the PHP equivalent on the payout date, or to the e-wallet or bank
                account you give us. A wrong address, wrong account details or a missing memo is your responsibility.
              </>,
              <>
                <b>Voiding.</b> We can void a reward for self-referral, fake accounts or other abuse.
              </>,
              <>
                <b>Changes and ending.</b> We can change or end the program. If it ends, rewards already eligible on the
                end date are paid if the payout questionnaire is complete within 30 days of that date. We pay within
                30 days of the end date or of the questionnaire being complete, whichever is later.
              </>,
              <>
                <b>Tax.</b> {TAX_CLAUSE}
              </>,
              <>
                <b>Privacy.</b> {REFERRER_VIEW_CLAUSE} Admins see full details for review and payment.
              </>,
              <>
                <b>Deleted accounts.</b> {REFERRAL_DELETION_CLAUSE}
              </>,
              <>
                <b>Testimonials.</b> Feedback is optional. {TESTIMONIAL_CLAUSE}
              </>,
            ]}
          />
        </>
      ),
    },
    {
      id: "promotions",
      title: "Promotions",
      body: (
        <p>
          Promotions follow the rules stated with them. A promo entry is sent to OpenAI for an AI rating, which only
          orders the review queue. A person makes the decision.
        </p>
      ),
    },
    {
      id: "termination",
      title: "Suspension, termination and account deletion",
      body: (
        <>
          <p>
            We may suspend or end your access if you break these terms or put the service or other people at risk. You
            can stop using Doqtri at any time.
          </p>
          <p>
            To delete your account, email <MailLink address={PRIVACY_EMAIL} />. Deleting an account removes the account
            and keeps your content: your notes stay but no longer name your account, free templates stay listed as by
            &ldquo;Former user&rdquo;, paid ones are hidden from the gallery, and purchases stay valid. The{" "}
            <Link href={`${PRIVACY_PATH}#retention`}>Privacy Policy</Link> has the full list. {KEPT_CONTENT_CLAUSE}{" "}
            {ONCHAIN_PERMANENCE_CLAUSE}
          </p>
          <p>
            We can&rsquo;t delete an account that is the last owner of a team workspace with no admin until another
            member becomes an owner or an admin.
          </p>
        </>
      ),
    },
    {
      id: "disclaimers",
      title: "Disclaimers",
      body: (
        <p>
          Doqtri is provided as it is and as available. To the extent the law allows, we give no promise that it will be
          uninterrupted, error-free or fit for a particular purpose, or that anything stored or anchored will stay
          available. We don&rsquo;t control the Stellar network or the other services Doqtri relies on.
        </p>
      ),
    },
    {
      id: "liability",
      title: "Limits of liability",
      body: (
        <p>
          To the extent the law allows, we are not liable for indirect or consequential loss, or for loss caused by
          testnet resets, lost keys or passkeys, wrong payout details, or other services. Nothing in these terms removes
          a right you have under the law that cannot be waived.
        </p>
      ),
    },
    {
      id: "law",
      title: "Governing law and disputes",
      body: (
        <p>
          These terms are governed by the laws of the Philippines. If you have a dispute with us, email us first so we
          can try to resolve it. If we can&rsquo;t, it is settled as Philippine law provides.
        </p>
      ),
    },
    {
      id: "changes",
      title: "Changes to these terms",
      body: (
        <p>
          When these terms change, we update the date at the top of this page. If a change is significant, we also say
          so in the app. If you keep using Doqtri after a change, the new terms apply to you.
        </p>
      ),
    },
  ];
}

export default function TermsPage() {
  const operator = legalOperatorName();
  if (!operator) notFound();
  return (
    <LegalPage
      tag="Terms"
      title="Terms of Service"
      lede="The rules for using Doqtri, its template marketplace, its AI features and its referral program."
      sections={sections(operator)}
      other={{ href: PRIVACY_PATH, label: "Privacy Policy" }}
    />
  );
}

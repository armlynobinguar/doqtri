import { TEMPLATES } from "@/lib/templates";

/**
 * The public demo vault at /demo: a fixed, read-only set of notes anyone can
 * open before signing up. Nothing here touches Supabase or the chain — the
 * notes are the template gallery's starters plus a welcome note, so the demo
 * always shows the same maps a new user can start from.
 */
export type DemoNote = {
  id: string;
  title: string;
  /** One line for the explorer. */
  description: string;
  /** The note's text as a vault note stores it: its title is not part of it (D-121). */
  markdown: string;
};

/** Starters that show the range of plans Doqtri is built for, in explorer order. */
const DEMO_TEMPLATE_IDS = [
  "product-roadmap",
  "smart-contract-launch",
  "grant-proposal",
  "sprint-plan",
  "hackathon-project",
  "freelancer-payments",
  "incident-postmortem",
] as const;

const WELCOME: DemoNote = {
  id: "welcome",
  title: "Welcome to Doqtri",
  description: "What this demo shows and how a real vault works.",
  markdown: `This is a read-only demo vault. Open any note on the left: its headings become the mindmap beside it, exactly as they do in your own vault.

## Write the plan
Notes are plain markdown, written in the editor or imported from PDF and DOCX.

### Every heading is a node
The mindmap is rebuilt from the note's headings as you type.

### Link notes together
Use [[wikilinks]] such as [[Product Roadmap]] to connect plans; the vault graph shows how they relate.

## Track what ships
Each node moves from Planned to Building, Built and Verified.

### Link nodes to GitHub
Attach the issue or pull request that shipped a node; its state suggests the node's status.

## Prove it on Stellar
### Save & anchor
One button writes the note's SHA-256 hash to the DoqtriRegistry contract on Stellar.

### Public audit pages
Anyone can open a note's audit page and check its history against the ledger, without trusting Doqtri.

## Start your own vault
### Sign up with email
A passkey (Face ID, fingerprint or PIN) creates your Stellar wallet. No extension needed.

### Or connect a wallet
Varial and other Stellar wallets sign in with a signed challenge.
`,
};

export const DEMO_NOTES: readonly DemoNote[] = [
  WELCOME,
  ...DEMO_TEMPLATE_IDS.flatMap((id) => {
    const template = TEMPLATES.find((t) => t.id === id);
    if (!template) throw new Error(`Demo vault: unknown template "${id}"`);
    // A template's linked notes follow it, so its [[links]] resolve in the demo too.
    return [
      {
        id: template.id,
        title: template.title,
        description: template.description,
        markdown: template.body,
      },
      ...(template.linkedNotes ?? []).map((note, i) => ({
        id: `${template.id}-${i + 1}`,
        title: note.title,
        description: `Linked note of ${template.title}.`,
        markdown: note.body,
      })),
    ];
  }),
];

export function demoNote(id: string): DemoNote | undefined {
  return DEMO_NOTES.find((note) => note.id === id);
}

/**
 * Template marketplace helpers shared by the browser, the API routes and the
 * relay (progress/004). Pure: no network, no Supabase.
 */
import { TEMPLATE_CATEGORIES, type TemplateCategory } from "@/lib/templates";

/** Template ids: 16 lowercase base32 characters (80 random bits). */
export const TEMPLATE_ID_PATTERN = /^[a-z2-7]{16}$/;

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

export function newTemplateId(random: (bytes: Uint8Array) => Uint8Array = (b) => crypto.getRandomValues(b)): string {
  const bytes = random(new Uint8Array(16));
  return Array.from(bytes, (b) => BASE32[b & 31]).join("");
}

export const MAX_TEMPLATE_TITLE = 120;
export const MAX_TEMPLATE_DESCRIPTION = 280;
export const MAX_TEMPLATE_BODY = 50_000;

export function isTemplateCategory(value: unknown): value is TemplateCategory {
  return typeof value === "string" && (TEMPLATE_CATEGORIES as readonly string[]).includes(value);
}

/**
 * The part of a note that becomes the template: its markdown without the
 * leading `# Title` line, the same shape as the starter templates' bodies.
 * Using a template writes `# <title>` back on top, so a copy reads like the
 * original under whatever title the buyer ends up with.
 */
export function templateBodyFromNote(markdown: string): string {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  let start = 0;
  while (start < lines.length && lines[start].trim() === "") start++;
  if (start < lines.length && /^#\s+\S/.test(lines[start])) {
    start++;
    while (start < lines.length && lines[start].trim() === "") start++;
  }
  return lines.slice(start).join("\n").trimEnd() + "\n";
}

/**
 * What a paid template shows before purchase: its headings (the mindmap) and
 * nothing else. Paragraph text, lists and code stay hidden.
 */
export function templateOutline(body: string): string {
  let fenced = false;
  const out: string[] = [];
  for (const line of body.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (!fenced && /^#{1,6}\s+\S/.test(line)) out.push(line.trimEnd());
  }
  return out.join("\n");
}

/** Shortened Stellar address for display: `GABC…WXYZ`. */
export function shortAddress(address: string): string {
  return address.length > 12 ? `${address.slice(0, 4)}…${address.slice(-4)}` : address;
}

/** `12345678` stroops → `"1.2345678"`, trailing zeros dropped. */
export function formatAmount(units: bigint, decimals = 7): string {
  const negative = units < BigInt(0);
  const abs = negative ? -units : units;
  const scale = BigInt(10) ** BigInt(decimals);
  const whole = abs / scale;
  const frac = (abs % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${frac ? `.${frac}` : ""}`;
}

/** `"1.5"` → `15000000n`. Null for anything that isn't a plain non-negative decimal. */
export function parseAmount(text: string, decimals = 7): bigint | null {
  const match = /^\s*(\d+)(?:\.(\d+))?\s*$/.exec(text);
  if (!match) return null;
  const [, whole, frac = ""] = match;
  if (frac.length > decimals) return null;
  return BigInt(whole) * BigInt(10) ** BigInt(decimals) + BigInt(frac.padEnd(decimals, "0") || "0");
}

export type MarketFees = { creatorBps: number; parentBps: number; treasuryBps: number };

export type MarketTransfer = { to: string; amount: bigint };

/**
 * The transfers `buy` makes, in the order it makes them — a mirror of the
 * contract's split (market/src/lib.rs). The confirm sheet shows these, and
 * the relay accepts a signed `buy` only if its transfers are exactly these.
 */
export function buySplit(input: {
  price: bigint;
  buyer: string;
  creator: string;
  parentCreator: string | null;
  treasury: string;
  fees: MarketFees;
}): { transfers: MarketTransfer[]; creatorCut: bigint; parentCut: bigint; treasuryCut: bigint } {
  const { price, buyer, creator, parentCreator, treasury, fees } = input;
  const zero = BigInt(0);
  if (price <= zero) return { transfers: [], creatorCut: zero, parentCut: zero, treasuryCut: zero };

  const share = (bps: number) => (price * BigInt(bps)) / BigInt(10_000);
  const treasuryCut = share(fees.treasuryBps);
  const parentCut = parentCreator ? share(fees.parentBps) : zero;
  const creatorCut = price - treasuryCut - parentCut;

  const transfers: MarketTransfer[] = [];
  const pay = (to: string, amount: bigint) => {
    if (amount > zero && to !== buyer) transfers.push({ to, amount });
  };
  if (parentCreator && parentCreator === creator) {
    pay(creator, creatorCut + parentCut);
  } else {
    pay(creator, creatorCut);
    if (parentCreator) pay(parentCreator, parentCut);
  }
  pay(treasury, treasuryCut);
  return { transfers, creatorCut, parentCut, treasuryCut };
}

/** A gallery card, as /api/market/templates returns it. */
export type CommunityTemplate = {
  id: string;
  title: string;
  category: TemplateCategory;
  description: string;
  /** Full body for free templates; headings only for paid ones. */
  preview: string;
  free: boolean;
  /** Smallest-unit amount as a decimal string (bigint doesn't survive JSON). */
  price: string;
  token: string;
  tokenCode: string;
  creatorWallet: string;
  mine: boolean;
  /** Bought before by this user: copying again is free. */
  owned: boolean;
  uses: number;
  sales: number;
  parent: { id: string; title: string; creatorWallet: string } | null;
  listedAt: string;
};

/** Lowercased heading text, without `#`s, markdown emphasis or extra spaces. */
function headingSet(body: string): Set<string> {
  return new Set(
    templateOutline(body)
      .split("\n")
      .map((h) => h.replace(/^#+\s*/, "").replace(/[*_`~[\]]/g, "").replace(/\s+/g, " ").trim().toLowerCase())
      .filter(Boolean),
  );
}

/**
 * How alike two templates' structures are: the share of headings they have
 * in common (Jaccard, 0–1). Copy reports are judged on this, the content
 * hashes and the on-chain listing times.
 */
export function sectionSimilarity(a: string, b: string): number {
  const x = headingSet(a);
  const y = headingSet(b);
  if (x.size === 0 && y.size === 0) return 0;
  let shared = 0;
  for (const h of x) if (y.has(h)) shared++;
  return shared / (x.size + y.size - shared);
}

/** One of the creator's templates on the earnings page (/vault/earnings). */
export type EarningsTemplate = {
  id: string;
  title: string;
  listed: boolean;
  hidden: boolean;
  /** Smallest-unit amounts as decimal strings. */
  price: string;
  token: string;
  tokenCode: string;
  sales: number;
  earned: string;
  tips: string;
  uses: number;
  listedAt: string | null;
  parent: { id: string; title: string } | null;
  recentSales: { buyerWallet: string; amount: string; creatorCut: string; txHash: string | null; createdAt: string }[];
  derived: { id: string; title: string; creatorWallet: string; sales: number }[];
};

/** Royalties earned from other creators' derivatives of the user's templates. */
export type EarningsRoyalty = {
  templateId: string;
  title: string;
  parentId: string;
  parentTitle: string;
  tokenCode: string;
  sales: number;
  total: string;
};

export type EarningsSummary = {
  wallet: string | null;
  templates: EarningsTemplate[];
  royalties: EarningsRoyalty[];
  /** Per token: sales earnings, tips and royalties. */
  totals: { tokenCode: string; earned: string; tips: string; royalties: string }[];
};

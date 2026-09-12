/**
 * 信用卡資料庫：結帳成功後用卡號對應額度，計剩餘限額寫入 order／Google Sheet。
 */
import fs from "node:fs/promises";
import path from "node:path";

export type CreditCardInfo = {
  number: string;
  company: string;
  type: string;
  /** 原始額度（HKD）；null = 未知 */
  limit: number | null;
};

/** 用戶提供嘅卡（數字為原始 limit） */
export const CREDIT_CARD_POOL: CreditCardInfo[] = [
  { number: "341283094382009", company: "AE", type: "AE", limit: 60000 },
  { number: "6250912000895722", company: "citi", type: "union", limit: 100000 },
  { number: "6250912000853705", company: "citi", type: "union", limit: 44900 },
  { number: "5427136001956206", company: "citi", type: "mastercard", limit: 44994 },
  { number: "5427136001182753", company: "citi", type: "mastercard", limit: 100000 },
  { number: "5242260000374998", company: "citi", type: "mastercard", limit: 100000 },
  { number: "5520040003551773", company: "citi", type: "mastercard", limit: 100000 },
  { number: "4617267008358832", company: "citi", type: "visa", limit: 100000 },
  { number: "4015690000901978", company: "citi", type: "visa", limit: 100000 },
  { number: "5224231000309211", company: "citi", type: "mastercard", limit: 100000 },
  { number: "5427134000952300", company: "citi", type: "mastercard", limit: 100000 },
  { number: "5520040003999154", company: "citi", type: "mastercard", limit: 44994 },
  { number: "5224231000776971", company: "citi", type: "mastercard", limit: 44994 },
  { number: "5520040004102477", company: "citi", type: "mastercard", limit: 44900 },
  { number: "5224231000429589", company: "citi", type: "mastercard", limit: 44900 },
  { number: "4015690000977564", company: "citi", type: "visa", limit: 44900 },
  { number: "5427134001254383", company: "citi", type: "mastercard", limit: 44900 },
  { number: "4617267008543615", company: "citi", type: "visa", limit: 44900 },
  { number: "5427136001563291", company: "citi", type: "mastercard", limit: 44900 },
  { number: "4509360648369896", company: "sc", type: "visa", limit: 96000 },
  { number: "5523438420278367", company: "sc", type: "mastercard", limit: 96000 },
  { number: "4325650271511695", company: "sc", type: "visa", limit: 96000 },
  { number: "4325650460165816", company: "sc", type: "visa", limit: 96000 },
  { number: "5289460003265607", company: "hsbc", type: "mastercard", limit: 43000 },
  { number: "4966040128472586", company: "hsbc", type: "visa", limit: 23000 },
  { number: "4201840026146256", company: "hsbc", type: "visa", limit: 44000 },
  { number: "6250960012873963", company: "hsbc", type: "union", limit: 30400 },
  { number: "6250980009945707", company: "hsbc", type: "union", limit: 30400 },
  { number: "4966040522297746", company: "hsbc", type: "visa", limit: 60000 },
  { number: "4201840015253857", company: "hsbc", type: "visa", limit: 28000 },
  { number: "5289460004074891", company: "hsbc", type: "mastercard", limit: 64000 },
  { number: "6250960014191661", company: "hsbc", type: "union", limit: 22400 },
  { number: "4966040130036346", company: "hsbc", type: "visa", limit: 29000 },
  { number: "6250980017378149", company: "hsbc", type: "union", limit: 23200 },
  { number: "4966040522454933", company: "hsbc", type: "visa", limit: 65000 },
  { number: "5447290211950180", company: "mox", type: "mastercard", limit: 127000 },
  { number: "5547242700086603", company: "ccb", type: "mastercard", limit: 74000 },
  { number: "5408062000019445", company: "hsb", type: "mastercard", limit: 30000 },
  { number: "4557281019953483", company: "hsb", type: "visa", limit: 30000 },
  { number: "4931952006837304", company: "hsb", type: "visa", limit: 46000 },
  { number: "4006121009856063", company: "hsb", type: "visa", limit: 30000 },
  { number: "6250261009809023", company: "hsb", type: "union", limit: 46000 },
  { number: "4931952008114967", company: "hsb", type: "visa", limit: 40000 },
  { number: "4006121000811562", company: "hsb", type: "visa", limit: 30000 },
  { number: "4006121006625081", company: "hsb", type: "visa", limit: 40000 },
  { number: "5408062005816654", company: "hsb", type: "mastercard", limit: 60000 },
  { number: "5522682008182696", company: "hsb", type: "mastercard", limit: 40000 },
  { number: "4518354654672003", company: "dbs", type: "visa", limit: 256000 },
  { number: "4760736825456008", company: "dbs", type: "visa", limit: 256000 },
  { number: "5408047983583004", company: "dbs", type: "mastercard", limit: 256000 },
  { number: "5418199641916007", company: "dbs", type: "mastercard", limit: 256000 },
  { number: "5408205101537340", company: "bea", type: "mastercard", limit: 6000 },
  { number: "4384370121306521", company: "bea", type: "visa", limit: 33000 },
  { number: "5419822700102214", company: "bea", type: "mastercard", limit: 20000 },
  { number: "5452290300493987", company: "bea", type: "mastercard", limit: 14000 },
  { number: "5408205101677955", company: "bea", type: "mastercard", limit: 23000 },
  { number: "4384370121306539", company: "bea", type: "visa", limit: 29000 },
  { number: "4384375600272474", company: "bea", type: "visa", limit: 29000 },
  { number: "6224725000166131", company: "bea", type: "union", limit: 17000 },
  { number: "5419822700117105", company: "bea", type: "mastercard", limit: 23000 },
  { number: "4834340892240015", company: "boc", type: "visa", limit: 10000 },
  { number: "4835204269450012", company: "boc", type: "visa", limit: 10000 },
  { number: "4863303637330016", company: "boc", type: "visa infinite cheers", limit: 10000 },
  { number: "5228654147240013", company: "boc", type: "mastercard", limit: 10000 },
  { number: "5555422131900015", company: "boc", type: "mastercard", limit: 10000 },
  { number: "6251720643721117", company: "boc", type: "union", limit: null },
  { number: "6262080097930111", company: "boc", type: "union", limit: 10000 },
  { number: "6262100894740115", company: "boc", type: "union", limit: 10000 },
  { number: "4863301640910014", company: "boc", type: "visa infinite cheers", limit: 59000 },
  { number: "4835201365680013", company: "boc", type: "visa", limit: 59000 },
  { number: "6251720643720119", company: "boc", type: "union", limit: 59000 },
  { number: "5417365000068430", company: "aeon", type: "mastercard", limit: 75000 },
  { number: "5391423210992244", company: "motion", type: "mastercard", limit: 10000 },
  { number: "4423948333822477", company: "sc", type: "visa", limit: 79000 },
  { number: "4480602763121997", company: "za", type: "visa", limit: 50000 },
  { number: "4058038017030696", company: "sc", type: "visa", limit: 79000 },
  { number: "5523438418634530", company: "sc", type: "mastercard", limit: 79000 },
];

export function cardDigits(raw: string | null | undefined): string {
  return String(raw || "").replace(/\D/g, "");
}

export function formatHkLimit(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "";
  return String(Math.round(n));
}

export function parseHkAmount(raw: unknown): number | null {
  const s = String(raw ?? "").replace(/,/g, "");
  const m = s.match(/(\d+(?:\.\d+)?)/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

/** 用完整卡號或尾四位對應（尾四位唯一先用） */
export function findCreditCard(cardNumber: string | null | undefined): CreditCardInfo | null {
  const d = cardDigits(cardNumber);
  if (!d || /applepay/i.test(String(cardNumber || "").replace(/\s+/g, ""))) return null;

  const full = CREDIT_CARD_POOL.find((c) => cardDigits(c.number) === d);
  if (full) return full;

  if (d.length >= 4) {
    const last4 = d.slice(-4);
    const matches = CREDIT_CARD_POOL.filter((c) => cardDigits(c.number).endsWith(last4));
    if (matches.length === 1) return matches[0]!;
  }
  return null;
}

type RemainingStore = Record<string, number>;

function remainingFile(rootDir: string): string {
  return path.join(rootDir, "card-remaining-limits.json");
}

async function readRemainingStore(rootDir: string): Promise<RemainingStore> {
  try {
    const raw = await fs.readFile(remainingFile(rootDir), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: RemainingStore = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      const n = Number(v);
      if (Number.isFinite(n)) out[cardDigits(k)] = n;
    }
    return out;
  } catch {
    return {};
  }
}

async function writeRemainingStore(rootDir: string, store: RemainingStore): Promise<void> {
  await fs.writeFile(remainingFile(rootDir), JSON.stringify(store, null, 2), "utf8");
}

export type RemainingLimitResult = {
  card: CreditCardInfo;
  originalLimit: number | null;
  remainingLimit: number | null;
  amountSpent: number | null;
};

/**
 * 結帳成功：用卡號搵資料庫，剩餘限額 = 當前剩餘 − 今次消費，並持久化。
 */
export async function applySuccessfulCheckoutToCardLimit(
  rootDir: string,
  cardNumber: string | null | undefined,
  amountSpentRaw: unknown
): Promise<RemainingLimitResult | null> {
  const card = findCreditCard(cardNumber);
  if (!card) return null;

  const amountSpent = parseHkAmount(amountSpentRaw);
  const key = cardDigits(card.number);
  const store = await readRemainingStore(rootDir);
  const current =
    store[key] != null
      ? store[key]!
      : card.limit != null
        ? card.limit
        : null;

  let remaining: number | null = null;
  if (current != null && amountSpent != null) {
    remaining = Math.round((current - amountSpent) * 100) / 100;
    store[key] = remaining;
    await writeRemainingStore(rootDir, store);
  } else if (current != null && amountSpent == null) {
    remaining = current;
  }

  return {
    card,
    originalLimit: card.limit,
    remainingLimit: remaining,
    amountSpent,
  };
}

/** 只查詢／帶出卡資料（唔扣額） */
export function lookupCardMeta(cardNumber: string | null | undefined): {
  company: string;
  type: string;
  limit: string;
} | null {
  const card = findCreditCard(cardNumber);
  if (!card) return null;
  return {
    company: card.company,
    type: card.type,
    limit: formatHkLimit(card.limit),
  };
}

export type LiveCardLimitRow = {
  /** 遮罩卡號，Dashboard 顯示用 */
  masked: string;
  last4: string;
  company: string;
  type: string;
  originalLimit: number | null;
  remainingLimit: number | null;
  usedAmount: number | null;
  /** 曾經扣過額（有寫入 remaining store） */
  touched: boolean;
};

/** Dashboard live：全部卡嘅目前剩餘額度 */
export async function getLiveCardLimits(rootDir: string): Promise<{
  updatedAt: string;
  cards: LiveCardLimitRow[];
  touchedCount: number;
}> {
  const store = await readRemainingStore(rootDir);
  const cards: LiveCardLimitRow[] = CREDIT_CARD_POOL.map((card) => {
    const key = cardDigits(card.number);
    const touched = store[key] != null;
    const remaining = touched ? store[key]! : card.limit;
    const original = card.limit;
    const used =
      original != null && remaining != null
        ? Math.round((original - remaining) * 100) / 100
        : null;
    return {
      masked: key.length >= 4 ? `•••• ${key.slice(-4)}` : "—",
      last4: key.slice(-4),
      company: card.company,
      type: card.type,
      originalLimit: original,
      remainingLimit: remaining ?? null,
      usedAmount: used,
      touched,
    };
  });
  // 已用過嘅排前，再按剩餘額度由低到高
  cards.sort((a, b) => {
    if (a.touched !== b.touched) return a.touched ? -1 : 1;
    const ar = a.remainingLimit ?? Number.POSITIVE_INFINITY;
    const br = b.remainingLimit ?? Number.POSITIVE_INFINITY;
    return ar - br;
  });
  return {
    updatedAt: new Date().toISOString(),
    cards,
    touchedCount: cards.filter((c) => c.touched).length,
  };
}

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

/** Apple HK 官價（iPhone 18 Pro / Pro Max，2026） */
const IPHONE18_UNIT_HKD: Record<string, Record<string, number>> = {
  "iphone 18 pro max": {
    "256gb": 11499,
    "512gb": 13299,
    "1tb": 16799,
    "2tb": 21999,
  },
  "iphone 18 pro": {
    "256gb": 10499,
    "512gb": 12299,
    "1tb": 15799,
    "2tb": 20999,
  },
  "iphone 17": {
    "256gb": 6999,
    "512gb": 8499,
  },
};

function normalizeStorageKey(storage: string | null | undefined): string {
  return String(storage || "")
    .replace(/\s+/g, "")
    .toLowerCase()
    .replace(/（.*?）|\(.*?\)/g, "");
}

function normalizeModelKey(model: string | null | undefined): string {
  return String(model || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** 單機官價；搵唔到就 null */
export function lookupIphoneUnitPriceHkd(
  model: string | null | undefined,
  storage: string | null | undefined
): number | null {
  const m = normalizeModelKey(model);
  const s = normalizeStorageKey(storage);
  for (const [key, prices] of Object.entries(IPHONE18_UNIT_HKD)) {
    if (m.includes(key)) {
      return prices[s] ?? null;
    }
  }
  return null;
}

export function formatHkMoney(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "";
  return `HK$${Math.round(n).toLocaleString("en-US")}.00`;
}

/**
 * 訂單應付總額：優先用合理 scraped 金額；太細／冇掃到 → 官價 × 數量。
 * （確認頁有時會掃到 HK$229 等雜項，唔係訂單總額）
 */
export function resolveOrderAmountSpent(opts: {
  scrapedAmount?: unknown;
  model?: string | null;
  storage?: string | null;
  quantity?: number | null;
}): { amount: number | null; label: string; source: "scraped" | "catalog" | "none" } {
  const qty = Math.max(1, Number(opts.quantity) || 1);
  const scraped = parseHkAmount(opts.scrapedAmount);
  const unit = lookupIphoneUnitPriceHkd(opts.model, opts.storage);
  const catalog = unit != null ? unit * qty : null;

  // scraped 太細（例如 229）或遠低於官價 50% → 當錯掃
  if (scraped != null && scraped >= 3000) {
    if (catalog == null || scraped >= catalog * 0.5) {
      return { amount: scraped, label: formatHkMoney(scraped), source: "scraped" };
    }
  }
  if (catalog != null) {
    return { amount: catalog, label: formatHkMoney(catalog), source: "catalog" };
  }
  if (scraped != null) {
    return { amount: scraped, label: formatHkMoney(scraped), source: "scraped" };
  }
  return { amount: null, label: "", source: "none" };
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

export type CardLimitOverride = {
  /** Dashboard Credit cards 輸入嘅 limit；優先於 CREDIT_CARD_POOL */
  originalLimit?: number | null;
  company?: string;
  type?: string;
};

function resolveCardForLimit(
  cardNumber: string | null | undefined,
  opts?: CardLimitOverride
): CreditCardInfo | null {
  const d = cardDigits(cardNumber);
  if (!d || /applepay/i.test(String(cardNumber || "").replace(/\s+/g, ""))) return null;
  const pool = findCreditCard(cardNumber);
  const overrideLimit =
    opts?.originalLimit != null && Number.isFinite(opts.originalLimit)
      ? Number(opts.originalLimit)
      : null;
  if (pool) {
    return {
      ...pool,
      limit: overrideLimit != null ? overrideLimit : pool.limit,
      company: opts?.company || pool.company,
      type: opts?.type || pool.type,
    };
  }
  if (overrideLimit == null) return null;
  return {
    number: d,
    company: opts?.company || "",
    type: opts?.type || "",
    limit: overrideLimit,
  };
}

/**
 * 結帳成功：剩餘限額 = 當前剩餘 − 今次消費，並持久化。
 * 可用 opts.originalLimit（Credit cards 池輸入嘅 limit）覆蓋資料庫額度。
 */
export async function applySuccessfulCheckoutToCardLimit(
  rootDir: string,
  cardNumber: string | null | undefined,
  amountSpentRaw: unknown,
  opts?: CardLimitOverride
): Promise<RemainingLimitResult | null> {
  const card = resolveCardForLimit(cardNumber, opts);
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

/** 首次寫入卡嘅起始剩餘額（唔覆蓋已扣過嘅卡） */
export async function seedCardLimitsIfNeeded(
  rootDir: string,
  cards: Array<{ number: string; limit: number | null | undefined }>
): Promise<number> {
  const store = await readRemainingStore(rootDir);
  let seeded = 0;
  for (const c of cards) {
    if (c.limit == null || !Number.isFinite(Number(c.limit))) continue;
    const key = cardDigits(c.number);
    if (!key) continue;
    if (store[key] != null) continue;
    store[key] = Number(c.limit);
    seeded += 1;
  }
  if (seeded) await writeRemainingStore(rootDir, store);
  return seeded;
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

/** 只讀剩餘額度（唔再扣一次） */
export async function peekCardLimitInfo(
  rootDir: string,
  cardNumber: string | null | undefined,
  amountSpentRaw?: unknown,
  opts?: CardLimitOverride
): Promise<{
  company: string;
  type: string;
  cardLimit: string;
  remainingLimit: number | null;
  remainingLabel: string;
} | null> {
  const card = resolveCardForLimit(cardNumber, opts);
  if (!card) return null;
  const store = await readRemainingStore(rootDir);
  const key = cardDigits(card.number);
  const amount = parseHkAmount(amountSpentRaw);
  let remaining: number | null =
    store[key] != null ? store[key]! : card.limit;
  if (remaining == null && card.limit != null && amount != null) {
    remaining = Math.round((card.limit - amount) * 100) / 100;
  } else if (store[key] == null && card.limit != null && amount != null) {
    remaining = Math.round((card.limit - amount) * 100) / 100;
  }
  return {
    company: card.company,
    type: card.type,
    cardLimit: formatHkLimit(card.limit),
    remainingLimit: remaining,
    remainingLabel: remaining != null ? formatHkLimit(remaining) : "",
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

/** Order summary → Live card limits 列 */
export type LiveOrderSpendRow = {
  orderNumber: string;
  orderPlacedAt: string;
  browser: string;
  /** 落單用電郵（checkoutContact／shipping） */
  email: string;
  product: string;
  color: string;
  storage: string;
  quantity: number | null;
  amountSpent: number | null;
  amountSpentLabel: string;
  cardMasked: string;
  company: string;
  type: string;
  /** 起始信用額（Credit cards 輸入 / 資料庫） */
  cardLimit: string;
  remainingLimit: number | null;
  remainingLabel: string;
  /** 完整 proxy URL，例如 http://user:pass@ip:port */
  proxy: string;
};

function orderContactEmail(o: Record<string, unknown>): string {
  const contact = (o.checkoutContactUsed as Record<string, unknown> | undefined) || {};
  const ship = (o.confirmationPageShipping as Record<string, unknown> | undefined) || {};
  const sd = (o.shippingDetails as Record<string, unknown> | undefined) || {};
  const identity = (o.identity as Record<string, unknown> | undefined) || {};
  for (const v of [sd.email, contact.email, ship.email, identity.email, o.email]) {
    const e = String(v || "").trim();
    if (e && e !== "—") return e;
  }
  return "";
}

function hasRealOrderNumber(o: Record<string, unknown>): boolean {
  const n = String(o.orderNumber || "").trim();
  if (!n) return false;
  if (/^W9876543210$/i.test(n)) return false;
  if (/demo/i.test(String(o.browser || ""))) return false;
  return true;
}

function orderAmountSpent(o: Record<string, unknown>): {
  amount: number | null;
  label: string;
} {
  const label = String(o.amountSpent || o.total || "").trim();
  const amount = parseHkAmount(o.amountSpent ?? o.total);
  return { amount, label: label || (amount != null ? formatHkLimit(amount) : "") };
}

/**
 * Dashboard live：
 * - cards：信用卡池剩餘額度
 * - orders：由 Order summary（訂單編號 + 消費金額）帶入
 */
export async function getLiveCardLimits(
  rootDir: string,
  orders: unknown[] = [],
  vaultLimits: Record<string, number> = {}
): Promise<{
  updatedAt: string;
  cards: LiveCardLimitRow[];
  orders: LiveOrderSpendRow[];
  touchedCount: number;
  orderCount: number;
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
  cards.sort((a, b) => {
    if (a.touched !== b.touched) return a.touched ? -1 : 1;
    const ar = a.remainingLimit ?? Number.POSITIVE_INFINITY;
    const br = b.remainingLimit ?? Number.POSITIVE_INFINITY;
    return ar - br;
  });

  const orderRows: LiveOrderSpendRow[] = [];
  const seenOrders = new Set<string>();
  for (const item of orders) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    if (!hasRealOrderNumber(o)) continue;
    const orderNumber = String(o.orderNumber).trim();
    if (seenOrders.has(orderNumber)) continue;
    seenOrders.add(orderNumber);

    const { amount, label } = orderAmountSpent(o);
    const ship =
      (o.confirmationPageShipping as { cardNumber?: string } | undefined) || {};
    const cardRaw = String(o.cardNumber || ship.cardNumber || "").trim();
    const digits = cardDigits(cardRaw);
    const isApplePay =
      /apple\s*pay/i.test(cardRaw) ||
      !cardRaw ||
      cardRaw === "—" ||
      /人手填/.test(cardRaw) ||
      digits.length < 4;

    // 同 Order summary 一致：有完整卡號就顯示完整；否則 Apple Pay
    const cardDisplay = isApplePay
      ? "Apple Pay"
      : cardRaw.replace(/(\d{4})(?=\d)/g, "$1 ").replace(/\s+/g, " ").trim() ||
        cardRaw;

    const company = isApplePay
      ? String(o.cardCompany || "Apple Pay").trim() || "Apple Pay"
      : String(o.cardCompany || findCreditCard(cardRaw)?.company || "").trim() ||
        "—";

    const remainingFromOrder = String(
      o.remainingCreditCardLimit || o.remainingLimit || ""
    ).trim();
    const poolCard = isApplePay ? null : findCreditCard(cardRaw);
    const key = poolCard ? cardDigits(poolCard.number) : "";
    const remainingNum =
      remainingFromOrder
        ? parseHkAmount(remainingFromOrder)
        : key && store[key] != null
          ? store[key]!
          : poolCard?.limit != null && amount != null
            ? Math.round((poolCard.limit - amount) * 100) / 100
            : null;
    const remainingLabel = isApplePay
      ? "—"
      : remainingFromOrder ||
        (remainingNum != null ? formatHkLimit(remainingNum) : "—");

    const amountLabel =
      label ||
      String(o.amountSpent || o.total || "").trim() ||
      (amount != null ? formatHkLimit(amount) : "—");

    const cardLimitLabel = isApplePay
      ? "—"
      : String(o.cardLimit || "").trim() ||
        (digits
          ? formatHkLimit(
              vaultLimits[digits] ??
                vaultLimits[cardDigits(poolCard?.number || "")] ??
                vaultLimits[digits.slice(-4)]
            )
          : "") ||
        formatHkLimit(poolCard?.limit) ||
        "—";

    orderRows.push({
      orderNumber,
      orderPlacedAt: String(o.orderPlacedAt || o.scrapedAt || "") || "—",
      browser: String(o.browser || "") || "—",
      email: orderContactEmail(o) || "—",
      product: String(o.productType || o.productName || "") || "—",
      color: String(o.color || "") || "—",
      storage: String(o.storage || "") || "—",
      quantity:
        o.quantity == null || o.quantity === ""
          ? null
          : Number(o.quantity) || null,
      amountSpent: amount,
      amountSpentLabel: amountLabel,
      /** 同 Order summary Credit card 欄一致（完整卡號或 Apple Pay） */
      cardMasked: cardDisplay,
      company,
      type: isApplePay
        ? String(o.cardType || "Apple Pay")
        : String(o.cardType || poolCard?.type || "") || "—",
      cardLimit: cardLimitLabel,
      remainingLimit: isApplePay ? null : remainingNum,
      remainingLabel,
      proxy: String(o.proxy || "").trim() || "—",
    });
  }

  // 新單排前
  orderRows.sort((a, b) => String(b.orderPlacedAt).localeCompare(String(a.orderPlacedAt)));

  // Live：同一張卡嘅剩餘額 = 起始 limit − 所有成功消費合計（即時）
  applyLiveRemainingAcrossOrders(orderRows, store, vaultLimits);

  return {
    updatedAt: new Date().toISOString(),
    cards,
    orders: orderRows,
    touchedCount: cards.filter((c) => c.touched).length,
    orderCount: orderRows.length,
  };
}

/**
 * 按卡號把 Live 剩餘額度重算：remaining = originalLimit − Σ(成功訂單金額)。
 * originalLimit 優先用訂單 cardLimit／vaultLimits／pool。
 */
export function applyLiveRemainingAcrossOrders(
  orderRows: LiveOrderSpendRow[],
  store: Record<string, number> = {},
  vaultLimits: Record<string, number> = {}
): void {
  type Acc = {
    original: number | null;
    spent: number;
    keys: number[];
  };
  const byCard = new Map<string, Acc>();

  for (let i = 0; i < orderRows.length; i++) {
    const row = orderRows[i]!;
    const digits = cardDigits(row.cardMasked);
    if (!digits || digits.length < 4 || /apple\s*pay/i.test(row.cardMasked)) continue;
    const pool = findCreditCard(row.cardMasked);
    const fullKey = pool ? cardDigits(pool.number) : digits;
    const key = fullKey.length >= 13 ? fullKey : digits.slice(-4);
    let acc = byCard.get(key);
    if (!acc) {
      const fromOrder = parseHkAmount(row.cardLimit);
      const fromVault =
        vaultLimits[fullKey] ??
        vaultLimits[digits] ??
        vaultLimits[digits.slice(-4)] ??
        null;
      const original =
        fromOrder ??
        fromVault ??
        pool?.limit ??
        null;
      acc = { original: original ?? null, spent: 0, keys: [] };
      byCard.set(key, acc);
    } else if (acc.original == null) {
      const fromOrder = parseHkAmount(row.cardLimit);
      if (fromOrder != null) acc.original = fromOrder;
    }
    if (row.amountSpent != null) acc.spent += row.amountSpent;
    acc.keys.push(i);
  }

  for (const [, acc] of byCard) {
    let remaining: number | null = null;
    if (acc.original != null) {
      remaining = Math.round((acc.original - acc.spent) * 100) / 100;
    }
    const label = remaining != null ? formatHkLimit(remaining) : "—";
    for (const idx of acc.keys) {
      const row = orderRows[idx]!;
      row.remainingLimit = remaining;
      row.remainingLabel = label;
    }
  }
}

/** 供 Dashboard：用 cardLimit + 成功訂單金額即時計剩餘 */
export function liveRemainingByCardFromOrders(
  orders: Array<{
    cardNumber?: unknown;
    cardLimit?: unknown;
    amountSpent?: unknown;
    total?: unknown;
  }>
): Map<string, { limit: number | null; spent: number; remaining: number | null }> {
  const out = new Map<
    string,
    { limit: number | null; spent: number; remaining: number | null }
  >();
  for (const o of orders) {
    const digits = cardDigits(String(o.cardNumber || ""));
    if (!digits || digits.length < 4) continue;
    if (/applepay/i.test(String(o.cardNumber || "").replace(/\s+/g, ""))) continue;
    const key = digits.length >= 13 ? digits : digits.slice(-4);
    let row = out.get(key);
    if (!row) {
      const lim =
        parseHkAmount(o.cardLimit) ?? findCreditCard(String(o.cardNumber))?.limit ?? null;
      row = { limit: lim, spent: 0, remaining: lim };
      out.set(key, row);
    } else if (row.limit == null) {
      const lim =
        parseHkAmount(o.cardLimit) ?? findCreditCard(String(o.cardNumber))?.limit ?? null;
      if (lim != null) row.limit = lim;
    }
    const amt = parseHkAmount(o.amountSpent ?? o.total);
    if (amt != null) row.spent += amt;
  }
  for (const row of out.values()) {
    row.remaining =
      row.limit != null
        ? Math.round((row.limit - row.spent) * 100) / 100
        : null;
  }
  return out;
}

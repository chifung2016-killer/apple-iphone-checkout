/**
 * Apple 香港官網 iPhone 購買輔助腳本（headed browser）。
 *
 * 預設：iPhone 18 Pro Max / 256GB / 布根地紅色
 * 付款頁：Dashboard 加密信用卡池會 autofill 卡號／有效期／CVV，
 * 撳「檢查你的訂單」後喺 Review 自動撳「立即提交訂單」。
 * Apple Pay 模式仍要人手／裝置確認。
 *
 * 落單成功後撳 Enter，會輸出訂單編號同送貨／取貨資料，並寫入 order-summary.json。
 *
 * 用法：先改下面 CONFIG / EMAIL_POOL，再執行 `npm start`
 */
import { chromium, type Frame, type Locator, type Page } from "playwright";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import {
  applySuccessfulCheckoutToCardLimit,
  formatHkLimit,
  lookupCardMeta,
  parseHkAmount,
  resolveOrderAmountSpent,
} from "./credit-card-pool.js";
import { fulfillmentLabelFromPreference } from "./fulfillment-label.js";
import {
  excludeCheckoutCardById,
  loadAssignedCheckoutCard,
  type VaultCard,
} from "./checkout-card-vault.js";
import { appendDayLog } from "./runtime-day-log.js";

// =============================================================================
// 請喺呢度改你自己嘅選項（Dashboard 會用 runtime-config.json 覆寫）
// =============================================================================
let CONFIG = {
  buyUrl:
    "https://www.apple.com/hk-zh/shop/buy-iphone/iphone-18-pro/6.9-%E5%90%8B%E9%A1%AF%E7%A4%BA%E5%99%A8-256gb-%E5%B8%83%E6%A0%B9%E5%9C%B0%E7%B4%85%E8%89%B2",
  model: "iPhone 18 Pro Max",
  color: "布根地紅色",
  storage: "256GB",
  skipTradeIn: true,
  addAppleCare: false,
  quantity: 2,
  /** 同時開幾多個獨立瀏覽器（各自獨立 session） */
  browserCount: 2,
  /**
   * pickup = 取貨 + 信用卡（訪客）
   * delivery = 送貨 + 信用卡（訪客）
   * pickup_apple_pay = 取貨 + Apple Pay（購物袋「使用Apple Pay結帳」）
   * delivery_apple_pay = 送貨 + Apple Pay（訪客 bag 舊路徑）
   * pickup_applepay_guest = 取貨訪客（同信用卡）→ Billing 揀 Apple Pay → Review
   * delivery_applepay_guest = 送貨訪客（同信用卡）→ Billing 揀 Apple Pay → Review
   * pickup_apple_ac_apple_pay = 取貨 + Apple 帳戶 + Apple Pay
   * delivery_apple_ac_apple_pay = 送貨 + Apple 帳戶 + Apple Pay
   * auto = 先取貨失敗再送貨（信用卡訪客）
   */
  fulfillmentPreference: "pickup" as
    | "pickup"
    | "delivery"
    | "auto"
    | "pickup_apple_pay"
    | "delivery_apple_pay"
    | "pickup_applepay_guest"
    | "delivery_applepay_guest"
    | "pickup_apple_ac_apple_pay"
    | "delivery_apple_ac_apple_pay",
  /** 開賣時間（香港）：「繼續」預計呢個時間先會可用 */
  saleStartIso: "2026-09-12T20:00:00+08:00",
  /** 開賣前幾多毫秒開始每 5 秒 refresh 搶「繼續」 */
  salePollLeadMs: 5 * 60 * 1000,
  /** refresh／重試「繼續」間隔 */
  productPollIntervalMs: 5000,
  /** 取貨搜尋關鍵字 */
  pickupSearch: "中環",
  /** 「你附近的所有零售店」下面優先／可接受嘅門市關鍵字 */
  pickupStoreKeywords: [
    "ifc mall",
    "Canton Road",
    "Causeway Bay",
    "Festival Walk",
    "apm Hong Kong",
    "New Town Plaza",
  ],
  /** 每個自動撳掣前暫停，降低被偵測為機械操作嘅機會 */
  clickDelayMs: 100,
  /** 每個瀏覽器視窗大小（並排、互唔重疊） */
  windowWidth: 960,
  windowHeight: 980,
  windowGap: 12,
  windowTop: 20,
  /** 可選：銀行／發卡機構（稍後人手填，唔自動偵測） */
  cardCompany: "",
  cardLimit: "",
  /**
   * 可選 proxy／IP（Dashboard 填）：
   * host:port | http://host:port | socks5://host:1080 | http://user:pass@host:port
   * 留空＝唔用 proxy
   */
  proxy: "",
  /**
   * Monitor+buying：跑到取貨門市列表（中環＋6 掣）後停低，
   * 等有貨通知先 refresh 再隨機揀店繼續。
   */
  holdAtPickupStoresForStock: false,
};

type CheckoutConfig = typeof CONFIG;
type FulfillmentPreference = CheckoutConfig["fulfillmentPreference"];
type FulfillmentMode = "pickup" | "delivery";

function prefersDeliveryOnly(): boolean {
  const p = CONFIG.fulfillmentPreference;
  return (
    p === "delivery" ||
    p === "delivery_apple_pay" ||
    p === "delivery_applepay_guest" ||
    p === "delivery_apple_ac_apple_pay"
  );
}

function prefersPickupOnly(): boolean {
  const p = CONFIG.fulfillmentPreference;
  return (
    p === "pickup" ||
    p === "pickup_apple_pay" ||
    p === "pickup_applepay_guest" ||
    p === "pickup_apple_ac_apple_pay"
  );
}

function usesApplePay(): boolean {
  const p = CONFIG.fulfillmentPreference;
  return (
    p === "pickup_apple_pay" ||
    p === "delivery_apple_pay" ||
    p === "pickup_applepay_guest" ||
    p === "delivery_applepay_guest" ||
    p === "pickup_apple_ac_apple_pay" ||
    p === "delivery_apple_ac_apple_pay"
  );
}

function usesAppleAccount(): boolean {
  const p = CONFIG.fulfillmentPreference;
  return p === "pickup_apple_ac_apple_pay" || p === "delivery_apple_ac_apple_pay";
}

function isPickupApplePay(): boolean {
  return CONFIG.fulfillmentPreference === "pickup_apple_pay";
}

function isDeliveryApplePay(): boolean {
  return CONFIG.fulfillmentPreference === "delivery_apple_pay";
}

function isPickupApplepayGuest(): boolean {
  return CONFIG.fulfillmentPreference === "pickup_applepay_guest";
}

function isDeliveryApplepayGuest(): boolean {
  return CONFIG.fulfillmentPreference === "delivery_applepay_guest";
}

function isDeliveryAppleAcApplePay(): boolean {
  return CONFIG.fulfillmentPreference === "delivery_apple_ac_apple_pay";
}

function isPickupAppleAcApplePay(): boolean {
  return CONFIG.fulfillmentPreference === "pickup_apple_ac_apple_pay";
}

/** pickup credit card訪客模式 */
function isPickupCreditCardGuest(): boolean {
  return CONFIG.fulfillmentPreference === "pickup";
}

/** 所有取貨模式：PickupContact 用兩套姓名隨機 autofill */
function usesFastPickupContactFill(): boolean {
  return prefersPickupOnly();
}

/**
 * 所有取貨模式共用 pickup credit card訪客模式 嘅門市／繼續規則：
 * 撳門市後只捲底一次、唔重複捲頁撳「繼續前往取貨詳情」、一到 PickupContact 即停。
 */
function usesPickupGuestStoreContinueRules(): boolean {
  return prefersPickupOnly();
}

/**
 * Billing 頁揀 Apple Pay →「檢查你的訂單」→ Review「使用Apple Pay繼續」
 * （訪客 applepay／delivery apple pay／Apple 帳戶模式）
 */
function selectsApplePayAtBilling(): boolean {
  return (
    isDeliveryApplePay() ||
    isPickupApplepayGuest() ||
    isDeliveryApplepayGuest() ||
    isDeliveryAppleAcApplePay() ||
    isPickupAppleAcApplePay()
  );
}

/** Apple 帳戶結帳（delivery/pickup apple ac apple pay） */
const APPLE_ACCOUNT = {
  email: "chifung2010@yahoo.com.hk",
  password: "yY6594083",
  phone: "95858027",
};

/** 取貨聯絡資料：兩套姓名隨機用，電郵／電話相同 */
type PickupContact = {
  lastName: string;
  firstName: string;
  email: string;
  phone: string;
};

const PICKUP_CONTACT_OPTIONS: PickupContact[] = [
  {
    lastName: "Leung",
    firstName: "Chi Fung",
    email: "chifung2016@gmail.com",
    phone: "95858027",
  },
  {
    lastName: "梁",
    firstName: "志烽",
    email: "chifung2016@gmail.com",
    phone: "95858027",
  },
];

/** fallback（未揀過時） */
const PICKUP_CONTACT = PICKUP_CONTACT_OPTIONS[0]!;

/** 每個 page 只隨機揀一次姓名 */
const pickupContactByPage = new WeakMap<Page, PickupContact>();

/** 退回產品頁重試時可隨機嘅顏色（優先用 CONFIG.color） */
const COLORS = ["布根地紅色", "冰川色", "銀色", "黑色"];

/**
 * 輪流使用、唔重複。用完會記喺 used-emails.json。
 */
const EMAIL_POOL = [
  "chifungleung2025@gmail.com",
  "s.mscfl1997@gmail.com",
  "sm.scfl1997@gmail.com",
  "sms.cfl1997@gmail.com",
  "smsc.fl1997@gmail.com",
  "smscf.l1997@gmail.com",
  "cfleung1227@gmail.com",
  "c.fleung1227@gmail.com",
  "cf.leung1227@gmail.com",
  "cfl.eung1227@gmail.com",
  "cfle.ung1227@gmail.com",
  "cfleu.ng1227@gmail.com",
  "cfleun.g1227@gmail.com",
  "cfleung1997@gmail.com",
  "c.fleung1997@gmail.com",
  "cf.leung1997@gmail.com",
  "cfl.eung1997@gmail.com",
  "cfle.ung1997@gmail.com",
  "cfleu.ng1997@gmail.com",
  "cfleun.g1997@gmail.com",
  "chifung199712@gmail.com",
  "c.hifung199712@gmail.com",
  "ch.ifung199712@gmail.com",
  "chi.fung199712@gmail.com",
  "chif.ung199712@gmail.com",
  "chifu.ng199712@gmail.com",
  "chifun.g199712@gmail.com",
  "chifung24@gmail.com",
  "c.hifung24@gmail.com",
  "ch.ifung24@gmail.com",
  "chi.fung24@gmail.com",
  "chif.ung24@gmail.com",
  "chifu.ng24@gmail.com",
  "chifun.g24@gmail.com",
  "chifung971227@gmail.com",
  "c.hifung971227@gmail.com",
  "ch.ifung971227@gmail.com",
  "chi.fung971227@gmail.com",
  "chif.ung971227@gmail.com",
  "chifu.ng971227@gmail.com",
  "chifun.g971227@gmail.com",
];

const LAST_NAMES = [
  "陳", "李", "黃", "張", "周", "吳", "林", "劉", "鄭", "何",
  "梁", "羅", "Chan", "Lee", "Wong", "Cheung", "Chow", "Ng",
  "Lam", "Lau", "Cheng", "Ho", "Leung", "Law",
];

const FIRST_NAMES = [
  "家明", "志偉", "美玲", "曉彤", "俊傑", "雅雯", "建國", "詩婷",
  "浩然", "詠詩", "Ka Ming", "Chi Wai", "Mei Ling", "Hiu Tung",
  "Chun Kit", "Winnie", "Jason", "Emily", "Michael", "Kelly",
];

const HK_AREAS: { area: string; districts: string[] }[] = [
  { area: "香港島", districts: ["中西區", "灣仔", "東區", "南區"] },
  { area: "九龍", districts: ["油尖旺", "深水埗", "九龍城", "黃大仙", "觀塘"] },
  { area: "新界", districts: ["葵青", "荃灣", "屯門", "元朗", "北區", "大埔", "沙田", "西貢", "離島"] },
];

const STREETS_ZH = [
  "彌敦道", "皇后大道中", "軒尼詩道", "廣東道", "亞皆老街",
  "太子道西", "長沙灣道", "英皇道", "駱克道", "德輔道中",
];

const STREETS_EN = [
  "Nathan Road", "Queen's Road Central", "Hennessy Road", "Canton Road",
  "Argyle Street", "Prince Edward Road West", "Cheung Sha Wan Road",
  "King's Road", "Lockhart Road", "Des Voeux Road Central",
];

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SESSION_ID = process.env.CHECKOUT_SESSION_ID || "default";
const WINDOW_INDEX = Math.max(0, Number(process.env.CHECKOUT_WINDOW_INDEX || "0") || 0);
const WINDOW_TOTAL = Math.max(
  1,
  Number(process.env.CHECKOUT_WINDOW_TOTAL || "0") || 0
);
const RUNTIME_DIR = path.join(ROOT, "runtime");

/** console 同時寫入 runtime/logs/今日/checkout-{session}.log（非 Dashboard 子進程先 tee，避免重複） */
if (process.env.CHECKOUT_DASHBOARD !== "1") {
  const wrap =
    (level: "log" | "warn" | "error", orig: (...a: unknown[]) => void) =>
    (...args: unknown[]) => {
      orig(...args);
      const line = args
        .map((a) => {
          if (typeof a === "string") return a;
          try {
            return JSON.stringify(a);
          } catch {
            return String(a);
          }
        })
        .join(" ");
      void appendDayLog({
        channel: "checkout",
        sessionId: SESSION_ID,
        line: `[${level}] ${line}`,
      });
    };
  console.log = wrap("log", console.log.bind(console));
  console.warn = wrap("warn", console.warn.bind(console));
  console.error = wrap("error", console.error.bind(console));
}

const CHECKOUT_CARD_KEY_PATH =
  process.env.CHECKOUT_CARD_KEY_PATH || path.join(RUNTIME_DIR, ".add-order-key");
const CHECKOUT_CARD_ASSIGN_PATH =
  process.env.CHECKOUT_CARD_ASSIGN_PATH ||
  path.join(RUNTIME_DIR, `assigned-card-${SESSION_ID}.enc`);
const CHECKOUT_CARD_STATE_PATH =
  process.env.CHECKOUT_CARD_STATE_PATH ||
  path.join(RUNTIME_DIR, "checkout-cards-state.json");
const OUT_FILE = path.join(
  RUNTIME_DIR,
  SESSION_ID === "default" ? "order-summary.json" : `order-${SESSION_ID}.json`
);
const USED_EMAILS_FILE = path.join(ROOT, "used-emails.json");
const RUNTIME_CONFIG_FILE = path.join(ROOT, "runtime-config.json");
const DASHBOARD_CONTINUE_FLAG = path.join(ROOT, "dashboard-continue.flag");
const DASHBOARD_CONTINUE_SESSION_FLAG = path.join(
  RUNTIME_DIR,
  `continue-${SESSION_ID}.flag`
);
const DASHBOARD_RELEASE_FLAG = path.join(RUNTIME_DIR, `release-${SESSION_ID}.flag`);
const DASHBOARD_CLOSE_FLAG = path.join(RUNTIME_DIR, `close-${SESSION_ID}.flag`);
const DASHBOARD_SHOW_FLAG = path.join(RUNTIME_DIR, `show-${SESSION_ID}.flag`);
const DASHBOARD_HIDE_FLAG = path.join(RUNTIME_DIR, `hide-${SESSION_ID}.flag`);
/** Stop all：停自動化但唔開窗／唔 fullscreen */
const DASHBOARD_STOP_ALL_FLAG = path.join(RUNTIME_DIR, "stop-all.flag");
/** Monitor 有貨：通知停喺門市列表嘅 task 繼續 */
const STOCK_RESUME_SESSION_FLAG = path.join(
  RUNTIME_DIR,
  `stock-resume-${SESSION_ID}.flag`
);
const STOCK_RESUME_ALL_FLAG = path.join(RUNTIME_DIR, "stock-resume-all.flag");
const STATUS_FILE = path.join(
  RUNTIME_DIR,
  SESSION_ID === "default" ? "runtime-status.json" : `status-${SESSION_ID}.json`
);
const LEGACY_OUT_FILE = path.join(ROOT, "order-summary.json");

class ReleaseError extends Error {
  constructor(message = "Dashboard 要求停止自動化，改為人手操作") {
    super(message);
    this.name = "ReleaseError";
  }
}

async function ensureRuntimeDir(): Promise<void> {
  await fs.mkdir(RUNTIME_DIR, { recursive: true }).catch(() => {});
}

async function flagExists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

/** Dashboard 「Stop」／「Close」：優先處理 Close，再處理 Stop take-over */
async function throwIfReleased(): Promise<void> {
  if (process.env.CHECKOUT_DASHBOARD !== "1") return;
  for (const s of ACTIVE_SESSIONS) {
    await syncDashboardWindowFlags(s).catch(() => {});
  }
  // Close／Dismiss：即刻退出，唔好再寫 status 令卡片返嚟
  if (
    (await flagExists(DASHBOARD_CLOSE_FLAG)) ||
    (await flagExists(path.join(RUNTIME_DIR, `dismissed-${SESSION_ID}.flag`)))
  ) {
    throw new ReleaseError("Dashboard 要求關閉呢個瀏覽器 session");
  }
  if (await flagExists(DASHBOARD_RELEASE_FLAG)) {
    const raw = await fs.readFile(DASHBOARD_RELEASE_FLAG, "utf8").catch(() => "");
    // Stop all 會寫 "stop-all"；單個 Stop take-over 唔寫呢個字
    if (/^stop-all/i.test(raw.trim()) || (await flagExists(DASHBOARD_STOP_ALL_FLAG))) {
      SILENT_STOP_ALL = true;
    }
    await fs.unlink(DASHBOARD_RELEASE_FLAG).catch(() => {});
    throw new ReleaseError(
      SILENT_STOP_ALL
        ? "Dashboard Stop all：停止自動化（保持原本視窗位置）"
        : "Dashboard 要求停止自動化，改為人手操作"
    );
  }
  // 即使 release 已讀走，stop-all.flag 仍可標 silent
  if (await flagExists(DASHBOARD_STOP_ALL_FLAG)) {
    SILENT_STOP_ALL = true;
  }
}

/** 長 wait 期間都可響應 Dashboard Stop */
async function sleepCheckingRelease(ms: number): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    await throwIfReleased();
    const slice = Math.min(100, end - Date.now());
    if (slice > 0) await new Promise((r) => setTimeout(r, slice));
  }
}

/**
 * 同 Playwright 長操作 race：Stop 期間唔使等完 waitForURL / goto 先停下。
 */
async function withReleaseCheck<T>(work: Promise<T>): Promise<T> {
  if (process.env.CHECKOUT_DASHBOARD !== "1") return work;
  let settled = false;
  const watch = (async () => {
    while (!settled) {
      await throwIfReleased();
      await new Promise((r) => setTimeout(r, 100));
    }
  })();
  try {
    return await Promise.race([
      work.finally(() => {
        settled = true;
      }),
      watch.then(() => {
        throw new Error("release watch ended unexpectedly");
      }),
    ]);
  } finally {
    settled = true;
  }
}

let writeStatusChain: Promise<void> = Promise.resolve();

function keepCardStr(next: unknown, prev: unknown): string | null {
  const n = next == null ? "" : String(next).trim();
  const p = prev == null ? "" : String(prev).trim();
  if (n && n !== "—" && !/人手填/.test(n)) return n;
  if (p && p !== "—" && !/人手填/.test(p)) return p;
  return n || p || null;
}

function preferCardNumber(next: unknown, prev: unknown): string | null {
  const n = next == null ? "" : String(next).trim();
  const p = prev == null ? "" : String(prev).trim();
  const nd = n.replace(/\D/g, "");
  const pd = p.replace(/\D/g, "");
  if (/人手填/.test(n) && (pd.length >= 4 || /apple\s*pay/i.test(p))) return p || null;
  if (/apple\s*pay/i.test(n)) return n;
  if (/apple\s*pay/i.test(p) && nd.length < 4) return p;
  if (nd.length >= pd.length && nd.length >= 4) return n;
  if (pd.length >= 4) return p;
  return n || p || null;
}

async function writeStatus(patch: Record<string, unknown>): Promise<void> {
  // 串行化：避免 window sync 同 payment_succeeded 並寫時互相覆蓋
  const run = async () => {
    // 已 Close／dismiss：唔再寫 status（避免殘留卡片返 Opened browsers）
    if (
      process.env.CHECKOUT_DASHBOARD === "1" &&
      ((await flagExists(DASHBOARD_CLOSE_FLAG)) ||
        (await flagExists(path.join(RUNTIME_DIR, `dismissed-${SESSION_ID}.flag`))))
    ) {
      return;
    }
    await ensureRuntimeDir();
    let prev: Record<string, unknown> = {};
    try {
      prev = JSON.parse(await fs.readFile(STATUS_FILE, "utf8")) as Record<string, unknown>;
    } catch {
      /* empty */
    }
    const prevCard =
      prev.card && typeof prev.card === "object" && !Array.isArray(prev.card)
        ? (prev.card as Record<string, unknown>)
        : {};
    const patchCard =
      patch.card && typeof patch.card === "object" && !Array.isArray(patch.card)
        ? (patch.card as Record<string, unknown>)
        : null;

    const mergedCard = patchCard
      ? {
          ...prevCard,
          ...patchCard,
          // 一經標成功／有訂單編號，唔好被之後空值蓋走
          paymentSucceeded:
            Boolean(prevCard.paymentSucceeded) ||
            Boolean(patchCard.paymentSucceeded) ||
            Boolean(prevCard.orderNumber) ||
            Boolean(patchCard.orderNumber),
          orderNumber: patchCard.orderNumber || prevCard.orderNumber || null,
          cardNumber: preferCardNumber(patchCard.cardNumber, prevCard.cardNumber),
          cardType: keepCardStr(patchCard.cardType, prevCard.cardType),
          cardCompany: keepCardStr(patchCard.cardCompany, prevCard.cardCompany),
          cardLimit: keepCardStr(patchCard.cardLimit, prevCard.cardLimit),
          remainingCreditCardLimit: keepCardStr(
            patchCard.remainingCreditCardLimit ?? patchCard.remainingLimit,
            prevCard.remainingCreditCardLimit ?? prevCard.remainingLimit
          ),
          remainingLimit: keepCardStr(
            patchCard.remainingLimit ?? patchCard.remainingCreditCardLimit,
            prevCard.remainingLimit ?? prevCard.remainingCreditCardLimit
          ),
          total: keepCardStr(patchCard.total, prevCard.total),
          orderPlacedAt: keepCardStr(patchCard.orderPlacedAt, prevCard.orderPlacedAt),
        }
      : prevCard;

    const next: Record<string, unknown> = {
      ...prev,
      ...patch,
      sessionId: SESSION_ID,
      windowIndex: WINDOW_INDEX,
      updatedAt: new Date().toISOString(),
    };
    if (patchCard || Object.keys(prevCard).length) {
      next.card = mergedCard;
    }
    // phase：payment_succeeded 優先保留
    if (
      /payment_succeeded/i.test(String(prev.phase || "")) &&
      !/payment_succeeded/i.test(String(patch.phase || ""))
    ) {
      next.phase = "payment_succeeded";
    } else if (mergedCard.paymentSucceeded || mergedCard.orderNumber) {
      if (!patch.phase || /waiting_for_payment|waiting_user|manual_control|idle|steps_complete/i.test(String(patch.phase))) {
        // window-only／等待類 patch 唔好降級已成功狀態
        if (/payment_succeeded/i.test(String(prev.phase || "")) || mergedCard.paymentSucceeded) {
          next.phase = "payment_succeeded";
        }
      }
    } else if (
      /steps_complete/i.test(String(prev.phase || "")) &&
      (!patch.phase ||
        /waiting_user|idle|waiting_for_payment|manual_control|stop_requested/i.test(
          String(patch.phase || "")
        ))
    ) {
      // steps_complete 之後 window sync／Stop／waiting_for_payment 唔好降級
      // （Stop 後仍留喺 waiting payment tab，唔搬去 Opened browsers）
      next.phase = "steps_complete";
    }

    // 進展時間：只喺步驟／phase／輪詢有變先更新（window sync 唔計）
    const phaseNext = String(next.phase || "");
    const madeProgress =
      patch.stuck === false ||
      (patch.phase != null && String(patch.phase) !== String(prev.phase || "")) ||
      (patch.message != null && String(patch.message) !== String(prev.message || "")) ||
      (patch.pollRound != null && patch.pollRound !== prev.pollRound) ||
      (patch.error != null && String(patch.error) !== String(prev.error || "")) ||
      (patchCard?.url != null &&
        String(patchCard.url) !== String(prevCard.url || ""));
    if (madeProgress && patch.stuck !== true) {
      next.lastProgressAt = new Date().toISOString();
      next.stuck = false;
      next.stuckSince = null;
    } else {
      next.lastProgressAt =
        prev.lastProgressAt || prev.updatedAt || next.updatedAt;
      if (patch.stuck === true) {
        next.stuck = true;
        next.stuckSince =
          patch.stuckSince || prev.stuckSince || new Date().toISOString();
      } else if (patch.stuck === false) {
        next.stuck = false;
        next.stuckSince = null;
      } else {
        next.stuck = Boolean(prev.stuck);
        next.stuckSince = prev.stuckSince ?? null;
      }
    }
    // 終態／等人：唔標 stuck（page_error 除外，要保持紅閃）
    if (
      /waiting_for_payment|waiting_for_stock_at_stores|steps_complete|payment_succeeded|orders_ready|manual_control|closed|idle/i.test(
        phaseNext
      ) &&
      !/page_error/i.test(phaseNext)
    ) {
      next.stuck = false;
      next.stuckSince = null;
    }

    // page_error 必須保持 stuck 紅閃
    if (/page_error/i.test(phaseNext)) {
      next.stuck = true;
      next.stuckSince =
        next.stuckSince || prev.stuckSince || new Date().toISOString();
    }

    await fs.writeFile(STATUS_FILE, JSON.stringify(next, null, 2), "utf8").catch(() => {});
  };

  const queued = writeStatusChain.then(run, run);
  writeStatusChain = queued.then(
    () => undefined,
    () => undefined
  );
  await queued;
}

async function loadRuntimeConfig(): Promise<void> {
  const fromEnv = process.env.CHECKOUT_CONFIG_PATH;
  const file = fromEnv || RUNTIME_CONFIG_FILE;
  try {
    const raw = await fs.readFile(file, "utf8");
    const parsed = JSON.parse(raw) as Partial<CheckoutConfig>;
    CONFIG = { ...CONFIG, ...parsed };
    const holdRaw = (parsed as Record<string, unknown>).holdAtPickupStoresForStock;
    if (
      process.env.CHECKOUT_HOLD_AT_PICKUP_STORES === "1" ||
      holdRaw === true ||
      holdRaw === "1" ||
      holdRaw === 1
    ) {
      CONFIG.holdAtPickupStoresForStock = true;
    }
    console.log(`已載入 runtime config：${file}`);
    console.log(
      `  ${CONFIG.model} / ${CONFIG.color} / ${CONFIG.storage} ×${CONFIG.quantity}｜${CONFIG.fulfillmentPreference}｜browsers=${CONFIG.browserCount}${
        CONFIG.holdAtPickupStoresForStock ? "｜hold@stores→等有貨" : ""
      }`
    );
    await writeStatus({
      phase: "config_loaded",
      config: {
        buyUrl: CONFIG.buyUrl,
        model: CONFIG.model,
        color: CONFIG.color,
        storage: CONFIG.storage,
        quantity: CONFIG.quantity,
        browserCount: CONFIG.browserCount,
        fulfillmentPreference: CONFIG.fulfillmentPreference,
        pickupSearch: CONFIG.pickupSearch,
        saleStartIso: CONFIG.saleStartIso,
      },
    });
  } catch {
    console.log("未找到 runtime-config.json，用腳本內建 CONFIG。");
  }
}

const CONFIRM_URL =
  /thankyou|thank-you|orderconfirmation|order-confirmation|checkout\/status|\/shop\/order\//i;

const PAYMENT_URL =
  /(?:apw\/)?checkout\?_s=(?:Billing|Payment|Review)|wallet\.apple\.com/i;

const CARD_FIELD_RE =
  /card\s*number|信用卡|卡號|cvv|cvc|cid|安全碼|有效期|expiry|expiration/i;

const PLACE_ORDER_RE =
  /立即提交訂單|提交訂單|下訂單|立即下單|確認付款|Place Your Order|Place Order|Submit Order/i;
const PLACE_ORDER_NEEDLES = [
  "立即提交訂單",
  "提交訂單",
  "下訂單",
  "立即下單",
  "確認付款",
  "Place Your Order",
  "Place Order",
  "Submit Order",
];

class StepError extends Error {
  constructor(step: string, message: string) {
    super(`[${step}] ${message}`);
    this.name = "StepError";
  }
}

function normalizeCardNumber(raw: string): string | null {
  const digits = raw.replace(/\D/g, "");
  if (digits.length < 13 || digits.length > 19) return null;
  // 顯示完整卡號（每 4 位一組）
  return digits.replace(/(\d{4})(?=\d)/g, "$1 ").trim();
}

/** 由卡號／文字推斷卡類型：visa / mastercard / AE（唔寫銀行名） */
function detectCardType(cardNumber: string | null | undefined): string {
  const raw = String(cardNumber || "").trim();
  if (!raw || /apple\s*pay/i.test(raw)) return "";
  if (/visa/i.test(raw)) return "visa";
  if (/master\s*card|mastercard/i.test(raw)) return "mastercard";
  if (/amex|american\s*express|\bAE\b/i.test(raw)) return "AE";
  const d = raw.replace(/\D/g, "");
  if (!d) return "";
  if (d.startsWith("4")) return "visa";
  if (/^3[47]/.test(d)) return "AE";
  const bin2 = Number(d.slice(0, 2));
  const bin4 = Number(d.slice(0, 4));
  if ((bin2 >= 51 && bin2 <= 55) || (bin4 >= 2221 && bin4 <= 2720)) return "mastercard";
  return "";
}

/** 銀行／發卡機構：只用人手 CONFIG，唔自動填 */
function resolveCardCompany(): string {
  return String(CONFIG.cardCompany || "").trim();
}

function resolveCardLimit(): string {
  return String(CONFIG.cardLimit || "").trim();
}

/** 落單真實時間（香港）：12/9/2026 11:22am */
function formatHkOrderDateTime(d: Date = new Date()): string {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Hong_Kong",
    day: "numeric",
    month: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
  const parts = Object.fromEntries(
    fmt.formatToParts(d).filter((p) => p.type !== "literal").map((p) => [p.type, p.value])
  ) as Record<string, string>;
  const day = parts.day || "";
  const month = parts.month || "";
  const year = parts.year || "";
  const hour = parts.hour || "";
  const minute = parts.minute || "";
  const ampm = String(parts.dayPeriod || "")
    .toLowerCase()
    .replace(/\s+/g, "");
  return `${day}/${month}/${year} ${hour}:${minute}${ampm}`;
}

function randomBuildingLine(): string {
  const building = pick(["華苑", "豪庭", "大廈", "中心", "閣", "廣場", "居"]);
  const block = Math.floor(Math.random() * 8) + 1;
  const floor = Math.floor(Math.random() * 30) + 1;
  const flat = Math.floor(Math.random() * 20) + 1;
  return `${building}${block}座 ${floor}樓 ${flat}室`;
}

/** 由付款頁 input／iframe 讀完整信用卡號（人手填入後） */
async function readFullCardNumberFromPage(page: Page): Promise<string | null> {
  const frames = page.frames();
  for (const frame of frames) {
    const found = await frame
      .evaluate(() => {
        const sels = [
          'input[autocomplete="cc-number"]',
          'input[name*="cardNumber"]',
          'input[id*="cardNumber"]',
          'input[name*="card-number"]',
          'input[name*="cardnumber"]',
          'input[id*="cardnumber"]',
          'input[data-autom*="card"]',
          'input[placeholder*="卡號"]',
          'input[placeholder*="Card"]',
          'input[aria-label*="卡號"]',
          'input[aria-label*="Card number"]',
        ];
        const seen = new Set();
        for (const sel of sels) {
          let nodes;
          try {
            nodes = document.querySelectorAll(sel);
          } catch {
            continue;
          }
          for (const node of Array.from(nodes)) {
            if (seen.has(node)) continue;
            seen.add(node);
            const input = node as HTMLInputElement;
            const v = (input.value || "").trim();
            if (v.replace(/\D/g, "").length >= 13) return v;
          }
        }
        // 後備：任何看起來似卡號嘅 input
        for (const input of Array.from(document.querySelectorAll("input"))) {
          const el = input as HTMLInputElement;
          const v = (el.value || "").trim();
          const digits = v.replace(/\D/g, "");
          if (digits.length >= 13 && digits.length <= 19) return v;
        }
        return null;
      })
      .catch(() => null);
    if (found) {
      const normalized = normalizeCardNumber(found);
      if (normalized) return normalized;
    }
  }
  return null;
}

async function captureCardNumberIfPresent(session: BrowserSession): Promise<void> {
  const full = await readFullCardNumberFromPage(session.page).catch(() => null);
  if (!full) return;
  const prevDigits = (session.capturedCardNumber || "").replace(/\D/g, "");
  const nextDigits = full.replace(/\D/g, "");
  // 只升級：更長／更完整先覆寫
  if (nextDigits.length >= prevDigits.length && nextDigits.length >= 13) {
    session.capturedCardNumber = full;
    const meta = lookupCardMeta(full);
    session.cardType = meta?.type || detectCardType(full) || session.cardType || null;
    session.cardCompany =
      meta?.company || resolveCardCompany() || session.cardCompany || null;
    session.cardLimit =
      meta?.limit || resolveCardLimit() || session.cardLimit || null;
  }
}

function pick<T>(items: T[]): T {
  return items[Math.floor(Math.random() * items.length)]!;
}

/** 所有 pickup 步驟：每個 session／page 隨機固定用其中一套姓名 */
function resolvePickupContact(session?: BrowserSession, page?: Page): PickupContact {
  if (session?.pickupContact) {
    if (page) pickupContactByPage.set(page, session.pickupContact);
    return session.pickupContact;
  }
  if (page && pickupContactByPage.has(page)) {
    const existing = pickupContactByPage.get(page)!;
    if (session) session.pickupContact = existing;
    return existing;
  }
  const chosen = pick(PICKUP_CONTACT_OPTIONS);
  if (session) session.pickupContact = chosen;
  if (page) pickupContactByPage.set(page, chosen);
  console.log(`  PickupContact 隨機選用：${chosen.lastName} ${chosen.firstName}`);
  return chosen;
}

function randomHkMobile(): string {
  const prefix = pick(["5", "6", "9"]);
  let rest = "";
  for (let i = 0; i < 7; i++) rest += String(Math.floor(Math.random() * 10));
  return `${prefix}${rest}`;
}

function randomStreet(): string {
  const number = String(Math.floor(Math.random() * 180) + 1);
  if (Math.random() < 0.5) return `${pick(STREETS_ZH)}${number}號`;
  return `${number} ${pick(STREETS_EN)}`;
}

async function waitForEnter(
  message: string,
  opts?: { phase?: string; session?: BrowserSession }
): Promise<void> {
  console.log(`\n${message}`);
  if (process.env.CHECKOUT_DASHBOARD === "1") {
    console.log("（Dashboard 模式：請喺 UI 撳該瀏覽器／全部「確認已落單／繼續」）");
    const phase = opts?.phase || "waiting_user";
    const keepHiddenForPayment = /waiting_for_payment|steps_complete/i.test(phase);
    if (keepHiddenForPayment) {
      for (const s of ACTIVE_SESSIONS) {
        await setBrowserWindowState(s, "minimized").catch(() => {});
      }
      if (opts?.session) {
        await setBrowserWindowState(opts.session, "minimized").catch(() => {});
      }
    }
    await writeStatus({
      phase,
      message: keepHiddenForPayment ? "waiting for payment" : message,
      ...(keepHiddenForPayment
        ? { windowHidden: true, windowState: "minimized" }
        : {}),
    });
    await fs.unlink(DASHBOARD_CONTINUE_SESSION_FLAG).catch(() => {});
    while (true) {
      await throwIfReleased();
      // 付款頁：持續讀人手填入嘅完整卡號
      for (const s of ACTIVE_SESSIONS) {
        await captureCardNumberIfPresent(s).catch(() => {});
      }
      if (opts?.session) {
        await captureCardNumberIfPresent(opts.session).catch(() => {});
        if (opts.session.capturedCardNumber) {
          await writeStatus({
            card: cardFieldsFromSession(opts.session, {
              cardNumber: opts.session.capturedCardNumber,
              url: opts.session.page.url(),
            }),
            ...(keepHiddenForPayment
              ? { windowHidden: true, windowState: "minimized" }
              : {}),
          }).catch(() => {});
        }
      }
      // 付款成功：確認頁出現訂單編號就自動標綠
      if (opts?.session) {
        const scraped = await scrapeConfirmation(opts.session.page).catch(() => null);
        if (scraped?.orderNumber) {
          if (!opts.session.orderPlacedAt) {
            opts.session.orderPlacedAt = formatHkOrderDateTime();
            console.log(`${opts.session.tag} 記錄落單時間：${opts.session.orderPlacedAt}`);
          }
          const cardNo =
            opts.session.capturedCardNumber ||
            scraped.cardNumber ||
            null;
          const poolMeta = lookupCardMeta(cardNo);
          await writeStatus({
            phase: "payment_succeeded",
            message: `付款成功：${scraped.orderNumber}`,
            windowHidden: true,
            card: cardFieldsFromSession(opts.session, {
              orderNumber: scraped.orderNumber,
              total: scraped.total,
              quantity: scraped.quantity,
              cardNumber: cardNo,
              cardType:
                poolMeta?.type ||
                detectCardType(cardNo) ||
                opts.session.cardType ||
                "",
              cardCompany:
                poolMeta?.company ||
                resolveCardCompany() ||
                opts.session.cardCompany ||
                "",
              cardLimit:
                opts.session.cardLimit ||
                poolMeta?.limit ||
                resolveCardLimit() ||
                "",
              orderPlacedAt: opts.session.orderPlacedAt,
              paymentSucceeded: true,
            }),
          });
          console.log(`${opts.session.tag} 偵測到付款成功：${scraped.orderNumber}`);
          return;
        }
      }
      try {
        await fs.access(DASHBOARD_CONTINUE_SESSION_FLAG);
        await fs.unlink(DASHBOARD_CONTINUE_SESSION_FLAG).catch(() => {});
        // waiting for payment：Continue 唔好提早離開（要等付款成功或 Close）
        if (keepHiddenForPayment) {
          console.log("waiting for payment：已忽略 Continue，請完成付款或撳 Close。");
        } else {
          await writeStatus({ phase: "user_continued" });
          return;
        }
      } catch {
        /* try global flag */
      }
      try {
        await fs.access(DASHBOARD_CONTINUE_FLAG);
        if (keepHiddenForPayment) {
          await fs.unlink(DASHBOARD_CONTINUE_FLAG).catch(() => {});
          console.log("waiting for payment：已忽略 Continue，請完成付款或撳 Close。");
        } else {
          await writeStatus({ phase: "user_continued" });
          return;
        }
      } catch {
        /* wait */
      }
      for (const s of ACTIVE_SESSIONS) {
        await syncDashboardWindowFlags(s).catch(() => {});
      }
      // 保持隱藏（Open browser 會將 windowHidden 設 false，就唔再強制 minimize）
      if (keepHiddenForPayment) {
        try {
          const st = JSON.parse(await fs.readFile(STATUS_FILE, "utf8")) as {
            windowHidden?: boolean;
          };
          if (st.windowHidden !== false) {
            for (const s of ACTIVE_SESSIONS) {
              const state = await readBrowserWindowState(s).catch(() => null);
              if (state && state !== "minimized") {
                await setBrowserWindowState(s, "minimized").catch(() => {});
              }
            }
          }
        } catch {
          /* ignore */
        }
      }
      await sleepCheckingRelease(800);
    }
  }
  const rl = readline.createInterface({ input, output });
  await rl.question("按 Enter 繼續… ");
  rl.close();
}

function isSensitiveLocatorName(name: string): boolean {
  return CARD_FIELD_RE.test(name);
}

async function visible(locator: Locator, timeout = 2500): Promise<boolean> {
  return locator.first().isVisible({ timeout }).catch(() => false);
}

async function humanClick(
  el: Locator,
  options?: { force?: boolean; timeout?: number }
): Promise<void> {
  await sleepCheckingRelease(CONFIG.clickDelayMs);
  await el.scrollIntoViewIfNeeded().catch(() => {});
  await el.click({
    timeout: options?.timeout ?? 8000,
    force: options?.force ?? false,
  });
}

/** 跳到下一頁之後先等頁面載入，再多等 0.5 秒先繼續 */
async function settleAfterNavigation(page: Page): Promise<void> {
  await withReleaseCheck(page.waitForLoadState("domcontentloaded").catch(() => {}));
  await withReleaseCheck(page.waitForLoadState("networkidle").catch(() => {}));
  const url = page.url();
  if (isShop404Url(url)) {
    await recoverFromShop404IfNeeded(page).catch((err) => {
      console.warn(
        `  404 復原失敗：${err instanceof Error ? err.message : String(err)}`
      );
    });
  } else {
    markCheckoutNav(url, "settleAfterNavigation");
  }
  await sleepCheckingRelease(CONFIG.clickDelayMs);
}

/** 快速 settle：唔等 networkidle（Apple checkout 會拖好耐） */
async function settleDom(page: Page, extraMs = 200): Promise<void> {
  await withReleaseCheck(page.waitForLoadState("domcontentloaded").catch(() => {}));
  if (extraMs > 0) await sleepCheckingRelease(extraMs);
}

function isPickupContactPage(url: string): boolean {
  // 含 /shop/checkout 同 /shop/apw/checkout 嘅 PickupContact-init
  return /PickupContact|[?&]_s=PickupContact/i.test(url);
}

/** 只認 Billing 步驟（例如 ?_s=Billing-init）；唔用一般 payment 字樣亂開窗 */
function isBillingPage(url: string): boolean {
  return /[?&]_s=Billing/i.test(url) || /wallet\.apple\.com/i.test(url);
}

function isReviewPage(url: string): boolean {
  // /shop/checkout?_s=Review、/shop/apw/checkout?_s=Review-init 等（任何 secureN）
  return /[?&]_s=Review\b/i.test(url) || /\/checkout[^?#]*[?&]_s=Review/i.test(url);
}

/** Review／Apple Pay 繼續掣常見文案（含  / 無 Apple 字樣） */
const APPLE_PAY_CONTINUE_NEEDLES = [
  "使用Apple Pay繼續",
  "使用 Apple Pay 繼續",
  "使用Apple Pay繼續",
  "使用 Pay 繼續",
  "使用Pay繼續",
  "以 Apple Pay 繼續",
  "Continue with Apple Pay",
  "Continue with Apple Pay",
  "Continue with Pay",
];

const APPLE_PAY_CONTINUE_RE =
  /使用\s*(?:Apple\s*)?Pay\s*繼續|以\s*(?:Apple\s*)?Pay\s*繼續|Continue\s+with\s+(?:Apple\s*)?Pay|使用.*Pay.*繼續/i;

/** Billing「檢查你的訂單」常見文案 */
const CHECK_ORDER_NEEDLES = [
  "檢查你的訂單",
  "檢查您的訂單",
  "Check Your Order",
  "Review Your Order",
];

const CHECK_ORDER_RE =
  /檢查你的訂單|檢查您的訂單|Review\s+Your\s+Order|Check\s+Your\s+Order/i;

function isCheckoutFlowPage(url: string): boolean {
  return (
    /\/shop\/(?:apw\/)?checkout/i.test(url) ||
    /secure\d*\.store\.apple\.com\/[^/]+\/shop\/(?:apw\/)?checkout/i.test(url)
  );
}

function fulfillmentLabel(): string {
  return fulfillmentLabelFromPreference(CONFIG.fulfillmentPreference);
}

async function clickFirstVisible(
  locators: Locator[],
  options?: { force?: boolean; timeout?: number }
): Promise<boolean> {
  for (const loc of locators) {
    const el = loc.first();
    if (await visible(el, 800)) {
      await humanClick(el, options);
      return true;
    }
  }
  return false;
}

/** 雙重確認撳掣：搵到就撳兩次，減少第一次未生效 */
async function doubleConfirmClick(
  locators: Locator[],
  label: string,
  options?: { force?: boolean; timeout?: number; gapMs?: number }
): Promise<boolean> {
  console.log(`步驟：雙重確認撳「${label}」`);
  const force = options?.force ?? true;
  const timeout = options?.timeout ?? 8000;
  const gapMs = options?.gapMs ?? 400;
  const deadline = Date.now() + timeout;

  const findVisible = async (): Promise<Locator | null> => {
    for (const loc of locators) {
      const el = loc.first();
      if (await visible(el, 500)) return el;
      if ((await el.count().catch(() => 0)) > 0) return el;
    }
    return null;
  };

  let target = await findVisible();
  while (!target && Date.now() < deadline) {
    await sleepCheckingRelease(300);
    target = await findVisible();
  }
  if (!target) {
    console.warn(`  揾唔到「${label}」`);
    return false;
  }

  await target.scrollIntoViewIfNeeded().catch(() => {});
  await humanClick(target, { force }).catch(async () => {
    await target!.evaluate((n) => (n as HTMLElement).click()).catch(() => {});
  });
  console.log(`  已撳「${label}」（第 1 次）`);
  await sleepCheckingRelease(gapMs);

  const again = await findVisible();
  if (again) {
    await again.scrollIntoViewIfNeeded().catch(() => {});
    await humanClick(again, { force }).catch(async () => {
      await again.evaluate((n) => (n as HTMLElement).click()).catch(() => {});
    });
    console.log(`  已撳「${label}」（第 2 次／雙重確認）`);
  } else {
    console.log(`  「${label}」第二次已唔見（可能已跳頁），當成功`);
  }
  return true;
}

/** 雙重確認 + 多輪重試，直到 success() 為真（例如已去到 Review） */
async function doubleConfirmClickUntil(
  page: Page,
  locators: Locator[],
  label: string,
  success: () => boolean | Promise<boolean>,
  options?: { rounds?: number; force?: boolean; gapMs?: number; settleMs?: number }
): Promise<boolean> {
  const rounds = options?.rounds ?? 8;
  const settleMs = options?.settleMs ?? 1200;
  for (let round = 1; round <= rounds; round++) {
    await throwIfReleased();
    if (await success()) {
      console.log(`  「${label}」目標已達成（重試前／round ${round}）`);
      return true;
    }
    console.log(`  「${label}」雙重確認或重試 round ${round}/${rounds}`);
    const ok = await doubleConfirmClick(locators, label, {
      force: options?.force ?? true,
      timeout: 7000,
      gapMs: options?.gapMs ?? 450,
    });
    await settleAfterNavigation(page);
    if (await success()) {
      console.log(`  「${label}」目標已達成（round ${round}）`);
      return true;
    }
    if (!ok) {
      console.warn(`  「${label}」round ${round} 揾唔到掣，稍後再試…`);
    } else {
      console.warn(`  「${label}」round ${round} 已撳但仍未到目標，再試…`);
    }
    await sleepCheckingRelease(settleMs);
  }
  return Boolean(await success());
}

async function clickByAccessibleName(
  root: Page | Frame,
  names: Array<string | RegExp>,
  options?: { force?: boolean; timeout?: number }
): Promise<string | null> {
  for (const name of names) {
    const ok = await clickFirstVisible(
      [
        root.getByRole("button", { name }),
        root.getByRole("link", { name }),
        root.getByRole("radio", { name }),
        root.getByRole("checkbox", { name }),
        root.getByRole("tab", { name }),
        root.getByLabel(name),
        root.getByText(name, { exact: false }),
      ],
      options
    );
    if (ok) return name instanceof RegExp ? String(name) : name;
  }
  return null;
}

async function selectRadioByName(
  page: Page,
  step: string,
  name: string,
  extraMatchers: Array<string | RegExp> = []
): Promise<void> {
  const matchers: Array<string | RegExp> = [name, ...extraMatchers];
  for (const matcher of matchers) {
    const radio = page.getByRole("radio", { name: matcher });
    if (await radio.first().count()) {
      await humanClick(radio.first(), { force: true });
      console.log(`  已揀 radio：${name}`);
      return;
    }
    const byLabel = page.getByLabel(matcher);
    if (await visible(byLabel, 600)) {
      await humanClick(byLabel.first(), { force: true });
      console.log(`  已揀 label：${name}`);
      return;
    }
    const byText = page.getByText(matcher, { exact: false });
    if (await visible(byText, 600)) {
      await humanClick(byText.first(), { force: true });
      console.log(`  已揀文字：${name}`);
      return;
    }
  }
  throw new StepError(
    step,
    `揾唔到選項「${name}」。請確認文字同官網一致（例如顏色係「薰衣草紫色」）。`
  );
}

async function fillByLabels(
  page: Page,
  labels: Array<string | RegExp>,
  value: string,
  step: string
): Promise<boolean> {
  if (!value.trim()) return false;
  for (const label of labels) {
    const candidates = [
      page.getByLabel(label).first(),
      page.getByRole("textbox", { name: label }).first(),
      page.getByRole("combobox", { name: label }).first(),
      page.getByPlaceholder(label).first(),
    ];
    for (const field of candidates) {
      if (!(await visible(field, 1500))) continue;

      const accessible =
        (await field.getAttribute("aria-label").catch(() => null)) ||
        (await field.getAttribute("name").catch(() => null)) ||
        (await field.getAttribute("autocomplete").catch(() => null)) ||
        "";
      if (isSensitiveLocatorName(String(label)) || isSensitiveLocatorName(accessible)) {
        console.log(`  跳過疑似付款欄位：${String(label)}`);
        continue;
      }

      const tag = await field.evaluate((el) => el.tagName.toLowerCase()).catch(() => "");
      if (tag === "a" || tag === "button") continue;
      const editable = await field
        .evaluate((el) => {
          const t = el.tagName.toLowerCase();
          if (t === "input" || t === "textarea" || t === "select") return true;
          if ((el as HTMLElement).isContentEditable) return true;
          const role = el.getAttribute("role");
          return role === "textbox" || role === "combobox" || role === "searchbox";
        })
        .catch(() => false);
      if (!editable) continue;

      if (tag === "select") {
        const selected = await field
          .selectOption({ label: value })
          .catch(async () => field.selectOption({ value }).catch(() => null));
        if (selected) {
          console.log(`  已選：${String(label)} = ${value}`);
          return true;
        }
        continue;
      }

      await page.waitForTimeout(CONFIG.clickDelayMs);
      await field.click({ force: true }).catch(() => {});
      await field.fill("");
      await field.fill(value);
      const current = await field.inputValue().catch(() => "");
      if (current.includes(value) || current === value) {
        console.log(`  已填：${String(label)} = ${value}`);
        return true;
      }
      // 有時 fill 唔生效，用 type
      await field.press("ControlOrMeta+A").catch(() => {});
      await field.type(value, { delay: 20 }).catch(() => {});
      console.log(`  已填(type)：${String(label)} = ${value}`);
      return true;
    }
  }
  console.warn(`  [${step}] 揾唔到可填欄位：${labels.map(String).join(" / ")}`);
  return false;
}

async function selectByLabels(
  page: Page,
  labels: Array<string | RegExp>,
  optionText: string,
  step: string
): Promise<boolean> {
  for (const label of labels) {
    const combo = page.getByRole("combobox", { name: label }).first();
    if (await visible(combo, 1500)) {
      await humanClick(combo);
      const option = page.getByRole("option", { name: optionText, exact: false }).first();
      if (await visible(option, 2000)) {
        await humanClick(option);
        console.log(`  已選 combobox：${String(label)} = ${optionText}`);
        return true;
      }
    }

    const select = page.getByLabel(label).first();
    if (await visible(select, 800)) {
      await page.waitForTimeout(CONFIG.clickDelayMs);
      const ok = await select
        .selectOption({ label: optionText })
        .catch(async () => select.selectOption({ value: optionText }).catch(() => null));
      if (ok) {
        console.log(`  已選 select：${String(label)} = ${optionText}`);
        return true;
      }
    }
  }
  console.warn(`  [${step}] 揾唔到下拉選項「${optionText}」`);
  return false;
}

async function readUsedEmails(): Promise<string[]> {
  try {
    const raw = await fs.readFile(USED_EMAILS_FILE, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

type Identity = {
  lastName: string;
  firstName: string;
  area: string;
  district: string;
  street: string;
  /** 屋苑或大廈／座數／樓層／單位（Shipping 地址第 2 行） */
  buildingLine?: string;
  phone: string;
  email: string;
};

/** Shipping-init 四格資料（delivery） */
type DeliveryShippingBoxes = {
  lastName: string;
  firstName: string;
  /** 區域／地區／街道名稱及號碼 */
  areaDistrictStreet: string;
  /** 屋苑或大廈／座數／樓層／單位 */
  buildingFloorUnit: string;
};

type BrowserSession = {
  tag: string;
  identity: Identity;
  browser: Awaited<ReturnType<typeof chromium.launch>>;
  page: Page;
  fulfillmentMode?: "pickup" | "delivery";
  deliveryAddressFull?: string;
  deliveryShippingBoxes?: DeliveryShippingBoxes;
  /** Review／確認頁讀到嘅預計送貨日期（尤其 delivery Apple Pay） */
  estimatedDelivery?: string | null;
  windowId?: number;
  windowBounds?: { left: number; top: number; width: number; height: number };
  /** Billing 到達後只開大／fullscreen 一次 */
  billingWindowRevealed?: boolean;
  /** PickupContact（含 apw/checkout）已 autofill 一次 */
  pickupContactFilledOnce?: boolean;
  /** 今次取貨 autofill 揀嘅聯絡人（兩套姓名隨機其一） */
  pickupContact?: PickupContact;
  /** 人手喺付款頁填入嘅完整卡號（確認頁多數只有遮罩） */
  capturedCardNumber?: string | null;
  /** 銀行／發卡機構（人手／CONFIG，稍後先填） */
  cardCompany?: string | null;
  /** visa / mastercard / AE */
  cardType?: string | null;
  cardLimit?: string | null;
  /** 落單成功真實時間（香港顯示字串） */
  orderPlacedAt?: string | null;
};

/** Dashboard Open／Hide 輪詢用（main 會掛上） */
let ACTIVE_SESSIONS: BrowserSession[] = [];
/** Stop all：唔好開窗／fullscreen */
let SILENT_STOP_ALL = false;

async function takeNEmails(count: number): Promise<string[]> {
  const pool = EMAIL_POOL.map((e) => e.trim().toLowerCase()).filter(Boolean);
  if (pool.length === 0) {
    throw new StepError("電郵", "EMAIL_POOL 係空。請加入電郵。");
  }
  let used = new Set((await readUsedEmails()).map((e) => e.toLowerCase()));
  let unused = pool.filter((e) => !used.has(e));

  // 全部用完／剩餘唔夠：自動清空 used-emails.json，重用 pool
  if (unused.length < count) {
    console.warn(
      `[email] 未用電郵剩 ${unused.length} 個，需要 ${count} 個 → 偵測到電郵已用完，自動重用 EMAIL_POOL（清空 used-emails.json）`
    );
    used = new Set();
    unused = [...pool];
    await fs.writeFile(USED_EMAILS_FILE, "[]", "utf8").catch(() => {});
  }

  // pool 本身少過 count：循環重用同一批
  const picked: string[] = [];
  if (unused.length >= count) {
    picked.push(...unused.slice(0, count));
  } else {
    console.warn(
      `[email] EMAIL_POOL 只有 ${pool.length} 個，少過今次需要 ${count} 個 → 循環重用`
    );
    for (let i = 0; i < count; i++) {
      picked.push(pool[i % pool.length]!);
    }
  }

  for (const email of picked) used.add(email);
  await fs.writeFile(USED_EMAILS_FILE, JSON.stringify([...used], null, 2), "utf8");
  console.log(`[email] 已分配 ${picked.length} 個電郵（used=${used.size}/${pool.length}）`);
  return picked;
}

function makeIdentities(emails: string[]): Identity[] {
  const usedNames = new Set<string>();
  const usedPhones = new Set<string>();
  const usedStreets = new Set<string>();
  const usedPlaces = new Set<string>();

  return emails.map((email) => {
    let lastName = "";
    let firstName = "";
    let nameKey = "";
    for (let i = 0; i < 40; i++) {
      lastName = pick(LAST_NAMES);
      firstName = pick(FIRST_NAMES);
      nameKey = `${lastName}|${firstName}`;
      if (!usedNames.has(nameKey)) break;
    }
    usedNames.add(nameKey);

    const area = pick(HK_AREAS);
    let district = pick(area.districts);
    let placeKey = `${area.area}|${district}`;
    for (let i = 0; i < 20 && usedPlaces.has(placeKey); i++) {
      district = pick(area.districts);
      placeKey = `${area.area}|${district}`;
    }
    usedPlaces.add(placeKey);

    let street = randomStreet();
    for (let i = 0; i < 20 && usedStreets.has(street); i++) street = randomStreet();
    usedStreets.add(street);

    let phone = randomHkMobile();
    for (let i = 0; i < 30 && usedPhones.has(phone); i++) phone = randomHkMobile();
    usedPhones.add(phone);

    return { lastName, firstName, area: area.area, district, street, phone, email };
  });
}

async function dismissCookies(page: Page): Promise<void> {
  await clickByAccessibleName(page, [
    /^同意$/,
    /接受全部/,
    /允許全部/,
    /^Accept$/,
    /Allow all/i,
    /^OK$/,
  ]);
}

async function hasPaymentIframe(page: Page): Promise<boolean> {
  const frame = page.locator(
    'iframe[src*="payment"], iframe[name*="payment" i], iframe[title*="payment" i], iframe[src*="wallet"], iframe[src*="card"]'
  );
  return visible(frame, 800);
}

async function hasCardFields(page: Page): Promise<boolean> {
  const candidates = [
    page.getByLabel(/信用卡|卡號|Card number/i),
    page.getByLabel(/CVV|CVC|安全碼/i),
    page.locator('input[autocomplete="cc-number"]'),
    page.locator('input[autocomplete="cc-csc"]'),
    page.locator('input[name*="cardNumber" i]'),
  ];
  for (const loc of candidates) {
    if (await visible(loc, 400)) return true;
  }
  return false;
}

async function isOnPaymentStep(page: Page): Promise<boolean> {
  if (/\/shop\/signIn/i.test(page.url())) return false;
  // PickupContact／Shipping／Fulfillment 側欄常有「信用卡」字樣，唔好當付款頁而跳過填表
  if (
    isPickupContactPage(page.url()) ||
    /[?&]_s=(?:Shipping|Fulfillment|PickupContact)/i.test(page.url())
  ) {
    return false;
  }
  if (PAYMENT_URL.test(page.url())) return true;
  if (await hasPaymentIframe(page)) return true;
  if (await hasCardFields(page)) return true;
  const text = (await page.locator("body").innerText().catch(() => "")) || "";
  return /信用卡號碼|Card number|安全碼|CVV|CVC/i.test(text);
}

async function isConfirmationPage(page: Page): Promise<boolean> {
  if (CONFIRM_URL.test(page.url())) return true;
  const text = (await page.locator("body").innerText().catch(() => "")) || "";
  return /多謝你|謝謝你|感謝你的訂單|Thank you for your order|訂單編號|Order Number/i.test(
    text
  );
}

async function isSignInPage(page: Page): Promise<boolean> {
  if (/\/shop\/signIn/i.test(page.url())) return true;
  // Apple ID auth widget 有時喺 checkout start 內嵌
  const hasAuthIframe =
    (await page
      .locator("#aid-auth-widget-iFrame, iframe[src*='idmsa.apple.com'], iframe[src*='appleauth']")
      .count()
      .catch(() => 0)) > 0;
  return hasAuthIframe;
}

/** 讀 radio／checkbox 是否已選（含 aria-checked） */
async function isOptionSelected(el: Locator): Promise<boolean> {
  return el
    .evaluate((n) => {
      const node = n as HTMLElement;
      const input = (
        node.matches("input")
          ? node
          : node.querySelector("input[type='radio'], input[type='checkbox']")
      ) as HTMLInputElement | null;
      if (input?.checked) return true;
      const aria = (node.getAttribute("aria-checked") || input?.getAttribute("aria-checked") || "")
        .toLowerCase();
      return aria === "true";
    })
    .catch(() => false);
}

async function isOptionDisabled(el: Locator): Promise<boolean> {
  return el
    .evaluate((n) => {
      const node = n as HTMLElement;
      const input = (
        node.matches("input")
          ? node
          : node.querySelector("input")
      ) as HTMLInputElement | null;
      if (input?.disabled) return true;
      if (node.hasAttribute("disabled")) return true;
      return (node.getAttribute("aria-disabled") || "").toLowerCase() === "true";
    })
    .catch(() => false);
}

/**
 * 產品設定頁撳 radio：優先 label／role，等 enable，撳完要確認 checked。
 * （唔好喺 disabled 時假設成功；唔好只改 DOM checked 騙過 React）
 */
async function clickAutomOrRadio(
  page: Page,
  step: string,
  name: string,
  automSelectors: string[],
  extraMatchers: Array<string | RegExp> = []
): Promise<void> {
  const matchers: Array<string | RegExp> = [name, ...extraMatchers];

  const tryClickLocator = async (el: Locator, via: string): Promise<boolean> => {
    if (!(await el.count().catch(() => 0))) return false;

    // AppleCare 等區：未揀不換購前會 disabled，要等解鎖
    for (let w = 0; w < 12; w++) {
      if (!(await isOptionDisabled(el))) break;
      if (w === 0) console.log(`  等待「${name}」解鎖…`);
      await sleepCheckingRelease(350);
    }
    if (await isOptionDisabled(el)) {
      console.warn(`  「${name}」仍然 disabled（via ${via}）`);
      return false;
    }

    if (await isOptionSelected(el)) {
      console.log(`  已揀 ${step}：${name}（已選，via ${via}）`);
      return true;
    }

    await el.scrollIntoViewIfNeeded().catch(() => {});
    await sleepCheckingRelease(Math.min(CONFIG.clickDelayMs, 60));

    // 1) 撳對應 label（Apple 產品頁 radio 多數係 readonly，要撳 label）
    const clickedLabel = await el
      .evaluate((n) => {
        const node = n as HTMLElement;
        const input = (
          node.matches("input")
            ? node
            : node.querySelector("input")
        ) as HTMLInputElement | null;
        const labelledBy = input?.getAttribute("aria-labelledby") || node.getAttribute("aria-labelledby");
        const byFor = input?.id
          ? (document.querySelector(`label[for="${input.id}"]`) as HTMLElement | null)
          : null;
        const byAria = labelledBy
          ? (document.getElementById(labelledBy.split(/\s+/)[0]!) as HTMLElement | null)
          : null;
        const parentCard = (input || node).closest(
          ".form-selector, .rf-applecare-option, .colornav-item, label, [role='radio']"
        ) as HTMLElement | null;
        const target = byFor || byAria || node.closest("label") || parentCard || node;
        target.click();
        return true;
      })
      .catch(() => false);

    if (!clickedLabel) {
      await humanClick(el, { force: true }).catch(() => {});
    }

    await sleepCheckingRelease(isIphone17Task() || isIphone18Task() ? 120 : 400);
    if (await isOptionSelected(el)) {
      console.log(`  已揀 ${step}：${name}（${via}）`);
      return true;
    }

    // 2) Playwright force click label / radio
    if (automSelectors.length) {
      for (const sel of automSelectors) {
        const input = page.locator(sel).first();
        if (!(await input.count().catch(() => 0))) continue;
        const id = await input.getAttribute("id").catch(() => null);
        if (id) {
          const lab = page.locator(`label[for="${id}"]`).first();
          if (await lab.count().catch(() => 0)) {
            await humanClick(lab, { force: true }).catch(() => {});
            await sleepCheckingRelease(350);
            if (await isOptionSelected(input)) {
              console.log(`  已揀 ${step}：${name}（label[for]）`);
              return true;
            }
          }
        }
      }
    }

    await humanClick(el, { force: true }).catch(() => {});
    await sleepCheckingRelease(350);
    if (await isOptionSelected(el)) {
      console.log(`  已揀 ${step}：${name}（force click）`);
      return true;
    }
    return false;
  };

  // A) data-autom / css
  for (const sel of automSelectors) {
    const el = page.locator(sel).first();
    if (await tryClickLocator(el, `data-autom:${sel}`)) {
      await sleepCheckingRelease(500);
      return;
    }
  }

  // B) role=radio / getByLabel / 可見文字
  for (const matcher of matchers) {
    const radio = page.getByRole("radio", { name: matcher }).first();
    if (await tryClickLocator(radio, "role=radio")) {
      await sleepCheckingRelease(500);
      return;
    }
    const byLabel = page.getByLabel(matcher).first();
    if (await tryClickLocator(byLabel, "label")) {
      await sleepCheckingRelease(500);
      return;
    }
  }

  // C) 最後 fallback（舊邏輯）
  await selectRadioByName(page, step, name, extraMatchers);
}

function isIphone17Task(): boolean {
  return (
    /iPhone\s*17(?!\s*Pro)/i.test(CONFIG.model) ||
    /\/buy-iphone\/iphone-17(?![-/]*pro)/i.test(CONFIG.buyUrl || "")
  );
}

function isIphone18Task(): boolean {
  return (
    /iPhone\s*18/i.test(CONFIG.model) ||
    /\/buy-iphone\/iphone-18/i.test(CONFIG.buyUrl || "") ||
    /\/goto\/buy_iphone\/iphone_18/i.test(CONFIG.buyUrl || "")
  );
}

/** iPhone 18 設定 slug 出錯時改用嘅 goto 頁（refresh 直到可撳繼續） */
const IPHONE_18_PRO_GOTO_URL =
  "https://www.apple.com/hk-zh/shop/goto/buy_iphone/iphone_18_pro";
const IPHONE_18_PRO_MAX_GOTO_URL =
  "https://www.apple.com/hk-zh/shop/goto/buy_iphone/iphone_18_pro_max";

/** 一旦某 page 改走 goto，之後該 page refresh 都用 goto */
const iphone18GotoPages = new WeakSet<Page>();

function iphone18GotoBuyUrl(): string {
  const model = CONFIG.model || "";
  const buy = CONFIG.buyUrl || "";
  if (/pro\s*max/i.test(model) || /iphone[-_]18[-_]pro[-_]max/i.test(buy)) {
    return IPHONE_18_PRO_MAX_GOTO_URL;
  }
  return IPHONE_18_PRO_GOTO_URL;
}

function isIphone18ConfiguredSlugUrl(url: string): boolean {
  // 例：…/buy-iphone/iphone-18-pro/6.9-吋顯示屏-256gb-布根地紅色
  return /\/shop\/buy-iphone\/iphone-18[^/]*\/\d+\.\d+/i.test(url);
}

function currentIphone18BuyUrl(page?: Page): string {
  if (page && (iphone18GotoPages.has(page) || /\/goto\/buy_iphone\/iphone_18/i.test(page.url()))) {
    return iphone18GotoBuyUrl();
  }
  return CONFIG.buyUrl;
}

/** 偵測 iPhone 18 產品設定頁真正錯誤（唔包「暫無供應」等可繼續 refresh 嘅軟狀態） */
async function isIphone18BuyPageError(page: Page): Promise<boolean> {
  const url = page.url();
  if (/\/shop\/bag|\/checkout|\/signIn|wallet\.apple/i.test(url)) return false;
  if (isShop404Url(url)) return true;

  const title = (await page.title().catch(() => "")) || "";
  const body =
    ((await page.locator("body").innerText().catch(() => "")) || "").slice(0, 3500);
  const blob = `${title}\n${body}`;

  // 硬錯誤：真 404／拒絕存取／整頁壞咗
  if (
    /404|Page Not Found|找不到(?:此)?頁|This page isn'?t available|Access Denied|Service Unavailable|維護中|Something went wrong/i.test(
      blob
    )
  ) {
    return true;
  }

  const ctaCount = await page
    .locator(
      '[data-autom="continueButton"], [data-autom="add-to-cart"], button[name="add-to-cart"], button:has-text("加入購物袋"), button:has-text("繼續")'
    )
    .count()
    .catch(() => 0);

  // 「暫無供應／系統繁忙」但仲有 CTA：開賣前／搶購正常狀態 → 唔當錯誤、唔好亂轉 goto
  if (
    /系統繁忙|請稍後再試|Please try again|Currently unavailable|暫無供應|目前無法提供|無法載入|發生錯誤/i.test(
      blob
    )
  ) {
    if (ctaCount > 0) return false;
    // 冇 CTA 先當錯誤，轉 goto 試
    return true;
  }

  // 設定 slug 頁但完全冇「繼續／加入購物袋」
  if (isIphone18ConfiguredSlugUrl(url) || isIphone18ConfiguredSlugUrl(CONFIG.buyUrl)) {
    if (ctaCount === 0) return true;
  }
  return false;
}

/**
 * iPhone 18：設定 slug 出錯／加購失敗 → 轉 goto 頁，refresh 直到可撳掣去下一頁
 */
async function pollIphone18GotoUntilNextPage(page: Page): Promise<boolean> {
  const gotoUrl = iphone18GotoBuyUrl();
  iphone18GotoPages.add(page);
  console.log(`步驟：iPhone 18 設定頁失敗 → 改去 ${gotoUrl}`);
  console.log("  會不停 refresh，直到撳到「繼續／加入購物袋」入下一頁");

  const deadline = Date.now() + 12 * 60 * 1000;
  let round = 0;

  while (Date.now() < deadline) {
    await throwIfReleased();
    round += 1;
    await writeStatus({
      phase: "adding_cart",
      message: "adding cart",
      pollRound: round,
      buyUrl: gotoUrl,
      saleStartIso: CONFIG.saleStartIso,
      iphone18GotoFallback: true,
    }).catch(() => {});

    console.log(`  iPhone 18 goto 輪詢 #${round}｜${gotoUrl}`);
    await withReleaseCheck(
      page.goto(gotoUrl, { waitUntil: "domcontentloaded" }).catch(async () => {
        await page.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
      })
    );
    await dismissCookies(page).catch(() => {});
    await settleDom(page, 150);

    if (await isIphone18BuyPageError(page)) {
      if (isShop404Url(page.url())) {
        console.warn("  goto 輪詢撞到 /shop/404 → 購物袋復原…");
        const recovered = await recoverFromShop404IfNeeded(page);
        if (recovered && (await confirmAddedToBag(page))) {
          console.log("  ✓ 404 復原後已有購物袋貨，當加購成功");
          return true;
        }
        await sleepCheckingRelease(CONFIG.productPollIntervalMs);
        continue;
      }
      console.warn("  goto 頁仍似錯誤頁，refresh 再試…");
      await sleepCheckingRelease(CONFIG.productPollIntervalMs);
      continue;
    }

    await selectProductOptions(page, { randomColor: false }).catch((err) => {
      console.warn(
        `  goto 揀規格：${err instanceof Error ? err.message : String(err)}`
      );
    });
    await ensureTradeInAndAppleCareForAddToBag(page).catch(() => {});

    const before = page.url();
    const ok = await keepClickingContinueUntilNextPage(page, {
      maxMs: Math.max(12_000, CONFIG.productPollIntervalMs * 3),
    });
    if (ok || hasLeftBuyConfig(page.url(), before)) {
      console.log(`  ✓ iPhone 18 goto 已入下一頁 → ${page.url()}`);
      return true;
    }

    console.log(
      `  尚未入下一頁，${CONFIG.productPollIntervalMs / 1000}s 後 refresh goto…`
    );
    await sleepCheckingRelease(CONFIG.productPollIntervalMs);
    await withReleaseCheck(
      page.reload({ waitUntil: "domcontentloaded" }).catch(() => {})
    );
  }

  console.warn("  iPhone 18 goto 輪詢超時仍未入下一頁");
  return false;
}

/** iPhone 18 加購：先試 CONFIG slug；頁面真係壞先轉 goto + refresh */
async function addIphone18WithGotoFallback(page: Page): Promise<boolean> {
  // 已改走 goto：直接輪詢 goto
  if (iphone18GotoPages.has(page) || /\/goto\/buy_iphone\/iphone_18/i.test(page.url())) {
    return pollIphone18GotoUntilNextPage(page);
  }

  if (await isIphone18BuyPageError(page)) {
    console.warn("  偵測到 iPhone 18 設定頁錯誤 → 立即轉 goto");
    return pollIphone18GotoUntilNextPage(page);
  }

  const onSlug =
    isIphone18ConfiguredSlugUrl(page.url()) ||
    isIphone18ConfiguredSlugUrl(CONFIG.buyUrl);

  await ensureTradeInAndAppleCareForAddToBag(page).catch(() => {});
  const first = await keepClickingContinueUntilNextPage(page, {
    maxMs: onSlug ? 20_000 : 35_000,
  });
  if (first) return true;

  if (await isIphone18BuyPageError(page)) {
    console.warn("  iPhone 18 設定頁加購失敗且變成錯誤頁 → 轉 goto 並 refresh");
    return pollIphone18GotoUntilNextPage(page);
  }

  // 正常 slug 只係今輪未入袋：交俾外層 refresh，唔好鎖死喺 goto
  console.warn("  iPhone 18 今輪未入下一頁，留喺設定 slug 由外層再 refresh");
  return false;
}

/**
 * iPhone 17 平滑流程（固定順序）：
 * 1) 薰衣草紫色（或 CONFIG.color）— 已選就跳過
 * 2) 256GB（或 CONFIG.storage）— 已選就跳過
 * 3) 不換購（必須確認 checked，先解鎖 AppleCare）
 * 4) 無 AppleCare+ 服務計劃保障（等 enable 再撳）
 * （「加入購物袋」由呼叫端撳）
 */
async function selectIphone17OptionsSmooth(page: Page): Promise<void> {
  const color = String(CONFIG.color || "薰衣草紫色").trim() || "薰衣草紫色";
  const storage = String(CONFIG.storage || "256GB").trim() || "256GB";
  const storageAutom = storage.replace(/\s+/g, "").toLowerCase(); // 256gb

  console.log("步驟：iPhone 17 平滑揀選（顏色 → 容量 → 不換購 → 無 AppleCare+）");
  console.log(`  顏色=${color}｜容量=${storage}`);

  const colorAlready = await page
    .locator('[data-autom="dimensionColorlavender"], input[value="lavender"]')
    .first()
    .evaluate((n) => (n as HTMLInputElement).checked)
    .catch(() => false);
  const storageAlready = await page
    .locator(`[data-autom="dimensionCapacity${storageAutom}"], input[value="${storageAutom}"]`)
    .first()
    .evaluate((n) => (n as HTMLInputElement).checked)
    .catch(() => false);

  // 1) 顏色：薰衣草紫色（slug 頁多數已揀好，避免重撳導致 remount）
  if (colorAlready && /薰衣草|lavender/i.test(color)) {
    console.log("  ① 顏色已係薰衣草紫色，跳過");
  } else {
    console.log("  ① 撳顏色…");
    await clickAutomOrRadio(
      page,
      "顏色",
      color,
      [
        '[data-autom="dimensionColorlavender"]',
        'input[value="lavender"]',
        'label[for*="lavender" i]',
        '[data-autom*="lavender" i]',
      ],
      [color, /薰衣草紫色/, /薰衣草/, /lavender/i, /紫/]
    ).catch((err) => console.warn(`  顏色：${err instanceof Error ? err.message : String(err)}`));
    await sleepCheckingRelease(120);
  }

  // 2) 容量：256GB
  if (storageAlready) {
    console.log(`  ② 容量已係 ${storage}，跳過`);
  } else {
    console.log("  ② 撳容量…");
    await clickAutomOrRadio(
      page,
      "容量",
      storage,
      [
        `[data-autom="dimensionCapacity${storageAutom}"]`,
        `input[value="${storageAutom}"]`,
        `label[for*="${storageAutom}" i]`,
      ],
      [new RegExp(storage.replace(/\s+/g, "\\s*"), "i")]
    ).catch((err) => console.warn(`  容量：${err instanceof Error ? err.message : String(err)}`));
    await sleepCheckingRelease(120);
  }

  // 3) 不換購（解鎖 AppleCare 區）— 雙重確認
  console.log("  ③ 撳不換購…");
  for (let attempt = 1; attempt <= 3; attempt++) {
    await clickAutomOrRadio(
      page,
      "換購",
      "不換購",
      [
        '[data-autom="choose-noTradeIn"]',
        'input#noTradeIn',
        'input[value="noTradeIn"]',
        'label[for="noTradeIn"]',
      ],
      [/^不換購$/, /不換購/, /No trade[- ]?in/i]
    ).catch((err) => console.warn(`  不換購：${err instanceof Error ? err.message : String(err)}`));

    const noTradeOk = await page
      .locator('#noTradeIn, [data-autom="choose-noTradeIn"], input[value="noTradeIn"]')
      .first()
      .evaluate((n) => (n as HTMLInputElement).checked)
      .catch(() => false);
    if (noTradeOk) {
      console.log("  ✓ 不換購已選");
      break;
    }
    console.warn(`  不換購第 ${attempt} 次未確認 checked，再試…`);
    await sleepCheckingRelease(250);
  }
  await sleepCheckingRelease(200);

  // 4) 無 AppleCare+ 服務計劃保障（要等不換購解鎖）
  console.log("  ④ 撳無 AppleCare+ 服務計劃保障…");
  for (let attempt = 1; attempt <= 4; attempt++) {
    // 等 AppleCare radio 唔再 disabled
    for (let w = 0; w < 8; w++) {
      const disabled = await page
        .locator('[data-autom="noapplecare"]')
        .first()
        .evaluate((n) => (n as HTMLInputElement).disabled)
        .catch(() => true);
      if (!disabled) break;
      await sleepCheckingRelease(200);
    }

    await clickAutomOrRadio(
      page,
      "AppleCare",
      "無 AppleCare+ 服務計劃保障",
      [
        '[data-autom="noapplecare"]',
        'input[data-autom="noapplecare"]',
        'label[for*="noapplecare" i]',
        'input[value*="noAppleCare" i]',
      ],
      [/無\s*AppleCare\+?\s*服務計劃保障/, /無 AppleCare/, /冇 AppleCare/, /No AppleCare/i]
    ).catch((err) =>
      console.warn(`  AppleCare：${err instanceof Error ? err.message : String(err)}`)
    );

    const careOk = await page
      .locator('[data-autom="noapplecare"]')
      .first()
      .evaluate((n) => (n as HTMLInputElement).checked)
      .catch(() => false);
    if (careOk) {
      console.log("  ✓ 無 AppleCare+ 已選");
      break;
    }

    // 可能不換購被 reset — 再撳一次
    console.warn(`  無 AppleCare 第 ${attempt} 次未選中，重確認不換購…`);
    await clickAutomOrRadio(
      page,
      "換購",
      "不換購",
      ['[data-autom="choose-noTradeIn"]', 'input#noTradeIn', 'input[value="noTradeIn"]'],
      [/^不換購$/, /不換購/]
    ).catch(() => {});
    await sleepCheckingRelease(700);
  }
  await sleepCheckingRelease(500);

  // 等「加入購物袋」enable
  for (let i = 1; i <= 10; i++) {
    await throwIfReleased();
    const enabled = await page.evaluate(() => {
      const btn = document.querySelector(
        '[data-autom="add-to-cart"], button[name="add-to-cart"]'
      ) as HTMLButtonElement | null;
      if (btn && !btn.disabled && btn.getAttribute("aria-disabled") !== "true") return true;
      const btns = Array.from(document.querySelectorAll("button"));
      return btns.some((b) => {
        const t = (b.textContent || "").replace(/\s+/g, " ").trim();
        return /加入購物袋|Add to Bag/i.test(t) && !(b as HTMLButtonElement).disabled;
      });
    });
    if (enabled) {
      console.log(`  ✓ 加入購物袋已可撳（wait ${i}）`);
      return;
    }
    if (i === 3 || i === 6 || i === 9) {
      await clickAutomOrRadio(
        page,
        "換購",
        "不換購",
        ['[data-autom="choose-noTradeIn"]', 'input#noTradeIn', 'input[value="noTradeIn"]'],
        [/^不換購$/, /不換購/]
      ).catch(() => {});
      await sleepCheckingRelease(500);
      await clickAutomOrRadio(
        page,
        "AppleCare",
        "無 AppleCare+ 服務計劃保障",
        ['[data-autom="noapplecare"]', 'input[data-autom="noapplecare"]'],
        [/無\s*AppleCare/, /無 AppleCare/]
      ).catch(() => {});
    }
    await sleepCheckingRelease(450);
  }
  console.warn("  「加入購物袋」仍可能 disabled，稍後仍會嘗試撳。");
}

/** iPhone 17 已配置 slug 頁：必須先揀不換購 + 無 AppleCare，「加入購物袋」先會 enable */
async function ensureTradeInAndAppleCareForAddToBag(page: Page): Promise<void> {
  if (isIphone17Task()) {
    await selectIphone17OptionsSmooth(page);
    return;
  }
  console.log("步驟：確保已揀「不換購」同「無 AppleCare」（解鎖加入購物袋）");
  for (let round = 1; round <= 5; round++) {
    await throwIfReleased();

    // 不換購
    await clickAutomOrRadio(
      page,
      "換購",
      "不換購",
      [
        '[data-autom="choose-noTradeIn"]',
        'input#noTradeIn',
        'input[value="noTradeIn"]',
        'label[for="noTradeIn"]',
      ],
      [/^不換購$/, /No trade[- ]?in/i]
    ).catch(() => {});

    await sleepCheckingRelease(600);

    // 無 AppleCare（有時要等換購揀完先 enable）
    await clickAutomOrRadio(
      page,
      "AppleCare",
      "無 AppleCare+ 服務計劃保障",
      [
        '[data-autom="noapplecare"]',
        'input[data-autom="noapplecare"]',
        'label[for*="noapplecare" i]',
      ],
      [/無 AppleCare/, /冇 AppleCare/, /No AppleCare/i]
    ).catch(() => {});

    await sleepCheckingRelease(500);

    const unlocked = await page.evaluate(() => {
      const noTrade = document.querySelector(
        '#noTradeIn, input[value="noTradeIn"], [data-autom="choose-noTradeIn"]'
      ) as HTMLInputElement | null;
      const addBtns = Array.from(document.querySelectorAll("button")).filter((b) =>
        /加入購物袋|Add to Bag|^繼續$/i.test((b.textContent || "").trim())
      );
      const enabledAdd = addBtns.some((b) => !(b as HTMLButtonElement).disabled);
      return {
        noTradeChecked: Boolean(noTrade?.checked),
        enabledAdd,
        addDisabled: addBtns.map((b) => ({
          t: (b.textContent || "").replace(/\s+/g, " ").trim().slice(0, 30),
          d: (b as HTMLButtonElement).disabled,
        })),
      };
    });

    console.log(
      `  round ${round}/5：不換購=${unlocked.noTradeChecked}｜加入購物袋可撳=${unlocked.enabledAdd}`
    );
    if (unlocked.enabledAdd) return;

    // 有時要捲去換購／AppleCare 區再試
    await page
      .getByText(/不換購|AppleCare|以舊換新/i)
      .first()
      .scrollIntoViewIfNeeded()
      .catch(() => {});
    await sleepCheckingRelease(800);
  }
  console.warn("  未能確認「加入購物袋」已解鎖，稍後仍會 force 嘗試。");
}

function isConfiguredProductSlugUrl(url: string): boolean {
  // 例：/iphone-17/6.3-…-256gb-… 或 /iphone-18-pro/6.9-…
  return /\/shop\/buy-iphone\/iphone-[^/]+\/\d+\.\d+/i.test(url);
}

async function selectProductOptions(
  page: Page,
  opts?: { randomColor?: boolean }
): Promise<void> {
  // iPhone 17：固定平滑順序（顏色 → 256GB → 不換購 → 無 AppleCare+）
  if (isIphone17Task() && !opts?.randomColor) {
    await selectIphone17OptionsSmooth(page);
    return;
  }

  console.log("步驟：揀型號 / 容量 / 顏色");

  const color = opts?.randomColor ? pick(COLORS) : CONFIG.color;
  console.log(`  今次顏色：${color}${opts?.randomColor ? "（隨機）" : ""}`);

  const is17 = /iPhone\s*17(?!\s*Pro)/i.test(CONFIG.model);
  const isProMax = /Pro\s*Max/i.test(CONFIG.model);

  // 1) 型號
  if (is17) {
    await clickAutomOrRadio(
      page,
      "型號",
      CONFIG.model,
      [
        '[data-autom="dimensionScreensize6_3inch"]',
        'input[value="6_3inch"]',
        'label[for*="6_3inch" i]',
      ],
      [/iPhone\s*17/i, /6\.3/]
    ).catch(() => {});
  } else if (isProMax) {
    await clickAutomOrRadio(
      page,
      "型號",
      CONFIG.model,
      [
        '[data-autom="dimensionScreensize6_9inch"]',
        'input[value="6_9inch"]',
        'label[for*="6_9inch" i]',
      ],
      [/iPhone\s*18\s*Pro\s*Max/i, /Pro\s*Max/i, /6\.9/]
    );
  } else {
    await clickAutomOrRadio(
      page,
      "型號",
      CONFIG.model,
      [],
      [CONFIG.model, /Pro(?!\s*Max)/i, /6\.3/]
    ).catch(() => {});
  }

  // 2) 容量
  const storageAutom = CONFIG.storage.replace(/\s+/g, "").toLowerCase(); // 256gb
  await clickAutomOrRadio(
    page,
    "容量",
    CONFIG.storage,
    [
      `[data-autom="dimensionCapacity${storageAutom}"]`,
      `input[value="${storageAutom}"]`,
    ],
    [new RegExp(CONFIG.storage.replace(/\s+/g, "\\s*"), "i"), /^\d+\s*GB$/i]
  );

  // 3) 顏色（slug 已揀好就跳過，加快首屏）
  const colorAutom =
    /布根地/.test(color)
      ? "burgundy"
      : /冰川/.test(color)
        ? "glacier"
        : /銀/.test(color)
          ? "silver"
          : /黑/.test(color)
            ? "black"
            : /薰衣草|紫/.test(color)
              ? "lavender"
              : /霧藍|藍/.test(color)
                ? "mistblue"
                : /白/.test(color)
                  ? "white"
                  : /鼠尾草|綠/.test(color)
                    ? "sage"
                    : "";
  const colorAlreadySelected =
    colorAutom &&
    (await page
      .locator(`[data-autom="dimensionColor${colorAutom}"], input[value="${colorAutom}"]`)
      .first()
      .evaluate((n) => (n as HTMLInputElement).checked)
      .catch(() => false));
  if (colorAlreadySelected) {
    console.log(`  顏色已係 ${color}，跳過`);
  } else {
    await clickAutomOrRadio(
      page,
      "顏色",
      color,
      colorAutom
        ? [
            `[data-autom="dimensionColor${colorAutom}"]`,
            `input[value="${colorAutom}"]`,
          ]
        : [],
      [
        color,
        color.replace(/色$/, ""),
        /布根地紅/,
        /burgundy/i,
        /冰川/,
        /glacier/i,
        /銀/,
        /silver/i,
        /黑/,
        /black/i,
        /薰衣草/,
        /lavender/i,
      ]
    );
  }

  if (CONFIG.skipTradeIn) {
    await clickAutomOrRadio(
      page,
      "換購",
      "不換購",
      ['[data-autom="choose-noTradeIn"]', 'input[value="noTradeIn"]'],
      [/不換購/, /No trade[- ]?in/i]
    ).catch((err) => {
      console.warn(String(err));
      console.warn("  換購選項揾唔到，請人手揀「不換購」。");
    });
  }

  if (!CONFIG.addAppleCare) {
    await clickAutomOrRadio(
      page,
      "AppleCare",
      "無 AppleCare+ 服務計劃保障",
      ['[data-autom="noapplecare"]'],
      [/無 AppleCare/, /冇 AppleCare/, /No AppleCare/i]
    ).catch((err) => {
      console.warn(String(err));
      console.warn("  AppleCare 選項揾唔到，請人手揀。");
    });
  } else {
    await clickAutomOrRadio(
      page,
      "AppleCare",
      "AppleCare+",
      ['[data-autom="applecare"]', '[data-autom="acp"]'],
      [/AppleCare\+ 服務計劃/]
    ).catch((err) => {
      console.warn(String(err));
    });
  }

  // 缺貨提示
  const dude =
    ((await page.locator('[data-autom="dudeInfo"], [data-autom="deliveryQuotes"]').innerText().catch(() => "")) ||
      "") + "";
  if (/暫無供應|目前無法提供|Currently unavailable/i.test(dude)) {
    console.warn(`  供應狀態：${dude.replace(/\s+/g, " ").slice(0, 120)}`);
  }
}

function isProductConfigPage(url: string): boolean {
  return /\/shop\/buy-iphone\//i.test(url);
}

function isBagPage(url: string): boolean {
  return /\/shop\/bag/i.test(url);
}

/** Apple HK 錯誤頁：https://www.apple.com/hk-zh/shop/404 */
function isShop404Url(url: string): boolean {
  return /\/shop\/404\b/i.test(url);
}

/** Soft 404 文案（URL 仍可能係 Fulfillment-init 或 apple.com/search?src=pnf） */
const PAGE_NOT_FOUND_TEXT_RE =
  /The page you[\u2019']?re looking for can[\u2019']?t be found|找不到你想去的網頁|找不到你要找的頁面|找不到你要尋找的頁面|找不到此頁面|頁面不存在/i;

/** can't be found 時優先返產品購買頁（再由腳本重新入 checkout） */
const FALLBACK_BUY_URL_ON_NOT_FOUND =
  "https://www.apple.com/hk-zh/shop/buy-iphone/iphone-18-pro/6.9-%E5%90%8B%E9%A1%AF%E7%A4%BA%E5%99%A8-512gb-%E5%86%B0%E5%B7%9D%E8%89%B2";

function buyUrlForNotFoundRecovery(): string {
  const cfg = String(CONFIG.buyUrl || "").trim();
  if (/\/shop\/buy-iphone\//i.test(cfg)) return cfg;
  return FALLBACK_BUY_URL_ON_NOT_FOUND;
}

async function pageShowsNotFound(page: Page): Promise<boolean> {
  if (isShop404Url(page.url())) return true;
  return page
    .evaluate(() => {
      const title = document.title || "";
      const body = (document.body?.innerText || "").slice(0, 12000);
      const h1 = document.querySelector("h1")?.textContent || "";
      return `${title}\n${h1}\n${body}`;
    })
    .then((text) => PAGE_NOT_FOUND_TEXT_RE.test(text || ""))
    .catch(() => false);
}

/** Opened browsers：標 page error；can't be found → 先返 buy-iphone 產品頁 */
async function markPageErrorIfNotFound(
  page: Page,
  context = ""
): Promise<boolean> {
  if (!(await pageShowsNotFound(page))) return false;
  const url = page.url();
  const prefix = context ? `[${context}] ` : "";

  // 已喺正確產品頁就唔重複跳
  if (/\/shop\/buy-iphone\//i.test(url) && !isAppleSiteSearchUrl(url)) {
    console.warn(`  ${prefix}★ page not found 但仍喺 buy-iphone｜${url}`);
  } else {
    console.warn(
      `  ${prefix}★ “The page you're looking for can't be found.”／找不到網頁 → 先返產品購買頁｜${url}`
    );
    const recovered = await recoverToBuyPageFromNotFound(
      page,
      context || "page-not-found"
    );
    if (recovered) return true;
  }

  console.warn(
    `  ${prefix}★ page error：找不到你想去的網頁／can't be found｜${url}`
  );
  await writeStatus({
    phase: "page_error",
    stuck: true,
    url,
    message: "page error: The page you're looking for can't be found.",
    card: {
      url,
      message: "page error: The page you're looking for can't be found.",
    },
  }).catch(() => {});
  return true;
}

const recoveringNotFoundPages = new WeakSet<Page>();

/** “can't be found” → 先去產品購買頁（CONFIG.buyUrl／冰川藍 fallback） */
async function recoverToBuyPageFromNotFound(
  page: Page,
  tag = ""
): Promise<boolean> {
  if (recoveringNotFoundPages.has(page)) return false;
  recoveringNotFoundPages.add(page);
  try {
    const target = buyUrlForNotFoundRecovery();
    const prefix = tag ? `${tag} ` : "";
    console.warn(`  ${prefix}★ 返產品購買頁（先）：${target}`);
    markCheckoutNav(target, "recover-not-found-to-buy");
    await writeStatus({
      phase: "recover_to_buy",
      stuck: false,
      message: `can't be found → 先返產品購買頁`,
      url: target,
      card: { url: target, message: "recovered: can't be found → buy page" },
    }).catch(() => {});
    await withReleaseCheck(
      page.goto(target, { waitUntil: "domcontentloaded", timeout: 60_000 }).catch(() => {})
    );
    await settleDom(page, 400);
    return /\/shop\/buy-iphone\//i.test(page.url());
  } finally {
    recoveringNotFoundPages.delete(page);
  }
}

/** @deprecated 改用 recoverToBuyPageFromNotFound；保留別名以免漏改 */
async function recoverToFulfillmentInitFromNotFound(
  page: Page,
  tag = ""
): Promise<boolean> {
  return recoverToBuyPageFromNotFound(page, tag);
}

/** 上一頁時間戳：用嚟量 /shop/404 由邊頁跳過嚟、隔咗幾耐 */
type CheckoutNavMark = {
  url: string;
  atMs: number;
  atIso: string;
  label?: string;
};

let lastNon404NavMark: CheckoutNavMark | null = null;

/** 今次喺 Fulfillment-init 已 soft／full refresh 幾多次（撞 404 時寫入 jsonl） */
let fulfillmentRefreshCount = 0;
let fulfillmentRefreshFirstAt: string | null = null;
let fulfillmentRefreshLastAt: string | null = null;
let fulfillmentRefreshLastKind: "soft" | "full" | null = null;

function resetFulfillmentRefreshStats(): void {
  fulfillmentRefreshCount = 0;
  fulfillmentRefreshFirstAt = null;
  fulfillmentRefreshLastAt = null;
  fulfillmentRefreshLastKind = null;
}

function noteFulfillmentRefresh(kind: "soft" | "full"): number {
  fulfillmentRefreshCount += 1;
  const at = new Date().toISOString();
  if (!fulfillmentRefreshFirstAt) fulfillmentRefreshFirstAt = at;
  fulfillmentRefreshLastAt = at;
  fulfillmentRefreshLastKind = kind;
  console.log(
    `  Fulfillment-init refresh #${fulfillmentRefreshCount}（${kind}）`
  );
  return fulfillmentRefreshCount;
}

function markCheckoutNav(url: string, label?: string): void {
  const u = String(url || "").trim();
  if (!u || isShop404Url(u)) return;
  lastNon404NavMark = {
    url: u,
    atMs: Date.now(),
    atIso: new Date().toISOString(),
    label: label || undefined,
  };
}

/**
 * 進入 /shop/404 時記錄：上一頁 URL／時間 → 404 時間同間隔，
 * 以及 Fulfillment-init 已 refresh 幾多次（status + jsonl）。
 */
async function recordShop404Timing(
  page: Page,
  context: string
): Promise<{
  context: string;
  fromUrl: string | null;
  fromAt: string | null;
  fromLabel: string | null;
  toUrl: string;
  toAt: string;
  durationMs: number | null;
  durationSec: number | null;
  fulfillmentRefreshCount: number;
  fulfillmentRefreshFirstAt: string | null;
  fulfillmentRefreshLastAt: string | null;
  fulfillmentRefreshLastKind: "soft" | "full" | null;
} | null> {
  const toUrl = page.url();
  if (!isShop404Url(toUrl)) return null;
  const now = Date.now();
  const from = lastNon404NavMark;
  const durationMs = from ? Math.max(0, now - from.atMs) : null;
  const timing = {
    context,
    fromUrl: from?.url || null,
    fromAt: from?.atIso || null,
    fromLabel: from?.label || null,
    toUrl,
    toAt: new Date(now).toISOString(),
    durationMs,
    durationSec:
      durationMs == null ? null : Math.round(durationMs / 100) / 10,
    fulfillmentRefreshCount,
    fulfillmentRefreshFirstAt,
    fulfillmentRefreshLastAt,
    fulfillmentRefreshLastKind,
  };
  const durLabel =
    timing.durationMs == null ? "unknown" : `${timing.durationMs}ms (${timing.durationSec}s)`;
  console.warn(
    `  /shop/404 timing [${context}]: ${durLabel}｜Fulfillment refresh ×${timing.fulfillmentRefreshCount}｜from ${timing.fromUrl || "?"} → ${toUrl}`
  );
  await writeStatus({
    phase: "shop_404",
    url: toUrl,
    shop404Timing: timing,
    message: `shop/404 after ${durLabel}｜Fulfillment refresh ×${timing.fulfillmentRefreshCount} from ${timing.fromUrl || "?"}`,
  }).catch(() => {});
  await ensureRuntimeDir();
  await fs
    .appendFile(
      path.join(RUNTIME_DIR, "shop-404-timing.jsonl"),
      `${JSON.stringify({ sessionId: SESSION_ID, windowIndex: WINDOW_INDEX, ...timing })}\n`,
      "utf8"
    )
    .catch(() => {});
  return timing;
}

async function clickShoppingBagNavButton(page: Page): Promise<boolean> {
  const candidates = [
    page.locator("#globalnav-menubutton-link-bag"),
    page.locator("a.globalnav-link-bag, button.globalnav-link-bag"),
    page.locator('[data-autom="globalnav-bag"], [data-analytics-title="bag"]'),
    page.locator(
      'a[aria-label*="購物袋" i], button[aria-label*="購物袋" i], a[aria-label*="Shopping Bag" i], button[aria-label*="Bag" i]'
    ),
    page.getByRole("link", { name: /^(購物袋|Shopping Bag|Bag)$/i }),
    page.getByRole("button", { name: /^(購物袋|Shopping Bag|Bag)$/i }),
    page.locator(".globalnav-bag a, .globalnav-bag button, li.globalnav-item-bag a"),
  ];
  for (const loc of candidates) {
    const el = loc.first();
    if (!(await el.count().catch(() => 0))) continue;
    if (!(await visible(el, 1200))) continue;
    await humanClick(el, { force: true }).catch(async () => {
      await el.evaluate((n) => (n as HTMLElement).click()).catch(() => {});
    });
    return true;
  }
  // DOM 掃描：頂欄 bag icon
  const clicked = await page
    .evaluate(() => {
      const nodes = Array.from(
        document.querySelectorAll<HTMLElement>("a, button, summary")
      );
      for (const el of nodes) {
        const id = (el.id || "").toLowerCase();
        const cls = (el.className || "").toString().toLowerCase();
        const aria = (el.getAttribute("aria-label") || "").toLowerCase();
        const href = (el.getAttribute("href") || "").toLowerCase();
        const autom = (el.getAttribute("data-autom") || "").toLowerCase();
        if (
          id.includes("bag") ||
          cls.includes("globalnav-link-bag") ||
          cls.includes("globalnav-bag") ||
          autom.includes("bag") ||
          aria.includes("購物袋") ||
          aria.includes("shopping bag") ||
          (href.includes("/shop/bag") && cls.includes("globalnav"))
        ) {
          el.click();
          return true;
        }
      }
      return false;
    })
    .catch(() => false);
  return Boolean(clicked);
}

async function clickViewBagButton(page: Page): Promise<boolean> {
  const candidates = [
    page.getByRole("link", { name: /查看購物袋|檢視購物袋|前往購物袋|Review Bag|View Bag/i }),
    page.getByRole("button", { name: /查看購物袋|檢視購物袋|前往購物袋|Review Bag|View Bag/i }),
    page.locator(
      'a:has-text("查看購物袋"), button:has-text("查看購物袋"), a:has-text("檢視購物袋"), button:has-text("檢視購物袋")'
    ),
    page.locator(
      'a:has-text("Review Bag"), button:has-text("Review Bag"), a:has-text("View Bag"), button:has-text("View Bag")'
    ),
    page.locator('[data-autom*="bag" i]').filter({ hasText: /查看|檢視|Review|View/i }),
  ];
  for (const loc of candidates) {
    const el = loc.first();
    if (!(await el.count().catch(() => 0))) continue;
    if (!(await visible(el, 1500))) continue;
    await humanClick(el, { force: true }).catch(async () => {
      await el.evaluate((n) => (n as HTMLElement).click()).catch(() => {});
    });
    return true;
  }
  return false;
}

/**
 * 所有 task 停喺 /shop/404：
 * 撳頂欄「購物袋」→「查看購物袋」→ 再交俾後續結帳步驟。
 * （唔會喺呢度遞迴 call addToBag，避免搶購時爆 stack）
 */
const recovering404Pages = new WeakSet<Page>();

async function recoverFromShop404IfNeeded(
  page: Page,
  tag = ""
): Promise<boolean> {
  if (!isShop404Url(page.url())) return false;
  const prefix = tag ? `${tag} ` : "";
  if (recovering404Pages.has(page)) {
    console.warn(`${prefix}/shop/404 復原重入 → 直達 /shop/bag`);
    await page
      .goto("https://www.apple.com/hk-zh/shop/bag", { waitUntil: "domcontentloaded" })
      .catch(() => {});
    await settleDom(page, 200);
    return isBagPage(page.url()) || isCheckoutFlowPage(page.url());
  }
  recovering404Pages.add(page);
  try {
  const timing = await recordShop404Timing(page, tag || "recoverFromShop404").catch(
    () => null
  );
  const dur =
    timing?.durationMs == null
      ? ""
      : `（距上一頁 ${timing.durationMs}ms／${timing.durationSec}s｜Fulfillment refresh ×${timing.fulfillmentRefreshCount}｜${timing.fromUrl || "?"}）`;
  console.log(
    `${prefix}偵測到 /shop/404${dur} → 撳購物袋掣 →「查看購物袋」，再繼續流程`
  );
  await writeStatus({
    phase: "recover_404_to_bag",
    url: page.url(),
    shop404Timing: timing || undefined,
    message: timing
      ? `shop/404 after ${timing.durationMs}ms｜Fulfillment refresh ×${timing.fulfillmentRefreshCount} from ${timing.fromUrl || "?"} → bag`
      : "shop/404 → shopping bag → 查看購物袋",
  }).catch(() => {});

  const bagNavClicked = await clickShoppingBagNavButton(page);
  if (bagNavClicked) {
    console.log(`${prefix}已撳頂欄購物袋掣`);
    await settleDom(page, 350);
    const viewed = await clickViewBagButton(page);
    if (viewed) {
      console.log(`${prefix}已撳「查看購物袋」`);
      await settleDom(page, 400);
      await withReleaseCheck(
        page
          .waitForURL((u) => /\/shop\/bag|\/shop\/checkout|\/shop\/signIn/i.test(u.toString()), {
            timeout: 12_000,
          })
          .catch(() => {})
      );
    } else {
      console.warn(`${prefix}揾唔到「查看購物袋」，改直接開 /shop/bag`);
      await page
        .goto("https://www.apple.com/hk-zh/shop/bag", { waitUntil: "domcontentloaded" })
        .catch(() => {});
    }
  } else {
    console.warn(`${prefix}揾唔到頂欄購物袋掣，改直接開 /shop/bag`);
    await page
      .goto("https://www.apple.com/hk-zh/shop/bag", { waitUntil: "domcontentloaded" })
      .catch(() => {});
  }

  await settleDom(page, 250);
  const url = page.url();
  if (isCheckoutFlowPage(url) || /\/shop\/signIn/i.test(url)) {
    console.log(`${prefix}404 復原後已到結帳／登入：${url}`);
    return true;
  }
  if (isBagPage(url)) {
    if (await isBagEmpty(page)) {
      // 唔喺度遞迴加購；交返外層輪詢由 buy/goto 再試
      console.warn(`${prefix}404→購物袋係空，返回產品頁等外層輪詢重試…`);
      const resumeUrl = isIphone18Task() ? currentIphone18BuyUrl(page) : CONFIG.buyUrl;
      await page.goto(resumeUrl, { waitUntil: "domcontentloaded" }).catch(() => {});
      await selectProductOptions(page, { randomColor: false }).catch(() => {});
      return false;
    }
    console.log(`${prefix}已由 404 回到購物袋（有貨），繼續流程`);
    return true;
  }

  // 仍喺 404：最後再試一次直達 bag
  if (isShop404Url(page.url())) {
    await page
      .goto("https://www.apple.com/hk-zh/shop/bag", { waitUntil: "domcontentloaded" })
      .catch(() => {});
    await settleDom(page, 200);
  }
  return isBagPage(page.url()) || isCheckoutFlowPage(page.url());
  } finally {
    recovering404Pages.delete(page);
  }
}

/** 若被踢返產品設定頁／購物袋，重新加購（沿用 CONFIG 顏色，唔隨機） */
async function recoverAddToBagIfNeeded(page: Page, tag: string): Promise<boolean> {
  if (isShop404Url(page.url())) {
    return recoverFromShop404IfNeeded(page, tag);
  }
  const url = page.url();
  if (isProductConfigPage(url)) {
    console.log(`${tag} 偵測到退回產品頁，重新揀規格並加入購物袋…`);
    console.log(`${tag} URL：${url}`);
    const resumeUrl = isIphone18Task() ? currentIphone18BuyUrl(page) : CONFIG.buyUrl;
    await page.goto(resumeUrl, { waitUntil: "domcontentloaded" }).catch(() => {});
    await selectProductOptions(page, { randomColor: false });
    await addToBagAndOpenBag(page);
    await setBagQuantity(page, CONFIG.quantity).catch((err) => {
      console.warn(`${tag} 改數量失敗：${err instanceof Error ? err.message : String(err)}`);
    });
    return true;
  }
  if (isBagPage(url)) {
    console.log(`${tag} 而家喺購物袋，繼續結帳流程…`);
    return true;
  }
  return false;
}

function isStillOnIphone18ProConfig(url: string): boolean {
  return /\/shop\/buy-iphone\/iphone-18-pro/i.test(url) && !/\/shop\/bag|\/checkout|\/signIn/i.test(url);
}

function hasLeftBuyConfig(url: string, beforeUrl: string): boolean {
  if (/\/shop\/bag/i.test(url)) return true;
  if (/\/shop\/checkout|\/shop\/signIn/i.test(url)) return true;
  if (/[?&]step=attach\b/i.test(url)) return true;
  // 唔好單憑 product=／微變 URL 當加購成功（會誤入空購物袋）
  if (url !== beforeUrl) {
    if (!/\/shop\/buy-iphone\//i.test(url)) return true;
    if (/iphone-18-pro/i.test(beforeUrl) && !/iphone-18-pro\/\d+\.\d+/i.test(url)) return true;
    if (/iphone-17(?!-)/i.test(beforeUrl) && !/iphone-17\/\d+\.\d+/i.test(url) && !/[?&]product=/i.test(url)) {
      return true;
    }
  }
  return false;
}

/** 加購成功：已到 attach／購物袋（非空）／結帳 */
async function confirmAddedToBag(page: Page): Promise<boolean> {
  const url = page.url();
  if (isAttachStepUrl(url)) return true;
  // slug → ?product=…&step=attach 有時大小寫／編碼唔同
  if (/\/shop\/buy-iphone\//i.test(url) && /[?&]product=/i.test(url) && /step=attach/i.test(url)) {
    return true;
  }
  if (/\/shop\/checkout|\/shop\/signIn/i.test(url)) return true;
  if (/\/shop\/bag/i.test(url)) {
    const empty = await isBagEmpty(page);
    return !empty;
  }
  // attach UI
  if ((await page.locator('[data-autom="proceed"]').count().catch(() => 0)) > 0) return true;
  if (
    (await page
      .getByRole("button", { name: /查看購物袋|檢視購物袋|Review Bag/i })
      .count()
      .catch(() => 0)) > 0 &&
    /[?&]product=/i.test(url)
  ) {
    return true;
  }
  return false;
}

function formatHkTime(ms: number): string {
  return new Date(ms).toLocaleString("zh-HK", { timeZone: "Asia/Hong_Kong" });
}

async function waitUntilSalePollWindow(): Promise<void> {
  const saleStart = Date.parse(CONFIG.saleStartIso);
  if (Number.isNaN(saleStart)) return;
  const now = Date.now();
  const lead = Math.max(0, Number(CONFIG.salePollLeadMs) || 0);
  console.log(`  開賣時間：${formatHkTime(saleStart)} HKT（「繼續」預計呢個時間先可用）`);
  if (now < saleStart - lead) {
    const waitMs = saleStart - lead - now;
    console.log(
      `  距離搶購窗口仲有 ${Math.ceil(waitMs / 1000)} 秒（提前 ${Math.ceil(lead / 1000)} 秒開始 refresh）。會先停喺產品頁暖機。`
    );
    // 暖機：保持頁面，短間隔 sleep，唔狂 refresh 燒 IP
    const warmUntil = saleStart - lead;
    while (Date.now() < warmUntil) {
      await throwIfReleased();
      await sleepCheckingRelease(Math.min(5000, Math.max(500, warmUntil - Date.now())));
    }
  }
  if (Date.now() < saleStart) {
    console.log(
      `  已入搶購窗口（開賣前 ${Math.ceil((saleStart - Date.now()) / 1000)} 秒）。每 ${CONFIG.productPollIntervalMs / 1000} 秒 refresh 重試「繼續」。`
    );
  } else {
    console.log("  已過開賣時間，即刻每 5 秒 refresh 重試「繼續」。");
  }
}

function isAttachStepUrl(url: string): boolean {
  return /[?&]step=attach\b/i.test(url);
}

/** attach 步主 CTA：查看購物袋（phone 已入流程，唔係配件 upsell） */
async function clickReviewBagOnAttach(page: Page): Promise<boolean> {
  const beforeUrl = page.url();
  const candidates = [
    page.locator('[data-autom="proceed"]').first(),
    page.getByRole("button", { name: /查看購物袋|檢視購物袋|前往購物袋|Review Bag|View Bag/i }).first(),
    page.getByRole("link", { name: /查看購物袋|檢視購物袋|前往購物袋|Review Bag|View Bag/i }).first(),
  ];
  for (const el of candidates) {
    if (!(await el.count().catch(() => 0))) continue;
    if (!(await visible(el, 800))) continue;
    const label =
      ((await el.innerText().catch(() => "")) ||
        (await el.getAttribute("aria-label").catch(() => "")) ||
        "查看購物袋") + "";
    await humanClick(el, { force: true }).catch(async () => {
      await el.evaluate((n) => (n as HTMLElement).click()).catch(() => {});
    });
    console.log(`  已撳 attach「查看購物袋」：${label.trim().slice(0, 40)}`);
    await withReleaseCheck(
      page
        .waitForURL((u) => /\/shop\/bag|\/shop\/checkout|\/shop\/signIn/i.test(u.toString()), {
          timeout: 8000,
        })
        .catch(() => {})
    );
    if (/\/shop\/bag|\/shop\/checkout|\/shop\/signIn/i.test(page.url()) || page.url() !== beforeUrl) {
      console.log(`  已離開 attach → ${page.url()}`);
      return true;
    }
  }
  return false;
}

async function tryClickContinueOrAddToBag(page: Page): Promise<boolean> {
  const beforeUrl = page.url();

  // product=…&step=attach：主掣係「查看購物袋」，唔係「繼續」
  if (isAttachStepUrl(beforeUrl) || isAttachStepUrl(CONFIG.buyUrl)) {
    return clickReviewBagOnAttach(page);
  }

  // 只喺產品設定頁撳「繼續／加入購物袋」；配件頁唔好撳，以免誤加 MagSafe
  if (isAccessoryUpsellContext(page.url())) {
    return false;
  }

  // 已配置產品 slug（iPhone 17 薰衣草等）：只撳一次「加入購物袋」，避免重複加購
  if (
    isConfiguredProductSlugUrl(beforeUrl) ||
    isConfiguredProductSlugUrl(CONFIG.buyUrl) ||
    /iPhone\s*17(?!\s*Pro)/i.test(CONFIG.model)
  ) {
    return addConfiguredSlugToBagOnce(page);
  }

  if (isIphone18Task()) {
    return addIphone18WithGotoFallback(page);
  }

  await ensureTradeInAndAppleCareForAddToBag(page);

  const candidates = [
    page.getByRole("button", { name: /加入購物袋|加入購物車|Add to Bag/i }).first(),
    page.locator('[data-autom="add-to-cart"], button[name="add-to-cart"]').first(),
    page.locator('[data-autom="continueButton"]').first(),
    page.getByRole("button", { name: /^繼續$/ }).first(),
    page.getByRole("button", { name: /^Continue$/i }).first(),
    page.locator('[data-autom="proceed"]').first(),
    page.getByRole("button", { name: /查看購物袋|檢視購物袋|Review Bag/i }).first(),
  ];

  for (const el of candidates) {
    if (!(await el.count().catch(() => 0))) continue;
    if (!(await visible(el, 600))) continue;
    // 掣附近若似配件加購，跳過
    const label =
      ((await el.innerText().catch(() => "")) ||
        (await el.getAttribute("aria-label").catch(() => "")) ||
        "") + "";
    if (/MagSafe|矽膠|護殼|保護殼|掛繩|查看可用狀況/i.test(label)) continue;

    const enabled = await el.isEnabled().catch(() => false);
    if (!enabled) {
      // disabled 時再強制解鎖一次後重試
      await ensureTradeInAndAppleCareForAddToBag(page);
      const nowEnabled = await el.isEnabled().catch(() => false);
      if (!nowEnabled) {
        console.warn(`  「${label.trim().slice(0, 30) || "button"}」仍然 disabled，跳過`);
        continue;
      }
    }

    await el.scrollIntoViewIfNeeded().catch(() => {});
    await humanClick(el, { force: true }).catch(async () => {
      await el.evaluate((n) => (n as HTMLElement).click()).catch(() => {});
    });
    console.log(`  已嘗試撳：${(label || "button").trim().slice(0, 40)}`);

    await withReleaseCheck(
      page
        .waitForURL((url) => hasLeftBuyConfig(url.toString(), beforeUrl), { timeout: 8000 })
        .catch(() => {})
    );
    if (hasLeftBuyConfig(page.url(), beforeUrl)) {
      console.log(`  已離開產品設定頁 → ${page.url()}`);
      return true;
    }
    // 有時 SPA 未改 URL，但已出現 attach「查看購物袋」
    if (await clickReviewBagOnAttach(page)) return true;

    // 已撳過「加入購物袋」就唔好再試其他 candidate，避免重複加袋
    if (/加入購物袋|加入購物車|Add to Bag/i.test(label)) {
      console.log("  已撳過「加入購物袋」，等待跳頁（唔再撳第二次）…");
      for (let w = 0; w < 6; w++) {
        await sleepCheckingRelease(1000);
        if (hasLeftBuyConfig(page.url(), beforeUrl)) return true;
        if (await clickReviewBagOnAttach(page)) return true;
      }
      return false;
    }
  }
  return false;
}

/**
 * iPhone 18：不停撳「繼續／加入購物袋」直到成功去到下一頁（attach／bag／checkout）。
 * disabled 時會短等再試；唔因一次失敗就停。（同 iPhone 17 Review CTA 一樣強制 click）
 */
async function keepClickingContinueUntilNextPage(
  page: Page,
  opts?: { maxMs?: number }
): Promise<boolean> {
  const beforeUrl = page.url();
  const maxMs = opts?.maxMs ?? 60_000;
  const deadline = Date.now() + maxMs;
  let attempts = 0;

  console.log("步驟：iPhone 18 — 持續重試「繼續／加入購物袋」直到下一頁");

  while (Date.now() < deadline) {
    await throwIfReleased();
    if (hasLeftBuyConfig(page.url(), beforeUrl)) {
      console.log(`  ✓ 已離開產品設定頁 → ${page.url()}（共試 ${attempts} 次）`);
      return true;
    }
    if (isAttachStepUrl(page.url()) && (await clickReviewBagOnAttach(page))) {
      return true;
    }

    attempts += 1;

    // DOM 強制掃描（含 disabled）
    const domOk = await page
      .evaluate(() => {
        const bad = /MagSafe|矽膠|護殼|保護殼|掛繩|查看可用狀況/i;
        const nodes = Array.from(
          document.querySelectorAll(
            'button, a[role="button"], [data-autom="continueButton"], [data-autom="add-to-cart"], [data-autom="proceed"]'
          )
        ) as HTMLElement[];
        let best: HTMLElement | null = null;
        let bestScore = 0;
        for (const el of nodes) {
          const raw =
            (el.innerText || el.textContent || "") +
            " " +
            (el.getAttribute("aria-label") || "") +
            " " +
            (el.getAttribute("data-autom") || "");
          if (bad.test(raw)) continue;
          const t = raw.replace(/\s+/g, "");
          let score = 0;
          if (/加入購物袋|加入購物車|AddtoBag/i.test(t)) score += 80;
          if (/^繼續$|^Continue$/i.test((el.innerText || "").trim())) score += 70;
          if ((el.getAttribute("data-autom") || "").includes("continue")) score += 50;
          if ((el.getAttribute("data-autom") || "").includes("add-to-cart")) score += 60;
          if (score <= 0) continue;
          const rect = el.getBoundingClientRect();
          if (rect.width < 30 || rect.height < 12) continue;
          if (score > bestScore) {
            best = el;
            bestScore = score;
          }
        }
        if (!best) return false;
        best.scrollIntoView({ block: "center" });
        try {
          best.click();
        } catch {
          best.dispatchEvent(
            new MouseEvent("click", { bubbles: true, cancelable: true, view: window })
          );
        }
        return true;
      })
      .catch(() => false);

    const candidates = [
      page.locator('[data-autom="continueButton"]').first(),
      page.getByRole("button", { name: /^繼續$/ }).first(),
      page.getByRole("button", { name: /^Continue$/i }).first(),
      page.locator('button:has-text("繼續"):not(:has-text("繼續前往"))').first(),
      page.getByRole("button", { name: /加入購物袋|加入購物車|Add to Bag/i }).first(),
      page.locator('[data-autom="add-to-cart"], button[name="add-to-cart"]').first(),
      page.locator('[data-autom="proceed"]').first(),
    ];

    let clicked = domOk;
    if (!clicked) {
      for (const el of candidates) {
        if (!(await el.count().catch(() => 0))) continue;
        if (!(await el.isVisible().catch(() => false))) continue;
        const label =
          ((await el.innerText().catch(() => "")) ||
            (await el.getAttribute("aria-label").catch(() => "")) ||
            "繼續") + "";
        if (/MagSafe|矽膠|護殼|保護殼|掛繩|查看可用狀況/i.test(label)) continue;

        const disabled = await el
          .evaluate((n) => {
            const b = n as HTMLButtonElement;
            return b.disabled || b.getAttribute("aria-disabled") === "true";
          })
          .catch(() => true);
        if (disabled) {
          if (attempts === 1 || attempts % 10 === 0) {
            console.log(`  「繼續」仍 disabled，等待解鎖… (#${attempts})`);
          }
          if (attempts % 8 === 0) {
            await ensureTradeInAndAppleCareForAddToBag(page).catch(() => {});
          }
          break;
        }

        await el.scrollIntoViewIfNeeded().catch(() => {});
        const box = await el.boundingBox().catch(() => null);
        let ok = false;
        if (box) {
          ok = await page.mouse
            .click(box.x + box.width / 2, box.y + box.height / 2)
            .then(() => true)
            .catch(() => false);
        }
        if (!ok) {
          ok = await el
            .click({ force: true, timeout: 800 })
            .then(() => true)
            .catch(async () =>
              el
                .evaluate((n) => (n as HTMLElement).click())
                .then(() => true)
                .catch(() => false)
            );
        }
        if (ok) {
          clicked = true;
          if (attempts === 1 || attempts % 5 === 0) {
            console.log(`  已撳「${label.trim().slice(0, 24) || "繼續"}」(#${attempts})`);
          }
          break;
        }
      }
    } else if (attempts === 1 || attempts % 5 === 0) {
      console.log(`  已撳繼續／加購（DOM #${attempts}）`);
    }

    if (clicked) {
      await withReleaseCheck(
        page
          .waitForURL((url) => hasLeftBuyConfig(url.toString(), beforeUrl), {
            timeout: 2500,
          })
          .catch(() => {})
      );
      if (hasLeftBuyConfig(page.url(), beforeUrl)) {
        console.log(`  ✓ 已離開產品設定頁 → ${page.url()}`);
        return true;
      }
      if (await clickReviewBagOnAttach(page)) return true;
    }

    await ensureTradeInAndAppleCareForAddToBag(page).catch(() => {});
    await sleepCheckingRelease(clicked ? 350 : 500);
  }

  console.warn(`  iPhone 18 加購超時，仍喺：${page.url()}`);
  return hasLeftBuyConfig(page.url(), beforeUrl);
}

/** iPhone 17／已配置 slug：平滑揀選後只撳一次「加入購物袋」 */
async function addConfiguredSlugToBagOnce(page: Page): Promise<boolean> {
  const beforeUrl = page.url();
  console.log("步驟：產品頁平滑加購 — 揀選完成後只撳一次「加入購物袋」");

  if (isIphone17Task()) {
    await selectIphone17OptionsSmooth(page);
  } else {
    await ensureTradeInAndAppleCareForAddToBag(page);
  }

  const addBtn = page
    .locator('[data-autom="add-to-cart"], button[name="add-to-cart"]')
    .or(page.getByRole("button", { name: /加入購物袋|加入購物車|Add to Bag/i }))
    .first();

  for (let wait = 1; wait <= 12; wait++) {
    await throwIfReleased();
    const count = await addBtn.count().catch(() => 0);
    const enabled =
      count > 0 &&
      !(await addBtn
        .evaluate((n) => {
          const b = n as HTMLButtonElement;
          return b.disabled || b.getAttribute("aria-disabled") === "true";
        })
        .catch(() => true));
    if (enabled) break;
    console.log(`  ⑤ 等待「加入購物袋」可撳… (${wait}/12)`);
    if (wait === 3 || wait === 6 || wait === 9) {
      await clickAutomOrRadio(
        page,
        "換購",
        "不換購",
        ['[data-autom="choose-noTradeIn"]', 'input#noTradeIn', 'input[value="noTradeIn"]'],
        [/^不換購$/, /不換購/]
      ).catch(() => {});
      await sleepCheckingRelease(200);
      await clickAutomOrRadio(
        page,
        "AppleCare",
        "無 AppleCare+ 服務計劃保障",
        ['[data-autom="noapplecare"]'],
        [/無\s*AppleCare/, /無 AppleCare/]
      ).catch(() => {});
    }
    await sleepCheckingRelease(220);
  }

  if (!(await addBtn.count().catch(() => 0))) {
    console.warn("  揾唔到「加入購物袋」掣");
    return false;
  }

  const stillDisabled = await addBtn
    .evaluate((n) => (n as HTMLButtonElement).disabled)
    .catch(() => true);
  if (stillDisabled) {
    console.warn("  「加入購物袋」仍然 disabled — 唔 force 空撳，當失敗重試");
    return false;
  }

  console.log("  ⑤ 撳加入購物袋…");
  await addBtn.scrollIntoViewIfNeeded().catch(() => {});
  await sleepCheckingRelease(CONFIG.clickDelayMs);

  // 重要：唔好用 form.requestSubmit（會觸發 GET # 原生提交，Apple JS 加購唔會跑）
  // 要用真正 button click，等去到 ?product=…&step=attach
  let clickedHow = "";
  const navPromise = page
    .waitForURL(
      (u) => {
        const s = u.toString();
        return (
          /[?&]step=attach\b/i.test(s) ||
          /\/shop\/bag/i.test(s) ||
          /\/shop\/checkout|\/shop\/signIn/i.test(s) ||
          (/[?&]product=/i.test(s) && s !== beforeUrl)
        );
      },
      { timeout: 15000 }
    )
    .then(() => true)
    .catch(() => false);

  const humanOk = await humanClick(addBtn, { force: true })
    .then(() => true)
    .catch(() => false);
  if (humanOk) clickedHow = "playwright";
  else {
    const domOk = await addBtn
      .evaluate((n) => {
        (n as HTMLButtonElement).click();
        return true;
      })
      .catch(() => false);
    if (domOk) clickedHow = "dom-click";
  }

  console.log(clickedHow ? `  已撳「加入購物袋」（${clickedHow}）` : "  加入購物袋撳擊可能失敗");
  if (!clickedHow) {
    await navPromise;
    return false;
  }

  const navigated = await navPromise;
  if (navigated) {
    console.log(`  已跳頁 → ${page.url()}`);
  } else {
    console.warn(`  15 秒內未偵測到 attach／購物袋 URL（而家 ${page.url()}），繼續輪詢 UI…`);
  }
  await settleDom(page, 200);

  for (let w = 0; w < 12; w++) {
    await throwIfReleased();

    if (isShop404Url(page.url())) {
      console.warn("  加購後落到 /shop/404 → 購物袋復原…");
      const ok = await recoverFromShop404IfNeeded(page);
      if (ok && (await confirmAddedToBag(page))) {
        console.log(`  已加購成功（經 404 復原）→ ${page.url()}`);
        return true;
      }
    }

    if (
      isAttachStepUrl(page.url()) ||
      (await page.locator('[data-autom="proceed"]').count().catch(() => 0)) > 0
    ) {
      console.log(`  已到 attach 加購步 → ${page.url()}`);
      const ok = await clickReviewBagOnAttach(page);
      if (ok || /\/shop\/bag/i.test(page.url())) {
        console.log(`  已加購成功 → ${page.url()}`);
        return true;
      }
      // attach 已代表電話入咗流程
      if (isAttachStepUrl(page.url())) {
        console.log("  attach 已確認（查看購物袋稍後再試）");
        return true;
      }
    }

    if (await confirmAddedToBag(page)) {
      if (/\/shop\/bag/i.test(page.url()) && (await isBagEmpty(page))) {
        console.warn("  到咗購物袋但係空，繼續等…");
      } else {
        console.log(`  已加購成功 → ${page.url()}`);
        return true;
      }
    }

    const review = page
      .getByRole("button", { name: /查看購物袋|檢視購物袋|前往購物袋|Review Bag|View Bag/i })
      .or(page.getByRole("link", { name: /查看購物袋|檢視購物袋|Review Bag/i }))
      .or(page.locator('[data-autom="proceed"]'))
      .first();
    if (await visible(review, 400)) {
      await humanClick(review, { force: true }).catch(() => {});
      await settleDom(page, 300);
      if (await confirmAddedToBag(page)) {
        console.log(`  已加購成功（經查看購物袋）→ ${page.url()}`);
        return true;
      }
    }
    await sleepCheckingRelease(600);
  }

  console.warn("  撳咗加入購物袋但仍未確認入袋");
  return false;
}

function isAccessoryUpsellContext(url: string, bodyText = ""): boolean {
  // buy-iphone?step=attach 係加購／查看購物袋步驟，唔當純配件 trap
  if (isAttachStepUrl(url) && /\/shop\/buy-iphone\//i.test(url)) {
    return false;
  }
  if (/\/shop\/accessories|\/swb|product-selection|\/addon\b/i.test(url)) {
    return true;
  }
  return /MagSafe\s*矽膠|矽膠護殼|矽膠保護殼|為你的 iPhone 選購配件|推薦配件|Add a case|選擇護殼/i.test(
    bodyText
  );
}

async function skipAccessoryUpsells(page: Page): Promise<void> {
  console.log("步驟：跳過 MagSafe／配件加購（避免誤加入購物袋）");
  for (let attempt = 1; attempt <= 6; attempt++) {
    await settleAfterNavigation(page);
    const url = page.url();
    const bodyText = (await page.locator("body").innerText().catch(() => "")) || "";

    if (/\/shop\/bag|\/shop\/checkout|\/shop\/signIn/i.test(url)) {
      console.log("  已喺購物袋／結帳，配件跳過完成");
      return;
    }

    const looksLikeAccessory =
      isAccessoryUpsellContext(url, bodyText) ||
      /MagSafe|矽膠護殼|矽膠保護殼|護殼|保護殼/i.test(bodyText);

    if (!looksLikeAccessory) {
      // 中間頁：優先去購物袋，唔好亂撳「繼續」
      if (/\/shop\/buy-iphone|\/shop\/product/i.test(url)) return;
    }

    const skipped = await clickIfEnabled(
      [
        page.getByRole("button", { name: /暫不需要|暫時不需要|不需要了|暫不要|暫時不要/ }),
        page.getByRole("button", { name: /暫不加購|不加購|不要加購|無需加購/ }),
        page.getByRole("button", { name: /跳過|Skip for now|No thanks|No, thanks|Not now/i }),
        page.getByRole("link", { name: /暫不需要|暫不加購|跳過|No thanks/i }),
        page.locator(
          '[data-autom*="skip" i], [data-autom*="noThanks" i], [data-autom*="decline" i], [data-autom*="no-thanks" i]'
        ),
        page.getByRole("button", { name: /檢視購物袋|前往購物袋|查看購物袋|Review Bag|View Bag/i }),
        page.getByRole("link", { name: /檢視購物袋|前往購物袋|查看購物袋|Review Bag|View Bag/i }),
      ],
      2500
    );

    if (skipped) {
      console.log(`  已跳過配件頁（第 ${attempt} 次）`);
      await settleAfterNavigation(page);
      continue;
    }

    if (looksLikeAccessory || /MagSafe|矽膠|護殼|保護殼/i.test(bodyText)) {
      console.warn("  偵測配件／MagSafe 頁 → 強制只去購物袋（唔加配件）");
      await page.goto("https://www.apple.com/hk-zh/shop/bag", {
        waitUntil: "domcontentloaded",
      });
      await removeAccessoryItemsFromBag(page).catch(() => {});
      return;
    }
    return;
  }
}

async function removeAccessoryItemsFromBag(page: Page): Promise<void> {
  if (!/\/shop\/bag/i.test(page.url())) return;
  console.log("步驟：檢查購物袋有冇誤加 MagSafe／矽膠配件");

  for (let round = 1; round <= 6; round++) {
    const bodyText = (await page.locator("body").innerText().catch(() => "")) || "";
    if (!/MagSafe|矽膠護殼|矽膠保護殼|矽膠/i.test(bodyText)) {
      if (round === 1) console.log("  購物袋冇偵測到 MagSafe／矽膠配件");
      return;
    }

    // 搵含 MagSafe／矽膠嘅行，撳同一區「移除」
    const rows = page.locator("div, li, article, tr").filter({
      hasText: /MagSafe|矽膠護殼|矽膠保護殼/,
    });
    const rowCount = await rows.count().catch(() => 0);
    let removed = false;
    for (let i = 0; i < Math.min(rowCount, 12); i++) {
      const row = rows.nth(i);
      const rowText = ((await row.innerText().catch(() => "")) || "").trim();
      if (!/MagSafe|矽膠/i.test(rowText)) continue;
      // 避免整頁大容器
      if (rowText.length > 500) continue;
      const removeBtn = row
        .getByRole("button", { name: /移除|刪除|Remove/i })
        .or(row.getByRole("link", { name: /移除|刪除|Remove/i }))
        .or(row.locator('[data-autom*="remove" i], [data-autom*="delete" i]'))
        .first();
      if (!(await removeBtn.count().catch(() => 0))) continue;
      await removeBtn.scrollIntoViewIfNeeded().catch(() => {});
      await humanClick(removeBtn, { force: true }).catch(async () => {
        await removeBtn.evaluate((n) => (n as HTMLElement).click()).catch(() => {});
      });
      console.log(`  已移除誤加配件：${rowText.replace(/\s+/g, " ").slice(0, 60)}`);
      removed = true;
      await page.waitForTimeout(1200);
      break;
    }

    if (!removed) {
      // 後備：頁面任何「移除」若 aria 提到護殼
      const anyRemove = page.getByRole("button", { name: /移除.*護殼|移除.*MagSafe|Remove.*[Cc]ase/i });
      if (await anyRemove.count().catch(() => 0)) {
        await humanClick(anyRemove.first(), { force: true }).catch(() => {});
        console.log("  已用後備方式移除配件");
        await page.waitForTimeout(1200);
        continue;
      }
      console.warn("  偵測到 MagSafe／矽膠字樣但揾唔到移除掣，請人手檢查購物袋");
      return;
    }
  }
}

async function reloadBuyPageAndSelect(page: Page): Promise<void> {
  const targetUrl = isIphone18Task() ? currentIphone18BuyUrl(page) : CONFIG.buyUrl;
  await withReleaseCheck(
    page.goto(targetUrl, { waitUntil: "domcontentloaded" }).catch(async () => {
      await withReleaseCheck(page.reload({ waitUntil: "domcontentloaded" }).catch(() => {}));
    })
  );
  await withReleaseCheck(page.waitForLoadState("domcontentloaded").catch(() => {}));
  await dismissCookies(page).catch(() => {});
  // attach 網址已帶 product part，唔使再揀顏色／容量
  if (isAttachStepUrl(CONFIG.buyUrl) || isAttachStepUrl(page.url())) {
    console.log("  attach 頁 — 跳過重新揀規格");
    return;
  }
  // iPhone 18 設定 slug 出錯 → 改 goto
  if (isIphone18Task() && (await isIphone18BuyPageError(page))) {
    console.warn("  reload 後仍係錯誤頁 → 轉 iPhone 18 goto");
    iphone18GotoPages.add(page);
    const gotoUrl = iphone18GotoBuyUrl();
    await withReleaseCheck(
      page.goto(gotoUrl, { waitUntil: "domcontentloaded" }).catch(() => {})
    );
    await dismissCookies(page).catch(() => {});
  }
  await selectProductOptions(page).catch((err) => {
    console.warn(
      `  重新揀規格失敗：${err instanceof Error ? err.message : String(err)}`
    );
  });
}

async function addToBagAndOpenBag(page: Page): Promise<void> {
  // attach 冷開會「查看購物袋」但空袋：若 buyUrl 係 attach，改走完整加購；
  // 若已喺 attach 而且袋有貨，就直接查看購物袋。
  if (isAttachStepUrl(CONFIG.buyUrl) || isAttachStepUrl(page.url())) {
    console.log("步驟：處理 attach／查看購物袋");
    console.log(`  目標頁：${CONFIG.buyUrl}`);
    await writeStatus({
      phase: "adding_cart",
      message: "adding cart",
      pollRound: 0,
      buyUrl: CONFIG.buyUrl,
      saleStartIso: CONFIG.saleStartIso,
      attachDirect: true,
    });
    await withReleaseCheck(page.goto(CONFIG.buyUrl, { waitUntil: "domcontentloaded" }));
    await dismissCookies(page).catch(() => {});
    await settleAfterNavigation(page);

    let ok = await clickReviewBagOnAttach(page);
    if (!ok) {
      for (let i = 1; i <= 3 && !ok; i++) {
        console.log(`  重試查看購物袋 #${i}…`);
        await page.waitForTimeout(800);
        ok = await clickReviewBagOnAttach(page);
      }
    }
    await settleAfterNavigation(page);

    // 空袋 → 必須用設定頁真正加入
    const bagEmpty = await isBagEmpty(page);
    if (bagEmpty || !/\/shop\/bag/i.test(page.url())) {
      console.warn("  attach 後購物袋係空／未入袋 → 改用設定頁加入購物袋");
      const configUrl = buyConfigUrlFromAttach(CONFIG.buyUrl);
      await withReleaseCheck(page.goto(configUrl, { waitUntil: "domcontentloaded" }));
      await dismissCookies(page).catch(() => {});
      await selectProductOptions(page).catch(() => {});
      // 輪詢直到加入成功
      for (let round = 1; round <= 12; round++) {
        await throwIfReleased();
        const added = await tryClickContinueOrAddToBag(page);
        if (added) break;
        console.log(`  加購重試 #${round}…`);
        await sleepCheckingRelease(CONFIG.productPollIntervalMs);
        await reloadBuyPageAndSelect(page);
      }
      await settleAfterNavigation(page);
      if (isAttachStepUrl(page.url()) || (await page.locator('[data-autom="proceed"]').count())) {
        await clickReviewBagOnAttach(page);
      }
      if (!/\/shop\/bag/i.test(page.url())) {
        await page.goto("https://www.apple.com/hk-zh/shop/bag", {
          waitUntil: "domcontentloaded",
        });
      }
    }

    await settleAfterNavigation(page);
    await skipAccessoryUpsells(page);
    await removeAccessoryItemsFromBag(page).catch((err) => {
      console.warn(
        `  清理配件失敗：${err instanceof Error ? err.message : String(err)}`
      );
    });
    return;
  }

  console.log("步驟：等待開賣並撳「繼續／加入購物袋」加入流程");
  console.log(
    `  目標頁：${CONFIG.buyUrl}\n  開賣：${CONFIG.saleStartIso}（每 ${CONFIG.productPollIntervalMs / 1000} 秒 refresh 直到下一頁）`
  );

  await waitUntilSalePollWindow();

  // 已配置 slug／iPhone 17／18：先試加購
  if (
    isIphone17Task() ||
    isIphone18Task() ||
    isConfiguredProductSlugUrl(page.url()) ||
    isConfiguredProductSlugUrl(CONFIG.buyUrl)
  ) {
    const firstTry = isIphone17Task()
      ? await addConfiguredSlugToBagOnce(page)
      : isIphone18Task()
        ? await addIphone18WithGotoFallback(page)
        : (await ensureTradeInAndAppleCareForAddToBag(page),
          await tryClickContinueOrAddToBag(page));
    if (firstTry) {
      await settleDom(page, 200);
      await skipAccessoryUpsells(page);
      if (isAttachStepUrl(page.url())) {
        await clickReviewBagOnAttach(page);
      }
      if (!/\/shop\/bag/i.test(page.url())) {
        const toBag = await clickByAccessibleName(page, [
          /查看購物袋|檢視購物袋|前往購物袋|Review Bag|View Bag/i,
        ]);
        if (!toBag) {
          await page
            .goto("https://www.apple.com/hk-zh/shop/bag", {
              waitUntil: "domcontentloaded",
            })
            .catch(() => {});
        }
      }
      await settleDom(page, 300);
      await removeAccessoryItemsFromBag(page).catch(() => {});

      // 關鍵：空袋唔好當成功（b28 問題）
      if (/\/shop\/bag/i.test(page.url()) && (await isBagEmpty(page))) {
        console.warn("  購物袋係空 — 加購未成功，將重試");
      } else if (await confirmAddedToBag(page)) {
        console.log("  ✓ 已確認購物袋有貨／已入加購流程");
        return;
      } else {
        console.warn("  未能確認加購成功，將進入輪詢重試");
      }
    }
  }

  let round = 0;
  const saleStartMs = Date.parse(CONFIG.saleStartIso);
  const saleGraceEnd =
    (Number.isFinite(saleStartMs) ? saleStartMs : Date.now()) + 45 * 60 * 1000;
  while (true) {
    await throwIfReleased();
    round += 1;
    // 開賣前後 45 分鐘內大幅放寬，避免 round>40 提早放棄（12/9 8pm 波次問題）
    const maxRounds = Date.now() <= saleGraceEnd ? 900 : 80;
    if (round > maxRounds) {
      throw new StepError(
        "加入購物袋",
        "多次重試仍未能將 iPhone 加入購物袋。請人手加入後再繼續。"
      );
    }
    const saleStart = Date.parse(CONFIG.saleStartIso);
    const now = Date.now();
    const toSale = saleStart - now;
    if (toSale > 0) {
      console.log(
        `  輪詢 #${round}｜距離開賣仲有 ${Math.ceil(toSale / 1000)} 秒｜${formatHkTime(now)}`
      );
    } else {
      console.log(`  輪詢 #${round}｜已過開賣時間｜${formatHkTime(now)}｜重試「繼續／加入購物袋」`);
    }
    await writeStatus({
      phase: "adding_cart",
      message: "adding cart",
      pollRound: round,
      buyUrl: CONFIG.buyUrl,
      saleStartIso: CONFIG.saleStartIso,
    });

    // 每輪先處理 /shop/404（開賣高峰常見）
    if (isShop404Url(page.url())) {
      console.warn("  輪詢撞到 /shop/404 → 復原…");
      const recovered = await recoverFromShop404IfNeeded(page);
      if (recovered && (await confirmAddedToBag(page))) {
        console.log("  ✓ 404 復原後已有購物袋貨");
        await settleDom(page, 200);
        await skipAccessoryUpsells(page);
        await removeAccessoryItemsFromBag(page).catch(() => {});
        return;
      }
    }

    console.log(`  refresh 產品頁…`);
    // iPhone 18：只有已切 goto／而家頁真係錯誤，先走 goto 輪詢（唔好淨因為 CONFIG 係 slug 就強制 goto）
    if (isIphone18Task()) {
      if (
        iphone18GotoPages.has(page) ||
        /\/goto\/buy_iphone\/iphone_18/i.test(page.url()) ||
        (await isIphone18BuyPageError(page))
      ) {
        const gotoOk = await addIphone18WithGotoFallback(page);
        if (gotoOk) {
          await settleDom(page, 200);
          if (isAttachStepUrl(page.url())) await clickReviewBagOnAttach(page);
          if (!/\/shop\/bag/i.test(page.url())) {
            await page
              .goto("https://www.apple.com/hk-zh/shop/bag", {
                waitUntil: "domcontentloaded",
              })
              .catch(() => {});
          }
          await settleDom(page, 300);
          if (/\/shop\/bag/i.test(page.url()) && (await isBagEmpty(page))) {
            console.warn(`  輪詢 #${round}：購物袋仍空，繼續重試…`);
          } else if (await confirmAddedToBag(page)) {
            break;
          } else {
            console.warn(`  輪詢 #${round}：未確認入袋，繼續重試…`);
          }
          await sleepCheckingRelease(800);
          continue;
        }
      }
    }

    await reloadBuyPageAndSelect(page);

    const ok = isIphone17Task()
      ? await addConfiguredSlugToBagOnce(page)
      : isIphone18Task()
        ? await addIphone18WithGotoFallback(page)
        : (await ensureTradeInAndAppleCareForAddToBag(page), await tryClickContinueOrAddToBag(page));
    if (ok) {
      await settleDom(page, 200);
      if (isAttachStepUrl(page.url())) await clickReviewBagOnAttach(page);
      if (!/\/shop\/bag/i.test(page.url())) {
        await page
          .goto("https://www.apple.com/hk-zh/shop/bag", { waitUntil: "domcontentloaded" })
          .catch(() => {});
      }
      await settleDom(page, 300);
      if (/\/shop\/bag/i.test(page.url()) && (await isBagEmpty(page))) {
        console.warn(`  輪詢 #${round}：購物袋仍空，繼續重試…`);
      } else if (await confirmAddedToBag(page)) {
        break;
      } else {
        console.warn(`  輪詢 #${round}：未確認入袋，繼續重試…`);
      }
    } else {
      console.log(
        isIphone18Task()
          ? `  「繼續」仍未入到下一頁，短休後 refresh 再狂撳…`
          : `  「繼續／加入購物袋」未入到下一頁，${CONFIG.productPollIntervalMs / 1000} 秒後再 refresh…`
      );
    }
    await sleepCheckingRelease(isIphone18Task() ? 800 : CONFIG.productPollIntervalMs);
  }

  await settleDom(page, 200);
  await skipAccessoryUpsells(page);

  if (!/\/shop\/bag/i.test(page.url())) {
    const toBag = await clickByAccessibleName(page, [
      /檢視購物袋/,
      /前往購物袋/,
      /查看購物袋/,
      /Review Bag/i,
      /View Bag/i,
    ]);
    if (!toBag) {
      await page.goto("https://www.apple.com/hk-zh/shop/bag", {
        waitUntil: "domcontentloaded",
      });
    }
  }

  await removeAccessoryItemsFromBag(page).catch((err) => {
    console.warn(
      `  清理配件失敗：${err instanceof Error ? err.message : String(err)}`
    );
  });

  if (/\/shop\/bag/i.test(page.url()) && (await isBagEmpty(page))) {
    throw new StepError("加入購物袋", "購物袋仍然係空，未能加入 iPhone。");
  }
  console.log("  ✓ 加購完成，購物袋有貨");
  // 畀 Dashboard 即時更新（有 session 先寫）
  for (const s of ACTIVE_SESSIONS) {
    if (s.page === page) {
      await publishTaskSnapshot(s, "cart_added", {
        message: "已加入購物袋",
        url: page.url(),
      }).catch(() => {});
      break;
    }
  }
}

function buyConfigUrlFromAttach(url: string): string {
  try {
    const u = new URL(url);
    u.searchParams.delete("step");
    return u.toString();
  } catch {
    return url.replace(/([?&])step=attach\b&?/i, "$1").replace(/[?&]$/, "");
  }
}

async function isBagEmpty(page: Page): Promise<boolean> {
  if (!/\/shop\/bag/i.test(page.url())) return true;
  const text = ((await page.locator("body").innerText().catch(() => "")) || "").replace(
    /\s+/g,
    " "
  );
  return /購物袋沒有任何項目|購物袋是空|Bag is empty|Your bag is empty|沒有任何項目/i.test(
    text
  );
}

async function setBagQuantity(page: Page, quantity: number): Promise<void> {
  console.log(`步驟：購物袋數量改做 ${quantity}`);

  if (isShop404Url(page.url())) {
    await recoverFromShop404IfNeeded(page);
  }
  if (!/\/shop\/bag/i.test(page.url())) {
    await page.goto("https://www.apple.com/hk-zh/shop/bag", {
      waitUntil: "domcontentloaded",
    });
  }
  await page.waitForLoadState("domcontentloaded").catch(() => {});
  await page.waitForTimeout(800);
  await removeAccessoryItemsFromBag(page).catch(() => {});

  // 空袋：先重新加購再改數量
  if (await isBagEmpty(page)) {
    console.warn("  購物袋係空，先返回產品頁重新加入…");
    await page.goto(CONFIG.buyUrl, { waitUntil: "domcontentloaded" }).catch(() => {});
    await addToBagAndOpenBag(page);
    if (!/\/shop\/bag/i.test(page.url())) {
      await page.goto("https://www.apple.com/hk-zh/shop/bag", {
        waitUntil: "domcontentloaded",
      });
    }
    if (await isBagEmpty(page)) {
      throw new StepError("數量", "購物袋仍然係空，無法改數量。");
    }
  }

  const qtyStr = String(quantity);

  const autom = page.locator(
    '[data-autom*="quantity" i], select[id*="quantity" i], select[name*="quantity" i]'
  );
  const automCount = await autom.count();
  for (let i = 0; i < automCount; i++) {
    const el = autom.nth(i);
    const tag = await el.evaluate((n) => n.tagName.toLowerCase()).catch(() => "");
    if (tag === "select") {
      await el.selectOption(qtyStr, { force: true });
      console.log(`  已用 data-autom/select 改數量 = ${quantity}`);
      await page.waitForTimeout(1500);
      return;
    }
  }

  const selects = page.locator("select");
  const selectCount = await selects.count();
  for (let i = 0; i < selectCount; i++) {
    const sel = selects.nth(i);
    const values = await sel
      .locator("option")
      .evaluateAll((opts) =>
        opts.map((o) => ((o as HTMLOptionElement).value || o.textContent || "").trim())
      )
      .catch(() => [] as string[]);
    if (values.includes(qtyStr)) {
      await sel.selectOption(qtyStr, { force: true });
      console.log(`  已用隱藏 select 改數量 = ${quantity}`);
      await page.waitForTimeout(1500);
      return;
    }
  }

  const qtyLabel = page.getByLabel(/數量|Qty|Quantity/i).first();
  if (await qtyLabel.count()) {
    await humanClick(qtyLabel, { force: true }).catch(() => {});
    const option = page.getByRole("option", { name: qtyStr, exact: true }).first();
    if (await option.count()) {
      await humanClick(option, { force: true });
      console.log(`  已用 label/option 改數量 = ${quantity}`);
      await page.waitForTimeout(1500);
      return;
    }
  }

  const inc = page.getByRole("button", {
    name: /增加數量|增加|Increment|Increase quantity/i,
  });
  for (let n = 0; n < quantity - 1; n++) {
    if (!(await inc.first().count())) break;
    await humanClick(inc.first(), { force: true });
    await page.waitForTimeout(400);
    if (n === quantity - 2) {
      console.log(`  已用增加掣改數量 = ${quantity}`);
      await page.waitForTimeout(1000);
      return;
    }
  }

  throw new StepError("數量", `購物袋揾唔到數量選擇器，請人手改做 ${quantity}。`);
}

async function goToCheckout(page: Page): Promise<void> {
  if (isShop404Url(page.url())) {
    await recoverFromShop404IfNeeded(page);
  }
  if (!isBagPage(page.url()) && !isCheckoutFlowPage(page.url())) {
    // 唔喺袋／結帳：先試 404／nav bag 復原，再直達 bag
    if (isShop404Url(page.url())) await recoverFromShop404IfNeeded(page);
    if (!isBagPage(page.url()) && !isCheckoutFlowPage(page.url())) {
      await page
        .goto("https://www.apple.com/hk-zh/shop/bag", { waitUntil: "domcontentloaded" })
        .catch(() => {});
      await settleDom(page, 200);
    }
  }
  if (isPickupApplePay()) {
    console.log("步驟：使用 Apple Pay 結帳（pickup apple pay）");
    const clicked = await clickByAccessibleName(page, [
      /使用\s*Apple\s*Pay\s*結帳/i,
      /使用Apple Pay結帳/,
      /Apple\s*Pay.*結帳/i,
      /Check out with Apple Pay/i,
    ]);
    if (!clicked) {
      // 後備：文字／data-autom
      const ok = await clickFirstVisible(
        [
          page.locator('button:has-text("使用Apple Pay結帳"), a:has-text("使用Apple Pay結帳")'),
          page.locator('button:has-text("使用 Apple Pay 結帳"), a:has-text("使用 Apple Pay 結帳")'),
          page.locator('[data-autom*="applepay" i], [data-autom*="apple-pay" i]'),
        ],
        { force: true, timeout: 5000 }
      );
      if (!ok) {
        throw new StepError("結帳", "購物袋揾唔到「使用Apple Pay結帳」掣。");
      }
    }
    await settleDom(page, 100);
    return;
  }

  // Apple 帳戶模式：雙重確認撳「結帳」
  if (usesAppleAccount()) {
    console.log("步驟：結帳（Apple 帳戶 — 雙重確認）");
    const checkoutBtns = [
      page.getByRole("button", { name: /^結帳$/ }),
      page.getByRole("link", { name: /^結帳$/ }),
      page.getByRole("button", { name: /前往結帳/ }),
      page.getByRole("button", { name: /^Checkout$/i }),
      page.getByRole("button", { name: /Check Out/i }),
      page.locator('button:has-text("結帳"), a:has-text("結帳")'),
      page.locator('[data-autom*="checkout" i], [data-autom*="bag-checkout" i]'),
    ];
    let target: Locator | null = null;
    for (const loc of checkoutBtns) {
      const el = loc.first();
      if ((await el.count().catch(() => 0)) && (await visible(el, 1200))) {
        target = el;
        break;
      }
      if ((await el.count().catch(() => 0)) > 0) {
        target = el;
        break;
      }
    }
    if (!target) {
      throw new StepError("結帳", "購物袋揾唔到「結帳」掣。");
    }
    await target.scrollIntoViewIfNeeded().catch(() => {});
    await humanClick(target, { force: true }).catch(async () => {
      await target!.evaluate((n) => (n as HTMLElement).click()).catch(() => {});
    });
    console.log("  已撳「結帳」（第 1 次）");
    await sleepCheckingRelease(150);
    // 若仍喺 bag，再撳第二次確認
    if (/\/shop\/bag/i.test(page.url())) {
      await target.click({ force: true, timeout: 1500 }).catch(async () => {
        await target!.evaluate((n) => (n as HTMLElement).click()).catch(() => {});
      });
      console.log("  已雙重確認撳「結帳」（第 2 次）");
    } else {
      console.log("  已離開購物袋，略過第二次「結帳」");
    }
    await settleDom(page, 100);
    return;
  }

  console.log("步驟：結帳");
  const clicked = await clickByAccessibleName(page, [
    /^結帳$/,
    /前往結帳/,
    /^Checkout$/i,
    /Check Out/i,
  ]);
  if (!clicked) {
    throw new StepError("結帳", "購物袋揾唔到「結帳」掣。");
  }
  await settleAfterNavigation(page);
}

async function continueAsGuest(page: Page): Promise<void> {
  console.log("步驟：以訪客身份繼續");
  await page.waitForTimeout(800);

  const onCheckout = async () =>
    isCheckoutFlowPage(page.url()) && !(await isSignInPage(page));

  const deadline = Date.now() + 28000;
  while (Date.now() < deadline) {
    if (await onCheckout()) {
      console.log("  已經喺結帳頁，跳過訪客登入。");
      return;
    }
    if (
      (await isSignInPage(page)) ||
      /\/shop\/(?:apw\/)?checkout|\/shop\/signIn/i.test(page.url())
    ) {
      break;
    }
    await page.waitForTimeout(400);
  }

  if (await onCheckout()) {
    console.log("  已經喺結帳頁，跳過訪客登入。");
    return;
  }

  const guestLocators = [
    page.getByRole("button", { name: /以訪客身[份分]繼續/ }),
    page.getByRole("link", { name: /以訪客身[份分]繼續/ }),
    page.getByRole("button", { name: /以訪客身[份分]結帳/ }),
    page.getByRole("link", { name: /以訪客身[份分]結帳/ }),
    page.getByRole("button", { name: /Continue as Guest/i }),
    page.getByRole("link", { name: /Continue as Guest/i }),
    page.getByRole("button", { name: /不使用 Apple 帳[户戶]繼續/ }),
    page.getByRole("link", { name: /不使用 Apple 帳[户戶]繼續/ }),
    page.locator('[data-autom*="guest" i]'),
  ];

  const guestDeadline = Date.now() + 22000;
  let clicked = false;
  while (Date.now() < guestDeadline) {
    if (await onCheckout()) {
      console.log("  已離開登入頁。");
      return;
    }
    for (const loc of guestLocators) {
      const el = loc.first();
      if (await visible(el, 400)) {
        await humanClick(el);
        clicked = true;
        console.log("  已撳訪客繼續");
        break;
      }
    }
    if (clicked) break;
    await page.waitForTimeout(500);
  }

  if (!clicked) {
    throw new StepError(
      "訪客結帳",
      "揾唔到「以訪客身份繼續」。請人手撳，或確認而家頁面。"
    );
  }

  await withReleaseCheck(
    page.waitForURL(/\/shop\/(?:apw\/)?checkout/i, { timeout: 30000 }).catch(() => {})
  );
  await settleAfterNavigation(page);
  if (await isSignInPage(page)) {
    throw new StepError("訪客結帳", "撳完訪客繼續仍然喺登入頁。");
  }
}

/** Apple 帳戶登入 iframe（HK store signIn 常用） */
const APPLE_AUTH_IFRAME_SELS = [
  "#aid-auth-widget-iFrame",
  'iframe#aid-auth-widget-iFrame',
  'iframe[id*="aid-auth" i]',
  'iframe[src*="idmsa.apple.com" i]',
  'iframe[src*="appleauth" i]',
  'iframe[src*="appleid.apple.com" i]',
  'iframe[title*="Apple" i]',
  'iframe[name*="aid" i]',
];

async function waitForAppleAuthIframe(page: Page, timeoutMs = 20000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await throwIfReleased();
    for (const sel of APPLE_AUTH_IFRAME_SELS) {
      const iframe = page.locator(sel).first();
      if ((await iframe.count().catch(() => 0)) > 0) {
        const ready = await page
          .frameLocator(sel)
          .locator(
            '#account_name_text_field, input[name="accountName"], input[type="password"], #password_text_field'
          )
          .first()
          .waitFor({ state: "attached", timeout: 1500 })
          .then(() => true)
          .catch(() => false);
        if (ready) {
          console.log(`  已偵測 Apple 登入 iframe：${sel}`);
          return true;
        }
      }
    }
    if (
      (await page.locator("#account_name_text_field, input[name='accountName']").count().catch(() => 0)) >
      0
    ) {
      return true;
    }
    await sleepCheckingRelease(200);
  }
  return false;
}

async function fillInAppleAuthFrame(
  page: Page,
  kinds: "email" | "password",
  value: string
): Promise<boolean> {
  const emailSels = [
    "#account_name_text_field",
    'input[name="accountName"]',
    'input.form-textbox-text',
    'input[can-field="accountName"]',
    'input[autocomplete="username"]',
    'input[type="email"]',
    'input[type="text"][id*="account" i]',
    'input[placeholder*="Apple" i]',
    'input[aria-required="true"]',
  ];
  const passSels = [
    "#password_text_field",
    'input[type="password"]',
    'input[name="password"]',
    'input[autocomplete="current-password"]',
    'input[can-field="password"]',
  ];
  const fieldSels = kinds === "email" ? emailSels : passSels;

  const tryFillLocator = async (field: Locator): Promise<boolean> => {
    if ((await field.count().catch(() => 0)) === 0) return false;
    await field.waitFor({ state: "visible", timeout: 2500 }).catch(() => {});
    await field.click({ force: true, timeout: 1500 }).catch(() => {});
    await field.fill("").catch(() => {});
    await field.fill(value, { timeout: 2000 }).catch(() => {});
    let got = await field.inputValue().catch(() => "");
    if (got === value || got.includes(value.slice(0, 8))) return true;

    await field.click({ force: true }).catch(() => {});
    await field.press("ControlOrMeta+A").catch(() => {});
    await field.press("Backspace").catch(() => {});
    await field.pressSequentially(value, { delay: 8 }).catch(() => {});
    got = await field.inputValue().catch(() => "");
    if (got === value || got.includes(value.slice(0, 8))) return true;

    const ok = await field
      .evaluate((el, v) => {
        const input = el as HTMLInputElement;
        const proto = Object.getPrototypeOf(input);
        const desc = Object.getOwnPropertyDescriptor(proto, "value");
        desc?.set?.call(input, v);
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
        try {
          input.dispatchEvent(
            new InputEvent("input", { bubbles: true, data: v, inputType: "insertText" })
          );
        } catch {
          /* ignore */
        }
        return input.value === v || input.value.includes(v.slice(0, 8));
      }, value)
      .catch(() => false);
    return Boolean(ok);
  };

  for (const iframeSel of APPLE_AUTH_IFRAME_SELS) {
    if ((await page.locator(iframeSel).count().catch(() => 0)) === 0) continue;
    const frame = page.frameLocator(iframeSel);
    for (const sel of fieldSels) {
      const field = frame.locator(sel).first();
      if (await tryFillLocator(field)) {
        console.log(`  已填 ${kinds}（iframe ${iframeSel} / ${sel}）`);
        return true;
      }
    }
    const nested = frame.frameLocator(
      'iframe[src*="appleauth" i], iframe[src*="idmsa" i], iframe[title*="Apple" i]'
    );
    for (const sel of fieldSels) {
      const field = nested.locator(sel).first();
      if (await tryFillLocator(field)) {
        console.log(`  已填 ${kinds}（nested iframe / ${sel}）`);
        return true;
      }
    }
  }

  for (const root of [page, ...page.frames()] as Array<Page | Frame>) {
    for (const sel of fieldSels) {
      const field = root.locator(sel).first();
      if (await tryFillLocator(field as Locator)) {
        console.log(`  已填 ${kinds}（frames 掃描 / ${sel}）`);
        return true;
      }
    }
  }

  return false;
}

async function clickAppleAuthContinue(page: Page): Promise<boolean> {
  const btnSels = [
    "#sign-in",
    "button#sign-in",
    'button[type="submit"]',
    "button.aid-continue-button",
    "button.button-primary",
    'button:has-text("Continue")',
    'button:has-text("繼續")',
  ];

  for (const iframeSel of APPLE_AUTH_IFRAME_SELS) {
    if ((await page.locator(iframeSel).count().catch(() => 0)) === 0) continue;
    const frame = page.frameLocator(iframeSel);
    for (const sel of btnSels) {
      const btn = frame.locator(sel).first();
      if ((await btn.count().catch(() => 0)) === 0) continue;
      const ok = await btn
        .click({ force: true, timeout: 1500 })
        .then(() => true)
        .catch(async () =>
          btn
            .evaluate((n) => (n as HTMLElement).click())
            .then(() => true)
            .catch(() => false)
        );
      if (ok) {
        console.log(`  已撳登入繼續（${iframeSel} / ${sel}）`);
        return true;
      }
    }
    const arrow = frame.locator("button.icon-button, button.move, button:has(svg)").first();
    if ((await arrow.count().catch(() => 0)) > 0) {
      const ok = await arrow
        .click({ force: true, timeout: 1200 })
        .then(() => true)
        .catch(() => false);
      if (ok) {
        console.log("  已撳登入右箭頭");
        return true;
      }
    }
  }

  return clickAuthArrowAnywhere(page);
}

async function fillAuthFieldInRoots(
  page: Page,
  kinds: "email" | "password",
  value: string,
  _opts?: { doubleConfirm?: boolean }
): Promise<boolean> {
  return fillInAppleAuthFrame(page, kinds, value);
}

async function clickAuthArrowOrSubmit(root: Page | Frame): Promise<boolean> {
  const locators = [
    root.locator("#sign-in"),
    root.locator('button#sign-in, button[type="submit"]'),
    root.getByRole("button", { name: /^繼續$/ }),
    root.getByRole("button", { name: /Continue/i }),
    root.locator(
      "button.aid-continue-button, button.continue, button.move, button.button-primary"
    ),
    root.locator('button[aria-label*="繼續" i], button[aria-label*="Continue" i]'),
    root.locator("button:has(svg)"),
  ];
  for (const loc of locators) {
    const el = loc.first();
    if (!(await el.count().catch(() => 0))) continue;
    const ok = await el
      .click({ force: true, timeout: 800 })
      .then(() => true)
      .catch(async () =>
        el
          .evaluate((n) => (n as HTMLElement).click())
          .then(() => true)
          .catch(() => false)
      );
    if (ok) return true;
  }
  return false;
}

/** 喺 page + 所有 iframe 撳右箭頭／提交 */
async function clickAuthArrowAnywhere(page: Page): Promise<boolean> {
  if (await clickAuthArrowOrSubmit(page)) return true;
  for (const frame of page.frames()) {
    if (frame === page.mainFrame()) continue;
    if (await clickAuthArrowOrSubmit(frame)) return true;
  }
  return false;
}

async function pressEnterOnAuthField(page: Page, kinds: "email" | "password"): Promise<void> {
  for (const iframeSel of APPLE_AUTH_IFRAME_SELS) {
    if ((await page.locator(iframeSel).count().catch(() => 0)) === 0) continue;
    const frame = page.frameLocator(iframeSel);
    const sel =
      kinds === "email"
        ? "#account_name_text_field, input[name='accountName']"
        : "#password_text_field, input[type='password']";
    const field = frame.locator(sel).first();
    if ((await field.count().catch(() => 0)) > 0) {
      await field.press("Enter").catch(() => {});
      return;
    }
  }
  const roots: Array<Page | Frame> = [page, ...page.frames()];
  const sel =
    kinds === "email"
      ? 'input[type="email"], input#account_name_text_field, input[name="accountName"]'
      : 'input[type="password"], input#password_text_field, input[name="password"]';
  for (const root of roots) {
    const field = root.locator(sel).first();
    if (!(await field.count().catch(() => 0))) continue;
    await field.press("Enter").catch(() => {});
    return;
  }
  await page.keyboard.press("Enter").catch(() => {});
}

/** Apple 登入 iframe／frame（電郵提交後 content 會 reload，優先用 frames()） */
function appleAuthFrames(page: Page): Frame[] {
  return page.frames().filter((f) => {
    const u = f.url() || "";
    const n = f.name() || "";
    return (
      /idmsa|appleauth|appleid|IDMSWebAuth|auth\.apple/i.test(u) ||
      /aid|auth/i.test(n)
    );
  });
}

async function clickDomTextInRoot(
  root: Page | Frame,
  needles: string[],
  opts?: { loosePassword?: boolean }
): Promise<boolean> {
  return root
    .evaluate(
      (args) => {
        const norm = (s: string) =>
          (s || "")
            .replace(/[\s\u00a0\u200b\u200c\u200d\ufeff]+/g, "")
            .toLowerCase();
        const wanted = args.texts.map(norm).filter(Boolean);
        const loose = Boolean(args.loosePassword);
        const nodes = Array.from(
          document.querySelectorAll(
            "button, a, [role='button'], input[type='button'], input[type='submit'], div, span, p, label, li"
          )
        );
        const score = (el: Element): number => {
          const html = el as HTMLElement;
          const raw = norm(
            (html.textContent || "") +
              " " +
              ((html as HTMLInputElement).value || "") +
              " " +
              (html.getAttribute("aria-label") || "") +
              " " +
              (html.getAttribute("title") || "") +
              " " +
              (html.id || "")
          );
          if (!raw) return 0;
          if (html.id === "continue-password" || /continue-password/i.test(html.id)) {
            return 100;
          }
          for (const w of wanted) {
            if (raw.includes(w)) return 90;
          }
          if (loose) {
            // 通行密鑰畫面常見：「使用密碼」「以密碼」「password」
            if (
              (raw.includes("使用密碼") ||
                raw.includes("密碼登入") ||
                raw.includes("withpassword") ||
                raw.includes("usepassword")) &&
              !raw.includes("forgot") &&
              !/忘記|重置|reset|change/.test(raw)
            ) {
              return 70;
            }
          }
          return 0;
        };
        let best: HTMLElement | null = null;
        let bestScore = 0;
        for (const el of nodes) {
          const s = score(el);
          if (s <= bestScore) continue;
          // 偏向可點細件（避免整頁 div）
          const textLen = ((el.textContent || "").trim().length);
          if (textLen > 80 && s < 100) continue;
          best = el as HTMLElement;
          bestScore = s;
        }
        if (!best || bestScore <= 0) return false;
        best.scrollIntoView({ block: "center", inline: "nearest" });
        try {
          best.click();
        } catch {
          best.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
        }
        return true;
      },
      { texts: needles, loosePassword: opts?.loosePassword === true }
    )
    .catch(() => false);
}

/**
 * 撳「繼續使用密碼登入」（通行密鑰畫面可能要先撳「其他選項」）
 */
async function clickContinueWithPasswordFast(page: Page): Promise<boolean> {
  const pwdNeedles = [
    "繼續使用密碼登入",
    "使用密碼登入",
    "使用密碼",
    "以密碼繼續",
    "Continue with Password",
    "Use Password",
    "Sign in with Password",
  ];
  const otherNeedles = ["其他選項", "其他选项", "Other Options", "Other Option", "Try Another Way"];

  const tryClickPassword = async (): Promise<boolean> => {
    // 1) 明確 id（idmsa 常用 #continue-password）
    for (const fr of [...appleAuthFrames(page), page.mainFrame()]) {
      const byId = fr.locator(
        "#continue-password, button#continue-password, [id*='continue-password' i], button[data-test*='password' i]"
      ).first();
      if ((await byId.count().catch(() => 0)) > 0) {
        const ok = await byId
          .click({ force: true, timeout: 1500 })
          .then(() => true)
          .catch(async () =>
            byId
              .evaluate((n) => {
                (n as HTMLElement).click();
                return true;
              })
              .catch(() => false)
          );
        if (ok) return true;
      }
    }

    // 2) frameLocator（Playwright 定位）
    for (const iframeSel of APPLE_AUTH_IFRAME_SELS) {
      if ((await page.locator(iframeSel).count().catch(() => 0)) === 0) continue;
      const frame = page.frameLocator(iframeSel);
      const candidates = [
        frame.locator("#continue-password"),
        frame.getByRole("button", { name: /繼續使用密碼|使用密碼|Continue with Password|Use Password/i }),
        frame.getByRole("link", { name: /繼續使用密碼|使用密碼|Continue with Password|Use Password/i }),
        frame.getByText(/繼續使用密碼登入|使用密碼登入|Continue with Password/i),
        frame.locator('button:has-text("密碼"), a:has-text("密碼"), button:has-text("Password"), a:has-text("Password")'),
      ];
      for (const loc of candidates) {
        const el = loc.first();
        if ((await el.count().catch(() => 0)) === 0) continue;
        const ok = await el
          .click({ force: true, timeout: 1500 })
          .then(() => true)
          .catch(async () =>
            el
              .evaluate((n) => {
                (n as HTMLElement).click();
                return true;
              })
              .catch(() => false)
          );
        if (ok) return true;
      }
    }

    // 3) 所有 auth frame + 主頁 DOM 文字掃描
    for (const fr of [...appleAuthFrames(page), page.mainFrame(), ...page.frames()]) {
      if (await clickDomTextInRoot(fr, pwdNeedles, { loosePassword: true })) return true;
    }
    if (await clickCheckoutButtonByDomText(page, pwdNeedles)) return true;
    return false;
  };

  if (await tryClickPassword()) return true;

  // 通行密鑰／裝置登入畫面：先撳「其他選項」再搵密碼掣
  let openedOther = false;
  for (const fr of [...appleAuthFrames(page), page.mainFrame(), ...page.frames()]) {
    if (await clickDomTextInRoot(fr, otherNeedles)) {
      openedOther = true;
      break;
    }
  }
  if (!openedOther) {
    for (const iframeSel of APPLE_AUTH_IFRAME_SELS) {
      if ((await page.locator(iframeSel).count().catch(() => 0)) === 0) continue;
      const frame = page.frameLocator(iframeSel);
      const other = frame
        .getByRole("button", { name: /其他選項|Other Options|Try Another/i })
        .or(frame.getByText(/其他選項|Other Options/i))
        .first();
      if ((await other.count().catch(() => 0)) === 0) continue;
      openedOther = await other
        .click({ force: true, timeout: 1200 })
        .then(() => true)
        .catch(() => false);
      if (openedOther) break;
    }
  }
  if (openedOther) {
    console.log("  已撳「其他選項」，再試密碼登入…");
    await sleepCheckingRelease(400);
    if (await tryClickPassword()) return true;
  }

  return false;
}

/**
 * Apple 帳戶登入（pickup/delivery apple ac apple pay）
 * 等 aid-auth iframe → 填電郵 → 繼續 → 密碼 → 繼續 → Fulfillment
 */
async function signInWithAppleAccount(page: Page): Promise<void> {
  console.log("步驟：以 Apple 帳戶結帳");
  await sleepCheckingRelease(150);

  const deadline = Date.now() + 35000;
  while (Date.now() < deadline) {
    await throwIfReleased();
    if (/_s=Fulfillment/i.test(page.url()) && !(await isSignInPage(page))) {
      console.log("  已進入 Fulfillment，跳過登入。");
      return;
    }
    if (
      isCheckoutFlowPage(page.url()) &&
      !/signIn/i.test(page.url()) &&
      !(await isSignInPage(page))
    ) {
      console.log("  已進入結帳（非登入），跳過登入。");
      return;
    }
    if ((await isSignInPage(page)) || /\/shop\/signIn/i.test(page.url())) break;
    if (
      (await page
        .locator("#aid-auth-widget-iFrame, iframe[src*='idmsa'], iframe[src*='appleauth']")
        .count()
        .catch(() => 0)) > 0
    ) {
      break;
    }
    await sleepCheckingRelease(200);
  }

  const onSignIn =
    (await isSignInPage(page)) ||
    /\/shop\/signIn/i.test(page.url()) ||
    (await page
      .locator("#aid-auth-widget-iFrame, iframe[src*='idmsa'], iframe[src*='appleauth']")
      .count()
      .catch(() => 0)) > 0;

  if (!onSignIn) {
    if (/_s=Fulfillment/i.test(page.url())) return;
    throw new StepError("Apple 帳戶", "未到登入頁。");
  }

  console.log(`  帳戶：${APPLE_ACCOUNT.email}`);
  console.log(`  URL：${page.url()}`);

  const iframeOk = await waitForAppleAuthIframe(page, 20000);
  if (!iframeOk) {
    console.warn("  未明確等到 auth iframe，仍嘗試填電郵…");
  }

  let emailOk = false;
  for (let i = 0; i < 12; i++) {
    emailOk = await fillInAppleAuthFrame(page, "email", APPLE_ACCOUNT.email);
    if (emailOk) break;
    console.warn(`  電郵填寫重試 ${i + 1}/12…`);
    await sleepCheckingRelease(400);
    await waitForAppleAuthIframe(page, 3000).catch(() => false);
  }
  if (!emailOk) {
    throw new StepError(
      "Apple 帳戶",
      "揾唔到／填唔入 Apple 帳戶電郵欄（請確認 aid-auth iframe 已載入）。"
    );
  }

  let advanced = await clickAppleAuthContinue(page);
  if (!advanced) {
    await pressEnterOnAuthField(page, "email");
    advanced = true;
  }
  console.log("  已提交電郵");
  await sleepCheckingRelease(500);

  const pwdDeadline = Date.now() + 20000;
  let sawPassword = false;
  let pwdContinueClicks = 0;
  while (Date.now() < pwdDeadline) {
    await throwIfReleased();
    sawPassword = false;
    for (const fr of [...appleAuthFrames(page), page.mainFrame(), ...page.frames()]) {
      const n = await fr
        .locator("#password_text_field, input[type='password'], input[name='password']")
        .count()
        .catch(() => 0);
      if (n > 0) {
        sawPassword = true;
        break;
      }
    }
    if (sawPassword) break;

    const clicked = await clickContinueWithPasswordFast(page);
    if (clicked) {
      pwdContinueClicks += 1;
      console.log(`  已撳「繼續使用密碼登入」（第 ${pwdContinueClicks} 次）`);
      await sleepCheckingRelease(450);
    } else {
      await sleepCheckingRelease(250);
    }
  }

  if (!sawPassword) {
    // 最後再狂撳幾次
    for (let i = 0; i < 5; i++) {
      await throwIfReleased();
      if (await clickContinueWithPasswordFast(page)) {
        console.log("  補撳「繼續使用密碼登入」");
        await sleepCheckingRelease(500);
      }
      for (const fr of [...appleAuthFrames(page), ...page.frames()]) {
        if (
          (await fr
            .locator("#password_text_field, input[type='password']")
            .count()
            .catch(() => 0)) > 0
        ) {
          sawPassword = true;
          break;
        }
      }
      if (sawPassword) break;
    }
  }

  let passOk = false;
  for (let round = 1; round <= 10; round++) {
    passOk = await fillInAppleAuthFrame(page, "password", APPLE_ACCOUNT.password);
    if (passOk) break;
    await clickContinueWithPasswordFast(page).catch(() => {});
    console.warn(`  密碼填寫重試 ${round}/10…`);
    await sleepCheckingRelease(400);
  }
  if (!passOk) {
    throw new StepError(
      "Apple 帳戶",
      "揾唔到／填唔入密碼欄（請確認已出現「繼續使用密碼登入」並可撳）。"
    );
  }

  advanced = await clickAppleAuthContinue(page);
  if (!advanced) {
    await pressEnterOnAuthField(page, "password");
  }
  console.log("  已提交密碼");

  await withReleaseCheck(
    page
      .waitForURL(
        (url) => {
          const s = url.toString();
          return (
            /_s=Fulfillment/i.test(s) ||
            (/\/shop\/(?:apw\/)?checkout/i.test(s) && !/signIn/i.test(s))
          );
        },
        { timeout: 60000 }
      )
      .catch(() => {})
  );
  await settleDom(page, 200);

  const fulfillDeadline = Date.now() + 40000;
  while (Date.now() < fulfillDeadline) {
    await throwIfReleased();
    if (/_s=Fulfillment/i.test(page.url())) {
      console.log("  已到達 Fulfillment-init");
      return;
    }
    if (
      isCheckoutFlowPage(page.url()) &&
      !(await isSignInPage(page)) &&
      !/signIn/i.test(page.url())
    ) {
      console.log(`  已入結帳：${page.url()}`);
      return;
    }
    if (await isSignInPage(page)) {
      await clickAppleAuthContinue(page).catch(() => {});
      await clickContinueWithPasswordFast(page).catch(() => {});
    }
    await sleepCheckingRelease(300);
  }
  throw new StepError("Apple 帳戶", "登入後未到達 Fulfillment 頁。");
}

async function fillDeliveryAppleAcPhoneOnly(page: Page): Promise<void> {
  console.log(`步驟：送貨電話（Apple 帳戶）填 ${APPLE_ACCOUNT.phone}`);
  await settleDom(page, 100);
  const phoneLocators = [
    page.locator('input[type="tel"]').first(),
    page.locator('input[autocomplete="tel"], input[autocomplete="tel-national"]').first(),
    page.locator('input[id*="phone" i], input[name*="phone" i]').first(),
    page.getByLabel(/電話號碼|流動電話|Phone|Mobile/i).first(),
  ];
  let phoneOk = false;
  for (const loc of phoneLocators) {
    if (!(await loc.count().catch(() => 0))) continue;
    await loc.fill(APPLE_ACCOUNT.phone, { timeout: 1500 }).catch(() => {});
    const v = await loc.inputValue().catch(() => "");
    if (v.replace(/\D/g, "").includes(APPLE_ACCOUNT.phone)) {
      phoneOk = true;
      break;
    }
  }
  if (!phoneOk) {
    phoneOk =
      (await fillByLabels(
        page,
        [/電話號碼/, /流動電話/, /Phone/i, /Mobile/i],
        APPLE_ACCOUNT.phone,
        "電話"
      )) ||
      (await fillEditableFallback(
        page,
        [
          'input[type="tel"]',
          'input[autocomplete="tel"]',
          'input[name*="phone" i]',
          'input[id*="phone" i]',
          'input[data-autom*="phone" i]',
        ],
        APPLE_ACCOUNT.phone,
        "電話"
      ));
  }
  if (!phoneOk) {
    throw new StepError("送貨電話", `未能填入 ${APPLE_ACCOUNT.phone}`);
  }
  console.log("  電話已填");
}

async function goBackAndSettle(page: Page): Promise<void> {
  console.log("  返回上一頁重試…");
  await page.goBack({ waitUntil: "domcontentloaded" }).catch(async () => {
    await page.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
  });
  await settleAfterNavigation(page);
}

async function refreshFulfillmentPage(page: Page): Promise<void> {
  console.log("  等 1 分鐘先 refresh Fulfillment 頁…");
  await sleepCheckingRelease(60_000);
  noteFulfillmentRefresh("full");
  console.log("  重新整理 Fulfillment 頁…");
  markCheckoutNav(page.url(), "pre-full-refresh-fulfillment");
  const current = page.url();
  // 盡量留喺／回到 Fulfillment-init 再重試整個取貨流程
  if (/_s=Fulfillment/i.test(current)) {
    await page.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
  } else {
    const fulfillmentUrl = current.replace(
      /([?&]_s=)[^&]*/i,
      "$1Fulfillment-init"
    );
    if (/_s=Fulfillment-init/i.test(fulfillmentUrl) && fulfillmentUrl !== current) {
      await page.goto(fulfillmentUrl, { waitUntil: "domcontentloaded" }).catch(async () => {
        await page.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
      });
    } else {
      await page.goBack({ waitUntil: "domcontentloaded" }).catch(async () => {
        await page.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
      });
    }
  }
  await settleAfterNavigation(page);
}

async function continueToShippingAddress(page: Page): Promise<void> {
  console.log("步驟：繼續填寫送貨地址");
  if (/_s=Shipping/i.test(page.url())) {
    console.log("  已經喺送貨資料頁。");
    return;
  }

  await page.waitForTimeout(1000);

  const names: Array<string | RegExp> = [
    /繼續填寫送貨地址/,
    /填寫送貨地址/,
    /繼續前往送貨詳情/,
    /繼續前往送貨/,
    /前往送貨/,
    /Continue to Shipping/i,
    /Continue to Delivery/i,
  ];

  let clicked = false;
  for (let attempt = 1; attempt <= 4 && !clicked; attempt++) {
    clicked = Boolean(
      await clickByAccessibleName(page, names, { force: true, timeout: 5000 })
    );
    if (clicked) break;

    // Apple 有時用 data-autom / 普通 button
    clicked = await clickIfEnabled(
      [
        page.locator('[data-autom*="continue" i]'),
        page.locator('[data-autom*="shipping" i]'),
        page.getByRole("button", { name: /繼續填寫送貨地址/ }),
        page.getByRole("button", { name: /繼續前往送貨/ }),
        page.getByRole("button", { name: /^繼續$/ }),
        page.getByRole("button", { name: /繼續/ }),
      ],
      2500
    );
    if (clicked) break;

    // 強制撳第一個「繼續…送貨」文字
    const textBtn = page.getByText(/繼續填寫送貨地址|繼續前往送貨/, { exact: false }).first();
    if (await visible(textBtn, 800)) {
      await humanClick(textBtn, { force: true }).catch(() => {});
      clicked = true;
      break;
    }

    console.warn(`  送貨繼續掣第 ${attempt} 次未撳到，再等…`);
    await page.waitForTimeout(1500);
  }

  if (!clicked) {
    throw new StepError("送貨方式", "揾唔到「繼續填寫送貨地址」。請人手撳。");
  }
  console.log("  已撳繼續送貨地址");

  await withReleaseCheck(
    page.waitForURL(/_s=Shipping/i, { timeout: 30000 }).catch(() => {})
  );
  await settleAfterNavigation(page);

  // 等表單欄位出現
  await page
    .getByLabel(/^姓氏$|^姓$|Last name/i)
    .first()
    .waitFor({ state: "visible", timeout: 15000 })
    .catch(() => {});
}

async function startDeliveryFlow(page: Page): Promise<void> {
  // pickup-only 任務永遠唔好撳「我希望送貨」（b210 誤踩）
  if (prefersPickupOnly()) {
    console.warn("  pickup-only：拒絕撳「我希望送貨」");
    return;
  }
  console.log("步驟：我希望送貨");
  await page.waitForTimeout(800);

  if (/_s=Shipping/i.test(page.url())) {
    console.log("  已經喺送貨資料頁。");
    return;
  }

  for (let attempt = 1; attempt <= 3; attempt++) {
    if (attempt > 1) {
      await refreshFulfillmentPage(page);
    }

    const deliveryClicked = await clickDeliveryOption(page);
    if (deliveryClicked) {
      console.log("  已揀：我希望送貨");
    } else {
      console.warn(`  第 ${attempt} 次揾唔到「我希望送貨」`);
    }

    await page.waitForTimeout(1200);

    try {
      await continueToShippingAddress(page);
      if (/_s=Shipping/i.test(page.url()) || (await page.getByLabel(/姓氏|Last name/i).first().isVisible().catch(() => false))) {
        console.log("  已進入送貨資料頁。");
        return;
      }
    } catch (err) {
      console.warn(`  送貨繼續失敗（${attempt}/3）：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  throw new StepError("送貨方式", "「我希望送貨」流程未能進入送貨資料頁。");
}

async function clickIfEnabled(
  locators: Locator[],
  timeout = 2500
): Promise<boolean> {
  for (const loc of locators) {
    const el = loc.first();
    if (!(await visible(el, timeout))) continue;
    const enabled = await el.isEnabled().catch(() => false);
    if (!enabled) continue;
    await humanClick(el, { force: true });
    return true;
  }
  return false;
}

async function findPickupSearchInput(
  page: Page,
  maxMs = 10_000
): Promise<Locator | null> {
  // 唔好用頂欄「搜尋 apple.com」（role=button / globalnav）
  const candidates: Locator[] = [
    page.locator(
      'input[data-autom*="pickup" i], input[data-autom*="store" i], input[data-autom*="retail" i], input[data-autom*="zip" i], input[data-autom*="location" i]'
    ),
    page.getByPlaceholder(/城市或地區|城市、地區|郵遞區號|輸入城市|搜尋 Apple Store|Search for an Apple Store/i),
    page.getByRole("textbox", { name: /城市或地區|城市、地區|郵遞區號|取貨|門市|Apple Store/i }),
    page.locator(
      'main input[type="text"], main input[type="search"], form input[type="text"], form input[type="search"], [role="main"] input[type="text"], [role="main"] input[type="search"]'
    ),
    page.locator(
      'input[name*="postal" i], input[name*="zip" i], input[name*="storeLocator" i], input[id*="postal" i], input[id*="store" i]'
    ),
  ];

  const deadline = Date.now() + Math.max(200, maxMs);
  while (Date.now() < deadline) {
    for (const group of candidates) {
      const count = await group.count();
      for (let i = 0; i < count; i++) {
        const el = group.nth(i);
        if (!(await visible(el, 200))) continue;

        const ok = await el
          .evaluate((node) => {
            const tag = node.tagName.toLowerCase();
            if (tag !== "input" && tag !== "textarea") return false;
            const id = (node.getAttribute("id") || "").toLowerCase();
            const aria = (node.getAttribute("aria-label") || "").toLowerCase();
            const cls = (node.getAttribute("class") || "").toLowerCase();
            if (id.includes("globalnav") || cls.includes("globalnav")) return false;
            if (aria.includes("搜尋 apple.com") || aria.includes("search apple.com")) {
              return false;
            }
            const input = node as HTMLInputElement;
            if (input.disabled || input.readOnly) return false;
            return true;
          })
          .catch(() => false);

        if (ok) return el;
      }
    }
    await page.waitForTimeout(200);
  }
  return null;
}

const PICKUP_STORE_NOISE =
  /你附近的所有零售店|選擇取貨零售店|套用|我會前來取貨|我希望送貨|繼續前往取貨詳情|繼續前往|搜尋|Apply/i;

/** 中環附近 6 門市 → 短碼（Live 補貨紀錄） */
const PICKUP_STORE_CODES: Array<{ code: string; match: RegExp; name: string }> = [
  { code: "IFC", match: /ifc\s*mall|\bifc\b/i, name: "ifc mall" },
  { code: "TST", match: /canton\s*road/i, name: "canton road" },
  { code: "CWB", match: /causeway\s*bay/i, name: "causeway bay" },
  { code: "FW", match: /festival\s*walk/i, name: "festival walk" },
  { code: "APM", match: /apm\s*hong\s*kong|\bapm\b/i, name: "apm hong kong" },
  { code: "NTP", match: /new\s*town\s*plaza/i, name: "new town plaza" },
];

type StoreStockSnap = {
  code: string;
  name: string;
  /** 精確部數；缺貨 0；有貨但頁面冇數字 → null（顯示 ?） */
  qty: number | null;
  available: boolean;
  raw: string;
};

/** 今次 fulfillment 流程已試過嘅門市（用文字 key，避免重試重複撳同一間） */
let usedPickupStoreKeys = new Set<string>();
/** 避免 Live 補貨紀錄重複寫同一份門市庫存快照 */
let lastStoreStockFingerprint = "";
/** 由 fulfillment／pickup API 攔截到嘅門市庫存 */
const fulfillmentApiStoreQty = new Map<string, number>();

function pickupStoreKey(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 120).toLowerCase();
}

function pickupStoreKeywordPattern(): RegExp {
  const parts = CONFIG.pickupStoreKeywords.map((k) =>
    k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  );
  return new RegExp(parts.join("|"), "i");
}

function isNoisePickupText(text: string): boolean {
  const t = text.trim();
  if (!t) return true;
  if (PICKUP_STORE_NOISE.test(t) && t.length < 40) return true;
  if (/^套用$|^Apply$/i.test(t)) return true;
  return false;
}

/** 監控通知嘅有貨門市短碼（IFC／CWB…）；揀店時優先撳呢啲 */
let preferredMonitorStoreCodes = new Set<string>();

function setPreferredStoresFromResume(payload: StockResumePayload): void {
  const codes = new Set<string>();
  for (const sku of payload.skus) {
    if (!stockSkuMatchesCheckout(sku)) continue;
    for (const s of sku.stores || []) {
      const code = String(s.code || "").trim().toUpperCase();
      if (code && s.available !== false) codes.add(code);
    }
  }
  preferredMonitorStoreCodes = codes;
  if (codes.size) {
    console.log(`  監控指定門市：${[...codes].join("、")}`);
  }
}

function matchesPreferredStore(text: string): boolean {
  return pickupStoreKeywordPattern().test(text);
}

function resolvePickupStoreCode(text: string): { code: string; name: string } | null {
  for (const s of PICKUP_STORE_CODES) {
    if (s.match.test(text)) return { code: s.code, name: s.name };
  }
  return null;
}

function parseStoreButtonStock(text: string): { qty: number | null; available: boolean } {
  const t = text.replace(/\s+/g, " ").trim();
  if (
    /暫時缺貨|已售罄|暫時無貨|不可取貨|無貨可取|Currently unavailable|Out of stock|Unavailable|Not available/i.test(
      t
    )
  ) {
    return { qty: 0, available: false };
  }
  const patterns: RegExp[] = [
    /尚餘\s*(\d+)/i,
    /剩餘\s*(\d+)/i,
    /庫存\s*[:：]?\s*(\d+)/i,
    /可買\s*[:：]?\s*(\d+)/i,
    /可取貨?\s*[:：]?\s*(\d+)/i,
    /available\s*[:：]?\s*(\d+)/i,
    /qty\s*[:：]?\s*(\d+)/i,
    /quantity\s*[:：]?\s*(\d+)/i,
    /(\d+)\s*部/,
    /(\d+)\s*件/,
    /\(\s*(\d+)\s*\)/,
  ];
  for (const re of patterns) {
    const m = t.match(re);
    if (m?.[1]) {
      const n = Number(m[1]);
      if (Number.isFinite(n) && n >= 0) return { qty: n, available: n > 0 };
    }
  }
  if (/今日可取貨|可取貨|有貨|Available for pickup|Pick\s*up\s*available|available today/i.test(t)) {
    return { qty: null, available: true };
  }
  if (resolvePickupStoreCode(t)) return { qty: null, available: true };
  return { qty: null, available: true };
}

function formatStoreStockLabel(snap: StoreStockSnap): string {
  if (!snap.available || snap.qty === 0) return `${snap.code} (0)`;
  if (snap.qty != null && Number.isFinite(snap.qty)) return `${snap.code} (${snap.qty})`;
  return `${snap.code} (?)`;
}

function formatStoreStocksLine(snaps: StoreStockSnap[]): string {
  const byCode = new Map(snaps.map((s) => [s.code, s]));
  return PICKUP_STORE_CODES.map((def) => {
    const s = byCode.get(def.code);
    if (!s) return `${def.code} (0)`;
    return formatStoreStockLabel(s);
  }).join(" · ");
}

function formatHkNowForLog(): string {
  return new Intl.DateTimeFormat("zh-HK", {
    timeZone: "Asia/Hong_Kong",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date());
}

/** 攔截 fulfillment／pickup JSON，盡量攞每間店精確庫存 */
function attachFulfillmentStoreStockTap(page: Page): void {
  attachWrongAppleSearchRecovery(page);
  const flagged = page as Page & { __storeStockTap?: boolean };
  if (flagged.__storeStockTap) return;
  flagged.__storeStockTap = true;

  page.on("response", (res) => {
    void (async () => {
      try {
        const url = res.url();
        if (!/fulfillment|pickup-message|pickupMessage|store|retail|availability/i.test(url)) {
          return;
        }
        const ct = String(res.headers()["content-type"] || "");
        if (!/json/i.test(ct) && !/javascript/i.test(ct)) return;
        const data = await res.json().catch(() => null);
        if (!data || typeof data !== "object") return;

        const visit = (node: unknown, depth: number) => {
          if (depth > 10 || node == null) return;
          if (Array.isArray(node)) {
            for (const item of node) visit(item, depth + 1);
            return;
          }
          if (typeof node !== "object") return;
          const obj = node as Record<string, unknown>;
          const nameBlob = [
            obj.storeName,
            obj.retailStoreName,
            obj.name,
            obj.store,
            obj.city,
            obj.address,
            obj.storeNumber,
          ]
            .map((v) => String(v || ""))
            .join(" ");
          const id = resolvePickupStoreCode(nameBlob);
          if (id) {
            const qtyCandidates = [
              obj.quantityAvailable,
              obj.availableQuantity,
              obj.maxQuantity,
              obj.storePickupQuantity,
              obj.pickupQuantity,
              obj.qty,
              obj.quantity,
              (obj.partsAvailability as Record<string, unknown> | undefined)?.quantity,
            ];
            for (const c of qtyCandidates) {
              const n = Number(c);
              if (Number.isFinite(n) && n >= 0) {
                fulfillmentApiStoreQty.set(id.code, n);
                break;
              }
            }
            // pickupDisplay: available / unavailable
            const display = String(
              obj.pickupDisplay ||
                (obj.partsAvailability as Record<string, unknown> | undefined)?.pickupDisplay ||
                ""
            ).toLowerCase();
            if (display.includes("unavailable") || display.includes("ineligible")) {
              if (!fulfillmentApiStoreQty.has(id.code)) fulfillmentApiStoreQty.set(id.code, 0);
            }
          }
          for (const v of Object.values(obj)) visit(v, depth + 1);
        };
        visit(data, 0);
      } catch {
        /* ignore */
      }
    })();
  });
}

/** 一次掃晒頁面所有門市掣文字（唔撳掣） */
async function scrapePickupStoreStocksFromDom(page: Page): Promise<StoreStockSnap[]> {
  const defs = PICKUP_STORE_CODES.map((s) => ({
    code: s.code,
    name: s.name,
    match: s.match.source,
  }));

  const rawList = await page.evaluate((storeDefs) => {
    const out: Array<{ code: string; name: string; blob: string }> = [];
    const seen = new Set<string>();
    const nodes = Array.from(
      document.querySelectorAll(
        'button, [role="button"], [role="radio"], [role="option"], label, li, a, input[type="radio"], [data-autom*="store" i], [data-autom*="retail" i]'
      )
    );
    for (const n of nodes) {
      const el = n as HTMLElement;
      const bits = [
        el.innerText || "",
        el.getAttribute("aria-label") || "",
        el.getAttribute("title") || "",
        el.getAttribute("data-autom") || "",
        el.getAttribute("value") || "",
      ];
      const parent = el.closest(
        "label, li, [role='radio'], [role='option'], .form-selector, [class*='selector']"
      );
      if (parent && parent !== el) bits.push((parent as HTMLElement).innerText || "");
      const blob = bits.join("\n").replace(/\s+/g, " ").trim();
      if (!blob || blob.length < 4) continue;
      for (const d of storeDefs) {
        try {
          if (!new RegExp(d.match, "i").test(blob)) continue;
          if (seen.has(d.code)) continue;
          seen.add(d.code);
          out.push({ code: d.code, name: d.name, blob: blob.slice(0, 240) });
        } catch {
          /* ignore bad regex */
        }
      }
    }
    return out;
  }, defs);

  const snaps: StoreStockSnap[] = [];
  for (const row of rawList) {
    const parsed = parseStoreButtonStock(row.blob);
    let qty = parsed.qty;
    const apiQty = fulfillmentApiStoreQty.get(row.code);
    if (apiQty != null) qty = apiQty;
    snaps.push({
      code: row.code,
      name: row.name,
      qty: parsed.available === false ? 0 : qty,
      available: parsed.available && (qty == null || qty > 0),
      raw: row.blob,
    });
  }

  // API 有但 DOM 未見嘅店
  for (const def of PICKUP_STORE_CODES) {
    if (snaps.some((s) => s.code === def.code)) continue;
    const apiQty = fulfillmentApiStoreQty.get(def.code);
    if (apiQty == null) continue;
    snaps.push({
      code: def.code,
      name: def.name,
      qty: apiQty,
      available: apiQty > 0,
      raw: `api:${apiQty}`,
    });
  }
  return snaps;
}

/** 將各門市庫存寫入 Live 補貨紀錄（有變先寫） */
async function recordStoreStocksToRestockHistory(
  page: Page,
  opts?: { force?: boolean }
): Promise<StoreStockSnap[]> {
  attachFulfillmentStoreStockTap(page);
  const snaps = await scrapePickupStoreStocksFromDom(page);
  if (!snaps.length) return snaps;

  const line = formatStoreStocksLine(snaps);
  const fp = `${CONFIG.model}|${CONFIG.color}|${CONFIG.storage}|${line}`;
  if (!opts?.force && fp === lastStoreStockFingerprint) return snaps;
  lastStoreStockFingerprint = fp;

  const totalKnown = snaps.reduce(
    (sum, s) => sum + (typeof s.qty === "number" && s.qty > 0 ? s.qty : 0),
    0
  );
  const row = {
    at: new Date().toISOString(),
    atHk: formatHkNowForLog(),
    event: "store_stock",
    name: `${CONFIG.model} ${CONFIG.storage} ${CONFIG.color}`.trim(),
    model: CONFIG.model,
    color: CONFIG.color,
    storage: CONFIG.storage,
    stockQty: totalKnown,
    buyQty: CONFIG.quantity,
    detail: line,
    storeStocks: snaps.map((s) => ({
      code: s.code,
      name: s.name,
      qty: s.qty,
      available: s.available,
      label: formatStoreStockLabel(s),
    })),
  };
  try {
    await fs.mkdir(RUNTIME_DIR, { recursive: true });
    await fs.appendFile(
      path.join(RUNTIME_DIR, "restock-history.jsonl"),
      `${JSON.stringify(row)}\n`,
      "utf8"
    );
    console.log(`  門市庫存 → Live 補貨紀錄：${line}`);
    await writeStatus({
      message: `門市庫存：${line}`,
      storeStocks: row.storeStocks,
      storeStocksLine: line,
    }).catch(() => {});
  } catch (err) {
    console.warn(
      `  寫門市庫存補貨紀錄失敗：${err instanceof Error ? err.message : String(err)}`
    );
  }
  return snaps;
}

async function collectStoresUnderHeading(
  page: Page,
  headingRe: RegExp
): Promise<Locator[]> {
  const heading = page.getByText(headingRe, { exact: false }).first();
  if (!(await visible(heading, 1200))) return [];

  const found: Locator[] = [];
  const seen = new Set<string>();

  const pushUnique = async (el: Locator) => {
    if (!(await visible(el, 250))) return;
    const text = ((await el.innerText().catch(() => "")) || "").trim();
    if (isNoisePickupText(text)) return;
    // 用文字做粗略去重
    const key = text.slice(0, 120);
    if (seen.has(key)) return;
    const tag = await el.evaluate((n) => n.tagName.toLowerCase()).catch(() => "");
    const role = ((await el.getAttribute("role").catch(() => "")) || "").toLowerCase();
    const type = ((await el.getAttribute("type").catch(() => "")) || "").toLowerCase();
    const clickable =
      tag === "button" ||
      tag === "label" ||
      tag === "a" ||
      role === "button" ||
      role === "radio" ||
      role === "option" ||
      (tag === "input" && (type === "radio" || type === "button")) ||
      tag === "li" ||
      (tag === "div" && (matchesPreferredStore(text) || role === "listitem"));
    if (!clickable) return;
    seen.add(key);
    found.push(el);
  };

  // 標題所在區塊
  const section = heading.locator(
    "xpath=ancestor::*[self::section or self::form or self::fieldset or self::div][1]"
  );
  const scoped = section.locator(
    'button, [role="button"], [role="radio"], label, li, a, input[type="radio"], [data-autom*="store" i], [data-autom*="retail" i]'
  );
  const scopedCount = await scoped.count().catch(() => 0);
  for (let i = 0; i < Math.min(scopedCount, 60); i++) {
    await pushUnique(scoped.nth(i));
  }

  // 標題後面嘅可撳元素
  const following = heading.locator(
    "xpath=following::*[self::button or self::label or self::li or self::a or @role='radio' or @role='button' or @role='option' or (self::input and (@type='radio' or @type='button'))][position()<=50]"
  );
  const followingCount = await following.count().catch(() => 0);
  for (let i = 0; i < followingCount; i++) {
    await pushUnique(following.nth(i));
  }

  return found;
}

async function collectVisiblePickupStores(page: Page): Promise<Locator[]> {
  // 1) 優先：「你附近的所有零售店」
  let stores = await collectStoresUnderHeading(page, /你附近的所有零售店/);
  if (stores.length > 0) return stores;

  // 2) 後備：「選擇取貨零售店」
  stores = await collectStoresUnderHeading(page, /選擇取貨零售店/);
  if (stores.length > 0) return stores;

  // 3) 用指定門市關鍵字直接搵
  const keywordRe = pickupStoreKeywordPattern();
  const byKeyword = page
    .getByRole("button", { name: keywordRe })
    .or(page.getByRole("radio", { name: keywordRe }))
    .or(page.getByRole("link", { name: keywordRe }))
    .or(page.getByText(keywordRe));

  const keywordHits: Locator[] = [];
  const kwCount = await byKeyword.count().catch(() => 0);
  for (let i = 0; i < Math.min(kwCount, 30); i++) {
    const el = byKeyword.nth(i);
    if (!(await visible(el, 300))) continue;
    const text = ((await el.innerText().catch(() => "")) || "").trim();
    if (isNoisePickupText(text)) continue;
    keywordHits.push(el);
  }
  if (keywordHits.length > 0) return keywordHits;

  // 4) 其他可見 radio（排除取貨／送貨切換）
  const storeRadios = page.getByRole("radio").filter({
    hasNotText: /我會前來取貨|我希望送貨|送貨到|不換購|AppleCare|Pickup|Delivery/i,
  });
  const visibleRadios: Locator[] = [];
  const radioCount = await storeRadios.count();
  for (let i = 0; i < radioCount; i++) {
    const el = storeRadios.nth(i);
    if (await visible(el, 400)) visibleRadios.push(el);
  }
  return visibleRadios;
}

async function scrollPageToBottom(page: Page): Promise<void> {
  console.log("  捲動去頁面底部…");
  await page.evaluate(async () => {
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const maxY = Math.max(
      document.body.scrollHeight,
      document.documentElement.scrollHeight,
      document.body.offsetHeight,
      document.documentElement.offsetHeight
    );
    window.scrollTo({ top: maxY, behavior: "instant" as ScrollBehavior });
    await sleep(200);
    // 再推一下，應付動態加高嘅 footer / sticky bar
    window.scrollTo({
      top: Math.max(
        document.body.scrollHeight,
        document.documentElement.scrollHeight
      ),
      behavior: "instant" as ScrollBehavior,
    });
  }).catch(() => {});
  await page.keyboard.press("End").catch(() => {});
  await page.waitForTimeout(400);
}

/** Hard reload Fulfillment-init（同一 URL 用 reload，否則 goto） */
async function hardRefreshFulfillmentInit(
  page: Page,
  label = "hard-refresh-fulfillment"
): Promise<void> {
  const current = page.url();
  const target = fulfillmentInitUrlFrom(current);
  noteFulfillmentRefresh("soft");
  markCheckoutNav(target, label);
  usedPickupStoreKeys.clear();
  console.log(`  ★ hard refresh Fulfillment-init：${target}`);
  if (
    /\/shop\/checkout/i.test(current) &&
    /_s=Fulfillment-init/i.test(current) &&
    target === current
  ) {
    await withReleaseCheck(
      page.reload({ waitUntil: "domcontentloaded", timeout: 45_000 }).catch(() => {})
    );
  } else if (/\/shop\/checkout/i.test(current) && /_s=Fulfillment/i.test(current)) {
    await withReleaseCheck(
      page
        .goto(target, { waitUntil: "domcontentloaded", timeout: 45_000 })
        .catch(async () => {
          await page.reload({ waitUntil: "domcontentloaded", timeout: 45_000 }).catch(() => {});
        })
    );
  } else {
    await gotoFulfillmentInit(page);
    await markPageErrorIfNotFound(page, label).catch(() => false);
    await recoverFromWrongAppleSearchIfNeeded(page, label).catch(() => false);
    return;
  }
  await settleDom(page, 250);
  await markPageErrorIfNotFound(page, label).catch(() => false);
  await recoverFromWrongAppleSearchIfNeeded(page, label).catch(() => false);
}

async function softRefreshFulfillmentNow(page: Page): Promise<void> {
  console.log("  即刻 refresh Fulfillment-init（唔等 1 分鐘）…");
  await hardRefreshFulfillmentInit(page, "pre-soft-refresh-fulfillment");
  await settleAfterNavigation(page);
}

/** 快速數而家可見門市掣（唔等） */
async function countVisiblePickupStoreOptions(page: Page): Promise<number> {
  let stores = await collectStoresUnderHeading(page, /選擇取貨零售店/);
  if (stores.length < 6) {
    const nearby = await collectStoresUnderHeading(page, /你附近的所有零售店/);
    if (nearby.length >= stores.length) stores = nearby;
  }
  if (stores.length === 0) {
    stores = await collectVisiblePickupStores(page);
  }
  return stores.length;
}

async function clickContinueToPickupDetails(page: Page): Promise<boolean> {
  // 已入 PickupContact 就即刻停，唔好再撳「繼續前往取貨詳情」
  if (isPickupContactPage(page.url())) {
    console.log("  已喺 PickupContact，停止撳「繼續前往取貨詳情」");
    return true;
  }

  const stayOnFulfillment = (url: string) =>
    /_s=Fulfillment/i.test(url) &&
    !isShop404Url(url) &&
    !isPickupContactPage(url);

  console.log(
    "  「繼續前往取貨詳情」：撳掣 → 等 loading 停 → 若仍喺 Fulfillment-init 就 refresh 重試，直到下一頁…"
  );

  const locators = [
    page.getByRole("button", { name: /繼續前往取貨詳情/ }),
    page.getByRole("link", { name: /繼續前往取貨詳情/ }),
    page.getByRole("button", { name: /取貨詳情/ }),
    page.locator('button:has-text("繼續前往取貨詳情"), a:has-text("繼續前往取貨詳情")'),
  ];

  const overallDeadline = Date.now() + 180_000;
  let round = 0;

  while (Date.now() < overallDeadline) {
    await throwIfReleased();

    if (isPickupContactPage(page.url())) {
      console.log("  已進入 PickupContact，停止撳「繼續前往取貨詳情」");
      return true;
    }
    if (isShop404Url(page.url())) {
      await recoverFromShop404IfNeeded(page, "[continue-pickup]");
      return false;
    }
    if (await recoverFromWrongAppleSearchIfNeeded(page, "[continue-pickup]")) {
      continue;
    }
    if (!stayOnFulfillment(page.url()) && round > 0) {
      console.log(`  已離開 Fulfillment → ${page.url()}`);
      return true;
    }

    round += 1;
    markCheckoutNav(page.url(), "fulfillment-before-continue");

    if (usesPickupGuestStoreContinueRules()) {
      // 取貨：唔喺呢度捲頁（門市撳完已捲一次）；refresh 後可能要再捲
      if (round > 1) await scrollPageToBottom(page);
    } else {
      await scrollPageToBottom(page);
    }

    let target: Locator | null = null;
    for (const loc of locators) {
      const el = loc.first();
      if (await visible(el, 800)) {
        target = el;
        break;
      }
      if ((await el.count().catch(() => 0)) > 0) {
        target = el;
        break;
      }
    }

    if (!target) {
      console.warn(`  「繼續前往取貨詳情」第 ${round} 輪：揾唔到掣 → refresh 重試`);
      await softRefreshFulfillmentNow(page);
      if (isShop404Url(page.url())) {
        await recoverFromShop404IfNeeded(page, "[continue-pickup-no-btn]");
        return false;
      }
      // refresh 後要重新搜門市＋揀店先有掣
      if (!(await fillPickupSearchAndWaitHeading(page))) {
        await sleepCheckingRelease(800);
        continue;
      }
      if (!(await clickAnyNearbyStore(page))) {
        await sleepCheckingRelease(800);
        continue;
      }
      continue;
    }

    await target.scrollIntoViewIfNeeded().catch(() => {});
    await humanClick(target, { force: true }).catch(async () => {
      await target!.evaluate((n) => (n as HTMLElement).click()).catch(() => {});
    });
    console.log(`  已撳「繼續前往取貨詳情」（第 ${round} 輪）— 等 loading…`);

    await waitForCheckoutLoadingSettled(page, {
      timeoutMs: 25_000,
      stayOn: stayOnFulfillment,
    });

    if (isPickupContactPage(page.url())) {
      console.log("  loading 完後已進入 PickupContact");
      return true;
    }
    if (isShop404Url(page.url())) {
      await recoverFromShop404IfNeeded(page, "[continue-pickup-after-loading]");
      return false;
    }
    if (!stayOnFulfillment(page.url())) {
      console.log(`  loading 完後已離開 Fulfillment → ${page.url()}`);
      return true;
    }

    // loading 已停但仍喺 Fulfillment-init → refresh 再成個流程重試
    console.log(
      "  loading 已停但仍喺 Fulfillment-init → refresh 頁面，重複揀店＋繼續…"
    );
    await writeStatus({
      phase: "fulfillment_continue_refresh",
      url: page.url(),
      message: `繼續前往取貨詳情 loading 停咗仍未去下一頁 → refresh（第 ${round} 輪）`,
    }).catch(() => {});

    await softRefreshFulfillmentNow(page);
    if (isShop404Url(page.url())) {
      await recoverFromShop404IfNeeded(page, "[continue-pickup-refresh]");
      return false;
    }
    if (isPickupContactPage(page.url())) return true;

    if (!(await fillPickupSearchAndWaitHeading(page))) {
      await sleepCheckingRelease(800);
      continue;
    }
    if (!(await clickAnyNearbyStore(page))) {
      await sleepCheckingRelease(800);
      continue;
    }
  }

  if (isPickupContactPage(page.url())) {
    console.log("  已喺 PickupContact（超時後確認），當成功。");
    return true;
  }
  console.warn(
    "  「繼續前往取貨詳情」多次 refresh 仍未去下一頁（之後外層會再試）。"
  );
  return false;
}

/** Monitor+buying：解析 stock-resume flag（含 color／storage） */
type StockResumeSku = {
  name?: string;
  model?: string;
  color?: string;
  storage?: string;
  stockQty?: number | null;
  buyQty?: number;
  stores?: Array<{ code?: string; name?: string; available?: boolean }>;
};

type StockResumePayload = {
  atMs: number;
  skus: StockResumeSku[];
};

function normColorKey(s: string): string {
  return String(s || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "");
}

function normStorageKey(s: string): string {
  return String(s || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "");
}

function normModelKey(s: string): string {
  return String(s || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function stockSkuMatchesCheckout(sku: StockResumeSku): boolean {
  const wantModel = normModelKey(CONFIG.model);
  if (wantModel) {
    const gotModel = normModelKey(String(sku.model || ""));
    const name = normModelKey(String(sku.name || ""));
    const modelOk =
      (gotModel &&
        (wantModel === gotModel ||
          wantModel.includes(gotModel) ||
          gotModel.includes(wantModel))) ||
      (name && name.includes(wantModel.replace(/\s+/g, "")));
    // name 可能係 "iPhone 17 256GB …" — 用簡化比對
    const modelOkLoose =
      !gotModel &&
      name &&
      wantModel
        .split(" ")
        .filter(Boolean)
        .every((tok) => name.includes(tok));
    if (!modelOk && !modelOkLoose) return false;
  }

  const wantStorage = normStorageKey(CONFIG.storage);
  const gotStorage = normStorageKey(String(sku.storage || ""));
  if (!wantStorage || !gotStorage || wantStorage !== gotStorage) return false;

  const wantColor = normColorKey(CONFIG.color);
  if (!wantColor) return true;

  const gotColor = normColorKey(String(sku.color || ""));
  if (gotColor) {
    return (
      wantColor === gotColor ||
      wantColor.includes(gotColor) ||
      gotColor.includes(wantColor)
    );
  }
  const name = normColorKey(String(sku.name || ""));
  return Boolean(name && name.includes(wantColor));
}

async function readStockResumePayload(): Promise<StockResumePayload | null> {
  const tryFile = async (file: string): Promise<StockResumePayload | null> => {
    try {
      const st = await fs.stat(file);
      const raw = await fs.readFile(file, "utf8");
      let skus: StockResumeSku[] = [];
      let atMs = st.mtimeMs;
      try {
        const parsed = JSON.parse(raw) as {
          at?: string;
          atMs?: number;
          skus?: StockResumeSku[];
        };
        if (typeof parsed.atMs === "number") atMs = parsed.atMs;
        else if (parsed.at) {
          const t = Date.parse(parsed.at);
          if (Number.isFinite(t)) atMs = t;
        }
        if (Array.isArray(parsed.skus)) skus = parsed.skus;
      } catch {
        skus = [];
      }
      return { atMs, skus };
    } catch {
      return null;
    }
  };
  const session = await tryFile(STOCK_RESUME_SESSION_FLAG);
  const all = await tryFile(STOCK_RESUME_ALL_FLAG);
  if (session && all) return session.atMs >= all.atMs ? session : all;
  return session || all;
}

/**
 * 等 monitor 有貨，且 型號+顏色+容量 同本 task 一致。
 * timeoutMs 有設：逾時回 null；否則一直等。
 * afterMs：只要更新過呢個時間戳之後嘅通知。
 */
async function waitForMatchingStockResume(opts?: {
  afterMs?: number;
  timeoutMs?: number;
}): Promise<StockResumePayload | null> {
  const afterMs = opts?.afterMs ?? 0;
  const deadline =
    opts?.timeoutMs != null && opts.timeoutMs >= 0
      ? Date.now() + opts.timeoutMs
      : null;

  while (true) {
    await throwIfReleased();
    if (deadline != null && Date.now() >= deadline) return null;

    const payload = await readStockResumePayload();
    if (payload && payload.atMs > afterMs) {
      const matched =
        payload.skus.length === 0
          ? false
          : payload.skus.some((s) => stockSkuMatchesCheckout(s));
      // 舊格式冇 skus：唔當匹配（避免誤觸）
      if (matched) {
        setPreferredStoresFromResume(payload);
        console.log(
          `  收到有貨通知（匹配 ${CONFIG.model}／${CONFIG.color}／${CONFIG.storage}）at=${new Date(payload.atMs).toISOString()}`
        );
        return payload;
      }
    }
    await sleepCheckingRelease(400);
  }
}

function fulfillmentInitUrlFrom(current: string): string {
  if (/\/shop\/checkout/i.test(current) && /store\.apple\.com/i.test(current)) {
    if (/[?&]_s=/i.test(current)) {
      return current.replace(/([?&]_s=)[^&]*/i, "$1Fulfillment-init");
    }
    return `${current.split("#")[0]}${current.includes("?") ? "&" : "?"}_s=Fulfillment-init`;
  }
  // 誤入 www.apple.com／search 時唔好用錯 host → 用上一頁 checkout（例如 secure9）
  const last = lastNon404NavMark?.url || "";
  if (/\/shop\/checkout/i.test(last) && /store\.apple\.com/i.test(last)) {
    if (/[?&]_s=/i.test(last)) {
      return last.replace(/([?&]_s=)[^&]*/i, "$1Fulfillment-init");
    }
    return `${last.split("#")[0]}${last.includes("?") ? "&" : "?"}_s=Fulfillment-init`;
  }
  return "https://secure6.store.apple.com/hk-zh/shop/checkout?_s=Fulfillment-init";
}

/** https://www.apple.com/search/中環?src=pnf 或 /us/search/… */
function isAppleSiteSearchUrl(url: string): boolean {
  if (!/apple\.com/i.test(url)) return false;
  return /\/search\//i.test(url);
}

/** 誤入 Apple.com 全站搜尋（例如 /search/中環?src=pnf） */
function isWrongAppleSearchPnfUrl(url: string): boolean {
  if (!isAppleSiteSearchUrl(url)) return false;
  if (/[?&]src=pnf\b/i.test(url)) return true;
  const term = String(CONFIG.pickupSearch || "中環").trim();
  if (!term) return false;
  try {
    const decoded = decodeURIComponent(url);
    if (decoded.includes(term)) return true;
  } catch {
    /* ignore */
  }
  if (url.includes(encodeURIComponent(term))) return true;
  if (/%E4%B8%AD%E7%92%B0/i.test(url) || url.includes("中環")) return true;
  return false;
}

const recoveringWrongSearchPages = new WeakSet<Page>();

/**
 * 誤入 https://www.apple.com/search/中環?src=pnf
 * （常有 “The page you’re looking for can’t be found.”）
 * → 先返產品購買頁
 */
async function recoverFromWrongAppleSearchIfNeeded(
  page: Page,
  tag = ""
): Promise<boolean> {
  const url = page.url();
  if (!isAppleSiteSearchUrl(url)) return false;
  if (recoveringWrongSearchPages.has(page)) return false;

  const isPnf = /[?&]src=pnf\b/i.test(url) || isWrongAppleSearchPnfUrl(url);
  if (!isPnf) return false;

  recoveringWrongSearchPages.add(page);
  try {
    await page.waitForTimeout(250).catch(() => {});
    const notFound = await pageShowsNotFound(page).catch(() => false);
    if (!notFound && !/[?&]src=pnf\b/i.test(url) && !/%E4%B8%AD%E7%92%B0|中環/.test(url)) {
      return false;
    }

    const target = buyUrlForNotFoundRecovery();
    const prefix = tag ? `${tag} ` : "";
    console.warn(
      `  ${prefix}★ search pnf${notFound ? "（can't be found）" : ""} → 先返產品購買頁：${target}`
    );
    markCheckoutNav(target, "recover-wrong-apple-search-to-buy");
    await writeStatus({
      phase: "recover_to_buy",
      stuck: false,
      message: notFound
        ? `search pnf can't be found → 先返產品購買頁`
        : `誤入 search pnf → 先返產品購買頁`,
      url: target,
      card: { url: target, message: "recovered from search pnf → buy page" },
    }).catch(() => {});
    await withReleaseCheck(
      page.goto(target, { waitUntil: "domcontentloaded", timeout: 60_000 }).catch(() => {})
    );
    await settleDom(page, 400);
    return /\/shop\/buy-iphone\//i.test(page.url());
  } finally {
    recoveringWrongSearchPages.delete(page);
  }
}

/** 監聽誤導航去 apple.com/search?*src=pnf 或「找不到你想去的網頁」 */
function attachWrongAppleSearchRecovery(page: Page): void {
  const flagged = page as Page & { __wrongSearchRecovery?: boolean };
  if (flagged.__wrongSearchRecovery) return;
  flagged.__wrongSearchRecovery = true;
  const maybeRecover = () => {
    void (async () => {
      await recoverFromWrongAppleSearchIfNeeded(page, "[nav]").catch(() => {});
      await page.waitForTimeout(200).catch(() => {});
      if (await pageShowsNotFound(page)) {
        await markPageErrorIfNotFound(page, "[nav-not-found]").catch(() => {});
      }
    })();
  };
  page.on("framenavigated", (frame) => {
    if (frame !== page.mainFrame()) return;
    maybeRecover();
  });
  page.on("load", () => maybeRecover());
}

/** 頁面／HTTP 係咪 503 Service Temporarily Unavailable */
async function isFulfillment503(
  page: Page,
  response?: { status?: () => number } | null
): Promise<boolean> {
  try {
    if (response && typeof response.status === "function" && response.status() === 503) {
      return true;
    }
  } catch {
    /* ignore */
  }
  try {
    const sniff = await page.evaluate(() => {
      const title = document.title || "";
      const body = (document.body?.innerText || "").slice(0, 3000);
      const h1 = document.querySelector("h1")?.textContent || "";
      return `${title}\n${h1}\n${body}`;
    });
    return (
      /503\s*Service\s*Temporarily\s*Unavailable/i.test(sniff) ||
      (/Service Temporarily Unavailable/i.test(sniff) && /\b503\b/.test(sniff))
    );
  } catch {
    return false;
  }
}

async function gotoFulfillmentInit(page: Page): Promise<void> {
  const current = page.url();
  const target = fulfillmentInitUrlFrom(current);
  console.log(`  前往 Fulfillment-init：${target}`);
  markCheckoutNav(target || current, "gotoFulfillmentInit");
  if (target === current || /_s=Fulfillment-init/i.test(current)) {
    await withReleaseCheck(
      page.reload({ waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {})
    );
  } else {
    await withReleaseCheck(
      page.goto(target, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(async () => {
        await page.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
      })
    );
  }
  await settleAfterNavigation(page);
}

/**
 * Monitor+buying：refresh Fulfillment-init；若 503 就隔 6 秒再 refresh，直到頁面可用再交俾腳本。
 */
async function reloadFulfillmentInitUntilReady(page: Page): Promise<void> {
  const RETRY_503_MS = 6_000;
  for (let n = 1; ; n++) {
    await throwIfReleased();
    const current = page.url();
    const target = fulfillmentInitUrlFrom(current);
    markCheckoutNav(target || current, "stockResumeRefresh");
    console.log(`  refresh Fulfillment-init #${n}：${target}`);

    let response: { status?: () => number } | null = null;
    if (target === current || /_s=Fulfillment-init/i.test(current)) {
      response = await withReleaseCheck(
        page
          .reload({ waitUntil: "domcontentloaded", timeout: 60000 })
          .catch(() => null)
      );
    } else {
      response = await withReleaseCheck(
        page
          .goto(target, { waitUntil: "domcontentloaded", timeout: 60000 })
          .catch(async () => {
            return page.reload({ waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => null);
          })
      );
    }

    if (await isFulfillment503(page, response)) {
      console.warn(
        `  Fulfillment-init 503 Service Temporarily Unavailable — ${RETRY_503_MS / 1000}s 後再 refresh…`
      );
      await writeStatus({
        phase: "resuming_after_stock",
        message: `Fulfillment-init 503：${n} 次，${RETRY_503_MS / 1000}s 後再 refresh`,
      }).catch(() => {});
      await sleepCheckingRelease(RETRY_503_MS);
      continue;
    }

    await settleAfterNavigation(page);

    if (isShop404Url(page.url()) || !/\/shop\/checkout/i.test(page.url())) {
      console.warn("  refresh 後唔喺 checkout — 拉返 Fulfillment-init 再試…");
      await gotoFulfillmentInit(page);
      if (await isFulfillment503(page)) {
        await writeStatus({
          phase: "resuming_after_stock",
          message: `Fulfillment-init 503（返頁後）：${RETRY_503_MS / 1000}s 後再 refresh`,
        }).catch(() => {});
        await sleepCheckingRelease(RETRY_503_MS);
        continue;
      }
    }

    console.log("  Fulfillment-init 已可用，等待詳細內容載入…");
    const detailsOk = await waitForFulfillmentInitDetailsReady(page);
    if (!detailsOk) {
      if (await isFulfillment503(page)) {
        await writeStatus({
          phase: "resuming_after_stock",
          message: `Fulfillment-init 503（等詳細時）：${RETRY_503_MS / 1000}s 後再 refresh`,
        }).catch(() => {});
        await sleepCheckingRelease(RETRY_503_MS);
        continue;
      }
      console.warn(
        `  Fulfillment-init 詳細內容未齊 — ${RETRY_503_MS / 1000}s 後再 refresh…`
      );
      await writeStatus({
        phase: "resuming_after_stock",
        message: `等 Fulfillment-init 詳細內容逾時：${RETRY_503_MS / 1000}s 後再 refresh`,
      }).catch(() => {});
      await sleepCheckingRelease(RETRY_503_MS);
      continue;
    }

    console.log("  Fulfillment-init 詳細已齊，繼續：我會前來取貨 → 中環 → 其餘步驟…");
    return;
  }
}

/**
 * 等 Fulfillment-init 載入齊取貨／送貨等詳細 UI，先好撳「我會前來取貨」。
 */
async function waitForFulfillmentInitDetailsReady(page: Page): Promise<boolean> {
  console.log("  等待 Fulfillment-init 詳細內容（我會前來取貨／送貨選項）…");
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    await throwIfReleased();
    if (await isFulfillment503(page)) {
      console.warn("  等詳細內容期間出現 503");
      return false;
    }
    if (isShop404Url(page.url())) return false;
    if (
      isPickupContactPage(page.url()) ||
      isBillingPage(page.url()) ||
      isReviewPage(page.url())
    ) {
      return true;
    }

    const pickupVisible = await page
      .getByText(/我會前來取貨/, { exact: false })
      .first()
      .isVisible()
      .catch(() => false);
    const deliveryVisible = await page
      .getByText(/我希望送貨/, { exact: false })
      .first()
      .isVisible()
      .catch(() => false);
    const search = await findPickupSearchInput(page);

    if (pickupVisible || deliveryVisible || search) {
      await settleDom(page, 500);
      const stillPickup = await page
        .getByText(/我會前來取貨/, { exact: false })
        .first()
        .isVisible()
        .catch(() => false);
      const stillDelivery = await page
        .getByText(/我希望送貨/, { exact: false })
        .first()
        .isVisible()
        .catch(() => false);
      const stillSearch = await findPickupSearchInput(page);
      if (stillPickup || stillDelivery || stillSearch) {
        console.log("  Fulfillment-init 詳細內容已載入");
        return true;
      }
    }
    await sleepCheckingRelease(400);
  }
  console.warn("  等待 Fulfillment-init 詳細內容逾時");
  return false;
}

/** 輸入「中環」後，等到「選擇取貨零售店」下面出現 6 個選項；0 掣時每 5s hard refresh */
async function waitForSixPickupStoreOptions(page: Page): Promise<Locator[]> {
  console.log("  等待「選擇取貨零售店：」下面出現 6 個門市掣…");
  const REFRESH_MS = 5_000;
  const deadline = Date.now() + 600_000; // 最長 10 分鐘
  let lastCycleAt = Date.now();

  while (Date.now() < deadline) {
    await throwIfReleased();

    if (
      isPickupContactPage(page.url()) ||
      isBillingPage(page.url()) ||
      isReviewPage(page.url())
    ) {
      return [];
    }

    let stores = await collectStoresUnderHeading(page, /選擇取貨零售店/);
    if (stores.length < 6) {
      const nearby = await collectStoresUnderHeading(page, /你附近的所有零售店/);
      if (nearby.length >= stores.length) stores = nearby;
    }
    if (stores.length >= 6) {
      console.log(`  已見 ${stores.length} 個門市選項，再確認一次…`);
      await sleepCheckingRelease(800);
      let again = await collectStoresUnderHeading(page, /選擇取貨零售店/);
      if (again.length < 6) {
        const nearby = await collectStoresUnderHeading(page, /你附近的所有零售店/);
        if (nearby.length >= again.length) again = nearby;
      }
      if (again.length >= 6) {
        const six = again.slice(0, 6);
        console.log(`  雙重確認成功：會由 ${six.length} 個掣入面隨機揀一間`);
        return six;
      }
      console.warn(`  再確認時只得 ${again.length} 個，繼續等…`);
    } else {
      console.log(`  而家得 ${stores.length}/6 個門市掣，繼續等…`);
    }

    // pickup 訪客：門市未齊 → 固定每 5s hard refresh 成頁再搜
    if (isPickupCreditCardGuest() && stores.length < 6) {
      const elapsed = Date.now() - lastCycleAt;
      const waitMore = Math.max(0, REFRESH_MS - elapsed);
      if (waitMore > 0) {
        await sleepCheckingRelease(waitMore);
      }
      console.log(
        `  門市未齊（${stores.length}/6）→ hard refresh Fulfillment-init（固定 ${REFRESH_MS / 1000}s）`
      );
      await writeStatus({
        phase: "fulfillment_pickup_wait",
        message: `Fulfillment-init：門市 ${stores.length}/6，每 ${REFRESH_MS / 1000}s refresh`,
        url: page.url(),
      }).catch(() => {});
      await hardRefreshFulfillmentInit(page, "pickup-stores-5s-refresh");
      lastCycleAt = Date.now();
      if (await isFulfillment503(page)) {
        console.warn("  refresh 後 503 — 下一輪再試");
        continue;
      }
      await clickIfEnabled(
        [
          page.getByRole("radio", { name: /我會前來取貨/ }),
          page.getByRole("button", { name: /我會前來取貨/ }),
          page.getByLabel(/我會前來取貨/),
          page.getByText("我會前來取貨", { exact: false }),
        ],
        1200
      );
      await fillPickupSearchAndWaitHeading(page, { fast: true }).catch(() => false);
      continue;
    }

    await sleepCheckingRelease(1000);
  }
  console.warn("  逾時仍未等到 6 個門市掣。");
  return [];
}

async function clickAnyNearbyStore(page: Page): Promise<boolean> {
  let stores = await waitForSixPickupStoreOptions(page);
  if (stores.length < 6) {
    stores = await collectStoresUnderHeading(page, /選擇取貨零售店/);
    if (stores.length === 0) {
      stores = await collectStoresUnderHeading(page, /你附近的所有零售店/);
    }
  }
  if (stores.length === 0) {
    stores = await collectVisiblePickupStores(page);
  }
  if (stores.length === 0) {
    console.warn("  「選擇取貨零售店」下面揾唔到可撳選項。");
    return false;
  }

  // 撳門市前先掃庫存入 Live 補貨紀錄（唔額外撳其他門市）
  await recordStoreStocksToRestockHistory(page).catch(() => {});

  const pool = stores.slice(0, Math.max(6, stores.length));
  type Candidate = {
    el: Locator;
    text: string;
    key: string;
    code: string | null;
    available: boolean;
    qty: number | null;
  };
  const candidates: Candidate[] = [];
  for (const el of pool) {
    const text = ((await el.innerText().catch(() => "")) || "").trim();
    if (!text || isNoisePickupText(text)) continue;
    const key = pickupStoreKey(text) || `idx-${candidates.length}`;
    const id = resolvePickupStoreCode(text);
    const { qty, available } = parseStoreButtonStock(text);
    candidates.push({
      el,
      text,
      key,
      code: id?.code || null,
      available,
      qty,
    });
  }

  if (candidates.length === 0) {
    console.warn("  門市掣文字解析後冇可撳選項。");
    return false;
  }

  const unused = candidates.filter((c) => !usedPickupStoreKeys.has(c.key));
  const poolToPick = unused.length > 0 ? unused : candidates;
  const inStock = poolToPick.filter(
    (c) => c.available && (c.qty == null || c.qty > 0)
  );
  const pickFrom = inStock.length > 0 ? inStock : poolToPick;
  const monitored = pickFrom.filter(
    (c) => c.code && preferredMonitorStoreCodes.has(c.code)
  );
  const chosen = (monitored.length > 0 ? monitored : pickFrom)[0]!;
  usedPickupStoreKeys.add(chosen.key);
  const label = chosen.text.replace(/\s+/g, " ").slice(0, 90) || "門市";
  const codeTag = chosen.code ? ` ${chosen.code}` : "";
  const stockTag =
    chosen.qty != null
      ? `｜庫存=${chosen.qty}`
      : chosen.available
        ? "｜有貨"
        : "｜缺貨";
  console.log(
    `  撳門市掣一次${codeTag}：${label}${stockTag}｜剩餘未試 ${Math.max(0, unused.length - 1)}/${candidates.length}`
  );
  await chosen.el.scrollIntoViewIfNeeded().catch(() => {});
  // 只撳一次，之後即交俾「繼續前往取貨詳情」
  await humanClick(chosen.el, { force: true }).catch(async () => {
    await chosen.el.evaluate((n) => (n as HTMLElement).click()).catch(() => {});
  });
  console.log("  已撳門市（一次）→ 接著撳「繼續前往取貨詳情」");
  await sleepCheckingRelease(400);
  if (usesPickupGuestStoreContinueRules()) {
    await scrollPageToBottom(page);
  } else {
    await scrollPageToBottom(page);
  }
  return true;
}

async function fillPickupSearchAndWaitHeading(
  page: Page,
  opts?: { fast?: boolean }
): Promise<boolean> {
  const fast = Boolean(opts?.fast);
  const search = await findPickupSearchInput(page, fast ? 1500 : 10_000);
  if (!search) {
    console.warn("  揾唔到取貨搜尋欄。");
    return false;
  }
  await search.click({ force: true }).catch(() => {});
  await search.fill("");
  await search.fill(CONFIG.pickupSearch);
  console.log(`  已輸入：${CONFIG.pickupSearch}`);

  const applied = await clickIfEnabled(
    [
      page.getByRole("button", { name: /^套用$/ }),
      page.getByRole("button", { name: /套用/ }),
      page.getByRole("button", { name: /^Apply$/i }),
    ],
    fast ? 1200 : 4000
  );
  if (!applied) {
    await search.press("Enter").catch(() => {});
    await page.waitForTimeout(400).catch(() => {});
    if (await recoverFromWrongAppleSearchIfNeeded(page, "[pickup-search-enter]")) {
      return false;
    }
  } else {
    console.log("  已撳「套用」");
  }

  if (await recoverFromWrongAppleSearchIfNeeded(page, "[pickup-search]")) {
    return false;
  }

  // 套用後等列表載入：門市掣要時間先出現（b225 以前 1.5s 就 refresh 太快）
  console.log("  已輸入搜尋，等待門市列表載入…");
  await waitForCheckoutLoadingSettled(page, {
    timeoutMs: 12_000,
    stayOn: (u) => /_s=Fulfillment/i.test(u) || /\/shop\/checkout/i.test(u),
  }).catch(() => {});

  await page
    .getByText(/選擇取貨零售店|你附近的所有零售店/, { exact: false })
    .first()
    .waitFor({ state: "visible", timeout: 12_000 })
    .catch(() => {});

  // 輪詢等門市掣出現（最多 ~12s）
  const storeWaitMs = 12_000;
  const storeDeadline = Date.now() + storeWaitMs;
  let lastCount = 0;
  while (Date.now() < storeDeadline) {
    await throwIfReleased();
    if (await recoverFromWrongAppleSearchIfNeeded(page, "[pickup-search-wait]")) {
      return false;
    }
    lastCount = await countVisiblePickupStoreOptions(page);
    if (lastCount >= 1) {
      console.log(`  ✓ 搜尋後已見 ${lastCount} 個門市掣`);
      return true;
    }
    await sleepCheckingRelease(400);
  }
  console.warn(`  等 ${storeWaitMs / 1000}s 後仍 ${lastCount} 個門市掣`);
  return true;
}

async function choosePickupStore(page: Page): Promise<boolean> {
  console.log(`  搜尋取貨地點：${CONFIG.pickupSearch}`);
  await sleepCheckingRelease(usesFastPickupContactFill() ? 150 : 800);
  attachFulfillmentStoreStockTap(page);

  if (!(await fillPickupSearchAndWaitHeading(page))) return false;
  await waitForSixPickupStoreOptions(page).catch(() => {});
  await recordStoreStocksToRestockHistory(page, { force: true }).catch(() => {});

  // 成套：撳門市一次 →「繼續前往取貨詳情」；失敗就換下一間／refresh
  for (let storeTry = 1; storeTry <= 6; storeTry++) {
    if (isPickupContactPage(page.url())) {
      console.log("  已喺 PickupContact，即刻一次過 autofill");
      if (usesFastPickupContactFill()) {
        await fillPickupContactGuestAndContinue(page, "[PickupContact]");
      }
      return true;
    }

    const storeClicked = await clickAnyNearbyStore(page);
    if (!storeClicked) {
      console.warn(`  門市嘗試 ${storeTry}/6：冇剩餘未試過嘅掣`);
      return false;
    }

    if (isPickupContactPage(page.url())) {
      console.log("  撳門市後已到 PickupContact，即刻一次過 autofill");
      if (usesFastPickupContactFill()) {
        await fillPickupContactGuestAndContinue(page, "[PickupContact]");
      }
      return true;
    }

    const toDetails = await clickContinueToPickupDetails(page);
    if (isPickupContactPage(page.url())) {
      console.log("  已到達 PickupContact，即刻一次過 autofill");
      if (usesFastPickupContactFill()) {
        await fillPickupContactGuestAndContinue(page, "[PickupContact]");
      }
      return true;
    }
    if (!toDetails) {
      console.warn(
        `  門市嘗試 ${storeTry}/6：「繼續前往取貨詳情」失敗，換另一間未試過嘅門市…`
      );
      if (!/_s=Fulfillment/i.test(page.url())) return false;
      continue;
    }

    await withReleaseCheck(
      page
        .waitForURL(
          (url) =>
            isPickupContactPage(url.toString()) ||
            !/_s=Fulfillment/i.test(url.toString()),
          { timeout: 15000 }
        )
        .catch(() => {})
    );
    if (isPickupContactPage(page.url())) {
      await settleDom(page, 50);
      console.log("  已到達 PickupContact，即刻一次過 autofill");
      if (usesFastPickupContactFill()) {
        await fillPickupContactGuestAndContinue(page, "[PickupContact]");
      }
      return true;
    }
    await settleDom(page, 100);

    if (isPickupContactPage(page.url())) {
      console.log("  已到達 PickupContact，即刻一次過 autofill");
      if (usesFastPickupContactFill()) {
        await fillPickupContactGuestAndContinue(page, "[PickupContact]");
      }
      return true;
    }

    console.warn(`  未到達 PickupContact 頁。而家 URL：${page.url()}`);
    if (/_s=Fulfillment/i.test(page.url())) {
      console.warn(`  門市嘗試 ${storeTry}/6：仍喺 Fulfillment，換另一間…`);
      continue;
    }
    return true;
  }

  console.warn("  6 個門市掣都試過仍未能繼續。");
  return false;
}

/** Monitor+buying：Fulfillment-init 待命 → 同色同容量有貨就 refresh 再落單；冇新通知就返待命 */
async function ensureFulfillmentInitStandby(page: Page): Promise<void> {
  console.log("  待命：回到 Fulfillment-init，預熱中環＋6 門市…");
  await gotoFulfillmentInit(page);
  usedPickupStoreKeys.clear();
  const detailsOk = await waitForFulfillmentInitDetailsReady(page);
  if (!detailsOk) {
    console.warn("  待命：Fulfillment-init 詳細未齊，仍會停低等有貨");
    return;
  }
  const pickupClicked = await clickPickupOption(page);
  if (!pickupClicked) {
    console.warn("  待命：撳唔到「我會前來取貨」（可能已揀）");
  } else {
    console.log("  已揀：我會前來取貨");
  }
  await sleepCheckingRelease(usesFastPickupContactFill() ? 150 : 500);
  if (!(await fillPickupSearchAndWaitHeading(page))) {
    console.warn("  待命：搜尋門市失敗，仍會停低等有貨");
    return;
  }
  const ready = await waitForSixPickupStoreOptions(page);
  if (ready.length < 6) {
    console.warn("  待命：未齊 6 個門市掣，仍然停低等有貨…");
  } else {
    console.log("  待命：已見 6 個門市掣，停低等同色同容量有貨…");
  }
  attachFulfillmentStoreStockTap(page);
  await recordStoreStocksToRestockHistory(page, { force: true }).catch(() => {});
}

/**
 * 由而家頁面跑取貨→聯絡→付款（一次嘗試）。
 * Fulfillment-init 詳細載入後：撳「我會前來取貨」→ 輸入「中環」→ 其餘步驟。
 * @returns true = 已到付款／帳單頁
 */
async function attemptPickupCheckoutToPayment(
  page: Page,
  identity: Identity,
  tag: string,
  session?: BrowserSession
): Promise<boolean> {
  usedPickupStoreKeys.clear();

  if (
    /\/shop\/checkout/i.test(page.url()) &&
    !isPickupContactPage(page.url()) &&
    !isBillingPage(page.url()) &&
    !isReviewPage(page.url())
  ) {
    const ready = await waitForFulfillmentInitDetailsReady(page);
    if (!ready) {
      console.warn("  Fulfillment-init 詳細內容未就緒，今次未能繼續");
      return false;
    }
  }

  console.log(
    `  繼續腳本：撳「我會前來取貨」→ 輸入「${CONFIG.pickupSearch || "中環"}」→ 揀店／聯絡／付款…`
  );
  await writeStatus({
    phase: "resuming_after_stock",
    message: `繼續：我會前來取貨 → ${CONFIG.pickupSearch || "中環"} → 其餘步驟`,
  }).catch(() => {});

  if (isPickupCreditCardGuest()) {
    const ready = await ensurePickupClickThenContinueReady(page);
    if (!ready) {
      console.warn("  pickup credit card訪客：未能喺 Fulfillment-init 繼續");
      return false;
    }
  } else {
    const pickupClicked = await clickPickupOption(page);
    if (pickupClicked) {
      console.log("  已揀：我會前來取貨");
    } else {
      console.warn("  撳唔到「我會前來取貨」（可能已揀）— 仍試輸入搜尋／揀店");
    }
    await sleepCheckingRelease(usesFastPickupContactFill() ? 150 : 400);
  }

  const storeOk = await choosePickupStore(page);
  if (!storeOk && !isPickupContactPage(page.url())) {
    console.warn("  今次取貨揀店失敗");
    return false;
  }

  if (usesFastPickupContactFill() && isPickupContactPage(page.url())) {
    await fillPickupContactGuestAndContinue(page, tag, session);
  }

  if (await isOnPaymentStep(page) || isBillingPage(page.url()) || isReviewPage(page.url())) {
    if (session && isBillingPage(page.url())) {
      await revealAndEnlargeBrowser(session).catch(() => {});
    }
    await fillBillingAddressFields(page, {
      useShippingAddress: shouldUseShippingAddressForBilling(session),
      session,
    }).catch(() => {});
    if (session) {
      await writeStatus({
        phase: "waiting_for_payment",
        windowHidden: true,
        windowState: "minimized",
        card: cardFieldsFromSession(session, { url: page.url() }),
      });
    }
    return true;
  }
  return false;
}

/**
 * 完整加購一次：產品頁 → 入袋 → 結帳 → 取貨揀店 → 付款頁。
 * @returns true = 已到付款／帳單頁
 */
async function attemptFullAddCartToPayment(
  page: Page,
  identity: Identity,
  tag: string,
  session?: BrowserSession
): Promise<boolean> {
  console.log(`${tag} 開始完整加購（${CONFIG.color}／${CONFIG.storage} ×${CONFIG.quantity}）…`);
  if (session) {
    await publishTaskSnapshot(session, "adding_cart", {
      message: "有貨：重新加購",
      url: CONFIG.buyUrl,
    }).catch(() => {});
  }

  await withReleaseCheck(
    page.goto(CONFIG.buyUrl, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {})
  );
  await dismissCookies(page).catch(() => {});
  if (isShop404Url(page.url())) {
    await recoverFromShop404IfNeeded(page, tag).catch(() => {});
  }

  if (!(isAttachStepUrl(CONFIG.buyUrl) || isAttachStepUrl(page.url()))) {
    if (
      !(
        isIphone17Task() &&
        (isConfiguredProductSlugUrl(CONFIG.buyUrl) || isConfiguredProductSlugUrl(page.url()))
      )
    ) {
      await selectProductOptions(page).catch(() => {});
    }
  }

  await addToBagAndOpenBag(page);
  await setBagQuantity(page, CONFIG.quantity).catch(() => {});
  await goToCheckout(page);
  await settleAfterNavigation(page);

  if (usesAppleAccount()) {
    await signInWithAppleAccount(page).catch(() => {});
  } else {
    await continueAsGuest(page).catch(() => {});
  }
  await settleAfterNavigation(page);

  return attemptPickupCheckoutToPayment(page, identity, tag, session);
}

/**
 * Monitor+buying：停喺 Fulfillment-init 待命。
 * 監察到同型號＋同色＋同容量有貨 → 每 5 秒 refresh Fulfillment-init → 繼續取貨／聯絡／付款。
 * 若頁面 503 → 隔 6 秒再 refresh，直到可用再跑腳本。
 * 若 refresh 後落單失敗，先再試完整加購一次；之後繼續每 5 秒 refresh。
 */
async function runMonitorHoldBuyLoop(
  page: Page,
  identity: Identity,
  tag: string,
  session?: BrowserSession
): Promise<void> {
  /** 連續幾耐冇「新」嘅匹配通知，就當呢波完 */
  const STOCK_IDLE_MS = 8_000;
  /** 有貨期間：正常 refresh 間隔 */
  const STOCK_REFRESH_MS = 5_000;
  let lastConsumedAt = 0;

  console.log(
    `${tag} Monitor+buying hold：等 ${CONFIG.model}／${CONFIG.color}／${CONFIG.storage} 有貨 → 每 ${STOCK_REFRESH_MS / 1000}s refresh Fulfillment-init（503→6s）→ 繼續加購`
  );

  while (true) {
    await ensureFulfillmentInitStandby(page);
    await writeStatus({
      phase: "waiting_for_stock_at_stores",
      message: `待命 Fulfillment-init：等 ${CONFIG.model}／${CONFIG.color}／${CONFIG.storage} 有貨再每 ${STOCK_REFRESH_MS / 1000}s refresh`,
      stuck: false,
      stuckSince: null,
    });
    await fs.unlink(STOCK_RESUME_SESSION_FLAG).catch(() => {});

    // 只要「而家之後」寫入嘅新通知（避免舊 flag 即刻誤觸）
    const gateAt = Math.max(lastConsumedAt, Date.now());
    let pending = await waitForMatchingStockResume({
      afterMs: gateAt,
    });

    while (pending) {
      lastConsumedAt = pending.atMs;
      const matchLabel = `${CONFIG.model}／${CONFIG.color}／${CONFIG.storage}`;

      console.log(
        `  監察匹配有貨 — ${matchLabel}：每 ${STOCK_REFRESH_MS / 1000}s refresh Fulfillment-init（503 則 6s）→ 繼續腳本…`
      );

      // 有貨波：持續 refresh，直到到付款頁或冇新匹配通知
      for (;;) {
        await writeStatus({
          phase: "resuming_after_stock",
          message: `有貨（${matchLabel}）：每 ${STOCK_REFRESH_MS / 1000}s refresh Fulfillment-init（503→6s）`,
        });

        await reloadFulfillmentInitUntilReady(page);

        try {
          let reachedPay = await attemptPickupCheckoutToPayment(
            page,
            identity,
            tag,
            session
          );
          if (!reachedPay) {
            console.warn(
              `${tag} refresh 後直接繼續失敗 — 改試完整加購（產品頁→入袋→結帳）…`
            );
            reachedPay = await attemptFullAddCartToPayment(
              page,
              identity,
              tag,
              session
            );
          }
          if (reachedPay) {
            console.log(`${tag} 已到付款頁 — 結束 monitor hold loop`);
            return;
          }
        } catch (err) {
          if (err instanceof ReleaseError) throw err;
          console.warn(
            `${tag} 今次加購嘗試失敗：`,
            err instanceof Error ? err.message : String(err)
          );
        }

        console.log(
          `  未到付款頁 — ${STOCK_REFRESH_MS / 1000}s 後再 refresh Fulfillment-init…`
        );
        const nextSoon = await waitForMatchingStockResume({
          afterMs: lastConsumedAt,
          timeoutMs: STOCK_REFRESH_MS,
        });
        if (nextSoon) {
          lastConsumedAt = nextSoon.atMs;
          continue;
        }

        // 5s 內冇新 flag：若最近仍有匹配庫存訊號，繼續 refresh；否則再等 idle 窗口
        const still = await readStockResumePayload();
        const stillMatch =
          still &&
          still.skus.some((s) => stockSkuMatchesCheckout(s)) &&
          Date.now() - still.atMs < STOCK_IDLE_MS;
        if (stillMatch) continue;

        pending = await waitForMatchingStockResume({
          afterMs: lastConsumedAt,
          timeoutMs: STOCK_IDLE_MS,
        });
        if (pending) {
          lastConsumedAt = pending.atMs;
          continue;
        }
        console.log(
          `  已 ${STOCK_IDLE_MS / 1000}s 冇新嘅 ${matchLabel} 通知 → 返 Fulfillment-init 待命`
        );
        break;
      }
    }
  }
}

async function clickPickupOption(page: Page): Promise<boolean> {
  return clickIfEnabled(
    [
      page.getByRole("radio", { name: /我會前來取貨/ }),
      page.getByRole("button", { name: /我會前來取貨/ }),
      page.getByLabel(/我會前來取貨/),
      page.getByText("我會前來取貨", { exact: false }),
    ],
    5000
  );
}

/** 撳「我會前來取貨」之後，係咪已經可以繼續（搜尋中環／門市列表）— 快速版，唔阻塞 10s */
async function canContinuePickupScriptsAfterPickupClick(page: Page): Promise<boolean> {
  if (isPickupContactPage(page.url())) return true;
  if (isBillingPage(page.url()) || isReviewPage(page.url())) return true;
  return page
    .evaluate(() => {
      const text = (document.body?.innerText || "").slice(0, 12000);
      if (/選擇取貨零售店|你附近的所有零售店|城市或地區|郵遞區號/.test(text)) {
        return true;
      }
      const inputs = Array.from(
        document.querySelectorAll(
          'input[type="text"], input[type="search"], input:not([type]), textarea'
        )
      ) as HTMLInputElement[];
      for (const el of inputs) {
        if (el.disabled || el.readOnly) continue;
        const blob =
          `${el.placeholder || ""} ${el.getAttribute("aria-label") || ""} ${el.name || ""} ${el.id || ""} ${el.getAttribute("data-autom") || ""}`.toLowerCase();
        if (/globalnav|搜尋 apple|search apple/.test(blob)) continue;
        if (/postal|zip|store|城市|地區|retail|location|pickup|取貨/.test(blob)) return true;
      }
      return false;
    })
    .catch(() => false);
}

/**
 * pickup credit card訪客模式：
 * Fulfillment-init 固定每 5 秒 hard refresh，直到：
 * 撳得「我會前來取貨」→ 輸入中環 → 見到門市掣（先交俾後面揀店）。
 */
async function ensurePickupClickThenContinueReady(page: Page): Promise<boolean> {
  const REFRESH_MS = 5_000;
  const maxRounds = 120; // ~10 分鐘

  console.log(
    `  pickup credit card訪客：Fulfillment-init 固定每 ${REFRESH_MS / 1000}s hard refresh，直至取貨＋搜尋＋門市可繼續…`
  );

  for (let round = 1; round <= maxRounds; round++) {
    const roundStarted = Date.now();
    await throwIfReleased();

    if (
      isPickupContactPage(page.url()) ||
      isBillingPage(page.url()) ||
      isReviewPage(page.url())
    ) {
      return true;
    }

    // 第 1 輪：若已喺 Fulfillment 就先試；之後每輪一開始都 hard refresh
    if (round === 1) {
      if (!/_s=Fulfillment/i.test(page.url()) || isShop404Url(page.url())) {
        if (isShop404Url(page.url())) {
          await recoverFromShop404IfNeeded(page, "[pickup-cc-guest]").catch(() => {});
        }
        await hardRefreshFulfillmentInit(page, `pickup-cc-guest-5s-#${round}`);
      }
    } else {
      await hardRefreshFulfillmentInit(page, `pickup-cc-guest-5s-#${round}`);
    }

    if (await isFulfillment503(page)) {
      console.warn(`  Fulfillment-init 503（第 ${round} 輪）— 等滿 ${REFRESH_MS / 1000}s 再 refresh`);
      await writeStatus({
        phase: "fulfillment_pickup_wait",
        message: `Fulfillment 503：${REFRESH_MS / 1000}s 後再 refresh（第 ${round} 輪）`,
        url: page.url(),
      }).catch(() => {});
      const left503 = Math.max(0, REFRESH_MS - (Date.now() - roundStarted));
      await sleepCheckingRelease(left503);
      continue;
    }

    if (await markPageErrorIfNotFound(page, `pickup-cc-guest-#${round}`)) {
      const waitMore = Math.max(0, REFRESH_MS - (Date.now() - roundStarted));
      await sleepCheckingRelease(waitMore);
      continue;
    }

    if (await recoverFromWrongAppleSearchIfNeeded(page, `pickup-cc-guest-#${round}`)) {
      const waitMore = Math.max(0, REFRESH_MS - (Date.now() - roundStarted));
      await sleepCheckingRelease(waitMore);
      continue;
    }

    await page
      .getByText(/我會前來取貨/, { exact: false })
      .first()
      .waitFor({ state: "visible", timeout: 1500 })
      .catch(() => {});

    const pickupClicked = await clickIfEnabled(
      [
        page.getByRole("radio", { name: /我會前來取貨/ }),
        page.getByRole("button", { name: /我會前來取貨/ }),
        page.getByLabel(/我會前來取貨/),
        page.getByText("我會前來取貨", { exact: false }),
      ],
      1200
    );
    if (pickupClicked) {
      console.log("  已揀：我會前來取貨");
      await sleepCheckingRelease(250);
    } else {
      console.warn(`  第 ${round} 輪：撳唔到「我會前來取貨」`);
    }

    // 一定要搜到門市掣先算「可繼續」——套用後會等列表載入
    const searched = await fillPickupSearchAndWaitHeading(page, { fast: true }).catch(
      () => false
    );
    if (searched) {
      const n = await countVisiblePickupStoreOptions(page);
      if (n >= 1) {
        console.log(`  ✓ 已見 ${n} 個門市掣，交俾揀店／繼續腳本`);
        return true;
      }
      console.warn(`  第 ${round} 輪：等載入後仍 0 門市掣`);
    }

    // 套用後已等過門市載入；之後先補夠節奏再 hard refresh
    const elapsed = Date.now() - roundStarted;
    const waitMore = Math.max(0, REFRESH_MS - elapsed);
    console.log(
      `  未可繼續 → ${waitMore}ms 後 hard refresh（第 ${round}/${maxRounds} 輪）`
    );
    await writeStatus({
      phase: "fulfillment_pickup_wait",
      message: `Fulfillment-init：每 ${REFRESH_MS / 1000}s refresh（第 ${round} 輪）`,
      url: page.url(),
    }).catch(() => {});
    await sleepCheckingRelease(waitMore);
  }

  console.warn("  pickup credit card訪客：多次 refresh 仍未能繼續原腳本");
  return false;
}

async function clickDeliveryOption(page: Page): Promise<boolean> {
  if (prefersPickupOnly()) {
    console.warn("  pickup-only：跳過「我希望送貨」");
    return false;
  }
  const locators = [
    page.getByRole("radio", { name: /我希望送貨/ }),
    page.getByRole("button", { name: /我希望送貨/ }),
    page.getByLabel(/我希望送貨/),
    page.getByText("我希望送貨", { exact: false }),
  ];
  for (const loc of locators) {
    const el = loc.first();
    if (!(await el.count().catch(() => 0))) continue;
    if (!(await visible(el, 2000)) && !(await el.count())) continue;
    await humanClick(el, { force: true }).catch(async () => {
      await page.waitForTimeout(CONFIG.clickDelayMs);
      await el.evaluate((n) => (n as HTMLElement).click()).catch(() => {});
    });
    return true;
  }
  return clickIfEnabled(locators, 4000);
}

async function tryPickupOnce(page: Page, attempt: number): Promise<boolean> {
  console.log(`  取貨嘗試 ${attempt}/3`);

  // pickup credit card訪客：每 5 秒 refresh，直到撳得取貨並可繼續腳本
  if (isPickupCreditCardGuest()) {
    const ready = await ensurePickupClickThenContinueReady(page);
    if (!ready) {
      console.warn("  「我會前來取貨」後仍未能繼續原腳本。");
      return false;
    }
    return choosePickupStore(page);
  }

  const pickupClicked = await clickPickupOption(page);
  if (!pickupClicked) {
    console.warn("  「我會前來取貨」今次唔可用。");
    return false;
  }
  console.log("  已揀：我會前來取貨");
  return choosePickupStore(page);
}

async function chooseFulfillment(page: Page): Promise<"pickup" | "delivery"> {
  console.log("步驟：揀取貨或送貨");
  usedPickupStoreKeys.clear();
  resetFulfillmentRefreshStats();
  await page.waitForTimeout(prefersPickupOnly() ? 200 : 800);

  if (await isSignInPage(page)) {
    await continueAsGuest(page);
  }

  if (/_s=Pickup|取貨詳情|PickupContact/i.test(page.url())) {
    console.log("  已經喺取貨詳情頁。");
    return "pickup";
  }
  if (/_s=Shipping/i.test(page.url())) {
    console.log("  已經喺送貨資料頁。");
    return "delivery";
  }

  if (prefersDeliveryOnly()) {
    console.log("  Dashboard／設定指定：直接走送貨。");
    await startDeliveryFlow(page);
    return "delivery";
  }

  // pickup-only（含 credit card訪客）：只取貨，永遠唔撳「我希望送貨」
  if (prefersPickupOnly()) {
    for (let attempt = 1; ; attempt++) {
      await throwIfReleased();
      await markPageErrorIfNotFound(page, "chooseFulfillment").catch(() => false);

      if (attempt > 1) {
        console.log(`  第 ${attempt} 次：refresh Fulfillment-init 再重試取貨（pickup-only）…`);
        await hardRefreshFulfillmentInit(page, `pickup-only-retry-#${attempt}`);
        if (isPickupContactPage(page.url())) return "pickup";
      }

      const ok = await tryPickupOnce(page, attempt);
      if (ok) {
        console.log("  取貨流程成功。");
        resetFulfillmentRefreshStats();
        return "pickup";
      }
      console.warn(
        `  取貨第 ${attempt} 次未成功 — pickup-only，唔撳「我希望送貨」，繼續 refresh…`
      );
      await sleepCheckingRelease(5_000);
    }
  }

  const pickupAttempts = 3;
  for (let attempt = 1; attempt <= pickupAttempts; attempt++) {
    if (attempt > 1) {
      console.log(`  第 ${attempt}/${pickupAttempts} 次：refresh Fulfillment-init 再重試取貨…`);
      await refreshFulfillmentPage(page);
      if (/_s=Shipping/i.test(page.url())) return "delivery";
      if (isPickupContactPage(page.url())) return "pickup";
    }

    const ok = await tryPickupOnce(page, attempt);
    if (ok) {
      console.log("  取貨流程成功。");
      resetFulfillmentRefreshStats();
      return "pickup";
    }
    console.warn(`  取貨第 ${attempt} 次未成功（會 refresh 成頁再試）。`);
  }

  console.warn("  Fulfillment 已 refresh 重試仍失敗，改用「我希望送貨」。");
  await startDeliveryFlow(page);
  return "delivery";
}

async function fillEditableFallback(
  page: Page,
  selectors: string[],
  value: string,
  step: string
): Promise<boolean> {
  for (const sel of selectors) {
    const field = page.locator(sel).first();
    if (!(await visible(field, 1200))) continue;
    const tag = await field.evaluate((el) => el.tagName.toLowerCase()).catch(() => "");
    if (tag === "select") {
      const ok = await field
        .selectOption({ label: value })
        .catch(async () => field.selectOption({ value }).catch(() => null));
      if (ok) {
        console.log(`  已選 fallback：${step} = ${value}`);
        return true;
      }
      continue;
    }
    await field.click({ force: true }).catch(() => {});
    await field.fill("");
    await field.fill(value);
    let current = await field.inputValue().catch(() => "");
    if (!current || !current.includes(value)) {
      await field.press("ControlOrMeta+A").catch(() => {});
      await field.type(value, { delay: 15 }).catch(() => {});
      current = await field.inputValue().catch(() => "");
    }
    if (!current || !current.includes(value)) {
      // React controlled input：設 value + 觸發 input/change
      await field
        .evaluate((el, v) => {
          const input = el as HTMLInputElement;
          const proto = Object.getPrototypeOf(input);
          const desc = Object.getOwnPropertyDescriptor(proto, "value");
          desc?.set?.call(input, v);
          input.dispatchEvent(new Event("input", { bubbles: true }));
          input.dispatchEvent(new Event("change", { bubbles: true }));
        }, value)
        .catch(() => {});
    }
    console.log(`  已填 fallback：${step} = ${value}`);
    return true;
  }
  return false;
}

/** Apple PickupContact 官方欄位 id（HK checkout／apw checkout 常用） */
const PICKUP_CONTACT_FIELD_IDS = {
  lastName: "checkout.pickupContact.selfPickupContact.selfContact.address.lastName",
  firstName: "checkout.pickupContact.selfPickupContact.selfContact.address.firstName",
  email: "checkout.pickupContact.selfPickupContact.selfContact.address.emailAddress",
  phone: "checkout.pickupContact.selfPickupContact.selfContact.address.fullDaytimePhone",
  emailConfirm:
    "checkout.pickupContact.selfPickupContact.selfContact.address.emailAddress.confirm",
} as const;

/** APW／其他變體 id（部分 secure*.store 會用） */
const PICKUP_CONTACT_FIELD_ID_ALTS: Record<keyof typeof PICKUP_CONTACT_FIELD_IDS, string[]> = {
  lastName: [
    "checkout.pickupContact.selfPickupContact.selfContact.address.lastName",
    "checkout.pickupContact.pickupContactAddress.lastName",
    "pickupContact.address.lastName",
  ],
  firstName: [
    "checkout.pickupContact.selfPickupContact.selfContact.address.firstName",
    "checkout.pickupContact.pickupContactAddress.firstName",
    "pickupContact.address.firstName",
  ],
  email: [
    "checkout.pickupContact.selfPickupContact.selfContact.address.emailAddress",
    "checkout.pickupContact.pickupContactAddress.emailAddress",
    "pickupContact.address.emailAddress",
  ],
  phone: [
    "checkout.pickupContact.selfPickupContact.selfContact.address.fullDaytimePhone",
    "checkout.pickupContact.pickupContactAddress.fullDaytimePhone",
    "pickupContact.address.fullDaytimePhone",
  ],
  emailConfirm: [
    "checkout.pickupContact.selfPickupContact.selfContact.address.emailAddress.confirm",
    "checkout.pickupContact.pickupContactAddress.emailAddress.confirm",
    "pickupContact.address.emailAddress.confirm",
  ],
};

async function waitForContactForm(page: Page, options?: { fast?: boolean }): Promise<boolean> {
  const fast = options?.fast ?? false;
  const maxRounds = fast ? 20 : 25;
  const pauseMs = fast ? 150 : 700;

  const candidates = [
    page.locator(`[id="${PICKUP_CONTACT_FIELD_IDS.lastName}"]`).first(),
    page.locator('input[autocomplete="family-name"]').first(),
    page.locator('input[id*="lastName" i]').first(),
    page.locator('input[name*="lastName" i]').first(),
    page.getByLabel(/^姓氏$|姓氏|Last name/i).first(),
    page.getByRole("textbox", { name: /姓氏|Last name/i }).first(),
    page.locator('input[type="tel"]').first(),
    page.locator('input[autocomplete="email"]').first(),
  ];

  for (let i = 0; i < maxRounds; i++) {
    for (const loc of candidates) {
      if ((await loc.count().catch(() => 0)) > 0) return true;
    }
    await page.waitForTimeout(pauseMs);
  }
  return false;
}

/** 對單個 locator 寫入並核對 value（React-friendly） */
async function fillLocatorVerified(
  page: Page,
  field: Locator,
  value: string,
  step: string
): Promise<boolean> {
  if (!(await field.count().catch(() => 0))) return false;
  await field.scrollIntoViewIfNeeded().catch(() => {});
  await sleepCheckingRelease(Math.min(CONFIG.clickDelayMs, 300));

  try {
    await field.click({ force: true, timeout: 1500 });
  } catch {
    /* continue */
  }

  // 1) Playwright fill
  await field.fill("").catch(() => {});
  await field.fill(value).catch(() => {});
  let current = await field.inputValue().catch(() => "");
  if (current === value || current.includes(value)) {
    console.log(`  已填：${step} = ${value}`);
    return true;
  }

  // 2) 全選 + type
  await field.press("ControlOrMeta+A").catch(() => {});
  await field.type(value, { delay: 12 }).catch(() => {});
  current = await field.inputValue().catch(() => "");
  if (current === value || current.includes(value)) {
    console.log(`  已填(type)：${step} = ${value}`);
    return true;
  }

  // 3) native setter + InputEvent（對付 controlled input）
  const ok = await field
    .evaluate((el, v) => {
      const input = el as HTMLInputElement;
      const proto = Object.getPrototypeOf(input);
      const desc = Object.getOwnPropertyDescriptor(proto, "value");
      desc?.set?.call(input, v);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      try {
        input.dispatchEvent(new InputEvent("input", { bubbles: true, data: v, inputType: "insertText" }));
      } catch {
        /* older */
      }
      return input.value === v || input.value.includes(v);
    }, value)
    .catch(() => false);

  if (ok) {
    console.log(`  已填(native)：${step} = ${value}`);
    return true;
  }
  console.warn(`  ${step} 填寫後 value 仍唔對（而家="${current}"）`);
  return false;
}

/** PickupContact 填一格：先官方 id，再 label／autocomplete */
async function fillPickupFieldFast(
  page: Page,
  opts: {
    exactId?: string;
    selectors: string[];
    labels?: Array<string | RegExp>;
    value: string;
    step: string;
  }
): Promise<boolean> {
  const { exactId, selectors, labels = [], value, step } = opts;

  if (exactId) {
    const byId = page.locator(`[id="${exactId}"]`).first();
    if (await fillLocatorVerified(page, byId, value, step)) return true;
  }

  for (const label of labels) {
    const candidates = [
      page.getByLabel(label).first(),
      page.getByRole("textbox", { name: label }).first(),
    ];
    for (const field of candidates) {
      if (!(await field.count().catch(() => 0))) continue;
      if (!(await field.isVisible().catch(() => false))) continue;
      if (await fillLocatorVerified(page, field, value, step)) return true;
    }
  }

  for (const sel of selectors) {
    const field = page.locator(sel).first();
    if (!(await field.count().catch(() => 0))) continue;
    // 只填可見欄，避免填到隱藏 input 當成功
    const visibleOk = await field.isVisible().catch(() => false);
    if (!visibleOk) {
      await field.scrollIntoViewIfNeeded().catch(() => {});
      if (!(await field.isVisible().catch(() => false))) continue;
    }
    if (await fillLocatorVerified(page, field, value, step)) return true;
  }
  return false;
}

/** 避免同一頁重複填 PickupContact（只填一次） */
const pickupContactFillDone = new WeakSet<Page>();
const pickupContactFillInFlight = new WeakSet<Page>();

async function readPickupContactValues(page: Page): Promise<{
  lastName: string;
  firstName: string;
  phone: string;
  email: string;
  emailConfirm: string;
}> {
  return page
    .evaluate((idMap) => {
      const readIds = (ids: string[]) => {
        for (const id of ids) {
          const el = document.getElementById(id) as HTMLInputElement | null;
          if (el?.value) return el.value.trim();
        }
        return "";
      };
      return {
        lastName:
          readIds(idMap.lastName) ||
          (document.querySelector('input[autocomplete="family-name"]') as HTMLInputElement | null)
            ?.value?.trim() ||
          "",
        firstName:
          readIds(idMap.firstName) ||
          (document.querySelector('input[autocomplete="given-name"]') as HTMLInputElement | null)
            ?.value?.trim() ||
          "",
        phone:
          readIds(idMap.phone) ||
          (document.querySelector('input[type="tel"]') as HTMLInputElement | null)?.value?.trim() ||
          "",
        email:
          readIds(idMap.email) ||
          (document.querySelector('input[autocomplete="email"]') as HTMLInputElement | null)
            ?.value?.trim() ||
          "",
        emailConfirm: readIds(idMap.emailConfirm),
      };
    }, PICKUP_CONTACT_FIELD_ID_ALTS)
    .catch(() => ({
      lastName: "",
      firstName: "",
      phone: "",
      email: "",
      emailConfirm: "",
    }));
}

function pickupContactMatchesExpected(
  vals: {
    lastName: string;
    firstName: string;
    phone: string;
    email: string;
  },
  expected?: PickupContact
): boolean {
  const options = expected ? [expected] : PICKUP_CONTACT_OPTIONS;
  const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
  return options.some((c) => {
    return (
      norm(vals.lastName) === norm(c.lastName) &&
      norm(vals.firstName) === norm(c.firstName) &&
      vals.phone.replace(/\D/g, "").includes(c.phone.replace(/\D/g, "")) &&
      norm(vals.email) === norm(c.email)
    );
  });
}

function proofreadPickupContactLog(
  vals: { lastName: string; firstName: string; phone: string; email: string; emailConfirm?: string },
  tag: string,
  expected?: PickupContact
): boolean {
  const c = expected || PICKUP_CONTACT;
  const ok = pickupContactMatchesExpected(vals, c);
  console.log(`${tag} 校對 PickupContact：`);
  console.log(`  姓氏：期望「${c.lastName}」／實際「${vals.lastName}」${normEq(vals.lastName, c.lastName) ? " ✓" : " ✗"}`);
  console.log(`  名字：期望「${c.firstName}」／實際「${vals.firstName}」${normEq(vals.firstName, c.firstName) ? " ✓" : " ✗"}`);
  console.log(
    `  電話：期望「${c.phone}」／實際「${vals.phone}」${vals.phone.replace(/\D/g, "").includes(c.phone) ? " ✓" : " ✗"}`
  );
  console.log(`  電郵：期望「${c.email}」／實際「${vals.email}」${normEq(vals.email, c.email) ? " ✓" : " ✗"}`);
  if (vals.emailConfirm != null && vals.emailConfirm !== "") {
    console.log(
      `  確認電郵：期望「${c.email}」／實際「${vals.emailConfirm}」${normEq(vals.emailConfirm, c.email) ? " ✓" : " ✗"}`
    );
  }
  console.log(`  校對結果：${ok ? "全部正確" : "有錯／未齊"}`);
  return ok;
}

function normEq(a: string, b: string): boolean {
  return a.replace(/\s+/g, " ").trim().toLowerCase() === b.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * 所有取貨模式：PickupContact-init（含 /shop/apw/checkout?_s=PickupContact-init）
 * 只 autofill 一次：隨機 Leung/Chi Fung 或 梁/志烽；電郵／電話固定
 */
async function fillPickupContactGuestAndContinue(
  page: Page,
  tag: string,
  session?: BrowserSession
): Promise<void> {
  if (isBillingPage(page.url()) || isReviewPage(page.url())) {
    console.log(`${tag} 已喺付款／帳單頁，跳過 PickupContact 填表`);
    if (session) session.fulfillmentMode = "pickup";
    return;
  }
  if (!isPickupContactPage(page.url()) && (await isOnPaymentStep(page))) {
    console.log(`${tag} 已喺付款步驟，跳過 PickupContact 填表`);
    if (session) session.fulfillmentMode = "pickup";
    return;
  }

  const c = resolvePickupContact(session, page);
  const alreadyDone =
    Boolean(session?.pickupContactFilledOnce) || pickupContactFillDone.has(page);

  if (!isPickupContactPage(page.url())) {
    await withReleaseCheck(
      page
        .waitForURL((url) => isPickupContactPage(url.toString()), { timeout: 12000 })
        .catch(() => {})
    );
  }

  // 已填過一次 → 只撳繼續，絕對唔再填
  if (alreadyDone) {
    console.log(`${tag} PickupContact 已 autofill 過一次，跳過重複填表`);
    if (session) session.fulfillmentMode = "pickup";
    if (isPickupContactPage(page.url())) {
      await clickContinueToPayment(page, session);
      await settleDom(page, 80);
    }
    return;
  }
  if (pickupContactFillInFlight.has(page)) {
    console.log(`${tag} PickupContact 正在填寫中，跳過重複呼叫`);
    return;
  }

  // 欄位已係正確值（任一套姓名）→ 標做已填一次，只繼續
  {
    const existing = await readPickupContactValues(page);
    if (pickupContactMatchesExpected(existing, c) || pickupContactMatchesExpected(existing)) {
      // 若頁面已係另一套正確姓名，跟住頁面嗰套
      const matched = PICKUP_CONTACT_OPTIONS.find((opt) =>
        pickupContactMatchesExpected(existing, opt)
      );
      if (matched) {
        if (session) session.pickupContact = matched;
        pickupContactByPage.set(page, matched);
      }
      proofreadPickupContactLog(existing, tag, matched || c);
      pickupContactFillDone.add(page);
      if (session) {
        session.pickupContactFilledOnce = true;
        session.fulfillmentMode = "pickup";
      }
      console.log(`${tag} 欄位已正確，唔重複填，直接繼續`);
      await clickContinueToPayment(page, session);
      await settleDom(page, 80);
      return;
    }
  }

  pickupContactFillInFlight.add(page);
  // 一開始就標「已填一次」，防止 chooseFulfillment／後續路徑再入嚟重填
  pickupContactFillDone.add(page);
  if (session) {
    session.pickupContactFilledOnce = true;
    session.fulfillmentMode = "pickup";
  }

  console.log(`${tag} 步驟：PickupContact 一次過 autofill（只此一次）`);
  console.log(`${tag} 目標：姓=${c.lastName} 名=${c.firstName} 電郵=${c.email} 電話=${c.phone}`);
  console.log(`${tag} URL=${page.url()}`);

  try {
    // 即刻等姓氏欄（最多 1.2s），唔走慢速 waitForContactForm
    await page
      .locator(`[id="${PICKUP_CONTACT_FIELD_IDS.lastName}"]`)
      .first()
      .waitFor({ state: "attached", timeout: 1200 })
      .catch(() => {});

    const ids = PICKUP_CONTACT_FIELD_IDS;
    const entries: Array<{ id: string; value: string; step: string }> = [
      { id: ids.lastName, value: c.lastName, step: "姓氏" },
      { id: ids.firstName, value: c.firstName, step: "名字" },
      { id: ids.phone, value: c.phone, step: "電話" },
      { id: ids.email, value: c.email, step: "電郵" },
      { id: ids.emailConfirm, value: c.email, step: "確認電郵" },
    ];

    // 五欄並行 fill 一次（唔逐格 type／唔多輪）
    await Promise.all(
      entries.map(async ({ id, value, step }) => {
        const alts = PICKUP_CONTACT_FIELD_ID_ALTS[
          step === "姓氏"
            ? "lastName"
            : step === "名字"
              ? "firstName"
              : step === "電話"
                ? "phone"
                : step === "確認電郵"
                  ? "emailConfirm"
                  : "email"
        ];
        for (const fid of [id, ...alts]) {
          const loc = page.locator(`[id="${fid}"]`).first();
          if ((await loc.count().catch(() => 0)) === 0) continue;
          await loc.fill(value, { timeout: 1200 }).catch(() => {});
          const got = await loc.inputValue().catch(() => "");
          if (got === value || got.includes(value)) {
            console.log(`  已填：${step} = ${value}`);
            return;
          }
        }
        // fallback autocomplete／type
        if (step === "姓氏") {
          await page.locator('input[autocomplete="family-name"]').first().fill(value).catch(() => {});
        } else if (step === "名字") {
          await page.locator('input[autocomplete="given-name"]').first().fill(value).catch(() => {});
        } else if (step === "電話") {
          await page.locator('input[type="tel"]').first().fill(value).catch(() => {});
        } else if (step === "電郵") {
          await page.locator('input[autocomplete="email"]').first().fill(value).catch(() => {});
        }
      })
    );

    const vals = await readPickupContactValues(page);
    const ok = proofreadPickupContactLog(vals, tag, c);
    if (ok) {
      console.log(
        `${tag} PickupContact 一次過填寫完成：${c.lastName} ${c.firstName} / ${c.phone} / ${c.email}`
      );
    } else {
      console.warn(
        `${tag} 校對未全啱（姓=${vals.lastName} 名=${vals.firstName} 電話=${vals.phone} 電郵=${vals.email}），唔再重填，直接繼續`
      );
    }

    await clickContinueToPayment(page, session);
    await settleDom(page, 80);
  } finally {
    pickupContactFillInFlight.delete(page);
  }
}

async function selectFirstAvailableOption(
  page: Page,
  selectors: string[],
  step: string
): Promise<boolean> {
  for (const sel of selectors) {
    const citySelect = page.locator(sel).first();
    if (!(await visible(citySelect, 800))) continue;
    const values = await citySelect
      .locator("option")
      .evaluateAll((opts) =>
        opts
          .map((o) => ({
            value: (o as HTMLOptionElement).value,
            label: (o.textContent || "").trim(),
          }))
          .filter((o) => o.value && o.label && !/請選擇|select|choose/i.test(o.label))
      )
      .catch(() => [] as { value: string; label: string }[]);
    if (values.length === 0) continue;
    const chosen = pick(values);
    await citySelect.selectOption(chosen.value);
    console.log(`  已隨機揀${step}：${chosen.label}`);
    return true;
  }
  return false;
}

async function readLabeledInputValue(page: Page, patterns: RegExp[]): Promise<string> {
  for (const re of patterns) {
    const byLabel = page.getByLabel(re).first();
    if (await visible(byLabel, 400)) {
      const tag = await byLabel.evaluate((el) => el.tagName.toLowerCase()).catch(() => "");
      if (tag === "select") {
        const text = await byLabel.evaluate((el) => {
          const sel = el as HTMLSelectElement;
          return sel.options[sel.selectedIndex]?.text?.trim() || sel.value || "";
        }).catch(() => "");
        if (text) return text;
      } else {
        const v = (await byLabel.inputValue().catch(() => "")) || "";
        if (v.trim()) return v.trim();
      }
    }
    const byRole = page.getByRole("textbox", { name: re }).first();
    if (await visible(byRole, 300)) {
      const v = (await byRole.inputValue().catch(() => "")) || "";
      if (v.trim()) return v.trim();
    }
  }
  return "";
}

async function readDeliveryShippingBoxes(
  page: Page,
  identity: Identity,
  buildingFallback: string
): Promise<DeliveryShippingBoxes> {
  const lastName =
    (await readLabeledInputValue(page, [/^姓氏$/, /^姓$/, /Last name/i, /Family name/i])) ||
    identity.lastName;
  const firstName =
    (await readLabeledInputValue(page, [/^名字$/, /^名$/, /First name/i, /Given name/i])) ||
    identity.firstName;
  const area =
    (await readLabeledInputValue(page, [/^區域$/, /Area|Province|State/i])) || identity.area;
  const district =
    (await readLabeledInputValue(page, [/^地區$/, /City|District/i])) || identity.district;
  const street =
    (await readLabeledInputValue(page, [
      /街道名稱/,
      /街道地址/,
      /Address Line 1/i,
      /地址第 1 行/,
      /^街道$/,
      /Street/i,
    ])) || identity.street;
  const buildingFloorUnit =
    (await readLabeledInputValue(page, [
      /屋苑或大廈/,
      /座數/,
      /樓層/,
      /單位/,
      /地址第 2 行/,
      /Address Line 2/i,
    ])) ||
    identity.buildingLine ||
    buildingFallback;

  return {
    lastName,
    firstName,
    areaDistrictStreet: `${area} ${district} ${street}`.replace(/\s+/g, " ").trim(),
    buildingFloorUnit,
  };
}

async function fillContactFields(
  page: Page,
  identity: Identity,
  mode: "pickup" | "delivery",
  session?: BrowserSession,
  options?: { skipFormWait?: boolean }
): Promise<void> {
  // 取貨：兩套姓名隨機其一；送貨用 session identity
  const contact =
    mode === "pickup"
      ? resolvePickupContact(session, page)
      : {
          lastName: identity.lastName,
          firstName: identity.firstName,
          email: identity.email,
          phone: identity.phone,
        };

  console.log(`  等待${mode === "pickup" ? "取貨" : "送貨"}表單載入…`);
  console.log(
    `  將填寫：${contact.lastName} ${contact.firstName} / ${contact.phone} / ${contact.email}`
  );
  const deliveryApplePayFast = mode === "delivery" && isDeliveryApplePay();
  if (!options?.skipFormWait) {
    const formReady = await waitForContactForm(page, {
      fast: mode === "pickup" || deliveryApplePayFast,
    });
    if (!formReady) {
      console.warn("  表單欄位仍未出現，再等一次…");
      await page.waitForTimeout(mode === "pickup" || deliveryApplePayFast ? 400 : 2000);
    }
  }

  const addressLine2 = identity.buildingLine || randomBuildingLine();
  if (mode === "delivery") {
    identity.buildingLine = addressLine2;
  }
  if (mode === "delivery" && session) {
    session.deliveryAddressFull = `${identity.area} ${identity.district} ${identity.street}，${addressLine2}`;
    session.deliveryShippingBoxes = {
      lastName: contact.lastName,
      firstName: contact.firstName,
      areaDistrictStreet: `${identity.area} ${identity.district} ${identity.street}`,
      buildingFloorUnit: addressLine2,
    };
  }

  // ---- 姓名 ----
  let lastOk = false;
  let firstOk = false;
  for (let attempt = 1; attempt <= 3 && (!lastOk || !firstOk); attempt++) {
    if (!lastOk) {
      lastOk =
        (await fillByLabels(
          page,
          [/^姓氏$/, /姓氏/, /^姓$/, /Last name/i, /Family name/i],
          contact.lastName,
          "姓氏"
        )) ||
        (await fillEditableFallback(
          page,
          [
            `[id="${PICKUP_CONTACT_FIELD_IDS.lastName}"]`,
            'input[autocomplete="family-name"]',
            'input[name*="lastName" i]',
            'input[id*="lastName" i]',
            'input[data-autom*="lastName" i]',
            'input[data-autom*="last-name" i]',
            'input[data-autom*="LastName" i]',
            'input[name*="selfContact" i][name*="lastName" i]',
            'input[name*="pickupContact" i][name*="lastName" i]',
          ],
          contact.lastName,
          "姓氏"
        ));
    }
    if (!firstOk) {
      firstOk =
        (await fillByLabels(
          page,
          [/^名字$/, /名字/, /^名$/, /First name/i, /Given name/i],
          contact.firstName,
          "名字"
        )) ||
        (await fillEditableFallback(
          page,
          [
            `[id="${PICKUP_CONTACT_FIELD_IDS.firstName}"]`,
            'input[autocomplete="given-name"]',
            'input[name*="firstName" i]',
            'input[id*="firstName" i]',
            'input[data-autom*="firstName" i]',
            'input[data-autom*="first-name" i]',
            'input[data-autom*="FirstName" i]',
            'input[name*="selfContact" i][name*="firstName" i]',
            'input[name*="pickupContact" i][name*="firstName" i]',
          ],
          contact.firstName,
          "名字"
        ));
    }
    if (!lastOk || !firstOk) await page.waitForTimeout(deliveryApplePayFast ? 200 : 800);
  }
  if (!lastOk) console.warn("  姓氏仍未填到");
  if (!firstOk) console.warn("  名字仍未填到");

  // ---- 送貨地址 ----
  if (mode === "delivery") {
    let areaOk =
      (await selectByLabels(page, [/^區域$/, /Area|Province|State/i], identity.area, "區域")) ||
      (await fillEditableFallback(
        page,
        [
          'select[name*="state" i]',
          'select[name*="province" i]',
          'select[id*="state" i]',
          'select[data-autom*="state" i]',
          'select[data-autom*="province" i]',
        ],
        identity.area,
        "區域"
      ));
    if (!areaOk) {
      areaOk = await selectFirstAvailableOption(
        page,
        [
          'select[name*="state" i]',
          'select[name*="province" i]',
          'select[data-autom*="state" i]',
        ],
        "區域"
      );
    }
    await page.waitForTimeout(deliveryApplePayFast ? 200 : 700);

    let districtOk =
      (await selectByLabels(
        page,
        [/^地區$/, /District|City/i],
        identity.district,
        "地區"
      )) ||
      (await fillByLabels(page, [/^地區$/, /City/i], identity.district, "地區")) ||
      (await fillEditableFallback(
        page,
        [
          'select[name*="city" i]',
          'select[id*="city" i]',
          'select[data-autom*="city" i]',
          'input[name*="city" i]',
          'input[autocomplete="address-level2"]',
        ],
        identity.district,
        "地區"
      ));
    if (!districtOk) {
      districtOk = await selectFirstAvailableOption(
        page,
        ['select[name*="city" i]', 'select[id*="city" i]', 'select[data-autom*="city" i]'],
        "地區"
      );
    }

    let streetOk =
      (await fillByLabels(
        page,
        [/街道名稱/, /街道地址/, /Address Line 1/i, /地址第 1 行/, /^街道$/, /Street/i],
        identity.street,
        "街道名稱"
      )) ||
      (await fillEditableFallback(
        page,
        [
          'input[autocomplete="address-line1"]',
          'input[name*="street" i]',
          'input[name*="address1" i]',
          'input[name*="addressLine1" i]',
          'input[id*="street" i]',
          'input[data-autom*="street" i]',
          'input[data-autom*="addressLine1" i]',
        ],
        identity.street,
        "街道名稱"
      ));
    if (!streetOk) console.warn("  街道仍未填到");

    await fillByLabels(
      page,
      [/地址第 2 行/, /Address Line 2/i, /大廈|樓層|單位/],
      addressLine2,
      "地址第2行"
    );
    await fillEditableFallback(
      page,
      [
        'input[autocomplete="address-line2"]',
        'input[name*="address2" i]',
        'input[name*="addressLine2" i]',
        'input[data-autom*="addressLine2" i]',
      ],
      addressLine2,
      "地址第2行"
    );
  }

  if (mode === "delivery" && session) {
    const boxes = await readDeliveryShippingBoxes(page, identity, addressLine2);
    session.deliveryShippingBoxes = boxes;
    session.deliveryAddressFull = `${boxes.areaDistrictStreet}，${boxes.buildingFloorUnit}`;
    identity.buildingLine = boxes.buildingFloorUnit;
    console.log(
      `  已記錄 Shipping 四格：${boxes.lastName}／${boxes.firstName}／${boxes.areaDistrictStreet}／${boxes.buildingFloorUnit}`
    );
  }

  // ---- 電話 ----
  let phoneOk = false;
  for (let attempt = 1; attempt <= 3 && !phoneOk; attempt++) {
    phoneOk =
      (await fillByLabels(
        page,
        [/流動電話/, /日間聯絡電話/, /電話號碼/, /^電話$/, /Mobile/i, /Phone number/i],
        contact.phone,
        "電話"
      )) ||
      (await fillEditableFallback(
        page,
        [
          `[id="${PICKUP_CONTACT_FIELD_IDS.phone}"]`,
          'input[id*="fullDaytimePhone" i]',
          'input[type="tel"]',
          'input[autocomplete="tel"]',
          'input[autocomplete="tel-national"]',
          'input[name*="phone" i]',
          'input[id*="phone" i]',
          'input[data-autom*="phone" i]',
          'input[data-autom*="daytimePhone" i]',
        ],
        contact.phone,
        "電話"
      ));
    if (!phoneOk) await page.waitForTimeout(deliveryApplePayFast ? 200 : 600);
  }
  if (!phoneOk) console.warn("  電話仍未填到");

  // ---- 電郵 + 確認電郵 ----
  let emailOk = false;
  for (let attempt = 1; attempt <= 3 && !emailOk; attempt++) {
    emailOk =
      (await fillByLabels(
        page,
        [/電子郵件地址/, /電子郵件/, /電郵地址/, /^電郵$/, /Email address/i, /^Email$/i],
        contact.email,
        "電郵"
      )) ||
      (await fillEditableFallback(
        page,
        [
          `[id="${PICKUP_CONTACT_FIELD_IDS.email}"]`,
          'input[type="email"]',
          'input[autocomplete="email"]',
          'input[name*="email" i]:not([name*="confirm" i])',
          'input[id*="email" i]:not([id*="confirm" i])',
          'input[data-autom*="email" i]:not([data-autom*="confirm" i])',
        ],
        contact.email,
        "電郵"
      ));
    if (!emailOk) await page.waitForTimeout(deliveryApplePayFast ? 200 : 600);
  }
  if (!emailOk) console.warn("  電郵仍未填到");

  await fillByLabels(
    page,
    [/確認電郵/, /確認電子郵件/, /再次輸入/, /Email again/i, /Confirm email/i],
    contact.email,
    "確認電郵"
  );
  await fillEditableFallback(
    page,
    [
      `[id="${PICKUP_CONTACT_FIELD_IDS.emailConfirm}"]`,
      'input[name*="emailConfirm" i]',
      'input[name*="confirmEmail" i]',
      'input[id*="emailConfirm" i]',
      'input[data-autom*="emailConfirm" i]',
      'input[data-autom*="confirmEmail" i]',
    ],
    contact.email,
    "確認電郵"
  );

  const consents = page.getByRole("checkbox", {
    name: /接收|同意|條款|更新|newsletter|updates/i,
  });
  const consentCount = await consents.count().catch(() => 0);
  for (let i = 0; i < Math.min(consentCount, 3); i++) {
    const box = consents.nth(i);
    if (!(await visible(box, 400))) continue;
    const checked = await box.isChecked().catch(() => false);
    const name = ((await box.getAttribute("aria-label").catch(() => "")) || "").toLowerCase();
    const text = ((await box.innerText().catch(() => "")) || "").toLowerCase();
    if (/同意|條款|terms|privacy|本人確認/.test(`${name} ${text}`) && !checked) {
      await page.waitForTimeout(CONFIG.clickDelayMs);
      await box.check({ force: true }).catch(() => {});
      console.log("  已勾選同意條款");
    }
  }

  const missing: string[] = [];
  if (!lastOk) missing.push("姓氏");
  if (!firstOk) missing.push("名字");
  if (!phoneOk) missing.push("電話");
  if (!emailOk) missing.push("電郵");
  if (missing.length) {
    throw new StepError(
      "填寫聯絡資料",
      `以下欄位未成功自動填寫：${missing.join("、")}。會返回重試。`
    );
  }
  console.log("  聯絡資料已全部填寫");
}

/** Review／PickupContact 等「使用Apple Pay繼續」撳掣：見下方 clickApplePayContinueFast */

async function clickContinueToPayment(
  page: Page,
  session?: BrowserSession
): Promise<void> {
  const pickupGuestFast = usesFastPickupContactFill() && isPickupContactPage(page.url());
  const applePayFast = usesApplePay();
  await page.waitForTimeout(pickupGuestFast || applePayFast ? 30 : 800);

  // pickup apple pay：PickupContact 即刻撳「使用Apple Pay繼續」
  if (isPickupApplePay()) {
    const beforeUrl = page.url();
    const clicked = await clickApplePayContinueFast(page, {
      waitMs: 16_000,
      pollMs: 25,
      hammer: true,
    });
    if (!clicked) {
      throw new StepError(
        "使用Apple Pay繼續",
        "揾唔到「使用Apple Pay繼續」掣。請人手撳。"
      );
    }
    await withReleaseCheck(
      page
        .waitForURL((url) => url.toString() !== beforeUrl, { timeout: 20000 })
        .catch(() => {})
    );
    await settleDom(page, 100);
    return;
  }

  const paymentBtns = [
    page.getByRole("button", { name: /前往付款/ }),
    page.getByRole("button", { name: /繼續前往付款/ }),
    page.getByRole("button", { name: /Continue to Payment/i }),
    page.getByRole("button", { name: /繼續結帳/ }),
    page.locator('[data-autom*="continue" i]'),
    page.getByRole("button", { name: /^繼續$/ }),
  ];

  const beforeUrl = page.url();
  for (let attempt = 1; attempt <= 4; attempt++) {
    const clicked = await clickFirstVisible(paymentBtns, {
      timeout: pickupGuestFast ? 2500 : 5000,
      force: true,
    });
    if (clicked) {
      console.log("  已撳前往付款");
      break;
    }
    if (attempt === 4) {
      throw new StepError("前往付款", "揾唔到「前往付款／繼續」掣。請人手撳。");
    }
    console.warn(`  前往付款掣第 ${attempt} 次未撳到，再等…`);
    await page.waitForTimeout(pickupGuestFast ? 350 : 1500);
  }

  await withReleaseCheck(
    page
      .waitForURL((url) => url.toString() !== beforeUrl || isBillingPage(url.toString()), {
        timeout: pickupGuestFast ? 15000 : 30000,
      })
      .catch(() => {})
  );
  if (pickupGuestFast || isPickupCreditCardGuest() || usesApplePay() || usesAppleAccount()) {
    await settleDom(page, 150);
  } else {
    await settleAfterNavigation(page);
  }

  // 如果仲喺取貨聯絡／送貨／履行頁，再試一次
  if (
    isPickupContactPage(page.url()) ||
    /_s=Shipping|_s=Fulfillment/i.test(page.url())
  ) {
    console.warn("  仍未離開聯絡／送貨頁，再試撳前往付款…");
    await clickFirstVisible(paymentBtns, { timeout: 3000 });
    await withReleaseCheck(
      page.waitForURL((url) => isBillingPage(url.toString()), { timeout: 20000 }).catch(() => {})
    );
    await settleDom(page, 300);
  }

  if (
    isPickupContactPage(page.url()) ||
    /_s=Shipping|_s=Fulfillment/i.test(page.url())
  ) {
    throw new StepError(
      "前往付款",
      "仍然未去到付款頁，可能資料未通過驗證。請人手改好再撳前往付款。"
    );
  }

  // 帳單地址頁：先開全螢幕，再勾送貨地址／填欄（或 Apple Pay）
  if (isBillingPage(page.url()) || /Billing-init/i.test(page.url())) {
    if (session) await revealAndEnlargeBrowser(session);
    await fillBillingAddressFields(page, {
      useShippingAddress: shouldUseShippingAddressForBilling(session),
      session,
    }).catch((err) => {
      console.warn(
        `  帳單地址自動填寫未完成：${err instanceof Error ? err.message : String(err)}`
      );
    });
  }
}

async function fillInputInAnyFrame(
  page: Page,
  selectors: string[],
  value: string
): Promise<boolean> {
  const frames = page.frames();
  for (const frame of frames) {
    for (const sel of selectors) {
      const el = frame.locator(sel).first();
      if ((await el.count().catch(() => 0)) === 0) continue;
      const tag = await el.evaluate((n) => n.tagName.toLowerCase()).catch(() => "");
      if (tag === "select") {
        const ok = await el
          .selectOption({ value })
          .then(() => true)
          .catch(async () =>
            el
              .selectOption({ label: value })
              .then(() => true)
              .catch(async () =>
                el.selectOption({ index: Number(value) }).then(() => true).catch(() => false)
              )
          );
        if (ok) return true;
        continue;
      }
      const ok = await el
        .fill(value, { timeout: 1500 })
        .then(() => true)
        .catch(async () => {
          await el.click({ force: true, timeout: 800 }).catch(() => {});
          await el.fill("").catch(() => {});
          await el.type(value, { delay: 15 }).catch(() => {});
          return true;
        })
        .catch(() => false);
      if (ok) return true;
    }
  }
  // DOM evaluate fallback across frames
  for (const frame of frames) {
    const filled = await frame
      .evaluate(
        ({ sels, val }) => {
          for (const sel of sels) {
            let nodes: NodeListOf<Element>;
            try {
              nodes = document.querySelectorAll(sel);
            } catch {
              continue;
            }
            for (const node of Array.from(nodes)) {
              const el = node as HTMLInputElement | HTMLSelectElement;
              if (!el || (el as HTMLInputElement).disabled) continue;
              const style = window.getComputedStyle(el);
              if (style.display === "none" || style.visibility === "hidden") continue;
              el.focus();
              if (el.tagName.toLowerCase() === "select") {
                const selEl = el as HTMLSelectElement;
                const opt = Array.from(selEl.options).find(
                  (o) => o.value === val || o.textContent?.trim() === val || o.value.endsWith(val)
                );
                if (opt) {
                  selEl.value = opt.value;
                  selEl.dispatchEvent(new Event("input", { bubbles: true }));
                  selEl.dispatchEvent(new Event("change", { bubbles: true }));
                  return true;
                }
                continue;
              }
              const input = el as HTMLInputElement;
              input.value = val;
              input.dispatchEvent(new Event("input", { bubbles: true }));
              input.dispatchEvent(new Event("change", { bubbles: true }));
              return true;
            }
          }
          return false;
        },
        { sels: selectors, val: value }
      )
      .catch(() => false);
    if (filled) return true;
  }
  return false;
}

async function detectBillingCardDecline(page: Page): Promise<boolean> {
  const text = ((await page.locator("body").innerText().catch(() => "")) || "").slice(0, 8000);
  return /未能處理|無法處理|付款失敗|交易被拒|信用卡被拒|卡被拒絕|declined|could not process|payment failed|card was declined|invalid card|無效.*卡|請檢查.*卡|驗證失敗/i.test(
    text
  );
}

async function autofillAssignedCreditCard(
  page: Page,
  session?: BrowserSession
): Promise<boolean> {
  if (selectsApplePayAtBilling()) return false;
  const card = await loadAssignedCheckoutCard(
    CHECKOUT_CARD_ASSIGN_PATH,
    CHECKOUT_CARD_KEY_PATH
  ).catch(() => null);
  if (!card) {
    console.warn("  無分配信用卡（Dashboard 未 Save／池已用盡）— 跳過 autofill");
    return false;
  }

  console.log(
    `步驟：Billing autofill 信用卡 ****${card.number.slice(-4)}（${card.exp}）`
  );
  if (session) {
    session.capturedCardNumber = card.number;
    if (card.limit != null) {
      session.cardLimit = formatHkLimit(card.limit);
    }
    await writeStatus({
      card: {
        cardNumber: card.number,
        cardType: detectCardType(card.number),
        cardLimit: card.limit != null ? formatHkLimit(card.limit) : undefined,
      },
      message: `autofill card ****${card.number.slice(-4)}`,
    }).catch(() => {});
  }

  await sleepCheckingRelease(400);
  const numberOk = await fillInputInAnyFrame(
    page,
    [
      'input[autocomplete="cc-number"]',
      'input[name*="cardNumber" i]',
      'input[id*="cardNumber" i]',
      'input[name*="card-number" i]',
      'input[data-autom*="cardNumber" i]',
      'input[data-autom*="card-number" i]',
      'input[placeholder*="卡號" i]',
      'input[placeholder*="Card number" i]',
      'input[aria-label*="卡號" i]',
      'input[aria-label*="Card number" i]',
    ],
    card.number
  );

  const [mm, yy] = card.exp.split("/");
  const expCombined = card.exp;
  const expOkCombined = await fillInputInAnyFrame(
    page,
    [
      'input[autocomplete="cc-exp"]',
      'input[name*="expiration" i]',
      'input[name*="expiry" i]',
      'input[id*="expiration" i]',
      'input[id*="expiry" i]',
      'input[data-autom*="expiration" i]',
      'input[data-autom*="expiry" i]',
      'input[placeholder*="月" i]',
      'input[placeholder*="MM" i]',
      'input[aria-label*="有效期" i]',
      'input[aria-label*="Expiry" i]',
    ],
    expCombined
  );
  let expOk = expOkCombined;
  if (!expOk && mm && yy) {
    const monthOk = await fillInputInAnyFrame(
      page,
      [
        'input[autocomplete="cc-exp-month"]',
        'input[name*="expMonth" i]',
        'input[name*="month" i]',
        'select[name*="expMonth" i]',
        'select[autocomplete="cc-exp-month"]',
      ],
      mm
    );
    const yearOk = await fillInputInAnyFrame(
      page,
      [
        'input[autocomplete="cc-exp-year"]',
        'input[name*="expYear" i]',
        'input[name*="year" i]',
        'select[name*="expYear" i]',
        'select[autocomplete="cc-exp-year"]',
      ],
      yy.length === 2 ? `20${yy}` : yy
    );
    // also try 2-digit year
    if (!yearOk) {
      await fillInputInAnyFrame(
        page,
        [
          'input[autocomplete="cc-exp-year"]',
          'input[name*="expYear" i]',
          'select[name*="expYear" i]',
        ],
        yy
      );
    }
    expOk = monthOk || yearOk;
  }

  const cvvOk = await fillInputInAnyFrame(
    page,
    [
      'input[autocomplete="cc-csc"]',
      'input[name*="securityCode" i]',
      'input[name*="cvv" i]',
      'input[name*="cvc" i]',
      'input[id*="cvv" i]',
      'input[id*="cvc" i]',
      'input[data-autom*="security" i]',
      'input[data-autom*="cvv" i]',
      'input[placeholder*="安全碼" i]',
      'input[placeholder*="CVV" i]',
      'input[aria-label*="安全碼" i]',
      'input[aria-label*="CVV" i]',
      'input[aria-label*="CVC" i]',
    ],
    card.cvv
  );

  console.log(
    `  卡號=${numberOk ? "OK" : "fail"}｜有效期=${expOk ? "OK" : "fail"}｜CVV=${cvvOk ? "OK" : "fail"}`
  );
  return numberOk || expOk || cvvOk;
}

async function markAssignedCardRejected(card: VaultCard | null, reason: string): Promise<void> {
  if (!card) return;
  await excludeCheckoutCardById(CHECKOUT_CARD_STATE_PATH, card.id).catch(() => {});
  await writeStatus({
    phase: "card_rejected",
    cardRejected: true,
    message: `信用卡被拒／失敗 ****${card.number.slice(-4)}：${reason}`,
  }).catch(() => {});
  console.warn(`  信用卡拒單／失敗 ****${card.number.slice(-4)}｜${reason}（卡仍可再分配）`);
}

async function autofillCardThenCheckOrder(
  page: Page,
  session?: BrowserSession
): Promise<void> {
  const card = await loadAssignedCheckoutCard(
    CHECKOUT_CARD_ASSIGN_PATH,
    CHECKOUT_CARD_KEY_PATH
  ).catch(() => null);
  const filled = await autofillAssignedCreditCard(page, session);
  if (!filled) return;

  await sleepCheckingRelease(500);
  console.log("  autofill 後自動撳「檢查你的訂單」…");
  const checked = await clickCheckYourOrder(page);
  if (await detectBillingCardDecline(page)) {
    await markAssignedCardRejected(card, "Billing 頁顯示拒單／錯誤");
    return;
  }
  if (!isReviewPage(page.url())) {
    await withReleaseCheck(
      page
        .waitForURL((url) => isReviewPage(url.toString()), { timeout: 12_000 })
        .catch(() => {})
    );
  }
  if (isReviewPage(page.url())) {
    console.log("  已到 Review（信用卡 autofill）→ 自動撳「立即提交訂單」…");
    await completeCreditCardReviewSubmit(page, session, card);
    return;
  }
  if (!checked) {
    console.warn("  「檢查你的訂單」未成功，稍後人手／外層會再試");
  }
}

/** Credit cards 池：Review 頁撳「立即提交訂單」完成落單 */
async function clickSubmitOrderOnReview(page: Page): Promise<boolean> {
  console.log(`步驟：Review「立即提交訂單」｜${page.url()}`);
  if (!isReviewPage(page.url())) {
    await withReleaseCheck(
      page
        .waitForURL((url) => isReviewPage(url.toString()), { timeout: 10_000 })
        .catch(() => {})
    );
  }
  if (!isReviewPage(page.url())) {
    console.warn(`  未喺 Review，跳過提交訂單：${page.url()}`);
    return false;
  }

  await scrollPageToBottom(page).catch(() => {});
  await sleepCheckingRelease(400);

  const deadline = Date.now() + 45_000;
  let clicks = 0;
  while (Date.now() < deadline) {
    await throwIfReleased();
    if (!isReviewPage(page.url())) {
      console.log(`  已離開 Review → ${page.url()}`);
      return true;
    }
    if (CONFIRM_URL.test(page.url())) return true;

    let hit = await clickCheckoutButtonByDomText(page, PLACE_ORDER_NEEDLES, {
      allowDisabled: false,
    });
    if (!hit) {
      const locs = [
        page.getByRole("button", { name: PLACE_ORDER_RE }),
        page.getByRole("link", { name: PLACE_ORDER_RE }),
        page.locator(
          'button:has-text("立即提交訂單"), a:has-text("立即提交訂單"), button:has-text("提交訂單"), button:has-text("下訂單")'
        ),
        page.locator(
          '[data-autom*="placeOrder" i], [data-autom*="place-order" i], #rs-checkout-continue-button-bottom, .rs-checkout-continuebutton button'
        ),
      ];
      for (const loc of locs) {
        const el = loc.first();
        if ((await el.count().catch(() => 0)) === 0) continue;
        hit = await forceClickLocator(el, "立即提交訂單", clicks + 1);
        if (hit) break;
      }
    }

    if (!hit) {
      console.warn("  今輪揾唔到「立即提交訂單」，稍後再試…");
      await sleepCheckingRelease(600);
      continue;
    }

    clicks += 1;
    console.log(`  已撳「立即提交訂單」第 ${clicks} 次 — 等 loading／跳頁…`);
    await waitForCheckoutLoadingSettled(page, {
      timeoutMs: 20_000,
      stayOn: (url) => isReviewPage(url) && !CONFIRM_URL.test(url),
    }).catch(() => {});

    await withReleaseCheck(
      page
        .waitForURL(
          (url) => !isReviewPage(url.toString()) || CONFIRM_URL.test(url.toString()),
          { timeout: 8_000 }
        )
        .catch(() => {})
    );

    if (!isReviewPage(page.url()) || CONFIRM_URL.test(page.url())) {
      console.log(`  提交後頁面：${page.url()}`);
      return true;
    }
    if (await detectBillingCardDecline(page)) {
      console.warn("  Review／提交後偵測到拒單文案");
      return false;
    }
  }

  console.warn(`  Review 仍未提交成功（已撳 ${clicks} 次）：${page.url()}`);
  return clicks > 0 && !isReviewPage(page.url());
}

async function completeCreditCardReviewSubmit(
  page: Page,
  session?: BrowserSession,
  card?: VaultCard | null
): Promise<void> {
  const assigned =
    card ||
    (await loadAssignedCheckoutCard(
      CHECKOUT_CARD_ASSIGN_PATH,
      CHECKOUT_CARD_KEY_PATH
    ).catch(() => null));

  const ok = await clickSubmitOrderOnReview(page);
  if (await detectBillingCardDecline(page)) {
    await markAssignedCardRejected(assigned, "Review／提交訂單拒單");
    return;
  }
  if (!ok && isReviewPage(page.url())) {
    console.warn("  「立即提交訂單」未成功離開 Review");
    return;
  }

  // 等確認頁／訂單編號短暫出現
  await settleDom(page, 400);
  await withReleaseCheck(
    page
      .waitForURL((url) => CONFIRM_URL.test(url.toString()), { timeout: 15_000 })
      .catch(() => {})
  );

  if (session) {
    await writeStatus({
      phase: CONFIRM_URL.test(page.url()) ? "orders_ready" : "steps_complete",
      message: CONFIRM_URL.test(page.url())
        ? "已撳立即提交訂單 → 確認頁"
        : "已撳立即提交訂單",
      card: cardFieldsFromSession(session, {
        url: page.url(),
        cardNumber: assigned?.number || session.capturedCardNumber,
      }),
    }).catch(() => {});
  }
  console.log(
    `  Credit card 流程：已處理「立即提交訂單」｜而家 ${page.url()}`
  );
}

async function selectCreditOrDebitCard(page: Page): Promise<boolean> {
  console.log("步驟：揀「信用卡或扣賬卡」");
  await page.waitForTimeout(500);
  const locators = [
    page.getByRole("button", { name: /信用卡或扣賬卡/ }),
    page.getByRole("radio", { name: /信用卡或扣賬卡/ }),
    page.getByRole("link", { name: /信用卡或扣賬卡/ }),
    page.getByLabel(/信用卡或扣賬卡/),
    page.getByText(/信用卡或扣賬卡/, { exact: false }),
    page.getByRole("button", { name: /Credit or Debit Card/i }),
    page.getByRole("radio", { name: /Credit or Debit Card/i }),
    page.locator(
      '[data-autom*="credit" i], [data-autom*="debit" i], [data-autom*="card" i], [aria-label*="信用卡" i]'
    ),
  ];

  for (const loc of locators) {
    const el = loc.first();
    if (!(await el.count().catch(() => 0))) continue;
    await el.scrollIntoViewIfNeeded().catch(() => {});
    if (!(await visible(el, 1500)) && !(await el.count())) continue;
    await page.waitForTimeout(CONFIG.clickDelayMs);
    await humanClick(el, { force: true }).catch(async () => {
      await el.evaluate((n) => (n as HTMLElement).click()).catch(() => {});
    });
    console.log("  已撳「信用卡或扣賬卡」");
    await page.waitForTimeout(1000);
    return true;
  }

  console.warn("  揾唔到「信用卡或扣賬卡」掣（可能已選中或頁面結構不同）");
  return false;
}

async function selectApplePayPayment(page: Page): Promise<boolean> {
  console.log("步驟：揀 Apple Pay（Billing）");
  await sleepCheckingRelease(400);

  // 等付款方式區載入（短等）
  for (let i = 0; i < 15; i++) {
    await throwIfReleased();
    const ready =
      (await page
        .locator(
          '[data-autom*="applepay" i], [data-autom*="apple-pay" i], [data-autom*="paymentOption" i], input[value*="APPLE" i]'
        )
        .count()
        .catch(() => 0)) > 0 ||
      (await page.getByText(/Apple\s*Pay|信用卡或扣賬卡/i).count().catch(() => 0)) > 0;
    if (ready) break;
    await sleepCheckingRelease(250);
  }

  const tryClick = async (el: Locator, how: string): Promise<boolean> => {
    if (!(await el.count().catch(() => 0))) return false;
    await el.scrollIntoViewIfNeeded().catch(() => {});
    // 即使暫時報唔 visible 都 force 撳（Billing 有時被遮）
    await sleepCheckingRelease(CONFIG.clickDelayMs);
    const ok = await humanClick(el, { force: true })
      .then(() => true)
      .catch(async () => {
        await el
          .evaluate((n) => {
            const node = n as HTMLElement;
            const clickable =
              (node.closest("label") as HTMLElement | null) ||
              (node.closest("button") as HTMLElement | null) ||
              (node.closest("[role='radio']") as HTMLElement | null) ||
              (node.closest("[role='button']") as HTMLElement | null) ||
              node;
            clickable.click();
          })
          .then(() => true)
          .catch(() => false);
      });
    if (ok) {
      console.log(`  已撳 Apple Pay（${how}）`);
      await sleepCheckingRelease(400);
      return true;
    }
    return false;
  };

  // 1) 常見 Apple Store data-autom / value
  const automLocators = [
    page.locator('[data-autom*="applepay" i]'),
    page.locator('[data-autom*="apple-pay" i]'),
    page.locator('[data-autom*="APPLE_PAY" i]'),
    page.locator('[data-autom*="paymentOption" i][data-autom*="apple" i]'),
    page.locator('input[value*="APPLE_PAY" i], input[value*="applepay" i], input[id*="applepay" i]'),
    page.locator('[aria-label*="Apple Pay" i], [title*="Apple Pay" i]'),
    page.locator("apple-pay-button, .apple-pay-button, [class*='apple-pay' i]"),
  ];
  for (const loc of automLocators) {
    if (await tryClick(loc.first(), "data-autom/value")) return true;
  }

  // 2) 可讀名稱／文字
  const named = [
    page.getByRole("radio", { name: /Apple\s*Pay/i }),
    page.getByRole("button", { name: /Apple\s*Pay/i }),
    page.getByRole("listitem", { name: /Apple\s*Pay/i }),
    page.getByLabel(/Apple\s*Pay/i),
    page.locator("label").filter({ hasText: /Apple\s*Pay/i }),
    page.locator("li, div, span, button").filter({ hasText: /^[\s]*Apple\s*Pay[\s]*$/i }),
  ];
  for (const loc of named) {
    if (await tryClick(loc.first(), "accessible name / text")) return true;
  }

  // 3) 用戶指出：Billing 付款方式第二個掣 = Apple Pay
  const paymentGroupSelectors = [
    '[data-autom*="paymentOption" i]',
    '[data-autom*="payment-option" i]',
    '[data-autom*="billing" i] [role="radio"]',
    '[data-autom*="payment" i] [role="radio"]',
    'fieldset input[type="radio"]',
    '[class*="payment" i] [role="radio"]',
    '[class*="payment" i] button',
    '[class*="Payment" i] li',
    'form [role="listbox"] [role="option"]',
  ];
  for (const sel of paymentGroupSelectors) {
    const group = page.locator(sel);
    const count = await group.count().catch(() => 0);
    if (count >= 2) {
      // 第二個（index 1）
      if (await tryClick(group.nth(1), `第 2 個付款選項（共 ${count}，selector=${sel}）`)) {
        return true;
      }
    }
  }

  // 4) DOM 掃描：含 Apple Pay 字樣／logo 嘅可撳父層
  const clickedViaDom = await page
    .evaluate(() => {
      const isApplePayish = (el: Element) => {
        const t = `${el.getAttribute("data-autom") || ""} ${el.getAttribute("aria-label") || ""} ${el.getAttribute("id") || ""} ${el.getAttribute("value") || ""} ${el.textContent || ""}`.toLowerCase();
        return /apple\s*pay|applepay|apple_pay/.test(t);
      };
      const clickableAncestor = (el: Element): HTMLElement | null => {
        let cur: Element | null = el;
        for (let i = 0; i < 6 && cur; i++) {
          const tag = cur.tagName.toLowerCase();
          const role = (cur.getAttribute("role") || "").toLowerCase();
          if (
            tag === "button" ||
            tag === "label" ||
            tag === "a" ||
            tag === "li" ||
            role === "radio" ||
            role === "button" ||
            role === "option" ||
            (tag === "input" && (cur as HTMLInputElement).type === "radio")
          ) {
            return cur as HTMLElement;
          }
          cur = cur.parentElement;
        }
        return el as HTMLElement;
      };
      const all = Array.from(
        document.querySelectorAll(
          "button, label, li, a, input[type=radio], [role=radio], [role=button], [data-autom], apple-pay-button"
        )
      );
      for (const el of all) {
        if (!isApplePayish(el)) continue;
        const target = clickableAncestor(el);
        if (!target) continue;
        target.click();
        return true;
      }
      // 後備：付款區第二個 radio／button（querySelector 唔支援 i flag）
      const radios = Array.from(
        document.querySelectorAll(
          '[data-autom*="payment"] [role=radio], [data-autom*="Payment"] [role=radio], [data-autom*="paymentOption"], [data-autom*="payment-option"], fieldset input[type=radio], [role=radio]'
        )
      ).filter((n) => {
        const r = n.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      });
      if (radios.length >= 2) {
        (radios[1] as HTMLElement).click();
        return true;
      }
      return false;
    })
    .catch(() => false);

  if (clickedViaDom) {
    console.log("  已撳 Apple Pay（DOM 掃描／第二個付款選項）");
    await sleepCheckingRelease(1000);
    return true;
  }

  console.warn("  揾唔到 Apple Pay 掣");
  return false;
}

/** 強制撳掣：scroll → humanClick → DOM click */
async function forceClickLocator(el: Locator, label: string, nth: number): Promise<boolean> {
  await el.scrollIntoViewIfNeeded().catch(() => {});
  await sleepCheckingRelease(CONFIG.clickDelayMs);
  const ok = await humanClick(el, { force: true })
    .then(() => true)
    .catch(async () => {
      return el
        .evaluate((n) => {
          const node = n as HTMLElement;
          const btn =
            (node.closest("button") as HTMLElement | null) ||
            (node.closest("a") as HTMLElement | null) ||
            (node.closest('[role="button"]') as HTMLElement | null) ||
            node;
          btn.scrollIntoView({ block: "center", inline: "nearest" });
          btn.click();
        })
        .then(() => true)
        .catch(() => false);
    });
  if (ok) console.log(`  已撳「${label}」（第 ${nth} 次）`);
  return ok;
}

/** 用 DOM 文字掃描撳 checkout 主掣（Apple 有時唔係標準 role=button） */
async function clickCheckoutButtonByDomText(
  page: Page,
  needles: string[],
  opts?: { allowDisabled?: boolean; looseApplePay?: boolean }
): Promise<boolean> {
  return page
    .evaluate(
      (args) => {
        const norm = (s: string) =>
          (s || "")
            .replace(/[\s\u00a0\u200b\u200c\u200d\ufeff]+/g, "")
            .toLowerCase();
        const wanted = args.texts.map(norm).filter(Boolean);
        const allowDisabled = Boolean(args.allowDisabled);
        const looseApplePay = Boolean(args.looseApplePay);
        const nodes = Array.from(
          document.querySelectorAll(
            [
              "button",
              "a[role='button']",
              "a.button",
              "[role='button']",
              "input[type='submit']",
              "input[type='button']",
              "[data-autom*='continue' i]",
              "[data-autom*='placeOrder' i]",
              "[data-autom*='applepay' i]",
              "[data-autom*='ApplePay' i]",
              ".rs-checkout-continuebutton",
              "#rs-checkout-continue-button-bottom",
              "#rs-checkout-continue-button-top",
              "apple-pay-button",
            ].join(", ")
          )
        );
        const labelOf = (el: Element) => {
          const html = el as HTMLElement;
          return norm(
            (html.textContent || "") +
              " " +
              ((html as HTMLInputElement).value || "") +
              " " +
              (html.getAttribute("aria-label") || "") +
              " " +
              (html.getAttribute("title") || "") +
              " " +
              (html.getAttribute("data-autom") || "")
          );
        };
        const matches = (raw: string) => {
          if (!raw) return false;
          if (wanted.some((w) => raw.includes(w))) return true;
          if (
            looseApplePay &&
            raw.includes("pay") &&
            (raw.includes("繼續") || raw.includes("continue"))
          ) {
            return true;
          }
          return false;
        };
        const fire = (target: HTMLElement) => {
          target.scrollIntoView({ block: "center", inline: "nearest" });
          try {
            target.focus?.();
          } catch {
            /* ignore */
          }
          for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
            try {
              target.dispatchEvent(
                new MouseEvent(type, { bubbles: true, cancelable: true, view: window })
              );
            } catch {
              /* ignore */
            }
          }
          try {
            target.click();
          } catch {
            /* ignore */
          }
        };
        for (const el of nodes) {
          const raw = labelOf(el);
          if (!matches(raw)) continue;
          const target = el as HTMLElement;
          const disabled =
            (target as HTMLButtonElement).disabled ||
            target.getAttribute("aria-disabled") === "true" ||
            target.hasAttribute("disabled");
          if (disabled && !allowDisabled) continue;
          fire(target);
          return true;
        }
        return false;
      },
      {
        texts: needles,
        allowDisabled: opts?.allowDisabled === true,
        looseApplePay: opts?.looseApplePay === true,
      }
    )
    .catch(() => false);
}

/**
 * Review 頁專用：撳主 CTA（唔靠「Apple」字樣；官網常用  SVG）
 * 任何 secureN /shop/checkout?_s=Review 或 apw/checkout?_s=Review*
 */
async function clickReviewPagePrimaryCta(page: Page): Promise<boolean> {
  // 1) 直接 DOM 評分揀主掣
  const domHit = await page
    .evaluate(() => {
      const norm = (s: string) =>
        (s || "")
          .replace(/[\s\u00a0\u200b\u200c\u200d\ufeff\uf8ff]+/g, "")
          .toLowerCase();

      const candidates = Array.from(
        document.querySelectorAll(
          [
            "[data-autom='continueButton']",
            "[data-autom*='continue' i]",
            "#rs-checkout-continue-button-bottom",
            "#rs-checkout-continue-button-top",
            ".rs-checkout-continuebutton button",
            ".rs-checkout-continuebutton a",
            "button.button-block",
            "button.form-button",
            "button[type='submit']",
            "apple-pay-button",
            "[is='apple-pay-button']",
            "button",
            "a[role='button']",
            "[role='button']",
          ].join(", ")
        )
      ) as HTMLElement[];

      type Scored = { el: HTMLElement; score: number; label: string };
      const scored: Scored[] = [];

      for (const el of candidates) {
        const rect = el.getBoundingClientRect();
        if (rect.width < 40 || rect.height < 18) continue;
        // 必須大致喺視窗內或頁底 sticky
        const style = window.getComputedStyle(el);
        if (style.visibility === "hidden" || style.display === "none") continue;
        if (Number(style.opacity || "1") === 0) continue;

        const label = norm(
          (el.innerText || el.textContent || "") +
            " " +
            (el.getAttribute("aria-label") || "") +
            " " +
            (el.getAttribute("data-autom") || "") +
            " " +
            (el.id || "")
        );

        let score = 0;
        const autom = (el.getAttribute("data-autom") || "").toLowerCase();
        if (autom.includes("continue")) score += 40;
        if (/rs-checkout-continue|continue-button/i.test(el.id || "")) score += 35;
        if (el.tagName === "APPLE-PAY-BUTTON") score += 50;
        if (label.includes("pay") && label.includes("繼續")) score += 80;
        if (label.includes("apple") && label.includes("pay")) score += 50;
        if (label.includes("繼續") && label.includes("使用")) score += 45;
        if (label.includes("continue") && label.includes("pay")) score += 70;
        if (label === "繼續" || label.endsWith("繼續")) score += 20;
        // 主掣通常較闊
        if (rect.width >= 200) score += 15;
        if (rect.width >= 280) score += 10;
        // sticky／接近底部
        if (rect.bottom > window.innerHeight * 0.55) score += 10;
        if (style.position === "fixed" || style.position === "sticky") score += 12;

        if (score < 25) continue;
        scored.push({ el, score, label });
      }

      scored.sort((a, b) => b.score - a.score);
      const best = scored[0];
      if (!best) return { ok: false, label: "", score: 0 };

      const target = best.el;
      target.scrollIntoView({ block: "center", inline: "nearest" });
      try {
        target.focus?.();
      } catch {
        /* ignore */
      }
      for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
        try {
          target.dispatchEvent(
            new MouseEvent(type, { bubbles: true, cancelable: true, view: window, buttons: 1 })
          );
        } catch {
          /* ignore */
        }
      }
      try {
        target.click();
      } catch {
        /* ignore */
      }
      // 再撳一次 parent button（文字可能喺 span）
      const btn =
        (target.closest("button") as HTMLElement | null) ||
        (target.closest("a") as HTMLElement | null) ||
        target;
      if (btn !== target) {
        try {
          btn.click();
        } catch {
          /* ignore */
        }
      }
      return { ok: true, label: best.label.slice(0, 60), score: best.score };
    })
    .catch(() => ({ ok: false, label: "", score: 0 }));

  if (domHit && (domHit as { ok?: boolean }).ok) {
    console.log(
      `  Review 主 CTA DOM 已撳（score=${(domHit as { score?: number }).score} label=${(domHit as { label?: string }).label}）`
    );
    return true;
  }

  // 2) Playwright + 滑鼠座標（有時 DOM click 被遮罩攔截）
  const locs = [
    page.locator('[data-autom="continueButton"]').first(),
    page.locator('[data-autom*="continue" i]').filter({ hasText: /繼續|Pay|Continue/i }).first(),
    page.locator("#rs-checkout-continue-button-bottom, #rs-checkout-continue-button-top").first(),
    page.getByRole("button", { name: APPLE_PAY_CONTINUE_RE }).first(),
    page.getByRole("button", { name: /使用.*繼續|Continue/i }).first(),
    page.locator("apple-pay-button, [is='apple-pay-button']").first(),
    page.locator("button.button-block, button.form-button, button[type='submit']").filter({
      hasText: /繼續|Pay|Continue/i,
    }).first(),
  ];

  for (const el of locs) {
    if ((await el.count().catch(() => 0)) === 0) continue;
    await el.scrollIntoViewIfNeeded().catch(() => {});
    const box = await el.boundingBox().catch(() => null);
    if (box) {
      await page.mouse
        .click(box.x + box.width / 2, box.y + box.height / 2, { delay: 20 })
        .then(() => true)
        .catch(() => false);
      console.log("  Review 主 CTA 已用 mouse.click");
      return true;
    }
    const ok = await el
      .click({ force: true, timeout: 1200 })
      .then(() => true)
      .catch(async () =>
        el
          .evaluate((n) => (n as HTMLElement).click())
          .then(() => true)
          .catch(() => false)
      );
    if (ok) {
      console.log("  Review 主 CTA 已用 locator.click");
      return true;
    }
  }

  return false;
}

/**
 * 強化撳「使用Apple Pay繼續」：
 * 適用 ?_s=Review（任何 secureN／checkout／apw/checkout）同 PickupContact 等相同掣。
 */
async function clickApplePayContinueFast(
  page: Page,
  opts?: { waitMs?: number; label?: string; pollMs?: number; hammer?: boolean }
): Promise<boolean> {
  const waitMs = opts?.waitMs ?? (isReviewPage(page.url()) ? 16_000 : 8_000);
  const label = opts?.label ?? "使用Apple Pay繼續";
  const needles = APPLE_PAY_CONTINUE_NEEDLES;
  const onReview = isReviewPage(page.url());
  const pollMs = opts?.pollMs ?? (onReview ? 20 : 45);
  const deadline = Date.now() + waitMs;
  let clicked = false;

  console.log(
    `步驟：即刻撳「${label}」${onReview ? "（Review 強化）" : ""}`
  );

  while (Date.now() < deadline) {
    await throwIfReleased();

    // Review：優先用主 CTA 掃描（Pay 文字唔穩）
    if (onReview || isReviewPage(page.url())) {
      if (await clickReviewPagePrimaryCta(page)) {
        clicked = true;
        if (!opts?.hammer) return true;
        await page.waitForTimeout(150);
        if (!isReviewPage(page.url())) return true;
      }
    }

    // 1) 強化 DOM（含 disabled／data-autom／sticky footer）
    if (
      await clickCheckoutButtonByDomText(page, needles, {
        allowDisabled: true,
        looseApplePay: true,
      })
    ) {
      console.log(`  已撳「${label}」（strong DOM）`);
      clicked = true;
      if (!opts?.hammer) return true;
      await page.waitForTimeout(120);
      if (!isReviewPage(page.url())) return true;
    }

    // 2) data-autom / sticky CTA
    const automCandidates = [
      page.locator('[data-autom="continueButton"], [data-autom*="continue" i]').filter({
        hasText: /繼續|Pay|Continue/i,
      }),
      page.locator(
        "#rs-checkout-continue-button-bottom, #rs-checkout-continue-button-top, .rs-checkout-continuebutton button, .rs-checkout-continuebutton a"
      ),
      page.locator("apple-pay-button, [is='apple-pay-button']"),
      page.locator('button[type="submit"]').filter({ hasText: /繼續|Pay|Continue/i }),
    ];
    for (const loc of automCandidates) {
      const el = loc.first();
      if ((await el.count().catch(() => 0)) === 0) continue;
      const box = await el.boundingBox().catch(() => null);
      let ok = false;
      if (box) {
        ok = await page.mouse
          .click(box.x + box.width / 2, box.y + box.height / 2)
          .then(() => true)
          .catch(() => false);
      }
      if (!ok) {
        ok = await el
          .click({ force: true, timeout: 900 })
          .then(() => true)
          .catch(async () =>
            el
              .evaluate((n) => {
                const node = n as HTMLElement;
                const btn =
                  (node.closest("button") as HTMLElement | null) ||
                  (node.closest("a") as HTMLElement | null) ||
                  node;
                btn.click();
              })
              .then(() => true)
              .catch(() => false)
          );
      }
      if (ok) {
        console.log(`  已撳「${label}」（autom/sticky）`);
        clicked = true;
        if (!opts?.hammer) return true;
        await page.waitForTimeout(120);
        if (!isReviewPage(page.url())) return true;
      }
    }

    // 3) Playwright role／text（含「使用 Pay 繼續」）
    const candidates = [
      page.getByRole("button", { name: APPLE_PAY_CONTINUE_RE }).first(),
      page.getByRole("link", { name: APPLE_PAY_CONTINUE_RE }).first(),
      page.getByText(APPLE_PAY_CONTINUE_RE).first(),
      page.locator('button:has-text("Pay"), a:has-text("Pay")').filter({
        hasText: /繼續|Continue/i,
      }).first(),
      page.locator('button:has-text("繼續")').filter({ hasText: /Pay|使用/i }).first(),
    ];
    for (const el of candidates) {
      if ((await el.count().catch(() => 0)) === 0) continue;
      const ok = await el
        .click({ force: true, timeout: 800 })
        .then(() => true)
        .catch(async () =>
          el
            .evaluate((n) => {
              const node = n as HTMLElement;
              (node.closest("button") || node.closest("a") || node).click();
            })
            .then(() => true)
            .catch(() => false)
        );
      if (ok) {
        console.log(`  已撳「${label}」（fast）`);
        clicked = true;
        if (!opts?.hammer) return true;
        await page.waitForTimeout(120);
        if (!isReviewPage(page.url())) return true;
      }
    }

    if (clicked && !isReviewPage(page.url())) return true;
    await page.waitForTimeout(pollMs);
  }

  if (clicked) {
    console.log(`  「${label}」已撳過，繼續`);
    return true;
  }
  console.warn(`  撳唔到「${label}」`);
  return false;
}

/**
 * Billing／Review 主掣雙重確認。
 * onceOnly=true：只做一輪兩下（Review「使用Apple Pay繼續」）。
 * onceOnly=false：最多 3 輪，直到離開 stayUrlTest 頁（Billing「檢查你的訂單」）。
 */
async function doubleConfirmCheckoutCta(
  page: Page,
  label: string,
  patterns: RegExp[],
  domNeedles: string[],
  opts?: {
    onceOnly?: boolean;
    /** 仍喺呢個步驟先繼續撳第二下／再一輪 */
    stillOnStep?: (url: string) => boolean;
    waitMs?: number;
    gapMs?: number;
  }
): Promise<boolean> {
  const onceOnly = opts?.onceOnly === true;
  const maxRounds = onceOnly ? 1 : 3;
  const waitMs = opts?.waitMs ?? 20_000;
  const gapMs = opts?.gapMs ?? 550;
  const stillOnStep = opts?.stillOnStep ?? (() => true);

  const locatorsFor = (p: Page): Locator[] => {
    const out: Locator[] = [];
    for (const re of patterns) {
      out.push(p.getByRole("button", { name: re }));
      out.push(p.getByRole("link", { name: re }));
    }
    for (const t of domNeedles) {
      out.push(p.getByRole("button", { name: t }));
      out.push(p.getByRole("link", { name: t }));
      out.push(p.locator(`button:has-text("${t}")`));
      out.push(p.locator(`a:has-text("${t}")`));
      out.push(p.getByText(t, { exact: false }));
    }
    out.push(
      p.locator('[data-autom*="continue" i]').filter({
        hasText: /檢查|訂單|Apple\s*Pay|繼續|Review|Check/i,
      })
    );
    return out;
  };

  const findTarget = async (): Promise<Locator | null> => {
    for (const loc of locatorsFor(page)) {
      const el = loc.first();
      const n = await el.count().catch(() => 0);
      if (!n) continue;
      const vis = await visible(el, 400);
      const enabled = await el.isEnabled().catch(() => true);
      if (vis && enabled) return el;
      if (vis) return el; // 仍試 force
      if (n > 0) return el;
    }
    return null;
  };

  console.log(
    onceOnly
      ? `步驟：雙重確認撳「${label}」（只一輪）`
      : `步驟：雙重確認撳「${label}」（可多輪直到離開呢一步）`
  );

  // 先等掣出現
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    await throwIfReleased();
    if (await findTarget()) break;
    // DOM 文字都試吓有冇
    const hasText = await page.getByText(domNeedles[0] || label, { exact: false }).first().isVisible().catch(() => false);
    if (hasText) break;
    await sleepCheckingRelease(400);
  }

  for (let round = 1; round <= maxRounds; round++) {
    await throwIfReleased();
    if (!stillOnStep(page.url())) {
      console.log(`  「${label}」已離開當前步驟，唔使再撳`);
      return true;
    }

    console.log(`  「${label}」雙重確認 round ${round}/${maxRounds}`);
    let clickedOnce = false;

    const target = await findTarget();
    if (target) {
      clickedOnce = await forceClickLocator(target, label, 1);
    }
    if (!clickedOnce) {
      clickedOnce = await clickCheckoutButtonByDomText(page, domNeedles);
      if (clickedOnce) console.log(`  已撳「${label}」（第 1 次／DOM）`);
    }
    if (!clickedOnce) {
      console.warn(`  round ${round}：揾唔到「${label}」`);
      if (onceOnly) return false;
      await sleepCheckingRelease(1000);
      continue;
    }

    await sleepCheckingRelease(gapMs);
    await settleAfterNavigation(page);

    if (!stillOnStep(page.url())) {
      console.log(`  「${label}」撳完第 1 次已跳頁`);
      return true;
    }

    // 第二下（雙重確認）— 同一輪內
    let clickedTwice = false;
    const again = await findTarget();
    if (again) {
      clickedTwice = await forceClickLocator(again, label, 2);
    }
    if (!clickedTwice) {
      clickedTwice = await clickCheckoutButtonByDomText(page, domNeedles);
      if (clickedTwice) console.log(`  已撳「${label}」（第 2 次／DOM）`);
    }
    if (!clickedTwice) {
      console.log(`  「${label}」第二次掣已唔見（可能已跳頁）`);
    }

    await settleAfterNavigation(page);
    if (!stillOnStep(page.url())) return true;
    if (onceOnly) {
      // Review：只一輪兩下，唔再重試
      return clickedOnce || clickedTwice;
    }
    await sleepCheckingRelease(1200);
  }

  return !stillOnStep(page.url());
}

/** 只撳一次 checkout CTA（唔雙重確認） */
async function clickCheckoutCtaOnce(
  page: Page,
  label: string,
  patterns: RegExp[],
  domNeedles: string[],
  opts?: { waitMs?: number; pollMs?: number }
): Promise<boolean> {
  const waitMs = opts?.waitMs ?? 12_000;
  const pollMs = opts?.pollMs ?? (usesApplePay() ? 80 : 300);
  const deadline = Date.now() + waitMs;

  const findTarget = async (): Promise<Locator | null> => {
    for (const re of patterns) {
      for (const loc of [
        page.getByRole("button", { name: re }),
        page.getByRole("link", { name: re }),
      ]) {
        const el = loc.first();
        if ((await el.count().catch(() => 0)) > 0) return el;
      }
    }
    for (const t of domNeedles) {
      for (const loc of [
        page.locator(`button:has-text("${t}")`),
        page.locator(`a:has-text("${t}")`),
        page.getByRole("button", { name: t }),
      ]) {
        const el = loc.first();
        if ((await el.count().catch(() => 0)) > 0) return el;
      }
    }
    return null;
  };

  console.log(`步驟：撳一次「${label}」`);
  while (Date.now() < deadline) {
    await throwIfReleased();
    // Apple Pay 流程：先 DOM 快撳，跳過 humanClick delay
    if (
      usesApplePay() &&
      (await clickCheckoutButtonByDomText(page, domNeedles, {
        allowDisabled: true,
        looseApplePay: /apple\s*pay/i.test(label),
      }))
    ) {
      console.log(`  已撳「${label}」（fast DOM）`);
      return true;
    }
    const target = await findTarget();
    if (target) {
      if (usesApplePay()) {
        const ok = await target
          .click({ force: true, timeout: 1200 })
          .then(() => true)
          .catch(async () =>
            target
              .evaluate((n) => {
                const node = n as HTMLElement;
                (node.closest("button") || node.closest("a") || node).click();
              })
              .then(() => true)
              .catch(() => false)
          );
        if (ok) {
          console.log(`  已撳「${label}」（fast）`);
          return true;
        }
      } else {
        const ok = await forceClickLocator(target, label, 1);
        if (ok) return true;
      }
    }
    if (await clickCheckoutButtonByDomText(page, domNeedles)) {
      console.log(`  已撳「${label}」（DOM）`);
      return true;
    }
    await sleepCheckingRelease(pollMs);
  }
  console.warn(`  撳唔到「${label}」`);
  return false;
}

async function clickCheckYourOrder(page: Page): Promise<boolean> {
  const patterns = [
    /檢查你的訂單/,
    /檢查您的訂單/,
    /Review Your Order|Check Your Order/i,
  ];
  const needles = CHECK_ORDER_NEEDLES;

  /**
   * 所有 Delivery method（Billing-init）：
   * 撳一次 → 等 loading logo 消失 → 若仍喺 Billing 再撳一次 → 重複直到下一頁
   */
  console.log(
    `步驟：Billing「檢查你的訂單」（撳一次→等 loading→再試）｜${page.url()}`
  );
  const deadline = Date.now() + 60_000;
  let clicks = 0;

  while (Date.now() < deadline) {
    await throwIfReleased();

    if (isReviewPage(page.url())) {
      console.log(`  已到 Review（「檢查你的訂單」累計撳 ${clicks} 次）`);
      return true;
    }
    if (!isBillingPage(page.url()) && clicks > 0) {
      console.log(`  已離開 Billing → ${page.url()}`);
      return true;
    }

    // 等上一次 loading 完先再撳
    if (await isCheckoutLoadingVisible(page)) {
      console.log("  仍見 loading，先等消失…");
      await waitForCheckoutLoadingSettled(page, { timeoutMs: 18_000 });
      if (isReviewPage(page.url()) || (!isBillingPage(page.url()) && clicks > 0)) {
        return true;
      }
    }

    let hit = await clickCheckoutButtonByDomText(page, needles, {
      allowDisabled: false,
    });
    if (!hit) {
      const autom = [
        page.locator('[data-autom="continueButton"], [data-autom*="continue" i]').filter({
          hasText: CHECK_ORDER_RE,
        }),
        page.locator(
          "#rs-checkout-continue-button-bottom, #rs-checkout-continue-button-top, .rs-checkout-continuebutton button, .rs-checkout-continuebutton a"
        ),
        page.locator('button[type="submit"]').filter({ hasText: CHECK_ORDER_RE }),
        page.getByRole("button", { name: CHECK_ORDER_RE }),
        page.getByRole("link", { name: CHECK_ORDER_RE }),
        page.getByText(CHECK_ORDER_RE).first(),
      ];
      for (const loc of autom) {
        const el = loc.first();
        if ((await el.count().catch(() => 0)) === 0) continue;
        const disabled = await el.isDisabled().catch(() => false);
        if (disabled) continue;
        hit = await el
          .click({ force: true, timeout: 1200 })
          .then(() => true)
          .catch(async () =>
            el
              .evaluate((n) => {
                const node = n as HTMLElement;
                (node.closest("button") || node.closest("a") || node).click();
              })
              .then(() => true)
              .catch(() => false)
          );
        if (hit) break;
      }
    }
    if (!hit) {
      hit = await clickCheckoutCtaOnce(page, "檢查你的訂單", patterns, needles, {
        waitMs: 900,
        pollMs: 60,
      });
    }

    if (!hit) {
      console.warn("  今輪揾唔到／撳唔到「檢查你的訂單」，稍後再試…");
      await sleepCheckingRelease(500);
      continue;
    }

    clicks += 1;
    console.log(`  已撳「檢查你的訂單」第 ${clicks} 次 — 等 loading…`);
    await waitForCheckoutLoadingSettled(page, { timeoutMs: 20_000 });

    await withReleaseCheck(
      page
        .waitForURL(
          (url) => isReviewPage(url.toString()) || !isBillingPage(url.toString()),
          { timeout: 2_500 }
        )
        .catch(() => {})
    );

    if (isReviewPage(page.url())) {
      console.log("  loading 完後已到達 Review");
      return true;
    }
    if (!isBillingPage(page.url())) {
      console.log(`  loading 完後已離開 Billing → ${page.url()}`);
      return true;
    }
    console.log("  loading 已消失但仍喺 Billing — 會再撳一次「檢查你的訂單」");
  }

  if (isReviewPage(page.url())) return true;
  console.warn(
    `  Billing 仍未到下一頁（已撳「檢查你的訂單」${clicks} 次）：${page.url()}`
  );
  return clicks > 0 && !isBillingPage(page.url());
}

/** Billing 頁是否仲有 loading logo／spinner */
async function isCheckoutLoadingVisible(page: Page): Promise<boolean> {
  return page
    .evaluate(() => {
      const sels = [
        ".rs-loader",
        ".rs-waitindicator",
        ".as-spinner",
        ".spinner",
        '[aria-busy="true"]',
        ".form-mask",
        ".rs-checkout-loader",
        'div[role="progressbar"]',
        ".progress-bar",
      ];
      const visible = (el: Element) => {
        const style = window.getComputedStyle(el);
        if (
          style.display === "none" ||
          style.visibility === "hidden" ||
          Number(style.opacity) === 0
        ) {
          return false;
        }
        const r = el.getBoundingClientRect();
        return r.width > 2 && r.height > 2;
      };
      for (const sel of sels) {
        for (const el of document.querySelectorAll(sel)) {
          if (visible(el)) return true;
        }
      }
      for (const el of document.querySelectorAll("[class]")) {
        const cls = String((el as HTMLElement).className || "");
        if (!/loading|spinner|waitindicator|busy/i.test(cls)) continue;
        if (visible(el)) return true;
      }
      const btns = document.querySelectorAll(
        'button, a, [data-autom="continueButton"], #rs-checkout-continue-button-bottom, #rs-checkout-continue-button-top, .rs-checkout-continuebutton button'
      );
      for (const btn of btns) {
        const text = (btn.textContent || "").replace(/\s+/g, "");
        const isContinue =
          /繼續前往取貨詳情|取貨詳情|檢查你的訂單|檢查您的訂單/i.test(text) ||
          btn.matches(
            '[data-autom="continueButton"], #rs-checkout-continue-button-bottom, #rs-checkout-continue-button-top, .rs-checkout-continuebutton button, .rs-checkout-continuebutton a'
          );
        if (!isContinue) continue;
        if (
          btn.getAttribute("aria-busy") === "true" ||
          /\b(loading|busy|pending)\b/i.test(String((btn as HTMLElement).className || ""))
        ) {
          if (visible(btn)) return true;
        }
        if (btn.querySelector(".spinner, .rs-loader, .rs-waitindicator")) {
          if (visible(btn)) return true;
        }
      }
      return false;
    })
    .catch(() => false);
}

/** 撳完 CTA 後：等 loading 出現（可選）再等消失 */
async function waitForCheckoutLoadingSettled(
  page: Page,
  opts?: { timeoutMs?: number; stayOn?: (url: string) => boolean }
): Promise<void> {
  const timeoutMs = opts?.timeoutMs ?? 20_000;
  const deadline = Date.now() + timeoutMs;
  const stayOn =
    opts?.stayOn ??
    ((url: string) => isBillingPage(url) && !isReviewPage(url));

  // 畀少少時間等 loading 出現
  const appearUntil = Date.now() + 1_200;
  let saw = false;
  while (Date.now() < appearUntil) {
    await throwIfReleased();
    if (!stayOn(page.url())) return;
    if (await isCheckoutLoadingVisible(page)) {
      saw = true;
      break;
    }
    await sleepCheckingRelease(80);
  }
  if (saw) console.log("  見到 loading logo，等佢消失…");

  while (Date.now() < deadline) {
    await throwIfReleased();
    if (!stayOn(page.url())) return;
    if (!(await isCheckoutLoadingVisible(page))) {
      await sleepCheckingRelease(280);
      if (!(await isCheckoutLoadingVisible(page))) {
        if (saw) console.log("  loading logo 已消失");
        return;
      }
    }
    await sleepCheckingRelease(120);
  }
  console.warn("  等 loading 消失逾時，繼續下一步");
}

async function scrapeEstimatedDeliveryText(page: Page): Promise<string | null> {
  const text = (await page.locator("body").innerText().catch(() => "")) || "";
  return firstMatch(text, [
    /(?:預計送貨|預計送達|送貨日期|Deliver(?:y|s)|Arrives)\s*[:：]?\s*([^\n]{1,80})/i,
    /(星期[一二三四五六日][^\n]{0,40}\d{1,2}\s*月\s*\d{1,2}\s*日[^\n]{0,20})/,
    /(\d{1,2}\s*月\s*\d{1,2}\s*日[^\n]{0,30})/,
    /(星期[一二三四五六日][^\n]{0,40})/,
  ]);
}

async function persistOrderSummaryPartial(
  session: BrowserSession,
  patch: Record<string, unknown>
): Promise<void> {
  const boxes = session.deliveryShippingBoxes;
  const cardNo = session.capturedCardNumber || "Apple Pay";
  const record = {
    browser: session.tag,
    deliveryMethod: fulfillmentLabel(),
    fulfillmentMode: session.fulfillmentMode ?? "delivery",
    fulfillmentPreference: CONFIG.fulfillmentPreference,
    proxy: CONFIG.proxy || "",
    productType: CONFIG.model,
    color: CONFIG.color,
    storage: CONFIG.storage,
    quantity: CONFIG.quantity,
    estimatedDelivery: session.estimatedDelivery ?? null,
    cardNumber: cardNo,
    cardType: detectCardType(cardNo) || session.cardType || "",
    cardCompany: resolveCardCompany() || session.cardCompany || "",
    cardLimit: resolveCardLimit() || session.cardLimit || "",
    orderPlacedAt: session.orderPlacedAt || null,
    shippingDetails: {
      name: `${session.identity.lastName} ${session.identity.firstName}`,
      phone: session.identity.phone,
      email: session.identity.email,
      address:
        session.deliveryAddressFull ||
        `${session.identity.area} ${session.identity.district} ${session.identity.street}`,
      estimatedDelivery: session.estimatedDelivery ?? null,
      lastName: boxes?.lastName || session.identity.lastName,
      firstName: boxes?.firstName || session.identity.firstName,
      areaDistrictStreet:
        boxes?.areaDistrictStreet ||
        `${session.identity.area} ${session.identity.district} ${session.identity.street}`,
      buildingFloorUnit: boxes?.buildingFloorUnit || session.identity.buildingLine || "",
    },
    deliveryShippingBoxes: boxes || null,
    identity: session.identity,
    scrapedAt: new Date().toISOString(),
    partial: true,
    ...patch,
  };

  await ensureRuntimeDir();
  await fs.writeFile(OUT_FILE, JSON.stringify([record], null, 2), "utf8").catch(() => {});

  try {
    let all: unknown[] = [];
    try {
      const raw = await fs.readFile(LEGACY_OUT_FILE, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      all = Array.isArray(parsed) ? parsed : [];
    } catch {
      all = [];
    }
    // 同一 browser 嘅 partial 用最新覆蓋
    const filtered = all.filter((item) => {
      const o = item as Record<string, unknown>;
      return !(o.browser === session.tag && o.partial === true);
    });
    filtered.push(record);
    await fs.writeFile(LEGACY_OUT_FILE, JSON.stringify(filtered, null, 2), "utf8");
  } catch {
    /* ignore */
  }
  console.log(`  已寫入 order summary（預計送貨：${record.estimatedDelivery ?? "—"}）`);
}

async function completeDeliveryApplePayReview(
  page: Page,
  session?: BrowserSession
): Promise<void> {
  // 任何 secureN 嘅 /shop/checkout?_s=Review 或 /shop/apw/checkout?_s=Review*
  console.log(
    `步驟：Review — 捲底一次，只撳一次「使用Apple Pay繼續」（URL=${page.url()}）`
  );

  // 等 Review URL 出現
  if (!isReviewPage(page.url())) {
    await withReleaseCheck(
      page
        .waitForURL((url) => isReviewPage(url.toString()), { timeout: 12_000 })
        .catch(() => {})
    );
  }

  if (!isReviewPage(page.url())) {
    throw new StepError("使用Apple Pay繼續", `未到達 Review 頁：${page.url()}`);
  }

  if (session) {
    await revealAndEnlargeBrowser(session).catch(() => {});
  }

  console.log("  Review：捲去頁底一次…");
  await scrollPageToBottom(page);
  await sleepCheckingRelease(300);

  console.log("  Review：只撳一次「使用Apple Pay繼續」…");
  let clicked = await clickReviewPagePrimaryCta(page);
  if (!clicked) {
    clicked = await clickApplePayContinueFast(page, {
      waitMs: 5_000,
      pollMs: 80,
      hammer: false,
    });
  }
  if (!clicked) {
    clicked = await page
      .evaluate(() => {
        const norm = (s: string) =>
          (s || "").replace(/[\s\u00a0\u200b\ufeff\uf8ff]+/g, "").toLowerCase();
        const nodes = Array.from(
          document.querySelectorAll(
            "button, a, [role='button'], apple-pay-button, [is='apple-pay-button'], [data-autom*='continue' i]"
          )
        ) as HTMLElement[];
        for (const el of nodes) {
          const t = norm(
            `${el.innerText || ""} ${el.getAttribute("aria-label") || ""} ${el.id || ""}`
          );
          if (
            !(
              (t.includes("apple") && t.includes("pay") && t.includes("繼續")) ||
              (t.includes("使用") && t.includes("pay") && t.includes("繼續")) ||
              (t.includes("continue") && t.includes("pay"))
            )
          ) {
            continue;
          }
          el.scrollIntoView({ block: "center" });
          el.click();
          return true;
        }
        const sticky = document.querySelector(
          "#rs-checkout-continue-button-bottom, .rs-checkout-continuebutton button, [data-autom='continueButton']"
        ) as HTMLElement | null;
        if (sticky) {
          sticky.scrollIntoView({ block: "center" });
          sticky.click();
          return true;
        }
        return false;
      })
      .catch(() => false);
  }

  if (!clicked) {
    throw new StepError("使用Apple Pay繼續", "Review 頁撳唔到主 CTA（使用Apple Pay繼續）。");
  }
  console.log("  已撳「使用Apple Pay繼續」一次（唔再連撳）");

  await withReleaseCheck(
    page
      .waitForURL((url) => !isReviewPage(url.toString()), { timeout: 12_000 })
      .catch(() => {})
  );
  if (!isReviewPage(page.url())) {
    console.log(`  已離開 Review → ${page.url()}`);
  } else {
    console.warn("  撳完一次仍喺 Review（可能等 Apple Pay sheet／人手確認）");
  }

  const eta = await scrapeEstimatedDeliveryText(page).catch(() => null);
  if (session) {
    session.estimatedDelivery = eta;
    await writeStatus({
      phase: "waiting_for_payment",
      card: cardFieldsFromSession(session, {
        estimatedDelivery: eta,
        url: page.url(),
      }),
    }).catch(() => {});
    await persistOrderSummaryPartial(session, { estimatedDelivery: eta, url: page.url() }).catch(
      () => {}
    );
  }
  if (eta) console.log(`  已記錄預計送貨：${eta}`);
  await settleDom(page, 50);
}

async function ensureSessionWindowId(session: BrowserSession): Promise<number | null> {
  if (session.windowId != null) return session.windowId;
  try {
    const cdp = await session.page.context().newCDPSession(session.page);
    const got = await cdp.send("Browser.getWindowForTarget");
    session.windowId = got.windowId;
    await cdp.detach().catch(() => {});
    return session.windowId ?? null;
  } catch {
    return null;
  }
}

async function selectUseShippingAddressForBilling(page: Page): Promise<boolean> {
  console.log("步驟：勾選「使用我的送貨地址」左邊選項");

  // 等帳單地址區出現（揀完信用卡之後先會有）
  for (let wait = 0; wait < 24; wait++) {
    const has = await page.getByText(/使用我的送貨地址/).first().isVisible().catch(() => false);
    if (has) break;
    await page.waitForTimeout(500);
  }

  const isShippingAddressSelected = async (): Promise<boolean> => {
    return page
      .evaluate(() => {
        const needle = "使用我的送貨地址";
        const all = Array.from(document.querySelectorAll("label, span, div, p, li, a, button"));
        let textEl: HTMLElement | null = null;
        let bestLen = Infinity;
        for (const el of all) {
          const t = (el.textContent || "").replace(/\s+/g, " ").trim();
          if (!t.includes(needle) || t.length > 100) continue;
          if (t.length < bestLen) {
            textEl = el as HTMLElement;
            bestLen = t.length;
          }
        }
        if (!textEl) return false;
        let row: HTMLElement | null = textEl;
        for (let i = 0; i < 10 && row; i++) {
          const input = row.querySelector(
            'input[type="radio"], input[type="checkbox"]'
          ) as HTMLInputElement | null;
          if (input?.checked) return true;
          const role = row.querySelector('[role="radio"][aria-checked="true"], [aria-checked="true"]');
          if (role) return true;
          // selected / active class near text
          if (
            /selected|is-selected|checked|active|rs-formrs-selected/i.test(
              row.className || ""
            )
          ) {
            return true;
          }
          row = row.parentElement;
        }
        return false;
      })
      .catch(() => false);
  };

  for (let attempt = 1; attempt <= 6; attempt++) {
    await throwIfReleased();
    if (await isShippingAddressSelected()) {
      console.log("  「使用我的送貨地址」已勾選");
      return true;
    }

    const clicked = await page
      .evaluate(() => {
        const needle = "使用我的送貨地址";
        const all = Array.from(document.querySelectorAll("label, span, div, p, li, a, button"));
        let textEl: HTMLElement | null = null;
        let bestLen = Infinity;
        for (const el of all) {
          const t = (el.textContent || "").replace(/\s+/g, " ").trim();
          if (!t.includes(needle)) continue;
          if (t.length > 100) continue;
          if (t.length < bestLen) {
            textEl = el as HTMLElement;
            bestLen = t.length;
          }
        }
        if (!textEl) return { ok: false, how: "no-text" };

        const textRect = textEl.getBoundingClientRect();
        const midY = textRect.top + textRect.height / 2;

        const scoreControl = (el: Element) => {
          const r = (el as HTMLElement).getBoundingClientRect();
          if (r.width < 1 && r.height < 1) return null;
          if (r.right > textRect.left + 12) return null;
          if (Math.abs(r.top + r.height / 2 - midY) > 48) return null;
          return textRect.left - r.right;
        };

        const controls = Array.from(
          document.querySelectorAll(
            'input[type="radio"], input[type="checkbox"], [role="radio"], [role="checkbox"], [aria-checked]'
          )
        );

        let best: HTMLElement | null = null;
        let bestScore = Infinity;
        for (const c of controls) {
          const s = scoreControl(c);
          if (s == null) continue;
          if (s < bestScore) {
            bestScore = s;
            best = c as HTMLElement;
          }
        }

        if (!best) {
          let row: HTMLElement | null = textEl;
          for (let i = 0; i < 10 && row; i++) {
            const input = row.querySelector(
              'input[type="radio"], input[type="checkbox"], [role="radio"], [role="checkbox"]'
            ) as HTMLElement | null;
            if (input) {
              best = input;
              break;
            }
            row = row.parentElement;
          }
        }

        const fire = (el: HTMLElement) => {
          el.scrollIntoView({ block: "center", inline: "nearest" });
          if (el instanceof HTMLInputElement) {
            el.checked = true;
            el.focus();
            el.click();
            el.dispatchEvent(new Event("input", { bubbles: true }));
            el.dispatchEvent(new Event("change", { bubbles: true }));
          } else {
            el.click();
            el.setAttribute("aria-checked", "true");
            el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
          }
          const lab = el.closest("label");
          if (lab && lab !== el) (lab as HTMLElement).click();
          // 亦撳文字本身
          textEl?.click();
        };

        if (best) {
          fire(best);
          return { ok: true, how: "left-control" };
        }

        const lab = textEl.closest("label") || textEl;
        (lab as HTMLElement).click();
        return { ok: true, how: "label-fallback" };
      })
      .catch(() => ({ ok: false, how: "evaluate-error" }));

    if (clicked && (clicked as { ok?: boolean }).ok) {
      console.log(
        `  已嘗試勾選「使用我的送貨地址」（${(clicked as { how?: string }).how}，第 ${attempt}/6 次）`
      );
    } else {
      // Playwright 後備
      const nameRe = /使用我的送貨地址/;
      const fallbacks: Locator[] = [
        page.getByRole("radio", { name: nameRe }),
        page.getByRole("checkbox", { name: nameRe }),
        page.locator("label").filter({ hasText: nameRe }),
        page.getByText(nameRe).first(),
      ];
      for (const loc of fallbacks) {
        if (!(await visible(loc.first(), 800))) continue;
        await humanClick(loc.first(), { force: true }).catch(
          async () => {
            await loc.first().evaluate((n) => (n as HTMLElement).click());
          }
        );
        console.log(`  已用 Playwright 後備勾選（第 ${attempt}/6 次）`);
        break;
      }
    }

    await page.waitForTimeout(700);
    if (await isShippingAddressSelected()) {
      console.log("  「使用我的送貨地址」已確認勾選");
      return true;
    }
    console.warn(`  勾選未生效，重試 ${attempt}/6…`);
  }

  console.warn("  揾唔到／勾唔上「使用我的送貨地址」左邊選項");
  return false;
}

async function fillBillingAddressFields(
  page: Page,
  opts?: { useShippingAddress?: boolean; session?: BrowserSession }
): Promise<void> {
  // 已喺 Review：唔好再搵 Billing 嘅 Apple Pay 掣（否則會 throw 停死）
  if (isReviewPage(page.url()) && selectsApplePayAtBilling()) {
    console.log("步驟：已喺 Review — 直接重試撳主 CTA（跳過揀 Apple Pay）");
    if (opts?.session) await revealAndEnlargeBrowser(opts.session).catch(() => {});
    await completeDeliveryApplePayReview(page, opts?.session);
    return;
  }
  if (isReviewPage(page.url())) {
    const assigned = await loadAssignedCheckoutCard(
      CHECKOUT_CARD_ASSIGN_PATH,
      CHECKOUT_CARD_KEY_PATH
    ).catch(() => null);
    if (assigned) {
      console.log("步驟：已喺 Review — Credit cards 池 →「立即提交訂單」");
      await completeCreditCardReviewSubmit(page, opts?.session, assigned);
      return;
    }
  }

  // delivery／pickup applepay訪客／Apple 帳戶 apple pay：Apple Pay → 檢查訂單 → Review 繼續
  if (selectsApplePayAtBilling()) {
    let selected = false;
    for (let round = 1; round <= 3; round++) {
      selected = await selectApplePayPayment(page);
      if (selected) break;
      // 過渡期間可能已跳去 Review
      if (isReviewPage(page.url())) {
        await completeDeliveryApplePayReview(page, opts?.session);
        return;
      }
      console.warn(`  揀 Apple Pay 失敗 round ${round}/3，再等 Billing…`);
      await sleepCheckingRelease(250);
    }
    if (!selected) {
      if (isReviewPage(page.url())) {
        await completeDeliveryApplePayReview(page, opts?.session);
        return;
      }
      throw new StepError("Apple Pay", "Billing 頁揾唔到／撳唔到 Apple Pay 掣。");
    }

    // 揀完 Apple Pay：重試「檢查你的訂單」直到 Review，再重試主 CTA
    await sleepCheckingRelease(40);
    let checked = await clickCheckYourOrder(page);
    if (!isReviewPage(page.url()) && isBillingPage(page.url())) {
      console.warn("  仍喺 Billing，再一輪「檢查你的訂單」重試…");
      checked = (await clickCheckYourOrder(page)) || checked;
    }
    if (isReviewPage(page.url())) {
      console.log("  已到 Review，開始重試主 CTA");
      await completeDeliveryApplePayReview(page, opts?.session);
      return;
    }
    if (!checked) {
      throw new StepError("檢查你的訂單", "Billing 頁撳唔到「檢查你的訂單」。");
    }
    console.log("  已撳「檢查你的訂單」，繼續搶 Review CTA");
    await completeDeliveryApplePayReview(page, opts?.session);
    return;
  }

  // 先揀信用卡／扣賬卡，再處理帳單地址
  await selectCreditOrDebitCard(page).catch(() => {});
  await page.waitForTimeout(900);

  const wantShipping = opts?.useShippingAddress === true;

  if (wantShipping) {
    // Delivery：必須勾「使用我的送貨地址」，失敗會再試
    for (let round = 1; round <= 3; round++) {
      const ok = await selectUseShippingAddressForBilling(page);
      if (ok) {
        console.log("  Delivery：已用送貨地址作帳單地址，唔再亂填帳單欄位");
        await autofillCardThenCheckOrder(page, opts?.session);
        return;
      }
      console.warn(`  Delivery 勾送貨地址失敗 round ${round}/3，再等帳單區…`);
      await page.waitForTimeout(1200);
      await selectCreditOrDebitCard(page).catch(() => {});
    }
    console.warn("  Delivery 仍未能勾「使用我的送貨地址」，仍嘗試 autofill 卡");
    await autofillCardThenCheckOrder(page, opts?.session);
    return;
  }

  console.log("步驟：填寫帳單地址（隨機）");
  await page.waitForTimeout(600);

  const lastName = pick(LAST_NAMES);
  const firstName = pick(FIRST_NAMES);
  const street = randomStreet();
  const floor = `${Math.floor(Math.random() * 30) + 1}樓`;
  console.log(`  帳單：${lastName} ${firstName} / ${street} / ${floor}`);

  await fillByLabels(
    page,
    [/^姓氏$/, /^姓$/, /Last name/i, /Family name/i],
    lastName,
    "帳單姓氏"
  ).catch(() => {});
  await fillEditableFallback(
    page,
    [
      'input[autocomplete="family-name"]',
      'input[name*="lastName" i]',
      'input[id*="lastName" i]',
      'input[data-autom*="lastName" i]',
      'input[data-autom*="billing" i][name*="last" i]',
    ],
    lastName,
    "帳單姓氏"
  ).catch(() => {});

  await fillByLabels(
    page,
    [/^名字$/, /^名$/, /First name/i, /Given name/i],
    firstName,
    "帳單名字"
  ).catch(() => {});
  await fillEditableFallback(
    page,
    [
      'input[autocomplete="given-name"]',
      'input[name*="firstName" i]',
      'input[id*="firstName" i]',
      'input[data-autom*="firstName" i]',
    ],
    firstName,
    "帳單名字"
  ).catch(() => {});

  await fillByLabels(
    page,
    [/街道名稱/, /街道地址/, /Address Line 1/i, /地址第 1 行/, /^街道$/, /Street/i],
    street,
    "帳單街道"
  ).catch(() => {});
  await fillEditableFallback(
    page,
    [
      'input[autocomplete="address-line1"]',
      'input[name*="street" i]',
      'input[name*="address1" i]',
      'input[data-autom*="street" i]',
      'input[data-autom*="address" i]',
    ],
    street,
    "帳單街道"
  ).catch(() => {});

  await fillByLabels(
    page,
    [/樓層/, /地址第 2 行/, /Address Line 2/i, /大廈|單位|Apartment|Floor/i],
    floor,
    "帳單樓層"
  ).catch(() => {});
  await fillEditableFallback(
    page,
    [
      'input[autocomplete="address-line2"]',
      'input[name*="address2" i]',
      'input[name*="street2" i]',
      'input[data-autom*="address2" i]',
      'input[data-autom*="floor" i]',
    ],
    floor,
    "帳單樓層"
  ).catch(() => {});

  console.log("  帳單地址欄位已嘗試自動填寫");
  await autofillCardThenCheckOrder(page, opts?.session);
}

async function scrollPageToBottomRight(page: Page): Promise<void> {
  await page
    .evaluate(() => {
      const root = (document.scrollingElement || document.documentElement) as HTMLElement;
      const maxX = Math.max(
        0,
        (root.scrollWidth || 0) - (root.clientWidth || window.innerWidth || 0),
        (document.body?.scrollWidth || 0) - (window.innerWidth || 0)
      );
      const maxY = Math.max(
        0,
        (root.scrollHeight || 0) - (root.clientHeight || window.innerHeight || 0),
        (document.body?.scrollHeight || 0) - (window.innerHeight || 0)
      );
      window.scrollTo(maxX, maxY);
      root.scrollLeft = maxX;
      root.scrollTop = maxY;
      if (document.body) {
        document.body.scrollLeft = maxX;
        document.body.scrollTop = maxY;
      }
      // 頁內可捲動容器都推去最右最底
      for (const el of Array.from(document.querySelectorAll("*"))) {
        const h = el as HTMLElement;
        try {
          if (h.scrollWidth > h.clientWidth + 8) h.scrollLeft = h.scrollWidth;
          if (h.scrollHeight > h.clientHeight + 8) h.scrollTop = h.scrollHeight;
        } catch {
          /* ignore */
        }
      }
    })
    .catch(() => {});
}

/** Zoom 100%，並令 Playwright viewport 貼齊最大化後嘅視窗，避免右邊／底欄捲軸內縮 */
async function applyFullWindowViewportAndZoom(
  session: BrowserSession,
  // Playwright CDPSession 泛型好嚴
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  cdp: any,
  windowId: number
): Promise<void> {
  await cdp.send("Emulation.setPageScaleFactor", { pageScaleFactor: 1 }).catch(() => {});
  await session.page
    .evaluate(() => {
      try {
        const html = document.documentElement as HTMLElement | null;
        const body = document.body as HTMLElement | null;
        if (html) html.style.zoom = "1";
        if (body) body.style.zoom = "1";
      } catch {
        /* ignore */
      }
    })
    .catch(() => {});

  const screen = await session.page
    .evaluate(() => ({
      aw: Math.max(window.screen.availWidth || 0, window.screen.width || 0, 1280),
      ah: Math.max(window.screen.availHeight || 0, window.screen.height || 0, 720),
    }))
    .catch(() => ({ aw: 1920, ah: 1080 }));

  let outerW = screen.aw;
  let outerH = screen.ah;
  try {
    const got = (await cdp.send("Browser.getWindowBounds", { windowId })) as {
      bounds?: { width?: number; height?: number };
    };
    if (got?.bounds?.width) outerW = Math.max(outerW, Number(got.bounds.width) || 0);
    if (got?.bounds?.height) outerH = Math.max(outerH, Number(got.bounds.height) || 0);
  } catch {
    /* ignore */
  }

  const viewportW = Math.max(1024, outerW);
  const viewportH = Math.max(700, outerH);
  await session.page.setViewportSize({ width: viewportW, height: viewportH }).catch(() => {});

  await cdp
    .send("Browser.setWindowBounds", {
      windowId,
      bounds: { windowState: "maximized" },
    })
    .catch(() => {});
  await new Promise((r) => setTimeout(r, 200));

  const inner = await session.page
    .evaluate(() => ({
      w: Math.max(
        window.innerWidth || 0,
        document.documentElement?.clientWidth || 0,
        1024
      ),
      h: Math.max(
        window.innerHeight || 0,
        document.documentElement?.clientHeight || 0,
        700
      ),
    }))
    .catch(() => ({ w: viewportW, h: viewportH }));
  if (Math.abs(inner.w - viewportW) > 24 || Math.abs(inner.h - viewportH) > 24) {
    await session.page
      .setViewportSize({
        width: Math.max(1024, inner.w),
        height: Math.max(700, inner.h),
      })
      .catch(() => {});
    await cdp
      .send("Browser.setWindowBounds", {
        windowId,
        bounds: { windowState: "maximized" },
      })
      .catch(() => {});
  }
}

/**
 * 最後一步完成：好似平時 Chrome 撳最大化，zoom 100%，捲軸貼最右／最底。
 */
async function maximizeBrowserLikeNormalChrome(
  session: BrowserSession
): Promise<void> {
  if (SILENT_STOP_ALL || (await flagExists(DASHBOARD_STOP_ALL_FLAG))) {
    SILENT_STOP_ALL = true;
    return;
  }
  const windowId = await ensureSessionWindowId(session);
  if (windowId == null) {
    console.warn(`${session.tag} 無 windowId，無法最大化`);
    return;
  }

  const cdp = await session.page.context().newCDPSession(session.page);
  try {
    await cdp.send("Browser.setWindowBounds", {
      windowId,
      bounds: { windowState: "normal" },
    });
    await new Promise((r) => setTimeout(r, 200));

    const screen = await session.page
      .evaluate(() => ({
        aw: Math.max(window.screen.availWidth || 0, 1280),
        ah: Math.max(window.screen.availHeight || 0, 720),
      }))
      .catch(() => ({ aw: 1920, ah: 1080 }));

    session.windowBounds = {
      left: 0,
      top: 0,
      width: screen.aw,
      height: screen.ah,
    };

    await cdp.send("Browser.setWindowBounds", {
      windowId,
      bounds: {
        left: 0,
        top: 0,
        width: screen.aw,
        height: screen.ah,
        windowState: "normal",
      },
    });
    await new Promise((r) => setTimeout(r, 150));

    await cdp.send("Browser.setWindowBounds", {
      windowId,
      bounds: { windowState: "maximized" },
    });
    await new Promise((r) => setTimeout(r, 250));

    await applyFullWindowViewportAndZoom(session, cdp, windowId);

    await session.page.bringToFront().catch(() => {});
    winBringBrowserToFront(session.browser);
    setTimeout(() => winBringBrowserToFront(session.browser), 350);

    await new Promise((r) => setTimeout(r, 200));
    await scrollPageToBottomRight(session.page);
    await new Promise((r) => setTimeout(r, 120));
    await scrollPageToBottomRight(session.page);

    session.billingWindowRevealed = true;
    await writeStatus({
      windowState: "maximized",
      windowHidden: false,
    });
    console.log(
      `${session.tag} 步驟完成 → 已最大化（zoom 100%），捲軸貼最右／最底`
    );
  } finally {
    await cdp.detach().catch(() => {});
  }
}

/** 開大／置頂瀏覽器。自動化預設唔 call；opts.force 或步驟完成先開。 */
async function revealAndEnlargeBrowser(
  session: BrowserSession,
  opts?: { force?: boolean }
): Promise<void> {
  if (!opts?.force) return;
  if (SILENT_STOP_ALL || (await flagExists(DASHBOARD_STOP_ALL_FLAG))) {
    SILENT_STOP_ALL = true;
    return;
  }
  await maximizeBrowserLikeNormalChrome(session);
}

function shouldUseShippingAddressForBilling(session?: BrowserSession): boolean {
  if (session?.fulfillmentMode === "delivery") return true;
  if (session?.fulfillmentMode === "pickup") return false;
  return prefersDeliveryOnly();
}

async function markWaitingForPayment(
  session: BrowserSession | undefined,
  page: Page,
  tag?: string
): Promise<void> {
  if (!session) return;
  if (!isCheckoutFlowPage(page.url()) && !(await isOnPaymentStep(page))) return;
  // 中途只更新 status；視窗全程保持隱藏，完成後先 sealStepsComplete 黃閃
  await writeStatus({
    phase: "waiting_for_payment",
    windowHidden: true,
    windowState: "minimized",
    card: cardFieldsFromSession(session, { url: page.url() }),
  });
  if (tag) {
    console.log(`${tag} 已入 checkout，status → waiting for payment（視窗保持隱藏）`);
  }
}

/** 自動化步驟全部做完（最終頁）：保持隱藏；dashboard 綠閃 steps_complete */
async function sealStepsComplete(session: BrowserSession): Promise<void> {
  await setBrowserWindowState(session, "minimized").catch(() => {});
  await writeStatus({
    phase: "steps_complete",
    windowHidden: true,
    windowState: "minimized",
    message: "waiting for payment",
    card: cardFieldsFromSession(session, {
      url: session.page.url(),
      quantity: CONFIG.quantity,
      estimatedDelivery: session.estimatedDelivery,
    }),
  });
  console.log(
    `${session.tag} 步驟已完成 → steps_complete（綠閃）；瀏覽器保持隱藏，唔會自動開啟`
  );
}

/** Dashboard：保持瀏覽器開住並隱藏，淨係 Close 先關 */
async function holdSessionsHiddenUntilClose(
  sessions: BrowserSession[]
): Promise<void> {
  if (!sessions.length) return;
  console.log(
    "Dashboard：瀏覽器保持開啟並隱藏（waiting for payment 唔自動開）。撳 Close 先關閉。"
  );
  for (const s of sessions) {
    await setBrowserWindowState(s, "minimized").catch(() => {});
  }

  let phase = "steps_complete";
  try {
    const st = JSON.parse(await fs.readFile(STATUS_FILE, "utf8")) as {
      phase?: string;
    };
    if (/payment_succeeded|orders_ready/i.test(String(st.phase || ""))) {
      phase = "payment_succeeded";
    } else if (/steps_complete/i.test(String(st.phase || ""))) {
      phase = "steps_complete";
      await writeStatus({
        phase: "steps_complete",
        windowHidden: true,
        windowState: "minimized",
        message: "waiting for payment",
      });
    } else {
      phase = "steps_complete";
      await writeStatus({
        phase: "steps_complete",
        windowHidden: true,
        windowState: "minimized",
        message: "waiting for payment",
      });
    }
  } catch {
    await writeStatus({
      phase: "steps_complete",
      windowHidden: true,
      windowState: "minimized",
      message: "waiting for payment",
    });
  }

  while (true) {
    if (await flagExists(DASHBOARD_CLOSE_FLAG)) {
      await fs.unlink(DASHBOARD_CLOSE_FLAG).catch(() => {});
      console.log("收到 Close，結束保持開啟…");
      return;
    }
    for (const s of ACTIVE_SESSIONS.length ? ACTIVE_SESSIONS : sessions) {
      await syncDashboardWindowFlags(s).catch(() => {});
      await captureCardNumberIfPresent(s).catch(() => {});
      if (!/payment_succeeded/i.test(phase)) {
        const scraped = await scrapeConfirmation(s.page).catch(() => null);
        if (scraped?.orderNumber) {
          if (!s.orderPlacedAt) s.orderPlacedAt = formatHkOrderDateTime();
          const cardNo = s.capturedCardNumber || scraped.cardNumber || null;
          const poolMeta = lookupCardMeta(cardNo);
          phase = "payment_succeeded";
          await writeStatus({
            phase: "payment_succeeded",
            message: `付款成功：${scraped.orderNumber}`,
            windowHidden: true,
            card: cardFieldsFromSession(s, {
              orderNumber: scraped.orderNumber,
              total: scraped.total,
              quantity: scraped.quantity,
              cardNumber: cardNo,
              cardType:
                poolMeta?.type || detectCardType(cardNo) || s.cardType || "",
              cardCompany:
                poolMeta?.company ||
                resolveCardCompany() ||
                s.cardCompany ||
                "",
              cardLimit:
                s.cardLimit || poolMeta?.limit || resolveCardLimit() || "",
              orderPlacedAt: s.orderPlacedAt,
              paymentSucceeded: true,
            }),
          });
          // 付款成功後都保持隱藏；用戶要睇先 Open browser
          await setBrowserWindowState(s, "minimized").catch(() => {});
        }
      }
    }
    // waiting for payment / steps_complete：若仍標 hidden 但視窗被彈出，再藏返（Open browser 會標 windowHidden=false）
    if (/waiting_for_payment|steps_complete/i.test(phase)) {
      try {
        const st = JSON.parse(await fs.readFile(STATUS_FILE, "utf8")) as {
          windowHidden?: boolean;
        };
        if (st.windowHidden !== false) {
          for (const s of sessions) {
            const state = await readBrowserWindowState(s).catch(() => null);
            if (state && state !== "minimized") {
              await setBrowserWindowState(s, "minimized").catch(() => {});
            }
          }
          await writeStatus({
            phase: /steps_complete/i.test(phase)
              ? "steps_complete"
              : "waiting_for_payment",
            windowHidden: true,
            windowState: "minimized",
          }).catch(() => {});
        }
      } catch {
        /* ignore */
      }
    }
    try {
      await sleepCheckingRelease(800);
    } catch (err) {
      if (err instanceof ReleaseError) {
        if (/關閉/.test(err.message) || (await flagExists(DASHBOARD_CLOSE_FLAG))) {
          throw err;
        }
        // Stop take-over：仍留喺 waiting payment（唔改 manual_control／唔搬去 Opened）
        phase = "steps_complete";
        await writeStatus({
          phase: "steps_complete",
          message: "自動化已停（仍喺 waiting payment；Open browser 人手操作）",
        }).catch(() => {});
        await new Promise((r) => setTimeout(r, 800));
        continue;
      }
      throw err;
    }
  }
}

async function fillShippingAndGoToPayment(
  page: Page,
  identity: Identity,
  tag: string,
  session?: BrowserSession
): Promise<void> {
  if (isCheckoutFlowPage(page.url())) {
    await markWaitingForPayment(session, page, tag);
  }

  // 已喺 Review（iPhone 17／18 Apple Pay）：直接撳主 CTA 去下一頁
  if (isReviewPage(page.url()) && selectsApplePayAtBilling()) {
    console.log(`${tag} 已喺 Review，直接撳主 CTA（唔再揀 Billing Apple Pay）`);
    if (session) await revealAndEnlargeBrowser(session).catch(() => {});
    await completeDeliveryApplePayReview(page, session);
    if (session) {
      await writeStatus({
        phase: "waiting_for_payment",
        windowHidden: true,
        windowState: "minimized",
        card: cardFieldsFromSession(session, { url: page.url() }),
      });
    }
    return;
  }
  if (isReviewPage(page.url())) {
    const assigned = await loadAssignedCheckoutCard(
      CHECKOUT_CARD_ASSIGN_PATH,
      CHECKOUT_CARD_KEY_PATH
    ).catch(() => null);
    if (assigned) {
      console.log(`${tag} 已喺 Review，Credit cards →「立即提交訂單」`);
      await completeCreditCardReviewSubmit(page, session, assigned);
      return;
    }
  }

  if (await isOnPaymentStep(page) || isBillingPage(page.url())) {
    console.log(
      `${tag} 已偵測付款／帳單頁，${selectsApplePayAtBilling() ? "揀 Apple Pay" : "揀信用卡"}並填帳單地址。`
    );
    if (session && isBillingPage(page.url())) await revealAndEnlargeBrowser(session);
    await fillBillingAddressFields(page, {
      useShippingAddress: shouldUseShippingAddressForBilling(session),
      session,
    }).catch(() => {});
    if (session) {
      const onBilling = isBillingPage(page.url());
      const onReview = isReviewPage(page.url());
      await writeStatus({
        phase: "waiting_for_payment",
        windowHidden: true,
        windowState: "minimized",
        card: cardFieldsFromSession(session, { url: page.url() }),
      });
    }
    return;
  }

  // 若被踢返 404／產品頁／購物袋，重新加購或由 404 入袋
  if (isShop404Url(page.url()) || isProductConfigPage(page.url()) || isBagPage(page.url())) {
    await recoverAddToBagIfNeeded(page, tag);
    await settleAfterNavigation(page);
    await goToCheckout(page).catch(() => {});
    await settleAfterNavigation(page);
    if (usesAppleAccount()) await signInWithAppleAccount(page).catch(() => {});
    else await continueAsGuest(page).catch(() => {});
    await settleAfterNavigation(page);
  }

  if (await isSignInPage(page)) {
    if (usesAppleAccount()) await signInWithAppleAccount(page);
    else await continueAsGuest(page);
    await settleDom(page, 150);
  }

  // Monitor+buying：喺 Fulfillment-init 待命，只響應同型號同色同容量有貨 → refresh → 繼續
  if (CONFIG.holdAtPickupStoresForStock) {
    await runMonitorHoldBuyLoop(page, identity, tag, session);
    return;
  }

  // 已喺 PickupContact：快速填固定聯絡資料 → 前往付款／Apple Pay 繼續
  if (usesFastPickupContactFill() && isPickupContactPage(page.url())) {
    await fillPickupContactGuestAndContinue(page, tag, session);
    if (session) {
      const onBilling = isBillingPage(page.url()) || isReviewPage(page.url());
      if (isBillingPage(page.url())) {
        await revealAndEnlargeBrowser(session);
        await fillBillingAddressFields(page, {
          useShippingAddress: shouldUseShippingAddressForBilling(session),
          session,
        }).catch(() => {});
      }
      await writeStatus({
        phase: "waiting_for_payment",
        windowHidden: true,
        windowState: "minimized",
        card: cardFieldsFromSession(session, { url: page.url() }),
      });
    }
    return;
  }

  let mode: "pickup" | "delivery" = "delivery";
  if (!(await isOnPaymentStep(page)) && !isBillingPage(page.url())) {
    mode = await chooseFulfillment(page);
    // 一到 PickupContact 即刻 autofill（只一次；若 choosePickupStore 已填過會自動跳過重填）
    if (usesFastPickupContactFill() && isPickupContactPage(page.url())) {
      await fillPickupContactGuestAndContinue(page, tag, session);
      if (session) {
        const onBilling = isBillingPage(page.url()) || isReviewPage(page.url());
        if (isBillingPage(page.url()) || isReviewPage(page.url())) {
          await revealAndEnlargeBrowser(session);
          await fillBillingAddressFields(page, {
            useShippingAddress: shouldUseShippingAddressForBilling(session),
            session,
          }).catch(() => {});
        }
        await writeStatus({
          phase: "waiting_for_payment",
          windowHidden: true,
          windowState: "minimized",
          card: cardFieldsFromSession(session, { url: page.url() }),
        });
      }
      return;
    }
    if (
      (isPickupContactPage(page.url()) && usesFastPickupContactFill()) ||
      isDeliveryApplePay()
    ) {
      await settleDom(page, 80);
    } else {
      await settleAfterNavigation(page);
    }
  }

  // 履行中途又退回 404／產品頁
  if (isShop404Url(page.url()) || isProductConfigPage(page.url())) {
    await recoverAddToBagIfNeeded(page, tag);
    await settleAfterNavigation(page);
    await goToCheckout(page);
    await settleAfterNavigation(page);
    if (usesAppleAccount()) await signInWithAppleAccount(page);
    else await continueAsGuest(page);
    await settleAfterNavigation(page);
    mode = await chooseFulfillment(page);
    if (usesFastPickupContactFill() && isPickupContactPage(page.url())) {
      await fillPickupContactGuestAndContinue(page, tag, session);
      if (session) {
        const onBilling = isBillingPage(page.url()) || isReviewPage(page.url());
        if (isBillingPage(page.url()) || isReviewPage(page.url())) {
          await revealAndEnlargeBrowser(session);
          await fillBillingAddressFields(page, {
            useShippingAddress: shouldUseShippingAddressForBilling(session),
            session,
          }).catch(() => {});
        }
        await writeStatus({
          phase: "waiting_for_payment",
          windowHidden: true,
          windowState: "minimized",
          card: cardFieldsFromSession(session, { url: page.url() }),
        });
      }
      return;
    }
    if (
      (isPickupContactPage(page.url()) && usesFastPickupContactFill()) ||
      isDeliveryApplePay()
    ) {
      await settleDom(page, 80);
    } else {
      await settleAfterNavigation(page);
    }
  }

  if (isPickupContactPage(page.url()) || /_s=Pickup/i.test(page.url())) {
    mode = "pickup";
  } else if (/_s=Shipping/i.test(page.url())) {
    mode = "delivery";
  }

  if (await isOnPaymentStep(page) || isBillingPage(page.url())) {
    console.log(
      `${tag} 已偵測付款／帳單頁，${selectsApplePayAtBilling() ? "揀 Apple Pay" : "揀信用卡"}並填帳單地址。`
    );
    if (session && isBillingPage(page.url())) await revealAndEnlargeBrowser(session);
    await fillBillingAddressFields(page, {
      useShippingAddress: shouldUseShippingAddressForBilling(session),
      session,
    }).catch(() => {});
    if (session) {
      const onBilling = isBillingPage(page.url());
      await writeStatus({
        phase: "waiting_for_payment",
        windowHidden: true,
        windowState: "minimized",
        card: cardFieldsFromSession(session, { url: page.url() }),
      });
    }
    return;
  }
  if (await isSignInPage(page)) {
    if (usesAppleAccount()) {
      console.warn(`${tag} 仍喺登入頁，再試 Apple 帳戶登入…`);
      await signInWithAppleAccount(page);
      await settleDom(page, 150);
    } else {
      throw new StepError("送貨資料", "仍然喺登入頁，未可以填資料。");
    }
  }

  if (/_s=Fulfillment/i.test(page.url())) {
    if (prefersPickupOnly()) {
      console.warn(`${tag} 仍然喺履行頁，再試取貨流程…`);
      mode = await chooseFulfillment(page);
    } else {
      console.warn(`${tag} 仍然喺履行頁，再試送貨流程…`);
      await startDeliveryFlow(page);
      mode = "delivery";
    }
    await settleDom(page, usesAppleAccount() ? 120 : 300);
  }

  // delivery apple ac apple pay：只改電話，其餘用帳戶已存地址
  if (isDeliveryAppleAcApplePay() && mode === "delivery") {
    if (!/_s=Shipping/i.test(page.url())) {
      await startDeliveryFlow(page);
      await settleDom(page, 120);
    }
    console.log(`${tag} 步驟：Apple 帳戶送貨（只填電話 ${APPLE_ACCOUNT.phone}）`);
    await fillDeliveryAppleAcPhoneOnly(page);
    if (session) {
      session.fulfillmentMode = "delivery";
      session.identity = { ...session.identity, phone: APPLE_ACCOUNT.phone };
    }
    await clickContinueToPayment(page, session);
    await settleDom(page, 150);
    if (!isBillingPage(page.url()) && !isReviewPage(page.url())) {
      await withReleaseCheck(
        page
          .waitForURL((url) => isBillingPage(url.toString()) || isReviewPage(url.toString()), {
            timeout: 12000,
          })
          .catch(() => {})
      );
      await settleDom(page, 100);
    }
    if (session) {
      const onBilling = isBillingPage(page.url()) || isReviewPage(page.url());
      if (onBilling) {
        await revealAndEnlargeBrowser(session);
        await fillBillingAddressFields(page, {
          useShippingAddress: true,
          session,
        }).catch((err) => {
          console.warn(
            `  Billing／Apple Pay 未完成：${err instanceof Error ? err.message : String(err)}`
          );
        });
      } else {
        console.warn(`${tag} 送貨後未到 Billing（而家 ${page.url()}）`);
      }
      await writeStatus({
        phase: "waiting_for_payment",
        windowHidden: true,
        windowState: "minimized",
        card: cardFieldsFromSession(session, { url: page.url() }),
      });
    }
    return;
  }

  // pickup apple ac apple pay：取貨聯絡 → 前往付款 → Billing 揀 Apple Pay
  if (isPickupAppleAcApplePay() && (mode === "pickup" || isPickupContactPage(page.url()) || prefersPickupOnly())) {
    mode = "pickup";
    if (!isPickupContactPage(page.url())) {
      if (/_s=Fulfillment/i.test(page.url())) {
        mode = await chooseFulfillment(page);
      } else {
        await withReleaseCheck(
          page
            .waitForURL((url) => isPickupContactPage(url.toString()), { timeout: 12000 })
            .catch(() => {})
        );
      }
      await settleDom(page, 100);
    }
    if (!isPickupContactPage(page.url()) && /_s=Fulfillment/i.test(page.url())) {
      mode = await chooseFulfillment(page);
      await settleDom(page, 100);
    }
    await fillPickupContactGuestAndContinue(page, tag, session);
    // 若仍未到 Billing，再等一下再填 Apple Pay
    if (!isBillingPage(page.url()) && !isReviewPage(page.url())) {
      await withReleaseCheck(
        page
          .waitForURL((url) => isBillingPage(url.toString()) || isReviewPage(url.toString()), {
            timeout: 12000,
          })
          .catch(() => {})
      );
      await settleDom(page, 100);
    }
    if (session) {
      const onBilling = isBillingPage(page.url()) || isReviewPage(page.url());
      if (onBilling) {
        await revealAndEnlargeBrowser(session);
        await fillBillingAddressFields(page, {
          useShippingAddress: false,
          session,
        }).catch((err) => {
          console.warn(
            `  Billing／Apple Pay 未完成：${err instanceof Error ? err.message : String(err)}`
          );
        });
      } else {
        console.warn(`${tag} PickupContact 後未到 Billing（而家 ${page.url()}），稍後 Resume 可再試`);
      }
      await writeStatus({
        phase: "waiting_for_payment",
        windowHidden: true,
        windowState: "minimized",
        card: cardFieldsFromSession(session, { url: page.url() }),
      });
    }
    return;
  }

  // 取貨：確保喺 PickupContact 頁再用固定資料填齊
  if (mode === "pickup") {
    if (usesFastPickupContactFill()) {
      await fillPickupContactGuestAndContinue(page, tag, session);
      if (session) {
        const onBilling = isBillingPage(page.url()) || isReviewPage(page.url());
        if (isBillingPage(page.url())) {
          await revealAndEnlargeBrowser(session);
          await fillBillingAddressFields(page, {
            useShippingAddress: shouldUseShippingAddressForBilling(session),
            session,
          }).catch(() => {});
        }
        await writeStatus({
          phase: "waiting_for_payment",
          windowHidden: true,
          windowState: "minimized",
          card: cardFieldsFromSession(session, { url: page.url() }),
        });
      }
      return;
    }
    if (!isPickupContactPage(page.url())) {
      await withReleaseCheck(
        page
          .waitForURL((url) => isPickupContactPage(url.toString()), { timeout: 15000 })
          .catch(() => {})
      );
      await settleAfterNavigation(page);
    }
    console.log(`${tag} 步驟：填寫取貨聯絡資料（PickupContact）`);
    {
      const pc = resolvePickupContact(session, page);
      console.log(`${tag} ${pc.lastName} ${pc.firstName} / ${pc.phone} / ${pc.email}`);
    }
  } else {
    console.log(`${tag} 步驟：填寫送貨聯絡資料`);
    console.log(
      `${tag} ${identity.lastName} ${identity.firstName} | ${identity.area} ${identity.district} | ${identity.street} | ${identity.phone} | ${identity.email}`
    );
  }
  await sleepCheckingRelease(usesApplePay() ? 40 : CONFIG.clickDelayMs);

  let filled = false;
  for (let attempt = 1; attempt <= 3; attempt++) {
    if (isShop404Url(page.url()) || isProductConfigPage(page.url())) {
      await recoverAddToBagIfNeeded(page, tag);
      await settleAfterNavigation(page);
      await goToCheckout(page);
      await settleAfterNavigation(page);
      if (usesAppleAccount()) await signInWithAppleAccount(page);
      else await continueAsGuest(page);
      await settleAfterNavigation(page);
      mode = await chooseFulfillment(page);
      await settleAfterNavigation(page);
    }
    try {
      if (mode === "pickup" && !isPickupContactPage(page.url())) {
        console.warn(`${tag} 第 ${attempt} 次：未喺 PickupContact，而家 ${page.url()}`);
      }
      await fillContactFields(page, identity, mode, session);
      filled = true;
      break;
    } catch (err) {
      console.warn(
        `${tag} 填表第 ${attempt} 次未齊：${err instanceof Error ? err.message : String(err)}`
      );
      await page.waitForTimeout(1500);
      if (attempt === 3) throw err;
    }
  }
  if (!filled) {
    throw new StepError("填寫聯絡資料", "未能完成自動填寫。");
  }

  if (session) session.fulfillmentMode = mode;
  await clickContinueToPayment(page, session);
  if (usesApplePay()) {
    await settleDom(page, 100);
  } else {
    await settleAfterNavigation(page);
  }

  // 撳完又退回 404／產品頁就再走一次
  if (isShop404Url(page.url()) || isProductConfigPage(page.url())) {
    console.warn(
      `${tag} 前往付款後落到 ${isShop404Url(page.url()) ? "/shop/404" : "產品頁"}，復原再試…`
    );
    await recoverAddToBagIfNeeded(page, tag);
    await settleAfterNavigation(page);
    await goToCheckout(page);
    await settleAfterNavigation(page);
    await continueAsGuest(page);
    await settleAfterNavigation(page);
    mode = await chooseFulfillment(page);
    await settleAfterNavigation(page);
    await fillContactFields(page, identity, mode, session);
    await clickContinueToPayment(page, session);
    await settleAfterNavigation(page);
  }

  if (session) {
    session.fulfillmentMode = mode;
    await writeStatus({
      phase: "contact_filled",
      fulfillmentMode: mode,
      fulfillmentPreference: CONFIG.fulfillmentPreference,
      card: cardFieldsFromSession(session),
    });
  }

  // 淨係 Billing 頁（?_s=Billing…）先開大視窗；其他 checkout 步驟保持隱藏
  if (session && (isCheckoutFlowPage(page.url()) || (await isOnPaymentStep(page)) || isBillingPage(page.url()))) {
    const onBilling = isBillingPage(page.url());
    if (onBilling) {
      await revealAndEnlargeBrowser(session);
      await fillBillingAddressFields(page, {
        useShippingAddress: shouldUseShippingAddressForBilling(session),
        session,
      }).catch(() => {});
    }
    await writeStatus({
      phase: "waiting_for_payment",
      windowHidden: true,
      windowState: "minimized",
      card: cardFieldsFromSession(session, { url: page.url() }),
    });
    console.log(`${tag} checkout status 已更新（視窗保持隱藏）`);
  }
}

function firstMatch(text: string, patterns: RegExp[]): string | null {
  for (const re of patterns) {
    const m = text.match(re);
    if (m?.[1]) return m[1].trim();
  }
  return null;
}

async function scrapeConfirmation(page: Page) {
  const url = page.url();
  const title = await page.title().catch(() => "");
  const text = (await page.locator("body").innerText().catch(() => "")) || "";

  const orderNumber = firstMatch(text, [
    /(?:訂單編號|訂單號碼|Order(?:\s+Number)?)\s*[:：]?\s*([A-Z0-9-]{6,})/i,
    /\b(W\d{8,})\b/,
  ]);

  const productName = firstMatch(text, [
    /(iPhone\s*18(?:\s*Pro(?:\s*Max)?)?)/i,
    /(iPhone\s*17(?:\s*Pro(?:\s*Max)?)?)/i,
    new RegExp(`(${CONFIG.model.replace(/\s+/g, "\\s*")})`, "i"),
  ]);

  const color = firstMatch(text, [
    /顏色\s*[:：]?\s*([^\n]{1,40})/,
    /(布根地紅色|銀色|宇宙橙色|深藍色|白色|黑色|薰衣草紫色|霧藍色|鼠尾草綠色)/,
  ]);

  const storage = firstMatch(text, [/容量\s*[:：]?\s*([0-9]+\s*GB)/i, /(\d+\s*GB)/i]);

  const amounts = [
    ...new Set(
      [...text.matchAll(/HK\$\s*[\d,]+(?:\.\d{2})?/gi)].map((m) =>
        m[0].replace(/\s+/g, "")
      )
    ),
  ];

  const scrapedTotalRaw =
    firstMatch(text, [
      /(?:總計|合計|總額|應付總額|訂單總額|Grand Total|Order Total|Total)\s*[:：]?\s*(HK\$\s*[\d,]+(?:\.\d{2})?)/i,
      /(?:你已支付|已付款|Paid)\s*[:：]?\s*(HK\$\s*[\d,]+(?:\.\d{2})?)/i,
    ]) || amounts.at(-1) || null;

  const productResolved = productName ?? CONFIG.model;
  const storageResolved = storage ?? CONFIG.storage;
  const qtyResolved = CONFIG.quantity;
  const resolvedAmt = resolveOrderAmountSpent({
    scrapedAmount: scrapedTotalRaw,
    model: productResolved,
    storage: storageResolved,
    quantity: qtyResolved,
  });
  const total = resolvedAmt.label || scrapedTotalRaw;

  const estimatedDelivery = firstMatch(text, [
    /運送於\s*([0-9]{1,2}\/[0-9]{1,2}\/[0-9]{4}\s*[–—-]\s*[0-9]{1,2}\/[0-9]{1,2}\/[0-9]{4})/i,
    /(?:預計送貨|預計送達|送貨日期|Deliver(?:y|s)|Arrives)\s*[:：]?\s*([^\n]{1,80})/i,
    /(星期[一二三四五六日][^\n]{0,40})/,
  ]);

  const shippingName = firstMatch(text, [
    /(?:收件人|聯絡人|姓名|Name)\s*[:：]?\s*([^\n]{2,40})/i,
  ]);
  const shippingPhone = firstMatch(text, [
    /(?:電話|流動電話|Phone|Mobile)\s*[:：]?\s*((?:\+?852[-\s]?)?[456789]\d{7})/i,
    /\b([456789]\d{7})\b/,
  ]);
  const shippingEmail = firstMatch(text, [
    /(?:電郵|電子郵件|Email)\s*[:：]?\s*([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})/i,
    /\b([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})\b/i,
  ]);
  const shippingAddress = firstMatch(text, [
    /(?:送貨地址|運送地址|地址|Address)\s*[:：]?\s*([^\n]{6,120})/i,
  ]);
  const pickupStore = firstMatch(text, [
    /(?:取貨零售店|取貨門市|Apple Store|Pickup)\s*[:：]?\s*([^\n]{3,80})/i,
    /(Apple\s+(?:ifc mall|Canton Road|Causeway Bay|Festival Walk|apm Hong Kong|New Town Plaza)[^\n]{0,40})/i,
  ]);
  // Apple 確認頁常見：Visa •••• 1234／Mastercard••••1234／以 ••••1234 結尾
  const cardNumber =
    firstMatch(text, [
      /(?:信用卡|扣賬卡|付款卡|付款方式|Card(?:\s*number)?)\s*[:：]?\s*((?:Visa|Master(?:card)?|Amex|American Express|銀聯)?\s*[•*·．.\d\s-]{4,24}\d{4})/i,
      /((?:Visa|Mastercard|Master Card|Amex|American Express|銀聯)\s*[•*·．.]{0,12}\s*\d{4})/i,
      /([•*·．.]{4}\s*[•*·．.\s]{0,12}\d{4})/,
      /\b((?:Visa|Mastercard|Amex)\s+\d{4})\b/i,
    ]) || null;
  const fulfillmentType = /取貨|Pickup/i.test(text)
    ? /送貨|Delivery|Shipping/i.test(text)
      ? "mixed_or_unknown"
      : "pickup"
    : /送貨|Delivery|Shipping/i.test(text)
      ? "delivery"
      : null;

  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 1 && l.length < 200);

  const summaryLines = lines.filter((l) =>
    /iPhone|GB|顏色|容量|型號|送貨|運送|取貨|地址|電話|電郵|Email|小計|運費|稅|總計|合計|AppleCare|訂單|HK\$|ifc|Canton|Causeway|Festival|布根地/i.test(
      l
    )
  );

  return {
    scrapedAt: new Date().toISOString(),
    url,
    title,
    orderNumber,
    productName: productResolved,
    color: color ?? CONFIG.color,
    storage: storageResolved,
    quantity: qtyResolved,
    /** 消費金額（確認頁總計；不合理時用官價×數量） */
    total,
    amountSpent: total,
    amounts,
    estimatedDelivery,
    fulfillmentType,
    shipping: {
      name: shippingName,
      phone: shippingPhone,
      email: shippingEmail,
      address: shippingAddress,
      pickupStore,
      cardNumber,
    },
    /** 信用卡號（通常係遮罩尾四位） */
    cardNumber,
    summaryLines: summaryLines.slice(0, 80),
  };
}

async function buildOrderRecord(
  session: BrowserSession,
  scraped: Awaited<ReturnType<typeof scrapeConfirmation>>
) {
  const mode = session.fulfillmentMode ?? "unknown";
  const boxes = session.deliveryShippingBoxes;
  const pickup = resolvePickupContact(session);
  const usedContact =
    mode === "pickup"
      ? {
          mode: "pickup" as const,
          lastName: pickup.lastName,
          firstName: pickup.firstName,
          phone: pickup.phone,
          email: pickup.email,
          address: scraped.shipping.pickupStore,
        }
      : {
          mode: mode === "delivery" ? ("delivery" as const) : ("unknown" as const),
          lastName: boxes?.lastName || session.identity.lastName,
          firstName: boxes?.firstName || session.identity.firstName,
          phone: session.identity.phone,
          email: session.identity.email,
          address:
            session.deliveryAddressFull ||
            `${session.identity.area} ${session.identity.district} ${session.identity.street}`,
          areaDistrictStreet:
            boxes?.areaDistrictStreet ||
            `${session.identity.area} ${session.identity.district} ${session.identity.street}`,
          buildingFloorUnit: boxes?.buildingFloorUnit || session.identity.buildingLine || "",
        };

  const cardNumber =
    session.capturedCardNumber ||
    scraped.cardNumber ||
    "Apple Pay";
  const poolMeta = lookupCardMeta(cardNumber);
  const assignedForLimit = await loadAssignedCheckoutCard(
    CHECKOUT_CARD_ASSIGN_PATH,
    CHECKOUT_CARD_KEY_PATH
  ).catch(() => null);
  const vaultLimit =
    assignedForLimit?.limit ??
    parseHkAmount(session.cardLimit) ??
    parseHkAmount(poolMeta?.limit);
  const cardCompany =
    poolMeta?.company ||
    resolveCardCompany() ||
    session.cardCompany ||
    (/apple\s*pay/i.test(String(cardNumber || "")) ? "Apple Pay" : "");
  const cardLimit =
    (vaultLimit != null ? formatHkLimit(vaultLimit) : "") ||
    poolMeta?.limit ||
    resolveCardLimit() ||
    session.cardLimit ||
    "";
  const cardTypeResolved =
    poolMeta?.type ||
    detectCardType(cardNumber) ||
    session.cardType ||
    (/apple\s*pay/i.test(String(cardNumber || "")) ? "Apple Pay" : "");
  const orderPlacedAt = session.orderPlacedAt || formatHkOrderDateTime();
  session.orderPlacedAt = orderPlacedAt;

  const resolvedAmt = resolveOrderAmountSpent({
    scrapedAmount: scraped.amountSpent ?? scraped.total,
    model: scraped.productName ?? CONFIG.model,
    storage: scraped.storage ?? CONFIG.storage,
    quantity: scraped.quantity ?? CONFIG.quantity,
  });
  const amountLabel = resolvedAmt.label || scraped.amountSpent || scraped.total || null;

  // 成功落單：Credit cards limit − 今次消費 = 剩餘限額（Live card limits／Google Sheet）
  let remainingCreditCardLimit = "";
  if (scraped.orderNumber && cardNumber && !/apple\s*pay/i.test(String(cardNumber))) {
    const applied = await applySuccessfulCheckoutToCardLimit(
      ROOT,
      cardNumber,
      amountLabel,
      vaultLimit != null ? { originalLimit: vaultLimit } : undefined
    ).catch(() => null);
    if (applied) {
      remainingCreditCardLimit = formatHkLimit(applied.remainingLimit);
      console.log(
        `${session.tag} 卡額：原 ${formatHkLimit(applied.originalLimit) || "?"} − 消費 ${
          applied.amountSpent ?? "?"
        } → 剩餘 ${remainingCreditCardLimit || "—"}（${applied.card.company}/${applied.card.type}）`
      );
    }
  }

  return {
    browser: session.tag,
    orderNumber: scraped.orderNumber,
    productName: scraped.productName,
    productType: scraped.productName ?? CONFIG.model,
    color: scraped.color,
    storage: scraped.storage,
    quantity: scraped.quantity,
    total: amountLabel,
    amountSpent: amountLabel,
    cardNumber,
    cardType: cardTypeResolved,
    cardCompany,
    cardLimit:
      cardLimit ||
      (vaultLimit != null ? formatHkLimit(vaultLimit) : "") ||
      poolMeta?.limit ||
      "",
    /** 成功結帳後剩餘信用額 */
    remainingCreditCardLimit,
    remainingLimit: remainingCreditCardLimit,
    orderPlacedAt,
    estimatedDelivery: scraped.estimatedDelivery ?? session.estimatedDelivery ?? null,
    fulfillmentMode: mode,
    deliveryMethod: fulfillmentLabel(),
    fulfillmentPreference: CONFIG.fulfillmentPreference,
    proxy: CONFIG.proxy || "",
    checkoutContactUsed: usedContact,
    confirmationPageShipping: scraped.shipping,
    deliveryShippingBoxes: boxes || null,
    shippingDetails: {
      name:
        mode === "pickup"
          ? `${pickup.lastName} ${pickup.firstName}`
          : `${boxes?.lastName || session.identity.lastName} ${boxes?.firstName || session.identity.firstName}`,
      phone: usedContact.phone,
      email: usedContact.email,
      address: usedContact.address,
      lastName: mode === "delivery" ? boxes?.lastName || session.identity.lastName : pickup.lastName,
      firstName:
        mode === "delivery" ? boxes?.firstName || session.identity.firstName : pickup.firstName,
      areaDistrictStreet:
        mode === "delivery"
          ? boxes?.areaDistrictStreet ||
            `${session.identity.area} ${session.identity.district} ${session.identity.street}`
          : "",
      buildingFloorUnit:
        mode === "delivery" ? boxes?.buildingFloorUnit || session.identity.buildingLine || "" : "",
      estimatedDelivery: scraped.estimatedDelivery ?? session.estimatedDelivery ?? null,
      pickupStore: scraped.shipping.pickupStore,
      confirmationName: scraped.shipping.name,
      confirmationPhone: scraped.shipping.phone,
      confirmationEmail: scraped.shipping.email,
      confirmationAddress: scraped.shipping.address,
    },
    identity: session.identity,
    pickupContactFixed: pickup,
    url: scraped.url,
    title: scraped.title,
    scrapedAt: scraped.scrapedAt,
    amounts: scraped.amounts,
    summaryLines: scraped.summaryLines,
  };
}

async function runStep(
  name: string,
  fn: () => Promise<void>,
  options?: { pauseOnError?: boolean; page?: Page; retries?: number }
): Promise<boolean> {
  const pauseOnError = options?.pauseOnError ?? true;
  const retries = options?.retries ?? 0;
  const page = options?.page;

  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    await throwIfReleased();
    console.log(`\n▶ ${name}${attempt > 1 ? `（重試 ${attempt - 1}/${retries}）` : ""}`);
    try {
      await fn();
      console.log(`✓ ${name} 完成`);
      return true;
    } catch (err) {
      if (err instanceof ReleaseError) throw err;
      const message = err instanceof Error ? err.message : String(err);
      console.error(`✗ 步驟失敗：${name}`);
      console.error(message);
      if (attempt <= retries && page) {
        await goBackAndSettle(page);
        continue;
      }
      if (pauseOnError) {
        await waitForEnter(
          "請喺瀏覽器人手完成呢一步（或確認而家頁面），搞掂之後…"
        );
      }
      return false;
    }
  }
  return false;
}

/**
 * Windows：喺 Chromium process tree 搵有 MainWindow 嘅視窗，還原／最大化／置頂。
 * （根 process 多數 MainWindowHandle=0，一定要掃 child）
 */
function winBringBrowserToFront(
  browser: BrowserSession["browser"]
): void {
  if (process.platform !== "win32") return;
  const proc = (
    browser as unknown as { process?: () => { pid?: number } | null }
  ).process?.();
  const pid = proc?.pid;
  if (!pid) return;
  const ps = `
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class W {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr extra);
}
'@ -ErrorAction SilentlyContinue
$root = ${pid}
$all = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue
$queue = [System.Collections.Generic.Queue[int]]::new()
$queue.Enqueue([int]$root)
$seen = @{}
$handles = @()
while ($queue.Count -gt 0) {
  $id = $queue.Dequeue()
  if ($seen.ContainsKey($id)) { continue }
  $seen[$id] = $true
  $p = Get-Process -Id $id -ErrorAction SilentlyContinue
  if ($p -and $p.MainWindowHandle -ne [IntPtr]::Zero) {
    $handles += $p.MainWindowHandle
  }
  foreach ($c in @($all | Where-Object { $_.ParentProcessId -eq $id })) {
    $queue.Enqueue([int]$c.ProcessId)
  }
}
# Alt key 技巧：允許非前景 process 搶 SetForegroundWindow
[W]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero)
[W]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
foreach ($h in $handles) {
  if ([W]::IsIconic($h)) { [void][W]::ShowWindowAsync($h, 9) } # SW_RESTORE
  [void][W]::ShowWindowAsync($h, 3) # SW_MAXIMIZE
  [void][W]::BringWindowToTop($h)
  [void][W]::SetForegroundWindow($h)
}
`.trim();
  spawn("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", ps], {
    stdio: "ignore",
    windowsHide: true,
  });
}

/** Windows：強制 minimize（CDP 有時唔夠穩；新開 task 預設藏埋） */
function winMinimizeBrowserWindow(
  browser: BrowserSession["browser"]
): void {
  if (process.platform !== "win32") return;
  const proc = (
    browser as unknown as { process?: () => { pid?: number } | null }
  ).process?.();
  const pid = proc?.pid;
  if (!pid) return;
  const ps = `
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class W {
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr h, int n);
}
'@ -ErrorAction SilentlyContinue
$root = ${pid}
$all = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue
$queue = [System.Collections.Generic.Queue[int]]::new()
$queue.Enqueue([int]$root)
$seen = @{}
while ($queue.Count -gt 0) {
  $id = $queue.Dequeue()
  if ($seen.ContainsKey($id)) { continue }
  $seen[$id] = $true
  $p = Get-Process -Id $id -ErrorAction SilentlyContinue
  if ($p -and $p.MainWindowHandle -ne [IntPtr]::Zero) {
    [void][W]::ShowWindowAsync($p.MainWindowHandle, 6) # SW_MINIMIZE
  }
  foreach ($c in @($all | Where-Object { $_.ParentProcessId -eq $id })) {
    $queue.Enqueue([int]$c.ProcessId)
  }
}
`.trim();
  spawn("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", ps], {
    stdio: "ignore",
    windowsHide: true,
  });
}

async function setBrowserWindowState(
  session: BrowserSession,
  windowState: "minimized" | "normal"
): Promise<void> {
  const windowId = await ensureSessionWindowId(session);
  if (windowId == null) return;
  try {
    const cdp = await session.page.context().newCDPSession(session.page);
    if (windowState === "normal") {
      // 強制拉到最前：unminimize → normal → maximized → bringToFront
      await cdp.send("Browser.setWindowBounds", {
        windowId,
        bounds: { windowState: "normal" },
      });
      if (session.windowBounds) {
        await cdp.send("Browser.setWindowBounds", {
          windowId,
          bounds: { ...session.windowBounds, windowState: "normal" },
        });
      }
      await cdp
        .send("Browser.setWindowBounds", {
          windowId,
          bounds: { windowState: "maximized" },
        })
        .catch(() => {});
      await applyFullWindowViewportAndZoom(session, cdp, windowId).catch(() => {});
      await session.page.bringToFront().catch(() => {});
      await session.page.evaluate(() => {
        try {
          window.focus();
        } catch {
          /* ignore */
        }
      }).catch(() => {});
      winBringBrowserToFront(session.browser);
      // 再試一次：CDP 改完 bounds 後 OS 置頂有時要遲少少
      setTimeout(() => winBringBrowserToFront(session.browser), 350);
      await scrollPageToBottomRight(session.page).catch(() => {});
    } else {
      await cdp.send("Browser.setWindowBounds", {
        windowId,
        bounds: { windowState: "minimized" },
      });
      winMinimizeBrowserWindow(session.browser);
      session.billingWindowRevealed = false;
    }
    await cdp.detach().catch(() => {});
    await writeStatus({
      windowState: windowState === "normal" ? "maximized" : "minimized",
      windowHidden: windowState === "minimized",
      ...(windowState === "normal"
        ? { keepOpen: true, message: "Open browser — brought to front" }
        : { keepOpen: false, message: "Hide — browser minimized" }),
    });
  } catch (err) {
    console.warn(
      `${session.tag} 無法設定視窗 ${windowState}：${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/** Stop all：唔 minimize／唔 fullscreen，還原到原本鋪位／大小 */
async function restoreBrowserWindowLayout(session: BrowserSession): Promise<void> {
  const windowId = await ensureSessionWindowId(session);
  if (windowId == null) return;
  try {
    const cdp = await session.page.context().newCDPSession(session.page);
    // 先取消 minimized
    await cdp
      .send("Browser.setWindowBounds", {
        windowId,
        bounds: { windowState: "normal" },
      })
      .catch(() => {});
    if (session.windowBounds) {
      await cdp.send("Browser.setWindowBounds", {
        windowId,
        bounds: { ...session.windowBounds, windowState: "normal" },
      });
    } else {
      await cdp.send("Browser.setWindowBounds", {
        windowId,
        bounds: { windowState: "normal" },
      });
    }
    await cdp.detach().catch(() => {});
    await writeStatus({
      windowState: "normal",
      windowHidden: false,
      message: "Stop all：視窗保持原本位置",
    }).catch(() => {});
  } catch (err) {
    console.warn(
      `${session.tag} 無法還原視窗位置：${err instanceof Error ? err.message : String(err)}`
    );
  }
}

async function readBrowserWindowState(
  session: BrowserSession
): Promise<"minimized" | "normal" | "maximized" | "fullscreen" | null> {
  if (session.windowId == null) return null;
  try {
    const cdp = await session.page.context().newCDPSession(session.page);
    const { bounds } = await cdp.send("Browser.getWindowBounds", {
      windowId: session.windowId,
    });
    await cdp.detach().catch(() => {});
    return (bounds.windowState as "minimized" | "normal" | "maximized" | "fullscreen") || null;
  } catch {
    return null;
  }
}

/** 處理 Dashboard Open／Hide，同同步 OS 撳「─」minimize 狀態 */
async function syncDashboardWindowFlags(session: BrowserSession): Promise<void> {
  if (process.env.CHECKOUT_DASHBOARD !== "1") return;
  let forced: "normal" | "minimized" | null = null;
  if (await flagExists(DASHBOARD_SHOW_FLAG)) {
    await fs.unlink(DASHBOARD_SHOW_FLAG).catch(() => {});
    await setBrowserWindowState(session, "normal");
    forced = "normal";
    console.log(`${session.tag} Dashboard 要求顯示瀏覽器`);
  }
  if (await flagExists(DASHBOARD_HIDE_FLAG)) {
    await fs.unlink(DASHBOARD_HIDE_FLAG).catch(() => {});
    await setBrowserWindowState(session, "minimized");
    forced = "minimized";
    console.log(`${session.tag} Dashboard 要求隱藏瀏覽器`);
  }
  // 啱啱 force 完唔好即刻用 getWindowBounds 覆寫（Windows 會短暫仍報 minimized）
  if (forced) return;

  const state = await readBrowserWindowState(session);
  if (state) {
    // Billing 已開大之後，短暫誤報 minimized 唔好標 Hidden
    if (session.billingWindowRevealed && state === "minimized") {
      return;
    }
    await writeStatus({
      windowState: state,
      windowHidden: state === "minimized",
    });
  }
}

/** Dashboard：超過 30 秒無步驟進展 → 標 stuck（紅閃） */
const STUCK_AFTER_MS = 30_000;

function startStuckWatcher(): () => void {
  if (process.env.CHECKOUT_DASHBOARD !== "1") return () => {};
  let stopped = false;
  const tick = async () => {
    if (stopped) return;
    try {
      const raw = await fs.readFile(STATUS_FILE, "utf8");
      const st = JSON.parse(raw) as Record<string, unknown>;
      const phase = String(st.phase || "");
      if (
        /waiting_for_payment|waiting_for_stock_at_stores|steps_complete|payment_succeeded|orders_ready|manual_control|closed|idle/i.test(
          phase
        )
      ) {
        if (st.stuck) {
          await writeStatus({ stuck: false, stuckSince: null });
        }
        return;
      }
      const last = Date.parse(String(st.lastProgressAt || st.updatedAt || ""));
      if (!Number.isFinite(last)) return;
      if (Date.now() - last < STUCK_AFTER_MS) return;
      if (st.stuck) return;
      await writeStatus({
        stuck: true,
        stuckSince: new Date(last).toISOString(),
        message:
          String(st.error || st.message || "").trim() ||
          `超過 ${STUCK_AFTER_MS / 1000}s 無進展／未能進入下一步`,
      });
    } catch {
      /* ignore */
    }
  };
  const timer = setInterval(() => {
    void tick();
  }, 5000);
  void tick();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

function startWindowWatcher(sessions: BrowserSession[]): () => void {
  let stopped = false;
  const tick = async () => {
    if (stopped) return;
    for (const s of sessions) {
      await syncDashboardWindowFlags(s).catch(() => {});
    }
  };
  const timer = setInterval(() => {
    void tick();
  }, 500);
  void tick();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

async function holdForManualControl(
  sessions: BrowserSession[]
): Promise<"close" | "resume"> {
  if (await flagExists(DASHBOARD_STOP_ALL_FLAG)) {
    SILENT_STOP_ALL = true;
  }

  if (SILENT_STOP_ALL) {
    console.log("\n已 Stop all：停自動化，瀏覽器保持原本位置（唔隱藏／唔 fullscreen）。");
    for (const s of sessions) {
      await restoreBrowserWindowLayout(s).catch(() => {});
    }
    await writeStatus({
      phase: "manual_control",
      message: "Stop all：自動化已停，視窗保持原本位置",
      windowHidden: false,
      windowState: "normal",
    });
  } else {
    console.log("\n已停止自動化。瀏覽器保留畀你人手操作（Dashboard 顯示 manual_control）。");
    console.log("個別 Stop：唔會自動開大／置頂視窗；要睇請撳 Open browser。");
    console.log("撳 Continue 會由而家頁面繼續跑到最後一步；撳 Close 關閉瀏覽器。");
    // 刻意唔 call setBrowserWindowState / revealAndEnlargeBrowser
    await writeStatus({
      phase: "manual_control",
      message: "自動化已停（視窗保持原狀；Open browser 先開大）",
    });
  }

  while (true) {
    for (const s of sessions) {
      await syncDashboardWindowFlags(s).catch(() => {});
    }
    if (await flagExists(DASHBOARD_CLOSE_FLAG)) {
      await fs.unlink(DASHBOARD_CLOSE_FLAG).catch(() => {});
      await fs.unlink(DASHBOARD_RELEASE_FLAG).catch(() => {});
      await fs.unlink(DASHBOARD_STOP_ALL_FLAG).catch(() => {});
      console.log("收到 Close，準備關閉瀏覽器…");
      await Promise.all(sessions.map((s) => s.browser.close().catch(() => {})));
      await writeStatus({ phase: "closed", windowHidden: true });
      process.exit(0);
    }
    // Continue：恢復自動化
    if (
      (await flagExists(DASHBOARD_CONTINUE_SESSION_FLAG)) ||
      (await flagExists(DASHBOARD_CONTINUE_FLAG))
    ) {
      await fs.unlink(DASHBOARD_CONTINUE_SESSION_FLAG).catch(() => {});
      await fs.unlink(DASHBOARD_CONTINUE_FLAG).catch(() => {});
      await fs.unlink(DASHBOARD_RELEASE_FLAG).catch(() => {});
      console.log("收到 Continue：由而家頁面繼續自動化直到付款／最後一步…");
      await writeStatus({
        phase: "resuming",
        message: "Continue：恢復自動化",
        windowHidden: false,
      });
      return "resume";
    }
    await new Promise((r) => setTimeout(r, 300));
  }
}

async function resumeCheckoutToFinal(session: BrowserSession): Promise<void> {
  const page = session.page;
  const tag = session.tag;
  console.log(`${tag} Resume：由 ${page.url()} 繼續`);
  await throwIfReleased();

  if (await isConfirmationPage(page)) {
    console.log(`${tag} 已喺確認頁`);
    await sealStepsComplete(session);
    return;
  }

  if (await isSignInPage(page)) {
    if (usesAppleAccount()) await signInWithAppleAccount(page);
    else await continueAsGuest(page);
    await settleDom(page, 150);
  }

  if (
    isBillingPage(page.url()) ||
    isReviewPage(page.url()) ||
    (await isOnPaymentStep(page))
  ) {
    // Review：走 fillBillingAddressFields 內嘅 Review 短路徑（iPhone 17／18 共用）
    await fillBillingAddressFields(page, {
      useShippingAddress: shouldUseShippingAddressForBilling(session),
      session,
    }).catch(() => {});
    await sealStepsComplete(session);
    return;
  }

  await fillShippingAndGoToPayment(page, session.identity, tag, session);
  if (isBillingPage(page.url())) {
    await fillBillingAddressFields(page, {
      useShippingAddress: shouldUseShippingAddressForBilling(session),
      session,
    }).catch(() => {});
  }
  await sealStepsComplete(session);
}

function computeWindowLayout(
  index: number,
  total: number,
  screenW: number,
  screenH: number
): { x: number; y: number; width: number; height: number } {
  const n = Math.max(1, total);
  const gap = 4;
  // 4 個 → 四宮格（左上／右上／左下／右下）最大面積；其他按網格
  const cols = n === 1 ? 1 : 2;
  const rows = n <= 2 ? 1 : 2;
  const width = Math.max(320, Math.floor((screenW - gap * (cols + 1)) / cols));
  const height = Math.max(320, Math.floor((screenH - gap * (rows + 1)) / rows));
  const col = index % cols;
  const row = Math.floor(index / cols);
  return {
    x: gap + col * (width + gap),
    y: gap + row * (height + gap),
    width,
    height,
  };
}

/** 解析 Dashboard proxy 字串 → Playwright proxy option */
function parseProxyConfig(raw: string): {
  server: string;
  username?: string;
  password?: string;
} | null {
  const s = String(raw || "").trim();
  if (!s) return null;
  try {
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `http://${s}`;
    const u = new URL(withScheme);
    if (!u.hostname) return null;
    const port = u.port || (u.protocol === "socks5:" || u.protocol === "socks4:" ? "1080" : "80");
    const server = `${u.protocol}//${u.hostname}:${port}`;
    const username = u.username ? decodeURIComponent(u.username) : undefined;
    const password = u.password ? decodeURIComponent(u.password) : undefined;
    return username ? { server, username, password } : { server };
  } catch {
    console.warn(`  proxy 格式無效，已忽略：${s}`);
    return null;
  }
}

async function openSession(index: number, identity: Identity): Promise<BrowserSession> {
  const tag = process.env.CHECKOUT_SESSION_ID
    ? `[${SESSION_ID}]`
    : `[瀏覽器 ${index + 1}]`;
  const totalWindows = Math.max(
    WINDOW_TOTAL || 0,
    CONFIG.browserCount || 1,
    index + 1
  );

  const proxy = parseProxyConfig(String(CONFIG.proxy || ""));
  if (proxy) {
    console.log(`${tag} 使用 proxy：${proxy.server}${proxy.username ? "（有帳密）" : ""}`);
  }

  // 預設隱藏：--start-minimized + CDP/Win32 minimize；要睇先喺 Dashboard 撳 Open browser
  const browser = await chromium.launch({
    headless: false,
    slowMo: 60,
    ...(proxy ? { proxy } : {}),
    args: [
      "--disable-blink-features=AutomationControlled",
      "--window-size=800,600",
      "--start-minimized",
    ],
  });
  const context = await browser.newContext({
    locale: "zh-HK",
    timezoneId: "Asia/Hong_Kong",
    viewport: { width: 780, height: 520 },
    ...(proxy ? { proxy } : {}),
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  attachWrongAppleSearchRecovery(page);

  const screen = await page
    .evaluate(() => ({
      w: window.screen.availWidth || 1920,
      h: window.screen.availHeight || 1080,
    }))
    .catch(() => ({ w: 1920, h: 1080 }));

  const { x, y, width, height } = computeWindowLayout(
    index,
    totalWindows,
    screen.w,
    screen.h
  );
  console.log(
    `${tag} 視窗位置（隱藏中）：x=${x}, y=${y}, ${width}x${height}（共 ${totalWindows} 個，螢幕 ${screen.w}x${screen.h}）`
  );

  await page.setViewportSize({
    width: Math.max(360, width - 16),
    height: Math.max(400, height - 88),
  });

  const windowBounds = { left: x, top: y, width, height };

  let windowId: number | undefined;
  try {
    const cdp = await context.newCDPSession(page);
    const got = await cdp.send("Browser.getWindowForTarget");
    windowId = got.windowId;
    // 記低鋪位，但仍維持 minimized（Open browser 先還原）
    await cdp.send("Browser.setWindowBounds", {
      windowId,
      bounds: {
        ...windowBounds,
        windowState: "minimized",
      },
    });
    await cdp.detach().catch(() => {});
  } catch (err) {
    console.warn(
      `${tag} 無法用 CDP 設定視窗：${err instanceof Error ? err.message : String(err)}`
    );
  }
  winMinimizeBrowserWindow(browser);

  return { tag, identity, browser, page, windowId, windowBounds };
}

async function runCheckoutToPayment(session: BrowserSession): Promise<void> {
  const { tag, identity, page } = session;
  const base = { pauseOnError: false, page, retries: 2 };

  console.log(`\n${tag} 開啟購買頁：`, CONFIG.buyUrl);
  console.log(
    `${tag} 資料：${identity.lastName}${identity.firstName} / ${identity.area} ${identity.district} / ${identity.street} / ${identity.phone} / ${identity.email}`
  );
  await publishTaskSnapshot(session, "starting", {
    message: "開啟購買頁",
    url: CONFIG.buyUrl,
  });
  await page.goto(CONFIG.buyUrl, { waitUntil: "domcontentloaded" });
  await dismissCookies(page);
  if (isShop404Url(page.url())) {
    console.warn(`${tag} 開買頁即到 /shop/404 → 先試購物袋復原`);
    await recoverFromShop404IfNeeded(page, tag);
  }

  if (isAttachStepUrl(CONFIG.buyUrl) || isAttachStepUrl(page.url())) {
    console.log(`${tag} attach URL — 跳過揀規格，稍後直接「查看購物袋」`);
  } else if (
    isIphone17Task() &&
    (isConfiguredProductSlugUrl(CONFIG.buyUrl) || isConfiguredProductSlugUrl(page.url()))
  ) {
    // delivery／pickup credit card 訪客：slug 頁已帶顏色容量，留待加購步驟一次過揀不換購／無 AppleCare
    console.log(`${tag} 已配置 iPhone 17 slug — 規格揀選交俾「加入購物袋」步驟`);
  } else {
    const okOptions = await runStep(
      `${tag} 揀型號／顏色／容量`,
      () => selectProductOptions(page),
      { ...base, retries: 1 }
    );
    if (!okOptions) {
      await page.goto(CONFIG.buyUrl, { waitUntil: "domcontentloaded" });
      await selectProductOptions(page).catch(() => {});
    }
  }

  await runStep(
    `${tag} ${
      isAttachStepUrl(CONFIG.buyUrl) ? "查看購物袋" : "加入購物袋／等待開賣撳繼續"
    }`,
    () => addToBagAndOpenBag(page),
    {
      ...base,
      retries: 0,
    }
  );
  await publishTaskSnapshot(session, "cart_added", {
    message: "已加入購物袋",
    url: page.url(),
  });
  await runStep(
    `${tag} 數量改做 ${CONFIG.quantity}`,
    () => setBagQuantity(page, CONFIG.quantity),
    base
  );
  await publishTaskSnapshot(session, "cart_ready", {
    message: `購物袋數量 ×${CONFIG.quantity}`,
    url: page.url(),
  });
  await runStep(`${tag} 前往結帳`, () => goToCheckout(page), base);
  await markWaitingForPayment(session, page, tag);
  await publishTaskSnapshot(session, "checkout", {
    message: "已前往結帳",
    url: page.url(),
  });
  if (usesAppleAccount()) {
    await runStep(`${tag} 以 Apple 帳戶登入`, () => signInWithAppleAccount(page), {
      ...base,
      retries: 1,
    });
  } else {
    await runStep(`${tag} 以訪客身份繼續`, () => continueAsGuest(page), base);
  }
  await markWaitingForPayment(session, page, tag);
  await publishTaskSnapshot(session, "guest_or_signin", {
    message: usesAppleAccount() ? "已登入 Apple 帳戶" : "已以訪客繼續",
    url: page.url(),
  });
  await runStep(
    `${tag} 填寫聯絡資料並前往付款`,
    () => fillShippingAndGoToPayment(page, identity, tag, session),
    { ...base, retries: 2 }
  );
  await publishTaskSnapshot(session, "contact_filled", {
    message: "已填聯絡資料／前往付款",
    url: page.url(),
  });
}

/** Dashboard：即時把而家 session 資料推去 Opened browsers */
async function publishTaskSnapshot(
  session: BrowserSession,
  phase: string,
  extra?: Record<string, unknown>
): Promise<void> {
  const url =
    (extra?.url as string | undefined) ||
    session.page.url() ||
    "";
  await writeStatus({
    phase,
    message: String(extra?.message || phase),
    windowHidden: true,
    card: cardFieldsFromSession(session, {
      url,
      ...extra,
    }),
    identity: session.identity,
  });
}

function cardFieldsFromSession(session: BrowserSession, extra?: Record<string, unknown>) {
  const id = session.identity;
  const mode = session.fulfillmentMode;
  const boxes = session.deliveryShippingBoxes;
  const isDeliveryUi =
    mode === "delivery" ||
    (mode !== "pickup" && prefersDeliveryOnly());
  const pickup = resolvePickupContact(session);
  const contact =
    mode === "pickup"
      ? {
          name: `${pickup.lastName} ${pickup.firstName}`,
          email: pickup.email,
          phone: pickup.phone,
          address: "（取貨門市，見確認頁）",
        }
      : {
          name: `${boxes?.lastName || id.lastName} ${boxes?.firstName || id.firstName}`,
          email: id.email,
          phone: id.phone,
          address:
            session.deliveryAddressFull ||
            `${id.area} ${id.district} ${id.street}`,
        };
  const eta =
    (extra?.estimatedDelivery as string | null | undefined) ??
    session.estimatedDelivery ??
    null;
  const estimated = resolveOrderAmountSpent({
    scrapedAmount: extra?.total,
    model: CONFIG.model,
    storage: CONFIG.storage,
    quantity: (extra?.quantity as number | undefined) ?? CONFIG.quantity,
  });
  return {
    productType: CONFIG.model,
    color: CONFIG.color,
    storage: CONFIG.storage,
    quantity: CONFIG.quantity,
    fulfillmentMode: mode ?? CONFIG.fulfillmentPreference,
    fulfillmentPreference: CONFIG.fulfillmentPreference,
    deliveryMethod: fulfillmentLabel(),
    orderNumber: null as string | null,
    total:
      (extra?.total as string | null | undefined) ||
      estimated.label ||
      null,
    email: contact.email,
    phone: contact.phone,
    address: contact.address,
    name: contact.name,
    estimatedDelivery: eta,
    proxy: CONFIG.proxy || "",
    lastName: boxes?.lastName || (mode === "pickup" ? pickup.lastName : id.lastName),
    firstName: boxes?.firstName || (mode === "pickup" ? pickup.firstName : id.firstName),
    areaDistrictStreet: isDeliveryUi
      ? boxes?.areaDistrictStreet || `${id.area} ${id.district} ${id.street}`
      : "",
    buildingFloorUnit: isDeliveryUi
      ? boxes?.buildingFloorUnit || id.buildingLine || ""
      : "",
    /** delivery 時顯示完整送貨聯絡；卡號唔自動填，確認頁先會有遮罩卡號 */
    deliveryDetails: isDeliveryUi
      ? {
          name: contact.name,
          email: contact.email,
          phone: contact.phone,
          address: contact.address,
          lastName: boxes?.lastName || id.lastName,
          firstName: boxes?.firstName || id.firstName,
          areaDistrictStreet:
            boxes?.areaDistrictStreet || `${id.area} ${id.district} ${id.street}`,
          buildingFloorUnit: boxes?.buildingFloorUnit || id.buildingLine || "",
          estimatedDelivery: eta,
          cardNumber:
            usesApplePay()
              ? "Apple Pay"
              : ((extra?.cardNumber as string | null | undefined) &&
                  String(extra.cardNumber).trim() &&
                  !/人手填/.test(String(extra.cardNumber))
                    ? String(extra.cardNumber).trim()
                    : "Apple Pay"),
          cardType:
            (extra?.cardType as string | null | undefined) ||
            detectCardType(
              (extra?.cardNumber as string | null | undefined) ||
                (usesApplePay() ? "Apple Pay" : null)
            ) ||
            "",
          cardCompany:
            (extra?.cardCompany as string | null | undefined) ||
            resolveCardCompany() ||
            "",
          cardLimit:
            (extra?.cardLimit as string | null | undefined) || resolveCardLimit() || "",
        }
      : null,
    cardNumber:
      (extra?.cardNumber as string | null | undefined) &&
      String(extra.cardNumber).trim() &&
      !/人手填/.test(String(extra.cardNumber))
        ? String(extra.cardNumber).trim()
        : "Apple Pay",
    cardType:
      (extra?.cardType as string | null | undefined) ||
      detectCardType(
        (extra?.cardNumber as string | null | undefined) ||
          (usesApplePay() ? "Apple Pay" : null)
      ) ||
      "",
    cardCompany:
      (extra?.cardCompany as string | null | undefined) || resolveCardCompany() || "",
    cardLimit: (extra?.cardLimit as string | null | undefined) || resolveCardLimit() || "",
    remainingCreditCardLimit:
      (extra?.remainingCreditCardLimit as string | null | undefined) ||
      (extra?.remainingLimit as string | null | undefined) ||
      "",
    remainingLimit:
      (extra?.remainingLimit as string | null | undefined) ||
      (extra?.remainingCreditCardLimit as string | null | undefined) ||
      "",
    orderPlacedAt:
      (extra?.orderPlacedAt as string | null | undefined) || session.orderPlacedAt || null,
    buyUrl: CONFIG.buyUrl,
    ...extra,
  };
}

async function main(): Promise<void> {
  await ensureRuntimeDir();
  await loadRuntimeConfig();

  if (process.env.CHECKOUT_SESSION_ID) {
    CONFIG.browserCount = 1;
  }

  await fs.unlink(DASHBOARD_RELEASE_FLAG).catch(() => {});
  await fs.unlink(DASHBOARD_CLOSE_FLAG).catch(() => {});
  await fs.unlink(DASHBOARD_SHOW_FLAG).catch(() => {});
  await fs.unlink(DASHBOARD_HIDE_FLAG).catch(() => {});

  const count = CONFIG.browserCount;
  const emails = await takeNEmails(count);
  const identities = makeIdentities(emails);

  console.log(`準備同時開啟 ${count} 個獨立瀏覽器：`);
  console.log(
    `開賣時間：${CONFIG.saleStartIso}｜產品頁每 ${CONFIG.productPollIntervalMs / 1000} 秒 refresh，重試「繼續」直到下一頁`
  );
  identities.forEach((id, i) => {
    console.log(
      `  瀏覽器 ${i + 1}: ${id.lastName} ${id.firstName} | ${id.area} ${id.district} | ${id.street} | ${id.phone} | ${id.email}`
    );
  });

  let sessions: BrowserSession[] = [];
  let stopWatcher: (() => void) | null = null;
  let stopStuckWatcher: (() => void) | null = null;
  try {
    sessions = await Promise.all(
      identities.map((identity, index) =>
        openSession(process.env.CHECKOUT_SESSION_ID ? WINDOW_INDEX : index, identity)
      )
    );
    ACTIVE_SESSIONS = sessions;
    stopWatcher = startWindowWatcher(sessions);
    stopStuckWatcher = startStuckWatcher();

    const primary = sessions[0]!;
    await writeStatus({
      phase: "starting",
      pid: process.pid,
      label: SESSION_ID,
      windowIndex: WINDOW_INDEX,
      windowHidden: true,
      windowState: "minimized",
      card: cardFieldsFromSession(primary),
      identity: primary.identity,
    });
    // 確保啟動後視窗已隱藏
    for (const s of sessions) await setBrowserWindowState(s, "minimized");

    const finishAfterPayment = async () => {
      await waitForEnter("已經落單、見到訂單確認頁之後…", {
        phase: "waiting_for_payment",
        session: primary,
      });

      const summaries = [];
      for (const session of sessions) {
        await captureCardNumberIfPresent(session).catch(() => {});
        const scraped = await scrapeConfirmation(session.page);
        if (scraped.orderNumber && !session.orderPlacedAt) {
          session.orderPlacedAt = formatHkOrderDateTime();
          console.log(`${session.tag} 記錄落單時間：${session.orderPlacedAt}`);
        }
        summaries.push(await buildOrderRecord(session, scraped));
        if (scraped.orderNumber) {
          const rec = summaries[summaries.length - 1] as {
            orderNumber?: string | null;
            total?: string | null;
            amountSpent?: string | null;
            quantity?: number;
            cardNumber?: string | null;
            cardType?: string;
            cardCompany?: string;
            cardLimit?: string;
            remainingCreditCardLimit?: string;
            remainingLimit?: string;
            orderPlacedAt?: string | null;
          };
          await writeStatus({
            phase: "payment_succeeded",
            card: cardFieldsFromSession(session, {
              orderNumber: rec.orderNumber,
              total: rec.amountSpent || rec.total || scraped.total,
              quantity: rec.quantity ?? scraped.quantity,
              cardNumber: rec.cardNumber ?? session.capturedCardNumber ?? scraped.cardNumber,
              cardType: rec.cardType || "",
              cardCompany: rec.cardCompany || "",
              cardLimit: rec.cardLimit || "",
              remainingCreditCardLimit: rec.remainingCreditCardLimit || "",
              remainingLimit: rec.remainingLimit || rec.remainingCreditCardLimit || "",
              orderPlacedAt: rec.orderPlacedAt || session.orderPlacedAt,
              paymentSucceeded: true,
            }),
          });
        }
      }

      console.log("\n===== 訂單編號 =====");
      for (const s of summaries) {
        console.log(
          `${s.browser} 訂單編號：${s.orderNumber ?? "（確認頁未讀到，請人手抄）"}`
        );
      }

      console.log("\n===== 訂單摘要（含送貨／取貨聯絡資料）=====");
      console.log(JSON.stringify(summaries, null, 2));
      await fs.writeFile(OUT_FILE, JSON.stringify(summaries, null, 2), "utf8");
      if (SESSION_ID !== "default") {
        try {
          let all: unknown[] = [];
          try {
            all = JSON.parse(await fs.readFile(LEGACY_OUT_FILE, "utf8")) as unknown[];
            if (!Array.isArray(all)) all = [];
          } catch {
            all = [];
          }
          all.push(...summaries);
          await fs.writeFile(LEGACY_OUT_FILE, JSON.stringify(all, null, 2), "utf8");
        } catch {
          /* ignore */
        }
      } else {
        await fs
          .writeFile(LEGACY_OUT_FILE, JSON.stringify(summaries, null, 2), "utf8")
          .catch(() => {});
      }
      console.log(`\n已寫入 ${OUT_FILE}`);
      const first = summaries[0] as {
        orderNumber?: string | null;
        total?: string | null;
        quantity?: number;
        cardNumber?: string | null;
      };
      const paid = Boolean(first?.orderNumber);
      await writeStatus({
        phase: paid ? "payment_succeeded" : "orders_ready",
        orderCount: summaries.length,
        summaries,
        card: cardFieldsFromSession(primary, {
          orderNumber: first?.orderNumber ?? null,
          total: first?.total ?? null,
          quantity: first?.quantity ?? CONFIG.quantity,
          cardNumber: first?.cardNumber ?? null,
          paymentSucceeded: paid,
        }),
      });

      await waitForEnter("可以檢查完瀏覽器再關閉。");
    };

    const runAutomationToPayment = async (mode: "fresh" | "resume") => {
      if (mode === "fresh") {
        await Promise.all(
          sessions.map(async (session) => {
            await runCheckoutToPayment(session);
            const onBilling = isBillingPage(session.page.url());
            const onReview = isReviewPage(session.page.url());
            const assignedCard = await loadAssignedCheckoutCard(
              CHECKOUT_CARD_ASSIGN_PATH,
              CHECKOUT_CARD_KEY_PATH
            ).catch(() => null);
            if (onReview && selectsApplePayAtBilling()) {
              await completeDeliveryApplePayReview(session.page, session).catch((err) => {
                console.warn(
                  `${session.tag} Review CTA：${err instanceof Error ? err.message : String(err)}`
                );
              });
            } else if (onReview && assignedCard) {
              await completeCreditCardReviewSubmit(
                session.page,
                session,
                assignedCard
              ).catch((err) => {
                console.warn(
                  `${session.tag} 立即提交訂單：${err instanceof Error ? err.message : String(err)}`
                );
              });
            } else if (onBilling) {
              await fillBillingAddressFields(session.page, {
                useShippingAddress: shouldUseShippingAddressForBilling(session),
                session,
              }).catch(() => {});
            }
            await sealStepsComplete(session);
            const payHint = usesApplePay()
              ? "請喺裝置完成 Apple Pay 確認"
              : assignedCard
                ? "已嘗試 autofill 信用卡並撳「立即提交訂單」"
                : "請手動輸入信用卡卡號並確認";
            console.log(
              `\n${session.tag} 自動化步驟完成（視窗保持隱藏）；${payHint}`
            );
            console.log(`${session.tag} URL：${session.page.url()}`);
            console.log(`${session.tag} 電郵：${session.identity.email}`);
          })
        );
      } else {
        await Promise.all(sessions.map((s) => resumeCheckoutToFinal(s)));
      }

      console.log(
        usesApplePay()
          ? "腳本唔會完成 Apple Pay 認證／落單。請喺裝置／瀏覽器完成確認。"
          : "Credit cards 池：已 autofill 並嘗試撳「立即提交訂單」；請喺 Dashboard 核對訂單結果。"
      );
      await finishAfterPayment();
    };

    // Stop(take over) → Continue 可恢復；Close 會 process.exit
    let automationMode: "fresh" | "resume" = "fresh";
    for (;;) {
      try {
        await runAutomationToPayment(automationMode);
        break;
      } catch (err) {
        if (!(err instanceof ReleaseError) || !sessions.length) throw err;
        const wantClose =
          /關閉/.test(err.message) || (await flagExists(DASHBOARD_CLOSE_FLAG));
        if (wantClose) {
          console.warn(err.message);
          await Promise.all(sessions.map((s) => s.browser.close().catch(() => {})));
          await writeStatus({ phase: "closed", windowHidden: true });
          process.exit(0);
        }
        console.warn(err.message);
        const action = await holdForManualControl(sessions);
        if (action === "resume") {
          automationMode = "resume";
          continue;
        }
        break;
      }
    }
  } catch (err) {
    if (err instanceof ReleaseError && sessions.length) {
      const wantClose =
        /關閉/.test(err.message) || (await flagExists(DASHBOARD_CLOSE_FLAG));
      if (wantClose) {
        console.warn(err.message);
        await Promise.all(sessions.map((s) => s.browser.close().catch(() => {})));
        await writeStatus({ phase: "closed", windowHidden: true });
        process.exit(0);
      }
      console.warn(err.message);
      const action = await holdForManualControl(sessions);
      if (action === "resume") {
        try {
          await Promise.all(sessions.map((s) => resumeCheckoutToFinal(s)));
          await waitForEnter("已經落單、見到訂單確認頁之後…", {
            phase: "waiting_for_payment",
            session: sessions[0],
          });
        } catch (err2) {
          if (err2 instanceof ReleaseError) {
            await holdForManualControl(sessions);
          } else throw err2;
        }
      }
    } else {
      throw err;
    }
  } finally {
    stopWatcher?.();
    stopStuckWatcher?.();
    if (process.env.CHECKOUT_DASHBOARD === "1" && sessions.length) {
      const wantClose = await flagExists(DASHBOARD_CLOSE_FLAG);
      if (!wantClose) {
        try {
          // waiting for payment／未關：保持瀏覽器開住並隱藏，唔自動 close
          await holdSessionsHiddenUntilClose(sessions);
        } catch (err) {
          if (
            !(err instanceof ReleaseError) ||
            !/關閉/.test(err.message)
          ) {
            console.warn(
              `保持瀏覽器時出錯：${err instanceof Error ? err.message : String(err)}`
            );
          }
        }
      }
    }
    await Promise.all(sessions.map((s) => s.browser.close().catch(() => {})));
    await writeStatus({ phase: "closed", windowHidden: true });
  }
}

main().catch(async (err) => {
  console.error("失敗：", err);
  await writeStatus({
    phase: "error",
    error: err instanceof Error ? err.message : String(err),
    message: err instanceof Error ? err.message : String(err),
  });
  process.exitCode = 1;
});

/**
 * iPhone 18 Pro Max（香港）門市取貨庫存監控 — 獨立模組
 *
 * - 讀 config/sku_map.json（由 scripts/fetch_skus.py 產生）
 * - 主路徑：retail/pickup-message?location=中環（fulfillment-messages 易 541）
 * - 結果寫入 runtime/promax-pickup-stock.jsonl；最新：promax-pickup-latest.json
 * - 有貨變化 → runtime/restock-history.jsonl（Live 補貨紀錄）
 *
 * 細節／排查：見 .cursor/rules/promax-pickup-monitor.mdc
 *
 * 由 dashboard server 啟動；亦可單獨：
 *   npx tsx -e "import { startPromaxPickupMonitor } from './src/promax-pickup-monitor.ts'; startPromaxPickupMonitor()"
 */
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  hasTelegramCreds,
  notifyPromaxHealthAlert,
  notifyPromaxModeChange,
  notifyPromaxTelegram,
  upsertPromaxTelegramStatus,
} from "./promax-telegram.js";
import {
  getMonitorProxyStatus,
  monitorFetchGet,
  rotateMonitorProxyOnBlock,
  setMonitorProxyPool,
} from "./promax-monitor-proxy.js";
import {
  noteRestockAt,
  reloadPromaxSchedule,
  resolveScheduleMode,
  scheduleIntervalRange,
  type ScheduleSnapshot,
} from "./promax-schedule.js";

export { setMonitorProxyPool, getMonitorProxyStatus, getMonitorProxyPoolText } from "./promax-monitor-proxy.js";
export type { ScheduleSnapshot };

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SKU_MAP_PATH = path.join(ROOT, "config", "sku_map.json");
const RUNTIME_DIR = path.join(ROOT, "runtime");
const COLLECTION_PATH = path.join(RUNTIME_DIR, "promax-pickup-stock.jsonl");
const LATEST_PATH = path.join(RUNTIME_DIR, "promax-pickup-latest.json");
const RESTOCK_HISTORY_FILE = path.join(RUNTIME_DIR, "restock-history.jsonl");
const RESTOCK_HISTORY_MAX = 800;

const PICKUP_MESSAGE_URL =
  "https://www.apple.com/hk/shop/retail/pickup-message";
/** 舊 endpoint 易被 541；保留作 fallback */
const FULFILLMENT_URL =
  "https://www.apple.com/hk/shop/fulfillment-messages";
const PRODUCT_REFERER =
  "https://www.apple.com/hk/shop/buy-iphone/iphone-18-pro";
/** pickup-message 要地區名（「HK」會空；中環可覆蓋六間店） */
const PICKUP_LOCATION = "中環";

/** Live 補貨紀錄門市代碼 */
const STORE_CODES: Record<string, string> = {
  causeway_bay: "CWB",
  ifc: "IFC",
  festival_walk: "FW",
  apm: "APM",
  new_town_plaza: "NTP",
  canton_road: "TST",
};

/** 香港 6 間 Apple Store（監控目標；回應用 fuzzy match） */
export const HK_APPLE_STORES = [
  {
    id: "causeway_bay",
    name: "Causeway Bay",
    aliases: ["Causeway Bay", "銅鑼灣", "HKT"],
  },
  {
    id: "ifc",
    name: "ifc mall",
    aliases: ["ifc mall", "ifc", "IFC", "國際金融中心"],
  },
  {
    id: "festival_walk",
    name: "Festival Walk",
    aliases: ["Festival Walk", "又一城"],
  },
  {
    id: "apm",
    name: "apm Hong Kong",
    aliases: ["apm Hong Kong", "apm", "APM", "觀塘"],
  },
  {
    id: "new_town_plaza",
    name: "New Town Plaza",
    aliases: ["New Town Plaza", "新城市廣場", "沙田"],
  },
  {
    id: "canton_road",
    name: "Canton Road",
    aliases: ["Canton Road", "廣東道", "R428"],
  },
] as const;

type SkuMap = Record<string, Record<string, string>>;

export type PromaxStockRow = {
  timestamp: string;
  sku: string;
  color: string;
  storage: string;
  store_name: string;
  pickup_display: string;
  pickup_quote: string;
};

export type StoreCell = {
  store_id: string;
  store_name: string;
  pickup_display: string | null;
  pickup_quote: string | null;
  matched_store_name: string | null;
};

export type MatrixEntry = {
  sku: string;
  color: string;
  storage: string;
  stores: StoreCell[];
};

export type PromaxPickupStatus = {
  ok: boolean;
  product: "iPhone 18 Pro Max";
  storages: string[];
  colors: string[];
  stores: { id: string; name: string }[];
  matrix: MatrixEntry[];
  /** 顏色 × 容量 × 門市 快捷表：matrix_by[storage][color][store_id] */
  matrix_by: Record<
    string,
    Record<string, Record<string, StoreCell>>
  >;
  last_success_at: string | null;
  last_attempt_at: string | null;
  last_error: string | null;
  consecutive_failures: number;
  next_poll_in_ms: number | null;
  poll_interval_ms: number;
  /** hot=已知補貨時段或有貨；peak=時段外疏掃 */
  poll_mode: "hot" | "peak";
  schedule?: ScheduleSnapshot;
  running: boolean;
  rows_in_last_poll: number;
  /** sku → 首次偵測到有貨時間（ISO）；重啟後可恢復 */
  available_since?: Record<string, string>;
  /** `${sku}|${store_id}` → 上次是否 available（重啟恢復用） */
  prev_available?: Record<string, boolean>;
};

type MonitorState = {
  running: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  consecutiveFailures: number;
  pollIntervalMs: number;
  nextPollInMs: number | null;
  lastSuccessAt: string | null;
  lastAttemptAt: string | null;
  lastError: string | null;
  latest: PromaxPickupStatus | null;
  /** `${sku}|${store_id}` → was available */
  prevAvailable: Map<string, boolean>;
  /** sku → 首次有貨時間 ms */
  availableSinceMs: Map<string, number>;
  /** 上次成功輪詢時有冇任何門市有貨 */
  anyInStock: boolean;
};

export type RestockHistoryEvent = {
  at: string;
  atHk: string;
  event: "restock" | "qty_up" | "sold_out" | "store_stock";
  name: string;
  model: string;
  color: string;
  storage: string;
  stockQty: number | null;
  buyQty: number;
  prevStockQty?: number | null;
  detail?: string;
  /** 由有貨到售罄嘅時長（毫秒）；只 sold_out 有） */
  inStockForMs?: number | null;
  inStockForLabel?: string | null;
  availableSince?: string | null;
  storeStocks?: Array<{
    code: string;
    name: string;
    qty: number | null;
    available: boolean;
    label: string;
  }>;
};

type PromaxHooks = {
  onPollComplete?: (
    status: PromaxPickupStatus,
    newRestockEvents: RestockHistoryEvent[]
  ) => void | Promise<void>;
};

let hooks: PromaxHooks = {};

export function setPromaxPickupHooks(next: PromaxHooks): void {
  hooks = next;
}

/** 可 .env 覆寫：PROMAX_POLL_IDLE_MIN_MS / IDLE_MAX / HOT_MIN / HOT_MAX */
function envMs(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= 5_000 ? Math.floor(n) : fallback;
}

/** 全無貨：稍密捉補貨（預設 45–60s） */
const IDLE_POLL_MIN_MS = envMs("PROMAX_POLL_IDLE_MIN_MS", 45_000);
const IDLE_POLL_MAX_MS = envMs("PROMAX_POLL_IDLE_MAX_MS", 60_000);
/** 有貨中：加密捉售罄（預設 25–40s；太密易觸發 541） */
const HOT_POLL_MIN_MS = envMs("PROMAX_POLL_HOT_MIN_MS", 25_000);
const HOT_POLL_MAX_MS = envMs("PROMAX_POLL_HOT_MAX_MS", 40_000);
const JITTER_MS = 8_000;
const BACKOFF_CAP_MS = 15 * 60_000;
/** 541/403/429 熔斷冷卻（預設 12 分鐘） */
const EDGE_COOLDOWN_MS = envMs("PROMAX_EDGE_COOLDOWN_MS", 12 * 60_000);
const MAX_COLLECTION_LINES = 50_000;

const state: MonitorState = {
  running: false,
  timer: null,
  consecutiveFailures: 0,
  pollIntervalMs: 52_000,
  nextPollInMs: null,
  lastSuccessAt: null,
  lastAttemptAt: null,
  lastError: null,
  latest: null,
  prevAvailable: new Map(),
  availableSinceMs: new Map(),
  anyInStock: false,
};

/** Telegram live status 上次推送時間（節流） */
let lastTelegramStatusAt = 0;
/** 上次已通知嘅監控模式（切換先再推） */
let lastNotifiedPollMode: string | null = null;

/** 健康檢查／自動修復 */
const STALE_SUCCESS_MS = 8 * 60_000;
const WATCHDOG_MS = 60_000;
const MAX_AUTO_HEAL = 3;
const EXPECTED_ROWS_SOFT = 24; // 8×6=48；少過呢個當半失效

let healthWatchdog: ReturnType<typeof setInterval> | null = null;
let wasUnhealthy = false;
let autoHealAttempts = 0;
let softLowRowStreak = 0;
/** 自動修復時覆寫下一次間隔（ms） */
let rescheduleOverrideMs: number | null = null;
let lastAutoHealAt = 0;
/** Apple 邊緣擋（541/403/429）冷卻至此時刻 */
let edgeBlockedUntil = 0;
let lastEdgeCooldownNotifyAt = 0;

function edgeBlockRemainingMs(): number {
  return Math.max(0, edgeBlockedUntil - Date.now());
}

function tripEdgeBlock(status: number, where: string): void {
  if (status !== 429 && status !== 403 && status !== 541) return;
  // 有其他監控 proxy 可轉 → 短暫停一下就換線，唔使熔斷 12 分鐘
  if (rotateMonitorProxyOnBlock(`HTTP ${status} @ ${where}`)) {
    edgeBlockedUntil = Date.now() + randomBetween(8_000, 15_000);
    console.warn(
      `[promax-pickup] edge HTTP ${status} @ ${where} — rotated monitor proxy, brief pause`
    );
    return;
  }
  const cool =
    status === 541
      ? EDGE_COOLDOWN_MS
      : Math.min(EDGE_COOLDOWN_MS, 5 * 60_000);
  const until = Date.now() + cool;
  if (until > edgeBlockedUntil) {
    edgeBlockedUntil = until;
    console.warn(
      `[promax-pickup] edge block HTTP ${status} @ ${where} — cooldown ${Math.round(cool / 60_000)}m`
    );
  }
}

async function notifyEdgeCooldown(statusHint: string): Promise<void> {
  const rem = edgeBlockRemainingMs();
  if (rem <= 0) return;
  const now = Date.now();
  if (now - lastEdgeCooldownNotifyAt < 10 * 60_000) return;
  lastEdgeCooldownNotifyAt = now;
  void notifyPromaxHealthAlert({
    kind: "auto_heal",
    reason: `Apple 邊緣擋請求（${statusHint}）。已暫停輪詢約 ${Math.ceil(rem / 60_000)} 分鐘，冷卻後自動重試 — 唔使重啟 Dashboard。若成日發生可喺 Dashboard 加 proxy。`,
    lastError: state.lastError,
    lastSuccessAt: state.lastSuccessAt,
    consecutiveFailures: state.consecutiveFailures,
    pollMode: currentPollMode(),
  }).catch(() => {});
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function randomBetween(min: number, max: number): number {
  return Math.floor(min + Math.random() * (max - min + 1));
}

function formatDurationLabel(ms: number): string {
  const sec = Math.max(0, Math.round(ms / 1000));
  if (sec < 60) return `${sec}秒`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m < 60) return s ? `${m}分${s}秒` : `${m}分鐘`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm ? `${h}小時${rm}分` : `${h}小時`;
}

function currentPollMode(): PromaxPickupStatus["poll_mode"] {
  const snap = resolveScheduleMode(state.anyInStock);
  return snap.mode === "peak" ? "peak" : "hot";
}

/** hot 有貨最密；hot 時段內次密；peak 時段外疏；失敗 ≥2 → backoff */
function computeNextIntervalMs(failures: number): number {
  const sched = resolveScheduleMode(state.anyInStock);
  const ranged = scheduleIntervalRange(sched.mode, {
    anyInStock: state.anyInStock,
  });
  let min: number;
  let max: number;
  if (sched.mode === "hot" && state.anyInStock) {
    min = HOT_POLL_MIN_MS;
    max = HOT_POLL_MAX_MS;
  } else if (ranged) {
    min = ranged.min;
    max = ranged.max;
  } else if (sched.mode === "peak") {
    min = 6 * 60_000;
    max = 10 * 60_000;
  } else {
    min = 90_000;
    max = 150_000;
  }
  max = Math.max(min, max);
  const base = randomBetween(min, max);
  const jitter =
    sched.mode === "peak"
      ? randomBetween(-45_000, 45_000)
      : randomBetween(-JITTER_MS, JITTER_MS);
  let ms = Math.max(15_000, base + jitter);
  if (failures >= 2) {
    const mult = Math.min(2 ** (failures - 1), 16);
    ms = Math.min(BACKOFF_CAP_MS, ms * mult);
  }
  return ms;
}

function diagnoseUnhealthy(): { unhealthy: boolean; reason: string } | null {
  if (!state.running) return null;
  // 熔斷冷卻中：唔當「壞咗要狂修」，等冷卻完
  if (edgeBlockRemainingMs() > 0) return null;
  if (state.consecutiveFailures >= 3) {
    return {
      unhealthy: true,
      reason: `連續 ${state.consecutiveFailures} 次輪詢無有效門市數據`,
    };
  }
  const sched = resolveScheduleMode(state.anyInStock);
  const staleMs =
    sched.mode === "peak"
      ? 35 * 60_000
      : STALE_SUCCESS_MS;
  if (state.lastSuccessAt) {
    const age = Date.now() - Date.parse(state.lastSuccessAt);
    if (Number.isFinite(age) && age > staleMs) {
      return {
        unhealthy: true,
        reason: `超過 ${Math.round(age / 60_000)} 分鐘無成功更新（數據可能過期）`,
      };
    }
  } else if (state.lastAttemptAt) {
    const age = Date.now() - Date.parse(state.lastAttemptAt);
    if (Number.isFinite(age) && age > 3 * 60_000) {
      return {
        unhealthy: true,
        reason: "從未成功拉取庫存，且已嘗試超過 3 分鐘",
      };
    }
  }
  if (softLowRowStreak >= 3) {
    return {
      unhealthy: true,
      reason: `連續 ${softLowRowStreak} 次 rows 偏少（<${EXPECTED_ROWS_SOFT}），可能被擋或部分失敗`,
    };
  }
  return null;
}

async function maybeAutoHeal(reason: string): Promise<void> {
  if (!state.running) return;
  const now = Date.now();
  if (now - lastAutoHealAt < 45_000) return;
  lastAutoHealAt = now;

  const rem = edgeBlockRemainingMs();
  if (rem > 0) {
    rescheduleOverrideMs = rem + randomBetween(5_000, 20_000);
    await notifyEdgeCooldown(state.lastError || "541");
    return;
  }

  autoHealAttempts += 1;
  // 縮短 backoff，唔好困喺 15 分鐘（非 541 熔斷時）
  state.consecutiveFailures = Math.min(state.consecutiveFailures, 1);
  console.warn(`[promax-pickup] auto-heal #${autoHealAttempts}：${reason}`);

  if (autoHealAttempts <= MAX_AUTO_HEAL) {
    rescheduleOverrideMs = randomBetween(45_000, 75_000);
    void notifyPromaxHealthAlert({
      kind: "auto_heal",
      reason,
      lastError: state.lastError,
      lastSuccessAt: state.lastSuccessAt,
      consecutiveFailures: state.consecutiveFailures,
      autoHealAttempt: autoHealAttempts,
      pollMode: currentPollMode(),
    }).catch(() => {});
  } else {
    rescheduleOverrideMs = randomBetween(90_000, 150_000);
    void notifyPromaxHealthAlert({
      kind: "needs_fix",
      reason: `${reason}（自動修復 ${MAX_AUTO_HEAL} 次仍失敗）`,
      lastError: state.lastError,
      lastSuccessAt: state.lastSuccessAt,
      consecutiveFailures: state.consecutiveFailures,
      rowsInLastPoll: state.latest?.rows_in_last_poll,
      autoHealAttempt: autoHealAttempts,
      pollMode: currentPollMode(),
    }).catch(() => {});
  }
}

async function evaluateHealthAfterPoll(rows: number): Promise<void> {
  if (rows > 0 && rows < EXPECTED_ROWS_SOFT) softLowRowStreak += 1;
  else if (rows >= EXPECTED_ROWS_SOFT) softLowRowStreak = 0;
  else if (rows === 0) softLowRowStreak += 1;

  const diag = diagnoseUnhealthy();
  if (diag?.unhealthy) {
    wasUnhealthy = true;
    await maybeAutoHeal(diag.reason);
    return;
  }

  if (wasUnhealthy && rows > 0 && state.consecutiveFailures === 0) {
    wasUnhealthy = false;
    const healedAfter = autoHealAttempts;
    autoHealAttempts = 0;
    softLowRowStreak = 0;
    void notifyPromaxHealthAlert({
      kind: "recovered",
      reason:
        healedAfter > 0
          ? `自動修復後恢復正常（曾重試 ${healedAfter} 次）`
          : "監控已恢復正常",
      lastSuccessAt: state.lastSuccessAt,
      rowsInLastPoll: rows,
      pollMode: currentPollMode(),
    }).catch(() => {});
  }
}

function startHealthWatchdog(): void {
  if (healthWatchdog) return;
  healthWatchdog = setInterval(() => {
    if (!state.running) return;

    // 輪詢 timer 卡住：太久無 attempt → 強制重新排程
    if (state.lastAttemptAt) {
      const age = Date.now() - Date.parse(state.lastAttemptAt);
      const hungAfter = Math.max(
        (state.pollIntervalMs || 60_000) * 3,
        4 * 60_000
      );
      if (Number.isFinite(age) && age > hungAfter) {
        wasUnhealthy = true;
        void (async () => {
          await maybeAutoHeal(
            `輪詢似乎卡住（${Math.round(age / 60_000)} 分鐘無 attempt）— 重新排程`
          );
          await scheduleNext();
        })();
        return;
      }
    }

    const diag = diagnoseUnhealthy();
    if (diag?.unhealthy) {
      wasUnhealthy = true;
      void (async () => {
        await maybeAutoHeal(diag.reason);
        // 若未排程中，確保有下一次
        if (!state.timer) await scheduleNext();
      })();
    }
  }, WATCHDOG_MS);
  if (typeof healthWatchdog === "object" && "unref" in healthWatchdog) {
    healthWatchdog.unref();
  }
}

function stopHealthWatchdog(): void {
  if (healthWatchdog) {
    clearInterval(healthWatchdog);
    healthWatchdog = null;
  }
}

async function ensureRuntime(): Promise<void> {
  if (!existsSync(RUNTIME_DIR)) {
    await fs.mkdir(RUNTIME_DIR, { recursive: true });
  }
}

export async function loadSkuMap(filePath = SKU_MAP_PATH): Promise<
  { storage: string; color: string; sku: string }[]
> {
  const raw = await fs.readFile(filePath, "utf8");
  const map = JSON.parse(raw) as SkuMap;
  const out: { storage: string; color: string; sku: string }[] = [];
  for (const [storage, colors] of Object.entries(map)) {
    if (!colors || typeof colors !== "object") continue;
    for (const [color, sku] of Object.entries(colors)) {
      const part = String(sku || "").trim();
      if (!part) continue;
      out.push({ storage, color, sku: part });
    }
  }
  if (!out.length) {
    throw new Error(`sku_map 為空：${filePath}`);
  }
  return out;
}

function matchStore(
  appleStoreName: string
): (typeof HK_APPLE_STORES)[number] | null {
  const n = appleStoreName.trim().toLowerCase();
  for (const store of HK_APPLE_STORES) {
    for (const alias of store.aliases) {
      const a = alias.toLowerCase();
      if (n === a || n.includes(a) || a.includes(n)) return store;
    }
  }
  return null;
}

function browserHeaders(): Record<string, string> {
  return {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    Accept: "application/json, text/javascript, */*; q=0.01",
    "Accept-Language": "zh-HK,zh;q=0.9,en-US;q=0.8,en;q=0.7",
    Referer: PRODUCT_REFERER,
    "X-Requested-With": "Fetch",
    "Cache-Control": "no-cache",
  };
}

function parsePickupStores(
  data: Record<string, unknown>,
  sku: string
): {
  storeName: string;
  pickupDisplay: string;
  pickupQuote: string;
}[] {
  const body = (data.body || {}) as Record<string, unknown>;
  const content = (body.content || {}) as Record<string, unknown>;
  const pickupMessage = (content.pickupMessage ||
    body.pickupMessage ||
    {}) as Record<string, unknown>;
  const stores = (pickupMessage.stores ||
    body.stores ||
    []) as Record<string, unknown>[];

  const rows: {
    storeName: string;
    pickupDisplay: string;
    pickupQuote: string;
  }[] = [];

  for (const store of stores) {
    const storeName = String(store.storeName || "").trim();
    if (!storeName) continue;
    const parts = (store.partsAvailability || {}) as Record<
      string,
      Record<string, unknown>
    >;
    const part =
      parts[sku] ||
      parts[sku.toUpperCase()] ||
      Object.values(parts)[0] ||
      {};
    rows.push({
      storeName,
      pickupDisplay: String(part.pickupDisplay ?? "").trim() || "unknown",
      pickupQuote: String(part.pickupSearchQuote ?? "").trim(),
    });
  }
  return rows;
}

async function fetchPickupMessageStores(sku: string): Promise<
  {
    storeName: string;
    pickupDisplay: string;
    pickupQuote: string;
  }[]
> {
  const url = new URL(PICKUP_MESSAGE_URL);
  url.searchParams.set("pl", "true");
  url.searchParams.set("parts.0", sku);
  url.searchParams.set("location", PICKUP_LOCATION);

  const res = await monitorFetchGet(url.toString(), browserHeaders());

  if (res.status === 429 || res.status === 403 || res.status === 541) {
    const err = new Error(
      `HTTP ${res.status} from pickup-message` +
        (res.proxyUsed ? ` via ${res.proxyUsed}` : "")
    );
    (err as Error & { status: number }).status = res.status;
    throw err;
  }
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} from pickup-message`);
  }

  const data = (await res.json()) as Record<string, unknown>;
  return parsePickupStores(data, sku);
}

async function fetchFulfillmentMessagesStores(sku: string): Promise<
  {
    storeName: string;
    pickupDisplay: string;
    pickupQuote: string;
  }[]
> {
  const url = new URL(FULFILLMENT_URL);
  url.searchParams.set("pl", "true");
  url.searchParams.set("mts.0", "regular");
  url.searchParams.set("parts.0", sku);
  url.searchParams.set("location", PICKUP_LOCATION);

  const res = await monitorFetchGet(url.toString(), browserHeaders());

  if (res.status === 429 || res.status === 403 || res.status === 541) {
    const err = new Error(
      `HTTP ${res.status} from fulfillment-messages` +
        (res.proxyUsed ? ` via ${res.proxyUsed}` : "")
    );
    (err as Error & { status: number }).status = res.status;
    throw err;
  }
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} from fulfillment-messages`);
  }

  const data = (await res.json()) as Record<string, unknown>;
  return parsePickupStores(data, sku);
}

/**
 * 優先 retail/pickup-message；
 * 541/403/429 唔好打 fulfillment（只會加倍觸發封鎖）。
 * 其他錯誤／空 stores 先 fallback。
 */
export async function fetchFulfillmentStores(
  sku: string
): Promise<
  {
    storeName: string;
    pickupDisplay: string;
    pickupQuote: string;
  }[]
> {
  try {
    const rows = await fetchPickupMessageStores(sku);
    if (rows.length) return rows;
  } catch (err) {
    const status = (err as { status?: number }).status;
    console.warn(
      `[promax-pickup] pickup-message failed for ${sku}: ${
        err instanceof Error ? err.message : String(err)
      }` +
        (status === 429 || status === 403 || status === 541
          ? " — skip fulfillment fallback"
          : " — try fulfillment-messages")
    );
    if (status === 429 || status === 403 || status === 541) {
      throw err;
    }
  }
  return fetchFulfillmentMessagesStores(sku);
}

async function appendCollection(rows: PromaxStockRow[]): Promise<void> {
  if (!rows.length) return;
  await ensureRuntime();
  const chunk = rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
  await fs.appendFile(COLLECTION_PATH, chunk, "utf8");
  // trim if huge
  try {
    const raw = await fs.readFile(COLLECTION_PATH, "utf8");
    const lines = raw.split(/\r?\n/).filter(Boolean);
    if (lines.length > MAX_COLLECTION_LINES) {
      const keep = lines.slice(-Math.floor(MAX_COLLECTION_LINES * 0.8));
      await fs.writeFile(COLLECTION_PATH, keep.join("\n") + "\n", "utf8");
    }
  } catch {
    /* ignore trim errors */
  }
}

function isAvailableDisplay(display: string | null | undefined): boolean {
  return /^available$/i.test(String(display || "").trim());
}

function formatHkNow(d = new Date()): string {
  return new Intl.DateTimeFormat("zh-HK", {
    timeZone: "Asia/Hong_Kong",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(d);
}

async function appendRestockEvents(events: RestockHistoryEvent[]): Promise<void> {
  if (!events.length) return;
  await ensureRuntime();
  const chunk = events.map((e) => JSON.stringify(e)).join("\n") + "\n";
  await fs.appendFile(RESTOCK_HISTORY_FILE, chunk, "utf8");
  try {
    const raw = await fs.readFile(RESTOCK_HISTORY_FILE, "utf8");
    const lines = raw.split(/\r?\n/).filter((l) => l.trim());
    if (lines.length > RESTOCK_HISTORY_MAX) {
      await fs.writeFile(
        RESTOCK_HISTORY_FILE,
        `${lines.slice(-RESTOCK_HISTORY_MAX).join("\n")}\n`,
        "utf8"
      );
    }
  } catch {
    /* ignore */
  }
}

/** 比較上輪 → 有貨變化就寫 Live 補貨紀錄 */
function detectRestockEvents(
  matrix: MatrixEntry[],
  atIso: string
): RestockHistoryEvent[] {
  const events: RestockHistoryEvent[] = [];
  const atHk = formatHkNow(new Date(atIso));

  for (const entry of matrix) {
    const storeStocks = entry.stores.map((cell) => {
      const available = isAvailableDisplay(cell.pickup_display);
      const code = STORE_CODES[cell.store_id] || cell.store_id.toUpperCase();
      return {
        code,
        name: cell.store_name,
        qty: available ? 1 : 0,
        available,
        label: `${code} (${available ? "有" : "0"})`,
      };
    });

    const availableCount = storeStocks.filter((s) => s.available).length;
    let flippedToAvailable = false;
    let flippedToUnavailable = false;
    let anyKnown = false;

    for (const cell of entry.stores) {
      if (cell.pickup_display == null) continue;
      anyKnown = true;
      const key = `${entry.sku}|${cell.store_id}`;
      const now = isAvailableDisplay(cell.pickup_display);
      const prev = state.prevAvailable.get(key);
      if (prev === undefined) {
        // 首輪只建立基線，唔當補貨（避免重啟就狂推 Telegram）
        state.prevAvailable.set(key, now);
        continue;
      }
      if (!prev && now) flippedToAvailable = true;
      if (prev && !now) flippedToUnavailable = true;
      state.prevAvailable.set(key, now);
    }

    if (!anyKnown) continue;

    const sinceMs = state.availableSinceMs.get(entry.sku);
    if (availableCount > 0) {
      if (sinceMs == null) {
        state.availableSinceMs.set(entry.sku, Date.parse(atIso) || Date.now());
      }
    }

    const base = {
      at: atIso,
      atHk,
      name: `iPhone 18 Pro Max ${entry.storage} ${entry.color}`,
      model: "iPhone 18 Pro Max",
      color: entry.color,
      storage: entry.storage,
      buyQty: 1,
      storeStocks,
    };

    if (flippedToAvailable) {
      if (sinceMs == null && !state.availableSinceMs.has(entry.sku)) {
        state.availableSinceMs.set(entry.sku, Date.parse(atIso) || Date.now());
      }
      events.push({
        ...base,
        event: "restock",
        stockQty: availableCount,
        detail: storeStocks
          .filter((s) => s.available)
          .map((s) => s.label)
          .join(" · "),
        availableSince: new Date(
          state.availableSinceMs.get(entry.sku) || Date.now()
        ).toISOString(),
      });
      events.push({
        ...base,
        event: "store_stock",
        stockQty: availableCount,
        detail: storeStocks.map((s) => s.label).join(" · "),
      });
    } else if (flippedToUnavailable && availableCount === 0) {
      const started = state.availableSinceMs.get(entry.sku);
      const endMs = Date.parse(atIso) || Date.now();
      const inStockForMs =
        started != null && Number.isFinite(started)
          ? Math.max(0, endMs - started)
          : null;
      const inStockForLabel =
        inStockForMs != null ? formatDurationLabel(inStockForMs) : null;
      state.availableSinceMs.delete(entry.sku);
      events.push({
        ...base,
        event: "sold_out",
        stockQty: 0,
        detail: inStockForLabel
          ? `六間門市皆 unavailable · 在架約 ${inStockForLabel}`
          : "六間門市皆 unavailable",
        inStockForMs,
        inStockForLabel,
        availableSince: started != null ? new Date(started).toISOString() : null,
      });
    }
  }
  return events;
}

function emptyStoreCells(): StoreCell[] {
  return HK_APPLE_STORES.map((s) => ({
    store_id: s.id,
    store_name: s.name,
    pickup_display: null,
    pickup_quote: null,
    matched_store_name: null,
  }));
}

function buildStatus(partial: {
  matrix: MatrixEntry[];
  rowsInLastPoll: number;
}): PromaxPickupStatus {
  const storages = [...new Set(partial.matrix.map((m) => m.storage))];
  const colors = [...new Set(partial.matrix.map((m) => m.color))];
  const matrix_by: PromaxPickupStatus["matrix_by"] = {};
  for (const entry of partial.matrix) {
    matrix_by[entry.storage] ||= {};
    matrix_by[entry.storage]![entry.color] ||= {};
    for (const cell of entry.stores) {
      matrix_by[entry.storage]![entry.color]![cell.store_id] = cell;
    }
  }
  return {
    ok: true,
    product: "iPhone 18 Pro Max",
    storages,
    colors,
    stores: HK_APPLE_STORES.map((s) => ({ id: s.id, name: s.name })),
    matrix: partial.matrix,
    matrix_by,
    last_success_at: state.lastSuccessAt,
    last_attempt_at: state.lastAttemptAt,
    last_error: state.lastError,
    consecutive_failures: state.consecutiveFailures,
    next_poll_in_ms: state.nextPollInMs,
    poll_interval_ms: state.pollIntervalMs,
    poll_mode: currentPollMode(),
    schedule: resolveScheduleMode(state.anyInStock),
    running: state.running,
    rows_in_last_poll: partial.rowsInLastPoll,
    available_since: Object.fromEntries(
      [...state.availableSinceMs.entries()].map(([sku, ms]) => [
        sku,
        new Date(ms).toISOString(),
      ])
    ),
    prev_available: Object.fromEntries(state.prevAvailable.entries()),
  };
}

export async function runPromaxPickupPollOnce(): Promise<PromaxPickupStatus> {
  state.lastAttemptAt = new Date().toISOString();

  const coolRem = edgeBlockRemainingMs();
  if (coolRem > 0) {
    state.lastError = `edge_cooldown ${Math.ceil(coolRem / 1000)}s (Apple 541/403/429)`;
    rescheduleOverrideMs = coolRem + randomBetween(5_000, 20_000);
    console.warn(
      `[promax-pickup] skip poll — edge cooldown ${Math.ceil(coolRem / 1000)}s`
    );
    await notifyEdgeCooldown(state.lastError);
    const status = buildStatus({
      matrix: state.latest?.matrix || [],
      rowsInLastPoll: 0,
    });
    state.latest = status;
    return status;
  }

  const skus = await loadSkuMap();
  const matrix: MatrixEntry[] = [];
  const collectionRows: PromaxStockRow[] = [];
  const ts = state.lastAttemptAt;
  let blocked = 0;
  let abortEdge = false;

  for (const item of skus) {
    const entry: MatrixEntry = {
      sku: item.sku,
      color: item.color,
      storage: item.storage,
      stores: emptyStoreCells(),
    };
    if (abortEdge) {
      matrix.push(entry);
      continue;
    }
    try {
      const appleStores = await fetchFulfillmentStores(item.sku);
      for (const a of appleStores) {
        const matched = matchStore(a.storeName);
        if (!matched) continue;
        const cell = entry.stores.find((c) => c.store_id === matched.id);
        if (!cell) continue;
        cell.pickup_display = a.pickupDisplay;
        cell.pickup_quote = a.pickupQuote;
        cell.matched_store_name = a.storeName;
        collectionRows.push({
          timestamp: ts,
          sku: item.sku,
          color: item.color,
          storage: item.storage,
          store_name: matched.name,
          pickup_display: a.pickupDisplay,
          pickup_quote: a.pickupQuote,
        });
      }
      // SKU 之間間隔：hot 較短；idle 稍鬆
      const gap = state.anyInStock
        ? randomBetween(250, 550)
        : randomBetween(400, 800);
      await sleep(gap);
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status === 429 || status === 403 || status === 541) {
        blocked += 1;
        tripEdgeBlock(status, `${item.storage}/${item.color}`);
        abortEdge = true;
      }
      state.lastError = err instanceof Error ? err.message : String(err);
      console.warn(
        `[promax-pickup] ${item.storage}/${item.color} (${item.sku}) failed: ${state.lastError}` +
          (abortEdge ? " — abort remaining SKUs this poll" : "")
      );
    }
    matrix.push(entry);
  }

  const matchedCells = collectionRows.length;
  let newRestockEvents: RestockHistoryEvent[] = [];
  if (matchedCells > 0) {
    state.consecutiveFailures = 0;
    state.lastSuccessAt = ts;
    state.lastError = null;
    edgeBlockedUntil = 0;
    await appendCollection(collectionRows);
    newRestockEvents = detectRestockEvents(matrix, ts);
    await appendRestockEvents(newRestockEvents);
    for (const ev of newRestockEvents) {
      if (ev.event === "restock") noteRestockAt(ev.at);
    }
    state.anyInStock = matrix.some((entry) =>
      entry.stores.some((c) => isAvailableDisplay(c.pickup_display))
    );
  } else {
    state.consecutiveFailures += 1;
    if (blocked > 0) {
      state.lastError =
        state.lastError ||
        `blocked_or_empty (http 429/403/541 x${blocked})`;
      const rem = edgeBlockRemainingMs();
      if (rem > 0) {
        rescheduleOverrideMs = rem + randomBetween(5_000, 20_000);
        await notifyEdgeCooldown(state.lastError);
      }
    } else if (!state.lastError) {
      state.lastError = "no store rows matched in this poll";
    }
  }

  const status = buildStatus({
    matrix,
    rowsInLastPoll: matchedCells,
  });
  state.latest = status;
  await ensureRuntime();
  await fs.writeFile(LATEST_PATH, JSON.stringify(status, null, 2), "utf8");
  console.log(
    `[promax-pickup] poll done rows=${matchedCells} mode=${status.poll_mode}` +
      ` failures=${state.consecutiveFailures}` +
      (newRestockEvents.length ? ` restockEvents=${newRestockEvents.length}` : "") +
      (state.lastError ? ` err=${state.lastError}` : "")
  );
  await evaluateHealthAfterPoll(matchedCells);
  if (newRestockEvents.some((e) => e.event === "restock" || e.event === "sold_out")) {
    void notifyPromaxTelegram(newRestockEvents, {
      pollMode: status.poll_mode,
    }).catch((err) => {
      console.warn(
        `[promax-pickup] telegram notify failed：${err instanceof Error ? err.message : String(err)}`
      );
    });
  }
  // 模式切換／啟動 → Telegram 告知而家用緊邊個模式
  if (lastNotifiedPollMode == null) {
    lastNotifiedPollMode = status.poll_mode;
    void notifyPromaxModeChange({
      from: "啟動",
      to: status.poll_mode,
      reason: status.schedule?.reason,
      peakWindows: status.schedule?.peakWindows,
    }).catch(() => {});
    lastTelegramStatusAt = 0;
  } else if (lastNotifiedPollMode !== status.poll_mode) {
    void notifyPromaxModeChange({
      from: lastNotifiedPollMode,
      to: status.poll_mode,
      reason: status.schedule?.reason,
      peakWindows: status.schedule?.peakWindows,
    }).catch(() => {});
    lastNotifiedPollMode = status.poll_mode;
    lastTelegramStatusAt = 0;
  }
  // live status：有貨變化／模式切換即更新；否則最多每 5 分鐘一次
  const shouldUpsertStatus =
    newRestockEvents.some((e) => e.event === "restock" || e.event === "sold_out") ||
    !lastTelegramStatusAt ||
    Date.now() - lastTelegramStatusAt > 5 * 60_000;
  if (shouldUpsertStatus && (matchedCells > 0 || state.consecutiveFailures === 0)) {
    lastTelegramStatusAt = Date.now();
    void upsertPromaxTelegramStatus(status).catch(() => {});
  }
  try {
    await hooks.onPollComplete?.(status, newRestockEvents);
  } catch (err) {
    console.warn(
      `[promax-pickup] onPollComplete hook failed：${err instanceof Error ? err.message : String(err)}`
    );
  }
  return status;
}

async function loadLatestFromDisk(): Promise<void> {
  try {
    const raw = await fs.readFile(LATEST_PATH, "utf8");
    const parsed = JSON.parse(raw) as PromaxPickupStatus;
    state.latest = parsed;
    state.lastSuccessAt = parsed.last_success_at;
    state.lastAttemptAt = parsed.last_attempt_at;
    state.lastError = parsed.last_error;
    state.consecutiveFailures = Number(parsed.consecutive_failures) || 0;
    if (parsed.prev_available && typeof parsed.prev_available === "object") {
      state.prevAvailable = new Map(
        Object.entries(parsed.prev_available).map(([k, v]) => [k, Boolean(v)])
      );
    } else if (parsed.matrix?.length) {
      // 舊快照：用 matrix 重建基線，避免重啟當補貨
      for (const entry of parsed.matrix) {
        for (const cell of entry.stores || []) {
          if (cell.pickup_display == null) continue;
          state.prevAvailable.set(
            `${entry.sku}|${cell.store_id}`,
            isAvailableDisplay(cell.pickup_display)
          );
        }
      }
    }
    if (parsed.available_since && typeof parsed.available_since === "object") {
      state.availableSinceMs = new Map(
        Object.entries(parsed.available_since)
          .map(([sku, iso]) => [sku, Date.parse(String(iso))] as const)
          .filter(([, ms]) => Number.isFinite(ms))
      );
    }
    state.anyInStock =
      parsed.poll_mode === "hot" ||
      [...state.prevAvailable.values()].some(Boolean) ||
      (parsed.matrix || []).some((e) =>
        (e.stores || []).some((c) => isAvailableDisplay(c.pickup_display))
      );
    // 重啟時若上次係 541／封鎖，且成功數據已過期，先冷卻再打
    const lastOk = parsed.last_success_at
      ? Date.parse(parsed.last_success_at)
      : NaN;
    const okFresh =
      Number.isFinite(lastOk) && Date.now() - lastOk < 5 * 60_000;
    if (
      !okFresh &&
      /541|403|429|edge_cooldown|blocked/i.test(String(parsed.last_error || ""))
    ) {
      edgeBlockedUntil = Date.now() + EDGE_COOLDOWN_MS;
      console.warn(
        `[promax-pickup] restored edge cooldown ${Math.round(EDGE_COOLDOWN_MS / 60_000)}m from last_error`
      );
    } else if (okFresh) {
      console.log(
        "[promax-pickup] last_success fresh — skip restoring edge cooldown"
      );
    }
  } catch {
    /* first run */
  }
}

async function scheduleNext(): Promise<void> {
  if (!state.running) return;
  if (rescheduleOverrideMs != null) {
    state.pollIntervalMs = rescheduleOverrideMs;
    rescheduleOverrideMs = null;
  } else {
    state.pollIntervalMs = computeNextIntervalMs(state.consecutiveFailures);
  }
  state.nextPollInMs = state.pollIntervalMs;
  if (state.timer) clearTimeout(state.timer);
  state.timer = setTimeout(() => {
    void (async () => {
      try {
        await runPromaxPickupPollOnce();
      } catch (err) {
        state.consecutiveFailures += 1;
        state.lastError = err instanceof Error ? err.message : String(err);
        console.warn(`[promax-pickup] poll crash: ${state.lastError}`);
        await evaluateHealthAfterPoll(0);
      } finally {
        await scheduleNext();
      }
    })();
  }, state.pollIntervalMs);
  console.log(
    `[promax-pickup] next poll in ${Math.round(state.pollIntervalMs / 1000)}s` +
      ` mode=${currentPollMode()}` +
      (state.consecutiveFailures >= 2
        ? ` (backoff failures=${state.consecutiveFailures})`
        : "")
  );
}

/** 啟動背景輪詢（idempotent） */
export async function startPromaxPickupMonitor(opts?: {
  runImmediately?: boolean;
}): Promise<void> {
  if (state.running) return;
  state.running = true;
  await ensureRuntime();
  await loadLatestFromDisk();
  await reloadPromaxSchedule(true);
  startHealthWatchdog();
  const sched = resolveScheduleMode(state.anyInStock);
  console.log(
    `[promax-pickup] started｜sku_map=${SKU_MAP_PATH}｜stores=${HK_APPLE_STORES.length}` +
      `｜telegram=${hasTelegramCreds() ? "on" : "off"}` +
      `｜idle=${Math.round(IDLE_POLL_MIN_MS / 1000)}-${Math.round(IDLE_POLL_MAX_MS / 1000)}s` +
      `｜hot=${Math.round(HOT_POLL_MIN_MS / 1000)}-${Math.round(HOT_POLL_MAX_MS / 1000)}s` +
      `｜health-watch=on` +
      `｜monitor-proxy=${getMonitorProxyStatus().mode}` +
      `｜schedule=${sched.mode}` +
      `｜peaks=${sched.peakWindows.join(",") || "—"}`
  );
  if (opts?.runImmediately !== false) {
    try {
      await runPromaxPickupPollOnce();
    } catch (err) {
      state.consecutiveFailures += 1;
      state.lastError = err instanceof Error ? err.message : String(err);
      console.warn(`[promax-pickup] initial poll failed: ${state.lastError}`);
    }
  }
  await scheduleNext();
}

export function stopPromaxPickupMonitor(): void {
  state.running = false;
  stopHealthWatchdog();
  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = null;
  }
  state.nextPollInMs = null;
  console.log("[promax-pickup] stopped");
}

/** 清 541 熔斷（例如換咗監控 proxy） */
export function clearPromaxEdgeCooldown(): void {
  edgeBlockedUntil = 0;
  softLowRowStreak = 0;
  autoHealAttempts = 0;
  wasUnhealthy = false;
  console.log("[promax-pickup] edge cooldown cleared");
}

/** API：最新 status matrix（含 last_success_at） */
export function getPromaxPickupStatus(): PromaxPickupStatus {
  if (state.latest) {
    return {
      ...state.latest,
      last_success_at: state.lastSuccessAt,
      last_attempt_at: state.lastAttemptAt,
      last_error: state.lastError,
      consecutive_failures: state.consecutiveFailures,
      next_poll_in_ms: state.nextPollInMs,
      poll_interval_ms: state.pollIntervalMs,
      poll_mode: currentPollMode(),
      running: state.running,
    };
  }
  return buildStatus({ matrix: [], rowsInLastPoll: 0 });
}

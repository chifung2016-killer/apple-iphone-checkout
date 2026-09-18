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
  notifyPromaxTelegram,
  upsertPromaxTelegramStatus,
} from "./promax-telegram.js";

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
  running: boolean;
  rows_in_last_poll: number;
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

const BASE_POLL_MIN_MS = 90_000;
const BASE_POLL_MAX_MS = 120_000;
const JITTER_MS = 20_000;
const BACKOFF_CAP_MS = 15 * 60_000;
const MAX_COLLECTION_LINES = 50_000;

const state: MonitorState = {
  running: false,
  timer: null,
  consecutiveFailures: 0,
  pollIntervalMs: 105_000,
  nextPollInMs: null,
  lastSuccessAt: null,
  lastAttemptAt: null,
  lastError: null,
  latest: null,
  prevAvailable: new Map(),
};

/** Telegram live status 上次推送時間（節流） */
let lastTelegramStatusAt = 0;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function randomBetween(min: number, max: number): number {
  return Math.floor(min + Math.random() * (max - min + 1));
}

/** 90–120s base + ±20s jitter；失敗時 exponential backoff */
function computeNextIntervalMs(failures: number): number {
  const base = randomBetween(BASE_POLL_MIN_MS, BASE_POLL_MAX_MS);
  const jitter = randomBetween(-JITTER_MS, JITTER_MS);
  let ms = Math.max(30_000, base + jitter);
  if (failures >= 2) {
    const mult = Math.min(2 ** (failures - 1), 16);
    ms = Math.min(BACKOFF_CAP_MS, ms * mult);
  }
  return ms;
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

  const res = await fetch(url.toString(), {
    method: "GET",
    headers: browserHeaders(),
    redirect: "follow",
  });

  if (res.status === 429 || res.status === 403 || res.status === 541) {
    const err = new Error(`HTTP ${res.status} from pickup-message`);
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

  const res = await fetch(url.toString(), {
    method: "GET",
    headers: browserHeaders(),
    redirect: "follow",
  });

  if (res.status === 429 || res.status === 403 || res.status === 541) {
    const err = new Error(`HTTP ${res.status} from fulfillment-messages`);
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
 * 優先 retail/pickup-message（本機可通）；
 * fulfillment-messages 常被 541，只作 fallback。
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
    console.warn(
      `[promax-pickup] pickup-message failed for ${sku}: ${
        err instanceof Error ? err.message : String(err)
      } — try fulfillment-messages`
    );
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
      events.push({
        ...base,
        event: "restock",
        stockQty: availableCount,
        detail: storeStocks
          .filter((s) => s.available)
          .map((s) => s.label)
          .join(" · "),
      });
      events.push({
        ...base,
        event: "store_stock",
        stockQty: availableCount,
        detail: storeStocks.map((s) => s.label).join(" · "),
      });
    } else if (flippedToUnavailable && availableCount === 0) {
      events.push({
        ...base,
        event: "sold_out",
        stockQty: 0,
        detail: "六間門市皆 unavailable",
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
    running: state.running,
    rows_in_last_poll: partial.rowsInLastPoll,
  };
}

export async function runPromaxPickupPollOnce(): Promise<PromaxPickupStatus> {
  state.lastAttemptAt = new Date().toISOString();
  const skus = await loadSkuMap();
  const matrix: MatrixEntry[] = [];
  const collectionRows: PromaxStockRow[] = [];
  const ts = state.lastAttemptAt;
  let blocked = 0;

  for (const item of skus) {
    const entry: MatrixEntry = {
      sku: item.sku,
      color: item.color,
      storage: item.storage,
      stores: emptyStoreCells(),
    };
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
      // small spacing between SKUs
      await sleep(randomBetween(400, 900));
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status === 429 || status === 403 || status === 541) blocked += 1;
      state.lastError = err instanceof Error ? err.message : String(err);
      console.warn(
        `[promax-pickup] ${item.storage}/${item.color} (${item.sku}) failed: ${state.lastError}`
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
    await appendCollection(collectionRows);
    newRestockEvents = detectRestockEvents(matrix, ts);
    await appendRestockEvents(newRestockEvents);
  } else {
    state.consecutiveFailures += 1;
    if (blocked > 0 && !state.lastError) {
      state.lastError = `blocked_or_empty (http 429/403/541 x${blocked})`;
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
    `[promax-pickup] poll done rows=${matchedCells} failures=${state.consecutiveFailures}` +
      (newRestockEvents.length ? ` restockEvents=${newRestockEvents.length}` : "") +
      (state.lastError ? ` err=${state.lastError}` : "")
  );
  if (newRestockEvents.some((e) => e.event === "restock" || e.event === "sold_out")) {
    void notifyPromaxTelegram(newRestockEvents).catch((err) => {
      console.warn(
        `[promax-pickup] telegram notify failed：${err instanceof Error ? err.message : String(err)}`
      );
    });
  }
  // live status：有貨變化即更新；否則最多每 5 分鐘一次
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
  } catch {
    /* first run */
  }
}

async function scheduleNext(): Promise<void> {
  if (!state.running) return;
  state.pollIntervalMs = computeNextIntervalMs(state.consecutiveFailures);
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
      } finally {
        await scheduleNext();
      }
    })();
  }, state.pollIntervalMs);
  console.log(
    `[promax-pickup] next poll in ${Math.round(state.pollIntervalMs / 1000)}s` +
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
  console.log(
    `[promax-pickup] started｜sku_map=${SKU_MAP_PATH}｜stores=${HK_APPLE_STORES.length}` +
      `｜telegram=${hasTelegramCreds() ? "on" : "off"}`
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
  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = null;
  }
  state.nextPollInMs = null;
  console.log("[promax-pickup] stopped");
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
      running: state.running,
    };
  }
  return buildStatus({ matrix: [], rowsInLastPoll: 0 });
}

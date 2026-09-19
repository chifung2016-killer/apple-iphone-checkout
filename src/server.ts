import "dotenv/config";
/**
 * Apple checkout control dashboard (multi-browser).
 * Run: npm run dashboard  →  http://127.0.0.1:8787
 */
import http from "node:http";
import fs from "node:fs/promises";
import { createReadStream, existsSync, watch as fsWatch, openSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcess } from "node:child_process";
import { exportOrdersToGoogleSheet } from "./export-google-sheet.js";
import {
  getLiveCardLimits,
  lookupCardMeta,
  peekCardLimitInfo,
  resolveOrderAmountSpent,
  seedCardLimitsIfNeeded,
  cardDigits,
} from "./credit-card-pool.js";
import {
  fulfillmentLabelFromPreference,
  resolveDeliveryMethodLabel,
} from "./fulfillment-label.js";
import {
  clearPromaxEdgeCooldown,
  getPromaxPickupStatus,
  getMonitorProxyPoolText,
  getMonitorProxyStatus,
  runPromaxPickupPollOnce,
  setMonitorProxyPool,
  setPromaxPickupHooks,
  startPromaxPickupMonitor,
  stopPromaxPickupMonitor,
} from "./promax-pickup-monitor.js";
import {
  decryptFromBlob,
  decryptFromFile,
  encryptToBlob,
  encryptToFile,
  loadGmailCopyPassword,
  loadShippingAddress,
  maskEmail,
  redactSecrets,
  rotateKey,
  secureWipeFile,
  type ShippingAddress,
} from "./add-order-secrets.js";
import {
  claimCheckoutCard,
  finalizeCheckoutCard,
  findVaultCardByNumber,
  loadCardVault,
  loadCardVaultState,
  maskedRows,
  removeCardsByIds,
  summarizeVault,
  upsertCardsFromText,
} from "./checkout-card-vault.js";
import {
  appendDayLog,
  dayLogsAbsoluteDir,
  dayLogsRelativeDir,
  ensureDayLogDir,
  hkDayStamp,
  hkTimeStamp,
} from "./runtime-day-log.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC = path.join(ROOT, "dashboard");
const RUNTIME_DIR = path.join(ROOT, "runtime");
const RUNTIME_CONFIG = path.join(ROOT, "runtime-config.json");
const ORDERS_FILE = path.join(ROOT, "order-summary.json");
const CONTINUE_ALL_FLAG = path.join(ROOT, "dashboard-continue.flag");
const PROXY_BLACKLIST_FILE = path.join(RUNTIME_DIR, "proxy-blacklist.json");
/** 每個 Proxy / IP 最多同時／累計分配畀幾多個 browser */
const PROXY_BROWSERS_PER_IP = 3;
const RESTOCK_HISTORY_FILE = path.join(RUNTIME_DIR, "restock-history.jsonl");

function pidAlive(pid: number | null | undefined): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** 唔關窗；寫 hide flag + status，等 worker 自己 minimize */
async function keepBrowserHiddenAfterScriptUpdate(
  id: string,
  st: Record<string, unknown>
): Promise<void> {
  const nid = normalizeBrowserId(id);
  await fs
    .writeFile(
      path.join(RUNTIME_DIR, `hide-${nid}.flag`),
      new Date().toISOString(),
      "utf8"
    )
    .catch(() => {});
  await fs.unlink(path.join(RUNTIME_DIR, `show-${nid}.flag`)).catch(() => {});
  const stPath = path.join(RUNTIME_DIR, `status-${nid}.json`);
  try {
    const next = {
      ...st,
      windowHidden: true,
      windowState: "minimized",
      keepOpen: false,
      message:
        String(st.message || "").trim() ||
        "script/server updated — browser kept open & hidden",
      updatedAt: new Date().toISOString(),
    };
    await fs.writeFile(stPath, JSON.stringify(next, null, 2), "utf8");
  } catch {
    /* ignore */
  }
}

/** server／tsx watch 重啟後：還原仲開住嘅 checkout browser（唔殺、保持 Hide） */
async function recoverCheckoutSessionsFromDisk(): Promise<void> {
  await ensureRuntimeDir();
  for (const id of await listPersistedSessionIds()) {
    if (await isDismissedBrowser(id) && !(await isPaidBrowserSession(id))) {
      continue;
    }
    const st = await readSessionStatus(id);
    if (!st) continue;
    const phase = String(st.phase || "");
    if (/^closed$/i.test(phase)) continue;

    const pidRaw = st.pid;
    const pid =
      typeof pidRaw === "number"
        ? pidRaw
        : Number(pidRaw) > 0
          ? Number(pidRaw)
          : null;
    const alive = pidAlive(pid);

    const cfgPath = path.join(RUNTIME_DIR, `config-${id}.json`);
    const cfg =
      ((await readJson(cfgPath)) as Record<string, unknown> | null) || {
        ...lastFormConfig,
      };

    const existing = sessions.get(id);
    const wasMissing = !existing;
    if (existing) {
      if (alive) {
        existing.running = true;
        existing.pid = pid;
        existing.exitCode = null;
        if (!existing.child) existing.child = null;
      } else if (existing.running && existing.pid && !pidAlive(existing.pid)) {
        existing.running = false;
        existing.pid = null;
        existing.child = null;
      }
    } else if (
      alive ||
      /waiting_for_payment|steps_complete|manual_control|fulfillment|checkout|starting|adding|guest|contact|stop_requested|page_error|recover/i.test(
        phase
      ) ||
      (await isPaidBrowserSession(id))
    ) {
      sessions.set(id, {
        id,
        index: browserIndexFromId(id),
        pid: alive ? pid : null,
        running: alive,
        exitCode: alive ? null : 0,
        startedAt: String(st.updatedAt || new Date().toISOString()),
        config: cfg,
        logs: [
          alive
            ? `[dashboard] recovered ${id} after script/server update · still running pid=${pid} · kept hidden`
            : `[dashboard] recovered ${id} card · ${phase || "idle"}`,
        ],
        child: null,
      });
    }

    // script／server 更新後第一次認回：保持 Hide，並繼續跟 log／pid（Open browser 仍然可用）
    if (alive && wasMissing) {
      await keepBrowserHiddenAfterScriptUpdate(id, st).catch(() => {});
      const s = sessions.get(id);
      if (s) {
        attachSessionLogTail(s, sessionLogPath(id));
        attachSessionLogTail(s, `${sessionLogPath(id)}.err`);
        watchSessionPid(s);
      }
    }
  }
}

async function writeSessionLaunchRecord(
  sessionId: string,
  config: Record<string, unknown>
): Promise<void> {
  try {
    const day = hkDayStamp();
    const dir = await ensureDayLogDir(day);
    const safe = { ...config };
    await fs.writeFile(
      path.join(dir, `checkout-${sessionId}-config.json`),
      JSON.stringify(
        {
          savedAt: new Date().toISOString(),
          savedAtHk: `${day} ${hkTimeStamp()}`,
          sessionId,
          config: safe,
        },
        null,
        2
      ),
      "utf8"
    );
    await appendDayLog({
      channel: "checkout",
      sessionId,
      line: `[dashboard] launch config saved｜proxy=${String(config.proxy || "本機 IP")}｜model=${String(config.model || "")} ${String(config.color || "")} ${String(config.storage || "")} ×${String(config.quantity || "")}｜${String(config.fulfillmentPreference || "")}${config.holdAtPickupStoresForStock ? "｜hold@stock" : ""}`,
      meta: {
        kind: "launch",
        proxy: config.proxy || "",
        model: config.model,
        color: config.color,
        storage: config.storage,
        quantity: config.quantity,
        fulfillmentPreference: config.fulfillmentPreference,
        holdAtPickupStoresForStock: Boolean(config.holdAtPickupStoresForStock),
      },
    });
  } catch {
    /* ignore */
  }
}
const GMAIL_ACCOUNTS_ENC = path.join(RUNTIME_DIR, "gmail-accounts.enc");
const GMAIL_ACCOUNTS_LEGACY = path.join(RUNTIME_DIR, "gmail-accounts-saved.txt");
const ADD_ORDER_KEY = path.join(RUNTIME_DIR, ".add-order-key");
const SHIPPING_ENC = path.join(RUNTIME_DIR, "shipping-address.enc");
const GMAIL_COPY_PASSWORD_ENC = path.join(RUNTIME_DIR, "gmail-copy-password.enc");
/** 只用作首次 seed 寫入加密檔；之後只由密文檔讀 */
const GMAIL_COPY_PASSWORD_BOOTSTRAP = "yY6594083";
const CHECKOUT_CARDS_ENC = path.join(RUNTIME_DIR, "checkout-cards.enc");
const CHECKOUT_CARDS_STATE = path.join(RUNTIME_DIR, "checkout-cards-state.json");
const ADD_ORDER_JOB_ENC = path.join(RUNTIME_DIR, "add-order-job.enc");
const ADD_ORDER_JOB_LEGACY = path.join(RUNTIME_DIR, "add-order-apple-ac.json");
const ADD_ORDER_STOP_FLAG = path.join(RUNTIME_DIR, "add-order-stop.flag");
const PORT = Number(process.env.DASHBOARD_PORT || 8787);
/** 每次 server 啟動／tsx watch 重載都會變 → 瀏覽器自動 refresh */
const DASHBOARD_BUILD_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

function assignedCardPath(sessionId: string): string {
  return path.join(RUNTIME_DIR, `assigned-card-${sessionId}.enc`);
}

/** Credit cards 池：卡號 digits → limit（畀 Live card limits 即時計剩餘） */
async function loadVaultLimitsMap(): Promise<Record<string, number>> {
  const cards = await loadCardVault(CHECKOUT_CARDS_ENC, ADD_ORDER_KEY).catch(() => []);
  const out: Record<string, number> = {};
  for (const c of cards) {
    if (c.limit == null || !Number.isFinite(c.limit)) continue;
    const d = cardDigits(c.number);
    if (!d) continue;
    out[d] = c.limit;
    if (d.length >= 4) out[d.slice(-4)] = c.limit;
  }
  return out;
}

async function vaultLimitOverrideForCard(
  cardNumber: string | null | undefined
): Promise<{ originalLimit?: number | null; company?: string; type?: string } | undefined> {
  const vault = await findVaultCardByNumber(
    CHECKOUT_CARDS_ENC,
    ADD_ORDER_KEY,
    cardNumber
  ).catch(() => null);
  if (!vault || vault.limit == null) {
    const map = await loadVaultLimitsMap();
    const d = cardDigits(cardNumber);
    const lim = d ? map[d] ?? map[d.slice(-4)] : undefined;
    if (lim == null) return undefined;
    return { originalLimit: lim };
  }
  return { originalLimit: vault.limit };
}

function usesCreditCardAutofill(fulfillmentPreference: unknown): boolean {
  const p = String(fulfillmentPreference || "");
  if (!p) return false;
  if (/apple_pay|applepay/i.test(p)) return false;
  // pickup / delivery 訪客信用卡模式
  return p === "pickup" || p === "delivery" || p === "auto";
}

type BrowserSession = {
  id: string;
  index: number;
  pid: number | null;
  running: boolean;
  exitCode: number | null;
  startedAt: string;
  config: Record<string, unknown>;
  logs: string[];
  child: ChildProcess | null;
};

let nextIndex = 0;
const sessions = new Map<string, BrowserSession>();
const sseClients = new Set<http.ServerResponse>();
let lastFormConfig: Record<string, unknown> = defaultConfig();

type AddOrderTask = {
  id: string;
  emailMasked: string;
  orderNumber: string;
  index: number;
  pid: number | null;
  running: boolean;
  startedAt: string;
  logs: string[];
  child: ChildProcess | null;
  exitCode: number | null;
};

const addOrderTasks = new Map<string, AddOrderTask>();
let addOrderNextIndex = 1;

async function readAddOrderStatus(id: string): Promise<Record<string, unknown> | null> {
  try {
    let raw = await fs.readFile(path.join(RUNTIME_DIR, `status-${id}.json`), "utf8");
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** 判斷 status 係咪 Finished（唔應被 Clear all 清走） */
function isAddOrderFinishedPhase(phase: unknown): boolean {
  return /^(finished|steps_complete|shipping_saved)$/i.test(String(phase || ""));
}

function finishedArchivePath(id: string): string {
  return path.join(RUNTIME_DIR, "finished-archive", `${id}.json`);
}

/** 寫入永久 Finished 存檔（Clear all 唔會刪）；送貨只存密文 */
async function archiveFinishedAddOrderTask(
  id: string,
  st: Record<string, unknown>
): Promise<void> {
  const nid = String(id || "").trim();
  if (!nid) return;
  await fs.mkdir(path.join(RUNTIME_DIR, "finished-archive"), { recursive: true }).catch(() => {});
  const safe = { ...st };
  // 唔 archive 明文 shipping
  if (safe.shipping && !safe.shippingEnc) {
    try {
      const blob = await encryptToBlob(ADD_ORDER_KEY, JSON.stringify(safe.shipping));
      safe.shippingEnc = blob;
    } catch {
      /* ignore */
    }
  }
  delete safe.shipping;
  const payload = {
    ...safe,
    phase: "finished",
    id: nid,
    type: "add_order",
    archivedAt: new Date().toISOString(),
  };
  await fs.writeFile(finishedArchivePath(nid), JSON.stringify(payload, null, 2), "utf8");
}

async function resolveShippingForStatus(
  st: Record<string, unknown> | null
): Promise<ShippingAddress | null> {
  if (!st) return null;
  const enc = String(st.shippingEnc || "").trim();
  if (enc) {
    try {
      const plain = await decryptFromBlob(ADD_ORDER_KEY, enc);
      const parsed = JSON.parse(plain) as ShippingAddress;
      if (parsed?.firstName && parsed?.areaStreet) return parsed;
    } catch {
      /* fall through */
    }
  }
  // 舊明文 → 即刻加密遷移
  const legacy = st.shipping as Partial<ShippingAddress> | undefined;
  if (legacy?.firstName && legacy?.lastName && legacy?.areaStreet && legacy?.building) {
    const shipping: ShippingAddress = {
      firstName: String(legacy.firstName),
      lastName: String(legacy.lastName),
      areaStreet: String(legacy.areaStreet),
      building: String(legacy.building),
    };
    return shipping;
  }
  try {
    return await loadShippingAddress(SHIPPING_ENC, ADD_ORDER_KEY);
  } catch {
    return null;
  }
}

async function scrubPlaintextShippingFromStatusFiles(): Promise<void> {
  let files: string[] = [];
  try {
    files = (await fs.readdir(RUNTIME_DIR)).filter((f) => /^status-ao\d+\.json$/i.test(f));
  } catch {
    return;
  }
  for (const file of files) {
    const id = /^status-(ao\d+)\.json$/i.exec(file)?.[1];
    if (!id) continue;
    const st = await readAddOrderStatus(id);
    if (!st?.shipping) continue;
    try {
      const shipping = st.shipping;
      const blob = await encryptToBlob(ADD_ORDER_KEY, JSON.stringify(shipping));
      const next: Record<string, unknown> = { ...st, shippingEnc: blob, shippingMasked: true };
      delete next.shipping;
      await fs.writeFile(
        path.join(RUNTIME_DIR, file),
        JSON.stringify(next, null, 2),
        "utf8"
      );
      if (isAddOrderFinishedPhase(st.phase)) {
        await archiveFinishedAddOrderTask(id, next);
      }
    } catch {
      /* ignore */
    }
  }
}

/** 誤被 Clear／Close 標成 closed 但已到 order/detail → 還原 Finished */
async function recoverMistakenlyClosedFinished(): Promise<void> {
  await ensureRuntimeDir();
  let files: string[] = [];
  try {
    files = (await fs.readdir(RUNTIME_DIR)).filter((f) => /^status-ao\d+\.json$/i.test(f));
  } catch {
    return;
  }
  for (const file of files) {
    const m = /^status-(ao\d+)\.json$/i.exec(file);
    if (!m) continue;
    const id = m[1]!;
    const st = await readAddOrderStatus(id);
    if (!st) continue;
    const phase = String(st.phase || "");
    if (!/^closed$/i.test(phase)) continue;
    const url = String(st.url || "");
    const looksFinished =
      /\/shop\/order\/detail\//i.test(url) ||
      /Finished|送貨已儲存|steps_complete|shipping_saved/i.test(String(st.message || ""));
    if (!looksFinished) continue;
    const restored = {
      ...st,
      phase: "finished",
      message:
        String(st.orderNumber || "").trim()
          ? `Finished · ${String(st.orderNumber).trim()} · 送貨已儲存`
          : "Finished",
      windowHidden: true,
      keepOpen: false,
      updatedAt: new Date().toISOString(),
    };
    await fs.writeFile(
      path.join(RUNTIME_DIR, `status-${id}.json`),
      JSON.stringify(restored, null, 2),
      "utf8"
    );
    await archiveFinishedAddOrderTask(id, restored);
  }

  // 由 finished-archive 補返 status（若 status 已冇／仍係 closed）
  let archives: string[] = [];
  try {
    archives = (await fs.readdir(path.join(RUNTIME_DIR, "finished-archive"))).filter((f) =>
      /^ao\d+\.json$/i.test(f)
    );
  } catch {
    archives = [];
  }
  for (const file of archives) {
    const id = file.replace(/\.json$/i, "");
    const stPath = path.join(RUNTIME_DIR, `status-${id}.json`);
    let cur = await readAddOrderStatus(id);
    if (cur && isAddOrderFinishedPhase(cur.phase)) continue;
    if (cur && !/^closed$/i.test(String(cur.phase || "")) && cur.phase) continue;
    try {
      let raw = await fs.readFile(path.join(RUNTIME_DIR, "finished-archive", file), "utf8");
      if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
      const arch = JSON.parse(raw) as Record<string, unknown>;
      const restored = {
        ...arch,
        phase: "finished",
        id,
        type: "add_order",
        updatedAt: new Date().toISOString(),
      };
      await fs.writeFile(stPath, JSON.stringify(restored, null, 2), "utf8");
    } catch {
      /* ignore */
    }
  }
}

/** server／tsx watch 重啟後由 status-ao*.json 還原 Tasks（含 Finished） */
async function recoverAddOrderTasksFromDisk(): Promise<void> {
  await recoverMistakenlyClosedFinished();
  await ensureRuntimeDir();
  let files: string[] = [];
  try {
    files = (await fs.readdir(RUNTIME_DIR)).filter((f) => /^status-ao\d+\.json$/i.test(f));
  } catch {
    return;
  }
  let maxIdx = addOrderNextIndex - 1;
  for (const file of files) {
    const m = /^status-(ao\d+)\.json$/i.exec(file);
    if (!m) continue;
    const id = m[1]!;
    const num = Number(/^ao(\d+)$/i.exec(id)?.[1] || 0);
    if (num > maxIdx) maxIdx = num;
    if (addOrderTasks.has(id)) continue;
    const st = await readAddOrderStatus(id);
    if (!st) continue;
    const phase = String(st.phase || "");
    if (/^closed$/i.test(phase)) continue;
    // 仲有 pid 且 process 存活 → running
    const pid = typeof st.pid === "number" ? st.pid : null;
    let running = false;
    if (pid && pid > 0) {
      try {
        process.kill(pid, 0);
        running = true;
      } catch {
        running = false;
      }
    }
    addOrderTasks.set(id, {
      id,
      emailMasked: String(st.emailMasked || "—"),
      orderNumber: String(st.orderNumber || ""),
      index: Math.max(0, num - 1),
      pid: running ? pid : null,
      running,
      startedAt: String(st.updatedAt || new Date().toISOString()),
      logs: [`[dashboard] recovered ${id} · ${phase || "idle"}`],
      child: null,
      exitCode: running ? null : 0,
    });
  }
  addOrderNextIndex = Math.max(addOrderNextIndex, maxIdx + 1);
}

async function snapshotAddOrderTasks() {
  await recoverAddOrderTasksFromDisk();
  await scrubPlaintextShippingFromStatusFiles().catch(() => {});
  const tasks = [];
  for (const t of addOrderTasks.values()) {
    const st = await readAddOrderStatus(t.id);
    const phase = String(st?.phase || (t.running ? "running" : "idle"));
    if (/^closed$/i.test(phase) && !t.running) {
      addOrderTasks.delete(t.id);
      continue;
    }
    if (t.running && t.pid) {
      try {
        process.kill(t.pid, 0);
      } catch {
        t.running = false;
        t.pid = null;
        t.child = null;
      }
    }
    if (isAddOrderFinishedPhase(phase) && st) {
      await archiveFinishedAddOrderTask(t.id, st).catch(() => {});
    }
    // Finished：本機 dashboard 解密顯示；磁碟只留 shippingEnc
    let shipping: ShippingAddress | null = null;
    if (isAddOrderFinishedPhase(phase)) {
      shipping = await resolveShippingForStatus(st);
    }
    tasks.push({
      id: t.id,
      emailMasked: t.emailMasked || st?.emailMasked || "—",
      email: String(st?.email || "").trim() || "",
      orderNumber: t.orderNumber || st?.orderNumber || "",
      running: t.running,
      pid: t.pid,
      startedAt: t.startedAt,
      exitCode: t.exitCode,
      phase,
      message: st?.message || "",
      url: st?.url || "",
      windowHidden: st?.windowHidden !== false,
      keepOpen: st?.keepOpen === true,
      shipping,
      logs: t.logs.slice(-80).map(redactSecrets),
    });
  }
  return tasks;
}

function stopAddOrderAutomation(id: string) {
  const nid = String(id || "").trim();
  void fs.writeFile(
    path.join(RUNTIME_DIR, `release-${nid}.flag`),
    `takeover\n${new Date().toISOString()}`,
    "utf8"
  );
}

function killAddOrderTask(id: string) {
  const t = addOrderTasks.get(id);
  void fs.writeFile(
    path.join(RUNTIME_DIR, `close-${id}.flag`),
    new Date().toISOString(),
    "utf8"
  );
  if (t?.child) killProc(t.child);
}

function defaultConfig() {
  return {
    buyUrl:
      "https://www.apple.com/hk-zh/shop/buy-iphone/iphone-18-pro/6.9-%E5%90%8B%E9%A1%AF%E7%A4%BA%E5%99%A8-256gb-%E5%B8%83%E6%A0%B9%E5%9C%B0%E7%B4%85%E8%89%B2",
    model: "iPhone 18 Pro Max",
    color: "布根地紅色",
    storage: "256GB",
    pickupSearch: "中環",
    saleStartIso: "2026-09-12T20:00:00+08:00",
    productPollIntervalMs: 5000,
    skipTradeIn: true,
    addAppleCare: false,
    cardCompany: "",
    cardLimit: "",
    proxy: "",
  };
}

function broadcast(payload: unknown) {
  const data = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of sseClients) res.write(data);
}

/** 改 dashboard 靜態檔／add-order worker 即推 reload；tsx watch 重啟 server 則靠 buildId */
function startLiveReloadWatcher() {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const fire = (reason: string) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      console.log(`[live-reload] ${reason}`);
      broadcast({
        type: "reload",
        buildId: DASHBOARD_BUILD_ID,
        reason,
        at: new Date().toISOString(),
      });
    }, 200);
  };
  try {
    fsWatch(PUBLIC, { recursive: true }, (_event, filename) => {
      const name = String(filename || "");
      if (!name) return;
      if (/\.(html|css|js|svg|png|ico|map)$/i.test(name)) {
        fire(`dashboard/${name.replace(/\\/g, "/")}`);
      }
    });
    console.log(`[live-reload] watching ${PUBLIC}`);
  } catch (err) {
    console.warn(
      `[live-reload] watch failed：${err instanceof Error ? err.message : String(err)}`
    );
  }
  // add-order worker／server 改動：推 reload，頁面即時更新
  const srcDir = path.join(ROOT, "src");
  try {
    fsWatch(srcDir, { recursive: false }, (_event, filename) => {
      const name = String(filename || "").replace(/\\/g, "/");
      if (!name) return;
      if (
        /^(add-order-to-apple-ac|add-order-secrets|server)\.ts$/i.test(name) ||
        name.endsWith("/add-order-to-apple-ac.ts")
      ) {
        fire(`src/${name}`);
      }
    });
    console.log(`[live-reload] watching ${srcDir} (add-order + server)`);
  } catch (err) {
    console.warn(
      `[live-reload] src watch failed：${err instanceof Error ? err.message : String(err)}`
    );
  }
}

let addOrderBroadcastTimer: ReturnType<typeof setTimeout> | null = null;
async function broadcastAddOrderStatus(): Promise<void> {
  if (addOrderBroadcastTimer) clearTimeout(addOrderBroadcastTimer);
  addOrderBroadcastTimer = setTimeout(async () => {
    try {
      const tasks = await snapshotAddOrderTasks();
      const anyRunning = tasks.some((t) => t.running);
      const allLogs = [...addOrderTasks.values()].flatMap((t) =>
        t.logs.slice(-40).map((line) => redactSecrets(line))
      );
      broadcast({
        type: "add_order_status",
        buildId: DASHBOARD_BUILD_ID,
        running: anyRunning,
        tasks,
        logs: allLogs.slice(-400),
        at: new Date().toISOString(),
      });
    } catch {
      /* ignore */
    }
  }, 250);
}

async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return null;
  }
}

async function ensureRuntimeDir() {
  await fs.mkdir(RUNTIME_DIR, { recursive: true }).catch(() => {});
}

function pushSessionLog(session: BrowserSession, line: string) {
  const text = line.replace(/\r/g, "");
  if (!text.trim()) return;
  const tagged = text.startsWith("[") ? text : `[${session.id}] ${text}`;
  session.logs.push(tagged);
  if (session.logs.length > 400) session.logs.splice(0, session.logs.length - 400);
  broadcast({ type: "log", sessionId: session.id, line: tagged, at: new Date().toISOString() });
  void appendDayLog({
    channel: "checkout",
    sessionId: session.id,
    line: tagged,
  });
}

function killProc(proc: ChildProcess) {
  try {
    proc.kill("SIGTERM");
  } catch {
    /* ignore */
  }
  if (process.platform === "win32" && proc.pid) {
    spawn("taskkill", ["/pid", String(proc.pid), "/T", "/F"], {
      stdio: "ignore",
      shell: true,
      windowsHide: true,
    });
  }
}

async function forceCloseAddOrderTask(id: string): Promise<void> {
  const nid = String(id || "").trim();
  await ensureRuntimeDir();
  await fs.writeFile(
    path.join(RUNTIME_DIR, `close-${nid}.flag`),
    new Date().toISOString(),
    "utf8"
  );
  await fs.unlink(path.join(RUNTIME_DIR, `keepopen-${nid}.flag`)).catch(() => {});
  await fs.unlink(path.join(RUNTIME_DIR, `show-${nid}.flag`)).catch(() => {});
  const t = addOrderTasks.get(nid);
  if (t?.child) {
    killProc(t.child);
    // Windows 再補一刀
    if (process.platform === "win32" && t.pid) {
      spawn("taskkill", ["/pid", String(t.pid), "/T", "/F"], {
        stdio: "ignore",
        shell: true,
        windowsHide: true,
      });
    }
  }
  if (t) {
    t.running = false;
    t.child = null;
    t.pid = null;
    t.exitCode = 0;
    t.logs.push(`[dashboard] Close ${nid}`);
  }
  try {
    const stPath = path.join(RUNTIME_DIR, `status-${nid}.json`);
    let prev: Record<string, unknown> = {};
    try {
      prev = JSON.parse(await fs.readFile(stPath, "utf8")) as Record<string, unknown>;
    } catch {
      /* empty */
    }
    await fs.writeFile(
      stPath,
      JSON.stringify(
        {
          ...prev,
          phase: "closed",
          message: "closed",
          windowHidden: true,
          updatedAt: new Date().toISOString(),
        },
        null,
        2
      ),
      "utf8"
    );
  } catch {
    /* ignore */
  }
  // 即刻由 Tasks 列表移除（唔等 process）
  addOrderTasks.delete(nid);
}

async function isDismissedBrowser(id: string): Promise<boolean> {
  const nid = normalizeBrowserId(id);
  try {
    await fs.access(path.join(RUNTIME_DIR, `dismissed-${nid}.flag`));
    return true;
  } catch {
    return false;
  }
}

function normalizeBrowserId(id: string): string {
  return String(id || "").trim().toLowerCase();
}

/** 由訂單嘅 browser 欄位抽出 b123 */
function browserIdFromOrderTag(raw: unknown): string | null {
  const m = /\b(b\d+)\b/i.exec(String(raw || ""));
  return m ? m[1]!.toLowerCase() : null;
}

async function lookupOrderForBrowser(
  id: string,
  orders?: Record<string, unknown>[]
): Promise<Record<string, unknown> | null> {
  const nid = normalizeBrowserId(id);
  const fromFile = await readSessionOrder(nid);
  if (fromFile?.orderNumber) return fromFile;
  const list = orders || ((await collectOrders()) as Record<string, unknown>[]);
  let best: Record<string, unknown> | null = null;
  for (const o of list) {
    if (!o || typeof o !== "object") continue;
    if (browserIdFromOrderTag(o.browser) !== nid) continue;
    if (!String(o.orderNumber || "").trim()) continue;
    if (!best || orderFieldRichness(o) > orderFieldRichness(best)) best = o;
  }
  return best || fromFile;
}

async function isPaidBrowserSession(id: string): Promise<boolean> {
  const nid = normalizeBrowserId(id);
  const st = await readSessionStatus(nid);
  const card = (st?.card as Record<string, unknown> | undefined) || {};
  if (card.paymentSucceeded || String(card.orderNumber || "").trim()) return true;
  if (/payment_succeeded|orders_ready/i.test(String(st?.phase || ""))) return true;
  const order = await lookupOrderForBrowser(nid);
  return Boolean(order && String(order.orderNumber || "").trim());
}

/** 唔好繼承 Cursor sandbox 嘅 PLAYWRIGHT_BROWSERS_PATH（入面未必有 chromium） */
function envForCheckoutChild(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  const browsersPath = String(env.PLAYWRIGHT_BROWSERS_PATH || "");
  if (!browsersPath) return env;
  if (/cursor-sandbox-cache/i.test(browsersPath)) {
    delete env.PLAYWRIGHT_BROWSERS_PATH;
    return env;
  }
  const chromeWin = path.join(
    browsersPath,
    "chromium-1243",
    "chrome-win64",
    "chrome.exe"
  );
  if (!existsSync(chromeWin)) {
    delete env.PLAYWRIGHT_BROWSERS_PATH;
  }
  return env;
}

function sessionLogPath(id: string): string {
  return path.join(RUNTIME_DIR, `session-${normalizeBrowserId(id)}.log`);
}

function sessionPidPath(id: string): string {
  return path.join(RUNTIME_DIR, `pid-${normalizeBrowserId(id)}.txt`);
}

function psSingleQuote(s: string): string {
  return `'${String(s).replace(/'/g, "''")}'`;
}

/**
 * 完全脫離 dashboard／tsx watch process tree（尤其 Windows job object），
 * 唔會因為 Dashboard 更新／重啟而被連帶關晒 browser。
 */
async function spawnCheckoutWorkerBreakaway(
  id: string,
  envExtra: Record<string, string>
): Promise<{ pid: number | null; child: ChildProcess | null; logFile: string }> {
  await ensureRuntimeDir();
  const nid = normalizeBrowserId(id);
  const tsxCli = path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
  const script = path.join(ROOT, "src", "buy-iphone-17.ts");
  const logFile = sessionLogPath(nid);
  const pidFile = sessionPidPath(nid);
  const env = envForCheckoutChild(envExtra);
  const errFile = `${logFile}.err`;
  // Start-Process -Redirect* 唔可以指向已存在嘅檔；唔好預先 writeFile
  await fs.unlink(logFile).catch(() => {});
  await fs.unlink(errFile).catch(() => {});
  await fs.unlink(pidFile).catch(() => {});

  if (process.platform === "win32") {
    // 用 .ps1 + env json，避免 -Command 太長（全份 process.env）同 quote 炸掉
    const envFile = path.join(RUNTIME_DIR, `launch-env-${nid}.json`);
    const ps1File = path.join(RUNTIME_DIR, `launch-${nid}.ps1`);
    const failFile = path.join(RUNTIME_DIR, `launch-fail-${nid}.txt`);
    const envObj: Record<string, string> = {};
    for (const [k, v] of Object.entries(env)) {
      if (v == null || !k || /[^A-Za-z0-9_]/i.test(k)) continue;
      envObj[k] = String(v);
    }
    await fs.writeFile(envFile, JSON.stringify(envObj), "utf8");
    await fs.unlink(failFile).catch(() => {});
    const ps1 = [
      `$ErrorActionPreference = 'Stop'`,
      `try {`,
      `  # PowerShell 會繼承 dashboard 嘅 env；JSON 冇寫嘅 key 唔會自動清，`,
      `  # 必須顯式刪 Cursor sandbox 嘅 PLAYWRIGHT_BROWSERS_PATH，否則 chromium 指向唔存在嘅路徑`,
      `  Remove-Item Env:PLAYWRIGHT_BROWSERS_PATH -ErrorAction SilentlyContinue`,
      `  $envMap = Get-Content -LiteralPath ${psSingleQuote(envFile)} -Raw -Encoding UTF8 | ConvertFrom-Json`,
      `  $envMap.PSObject.Properties | ForEach-Object {`,
      `    Set-Item -Path ('Env:' + $_.Name) -Value ([string]$_.Value)`,
      `  }`,
      `  if (-not $env:PLAYWRIGHT_BROWSERS_PATH) { Remove-Item Env:PLAYWRIGHT_BROWSERS_PATH -ErrorAction SilentlyContinue }`,
      `  $p = Start-Process -FilePath ${psSingleQuote(process.execPath)} \``,
      `    -ArgumentList @(${psSingleQuote(tsxCli)}, ${psSingleQuote(script)}) \``,
      `    -WorkingDirectory ${psSingleQuote(ROOT)} \``,
      `    -WindowStyle Hidden -PassThru \``,
      `    -RedirectStandardOutput ${psSingleQuote(logFile)} \``,
      `    -RedirectStandardError ${psSingleQuote(errFile)}`,
      `  if (-not $p) { throw 'Start-Process returned null' }`,
      `  Set-Content -LiteralPath ${psSingleQuote(pidFile)} -Value $p.Id -Encoding ascii`,
      `} catch {`,
      `  $_ | Out-File -LiteralPath ${psSingleQuote(failFile)} -Encoding utf8`,
      `  exit 1`,
      `}`,
    ].join("\r\n");
    await fs.writeFile(ps1File, ps1, "utf8");
    await new Promise<void>((resolve, reject) => {
      const chunks: Buffer[] = [];
      // 連 powershell 本身都唔好帶 sandbox browsers path
      const psEnv = { ...process.env, ...envObj };
      delete psEnv.PLAYWRIGHT_BROWSERS_PATH;
      const child = spawn(
        "powershell.exe",
        ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps1File],
        { windowsHide: true, env: psEnv }
      );
      child.stderr?.on("data", (d) => chunks.push(Buffer.from(d)));
      child.stdout?.on("data", (d) => chunks.push(Buffer.from(d)));
      child.on("error", reject);
      child.on("exit", async (code) => {
        if (code === 0) {
          resolve();
          return;
        }
        let detail = Buffer.concat(chunks).toString("utf8").trim();
        try {
          detail = (await fs.readFile(failFile, "utf8")).trim() || detail;
        } catch {
          /* ignore */
        }
        reject(
          new Error(
            detail
              ? `Start-Process failed exit=${code}: ${detail.slice(0, 500)}`
              : `Start-Process failed exit=${code}`
          )
        );
      });
    });
    let pid: number | null = null;
    for (let i = 0; i < 40; i++) {
      try {
        const raw = await fs.readFile(pidFile, "utf8");
        const n = Number(String(raw).trim());
        if (Number.isFinite(n) && n > 0) {
          pid = n;
          break;
        }
      } catch {
        /* wait */
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    return { pid, child: null, logFile };
  }

  // Unix：detached + 完全 ignore stdio，log 寫檔
  const outFd = openSync(logFile, "a");
  const proc = spawn(process.execPath, [tsxCli, script], {
    cwd: ROOT,
    env,
    detached: true,
    stdio: ["ignore", outFd, outFd],
  });
  proc.unref();
  if (proc.pid) {
    await fs.writeFile(pidFile, String(proc.pid), "utf8").catch(() => {});
  }
  return { pid: proc.pid ?? null, child: proc, logFile };
}

/** 跟住 session log 檔（breakaway 後冇 stdout pipe） */
function attachSessionLogTail(session: BrowserSession, logFile: string): void {
  let offset = 0;
  const tick = async () => {
    if (!session.running) return;
    try {
      const st = await fs.stat(logFile);
      if (st.size < offset) offset = 0;
      if (st.size > offset) {
        const fh = await fs.open(logFile, "r");
        try {
          const len = st.size - offset;
          const buf = Buffer.alloc(Math.min(len, 256_000));
          const { bytesRead } = await fh.read(buf, 0, buf.length, offset);
          offset += bytesRead;
          const chunk = buf.slice(0, bytesRead).toString("utf8");
          for (const line of chunk.split(/\r?\n/)) {
            if (line.trim()) pushSessionLog(session, line);
          }
        } finally {
          await fh.close().catch(() => {});
        }
      }
    } catch {
      /* ignore */
    }
    if (session.running) setTimeout(() => void tick(), 800);
  };
  void tick();
}

/** breakaway worker 冇 ChildProcess exit 事件時，用 PID 巡檢查有冇死 */
function watchSessionPid(session: BrowserSession): void {
  const tick = async () => {
    if (!session.running) return;
    const pid = session.pid;
    if (!pidAlive(pid)) {
      // 可能 status 檔已更新 pid；再讀一次
      const st = await readSessionStatus(session.id);
      const stPid =
        typeof st?.pid === "number"
          ? st.pid
          : Number(st?.pid) > 0
            ? Number(st?.pid)
            : null;
      if (stPid && pidAlive(stPid)) {
        session.pid = stPid;
        setTimeout(() => void tick(), 2000);
        return;
      }
      await onCheckoutWorkerExit(session, session.exitCode ?? null);
      return;
    }
    setTimeout(() => void tick(), 2000);
  };
  setTimeout(() => void tick(), 2500);
}

async function onCheckoutWorkerExit(
  session: BrowserSession,
  code: number | null
): Promise<void> {
  if (!session.running && session.pid == null) return;
  session.running = false;
  session.exitCode = code;
  session.pid = null;
  session.child = null;
  pushSessionLog(session, `[dashboard] 進程結束 exit=${code}`);
  const usedProxy = String(session.config?.proxy || "").trim();
  const paid = await isPaidBrowserSession(session.id);
  const st = await readSessionStatus(session.id);
  const phase = String(st?.phase || "");
  void appendDayLog({
    channel: "checkout",
    sessionId: session.id,
    line: `[dashboard] session summary exit=${code} paid=${paid} phase=${phase} proxy=${usedProxy || "本機 IP"}`,
    meta: {
      kind: "exit",
      exitCode: code,
      paid,
      phase,
      proxy: usedProxy,
      orderNumber:
        ((st?.card as { orderNumber?: string } | undefined)?.orderNumber as string) ||
        null,
    },
  });
  if (usedProxy) {
    const failed = !paid && (code !== 0 || /error|fail/i.test(phase));
    if (failed) {
      await blacklistProxy(
        usedProxy,
        `session=${session.id} exit=${code} phase=${phase || "—"}`
      ).catch(() => {});
    }
  }
  if (session.config?.checkoutCardId) {
    const rejected =
      Boolean(st?.cardRejected) ||
      /card_rejected|payment_declined|shop_404/i.test(phase);
    const outcome = paid
      ? "success"
      : rejected || code !== 0 || /error|fail/i.test(phase)
        ? "rejected"
        : "release";
    await finalizeCheckoutCard({
      statePath: CHECKOUT_CARDS_STATE,
      assignPath: assignedCardPath(session.id),
      sessionId: session.id,
      outcome,
    }).catch(() => {});
    pushSessionLog(
      session,
      `[card] finalize ${String(session.config.checkoutCardMasked || session.config.checkoutCardId)} → ${outcome}`
    );
  }
  broadcast({ type: "status", state: await snapshot() });
}

/** 唔好重用舊 id（尤其係已 dismissed），否則新 task 會即刻被隱藏 */
async function refreshNextIndexFromDisk(): Promise<void> {
  let maxN = 0;
  for (const id of sessions.keys()) {
    const m = /^b(\d+)$/i.exec(id);
    if (m) maxN = Math.max(maxN, Number(m[1]));
  }
  try {
    const files = await fs.readdir(RUNTIME_DIR);
    for (const f of files) {
      const m = /-b(\d+)\.(?:json|flag)$/i.exec(f);
      if (m) maxN = Math.max(maxN, Number(m[1]));
    }
  } catch {
    /* empty */
  }
  if (maxN > nextIndex) nextIndex = maxN;
}

async function clearLaunchFlags(id: string): Promise<void> {
  const nid = normalizeBrowserId(id);
  for (const name of [
    `close-${nid}.flag`,
    `release-${nid}.flag`,
    `dismissed-${nid}.flag`,
    `show-${nid}.flag`,
    `hide-${nid}.flag`,
    `continue-${nid}.flag`,
    `stock-resume-${nid}.flag`,
  ]) {
    await fs.unlink(path.join(RUNTIME_DIR, name)).catch(() => {});
  }
}

/** 將 Proxy 欄（多行／逗號分隔）拆成列表 */
function parseProxyPool(raw: unknown): string[] {
  const s = String(raw || "").trim();
  if (!s) return [];
  return s
    .split(/[\n\r,;]+/)
    .map((x) => x.trim())
    .filter(Boolean);
}

function normalizeProxyKey(proxy: string): string {
  return String(proxy || "").trim().toLowerCase();
}

async function loadProxyBlacklist(): Promise<Set<string>> {
  try {
    const raw = await fs.readFile(PROXY_BLACKLIST_FILE, "utf8");
    const parsed = JSON.parse(raw) as { proxies?: string[] } | string[];
    const list = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed.proxies)
        ? parsed.proxies
        : [];
    return new Set(list.map(normalizeProxyKey).filter(Boolean));
  } catch {
    return new Set();
  }
}

async function blacklistProxy(proxy: string, reason: string): Promise<void> {
  const key = normalizeProxyKey(proxy);
  if (!key) return;
  await ensureRuntimeDir();
  const set = await loadProxyBlacklist();
  if (set.has(key)) return;
  set.add(key);
  const proxies = [...set];
  await fs.writeFile(
    PROXY_BLACKLIST_FILE,
    JSON.stringify(
      { updatedAt: new Date().toISOString(), reason, lastAdded: proxy, proxies },
      null,
      2
    ),
    "utf8"
  );
  console.log(`[proxy] 已加入黑名單（之後唔再用）：${proxy}｜${reason}`);
}

/** 清黑名單，之後 Launch 可以再分配呢啲 IP */
async function clearProxyBlacklist(): Promise<number> {
  const banned = await loadProxyBlacklist();
  const n = banned.size;
  await ensureRuntimeDir();
  await fs
    .writeFile(
      PROXY_BLACKLIST_FILE,
      JSON.stringify(
        { updatedAt: new Date().toISOString(), reason: "manual reset", lastAdded: "", proxies: [] },
        null,
        2
      ),
      "utf8"
    )
    .catch(() => {});
  if (n > 0) console.log(`[proxy] blacklist reset：已解禁 ${n} 條`);
  else console.log(`[proxy] blacklist reset：本來就係空`);
  return n;
}

/** 每個 Proxy / IP 用滿 PROXY_BROWSERS_PER_IP 個 browser 先換下一個；唔超額重複 */
async function pickProxyForNewTask(poolRaw: unknown): Promise<string> {
  const pool = parseProxyPool(poolRaw);
  if (!pool.length) return "";
  const banned = await loadProxyBlacklist();
  const usage = new Map<string, number>();

  for (const s of sessions.values()) {
    const key = normalizeProxyKey(String(s.config?.proxy || ""));
    if (!key) continue;
    usage.set(key, (usage.get(key) || 0) + 1);
  }

  // 跟用戶填寫順序：一條用滿 3 個 browser 先用下一條
  for (const p of pool) {
    const key = normalizeProxyKey(p);
    if (!key || banned.has(key)) continue;
    const count = usage.get(key) || 0;
    if (count >= PROXY_BROWSERS_PER_IP) continue;
    console.log(
      `[proxy] 選用 ${p}（${count + 1}/${PROXY_BROWSERS_PER_IP}；同一條最多 ${PROXY_BROWSERS_PER_IP} 個 browser）`
    );
    return p;
  }

  console.warn(
    `[proxy] 每條 proxy 已用滿 ${PROXY_BROWSERS_PER_IP} 個 browser／全被禁用，呢個 task 改用本機 IP`
  );
  return "";
}

/** 由 Opened browsers 移除卡片（保留 order-*.json 畀 Order summary） */
async function dismissBrowserCard(id: string): Promise<void> {
  const nid = normalizeBrowserId(id);
  await ensureRuntimeDir();
  await fs.writeFile(
    path.join(RUNTIME_DIR, `dismissed-${nid}.flag`),
    new Date().toISOString(),
    "utf8"
  );
  await fs.unlink(path.join(RUNTIME_DIR, `status-${nid}.json`)).catch(() => {});
  await fs.unlink(path.join(RUNTIME_DIR, `release-${nid}.flag`)).catch(() => {});
  await fs.unlink(path.join(RUNTIME_DIR, `show-${nid}.flag`)).catch(() => {});
  await fs.unlink(path.join(RUNTIME_DIR, `hide-${nid}.flag`)).catch(() => {});
  await fs.unlink(path.join(RUNTIME_DIR, `continue-${nid}.flag`)).catch(() => {});
  // close flag 留低，等仲喺跑嘅 script 自己 exit
  await fs.writeFile(
    path.join(RUNTIME_DIR, `close-${nid}.flag`),
    new Date().toISOString(),
    "utf8"
  ).catch(() => {});
}

async function stopSession(
  id: string,
  mode: "release" | "force" = "release",
  opts?: { silent?: boolean }
) {
  const nid = normalizeBrowserId(id);
  const session = sessions.get(nid) || sessions.get(id);
  await ensureRuntimeDir();

  if (mode === "release") {
    // 冇 live process：Stop 無用，淨係 Close 可清卡片
    if (!session?.running || !session.child) {
      broadcast({ type: "status", state: await snapshot() });
      return;
    }
    // 停自動化、保留瀏覽器；silent=Stop all（唔開窗）
    const payload = opts?.silent
      ? `stop-all\n${new Date().toISOString()}`
      : `takeover\n${new Date().toISOString()}`;
    await fs.writeFile(path.join(RUNTIME_DIR, `release-${nid}.flag`), payload, "utf8");
    // 即刻更新 status，等 script 進入 manual_control
    const stPath = path.join(RUNTIME_DIR, `status-${nid}.json`);
    try {
      const prev = JSON.parse(await fs.readFile(stPath, "utf8")) as Record<string, unknown>;
      const prevPhase = String(prev.phase || "");
      // waiting payment 已 steps_complete：Stop 後仍留喺 waiting payment，唔改去 Opened
      const keepWaitingPayment = /steps_complete|waiting_for_payment/i.test(prevPhase);
      await fs.writeFile(
        stPath,
        JSON.stringify(
          {
            ...prev,
            phase: keepWaitingPayment
              ? /steps_complete/i.test(prevPhase)
                ? "steps_complete"
                : "waiting_for_payment"
              : "stop_requested",
            message: opts?.silent
              ? keepWaitingPayment
                ? "Stop all：自動化已停（仍喺 waiting payment）"
                : "Dashboard Stop all（保持原本視窗位置）"
              : keepWaitingPayment
                ? "自動化已停（仍喺 waiting payment；Open browser 人手操作）"
                : "Dashboard 要求 Stop（take over）",
            windowHidden: opts?.silent ? false : prev.windowHidden,
            windowState: opts?.silent ? "normal" : prev.windowState,
            updatedAt: new Date().toISOString(),
          },
          null,
          2
        ),
        "utf8"
      );
    } catch {
      /* ignore */
    }
    pushSessionLog(
      session,
      opts?.silent
        ? "[dashboard] Stop all：已要求停止自動化（保持原本視窗位置）"
        : "[dashboard] 已要求停止自動化（Take over / Stop）"
    );
    // 即刻回 UI；背景再跟進 manual_control（避免 Stop 掣卡住 30 秒）
    broadcast({ type: "status", state: await snapshot() });
    void (async () => {
      for (let i = 0; i < 80; i++) {
        await new Promise((r) => setTimeout(r, 250));
        const st = await readSessionStatus(nid);
        const phase = String(st?.phase || "");
        const releaseGone = !(await fs
          .access(path.join(RUNTIME_DIR, `release-${nid}.flag`))
          .then(() => true)
          .catch(() => false));
        if (
          st?.phase === "manual_control" ||
          !session.running ||
          (/steps_complete|waiting_for_payment/i.test(phase) && releaseGone)
        ) {
          broadcast({ type: "status", state: await snapshot() });
          break;
        }
      }
    })();
    return;
  }

  // force close：opened task 先 dismiss；已付款／Finished 只殺 process，保留卡片
  const stBefore = await readSessionStatus(nid).catch(() => null);
  const child = session?.child ?? null;
  const pid =
    session?.pid ??
    child?.pid ??
    (typeof stBefore?.pid === "number" ? stBefore.pid : Number(stBefore?.pid) || null);

  const paid = await isPaidBrowserSession(nid);
  if (!paid) {
    await dismissBrowserCard(nid);
  } else {
    // Finished：唔刪 status／唔寫 dismissed；只要求 process 結束
    await fs.writeFile(
      path.join(RUNTIME_DIR, `close-${nid}.flag`),
      new Date().toISOString(),
      "utf8"
    ).catch(() => {});
  }
  sessions.delete(nid);
  sessions.delete(id);

  if (session) {
    pushSessionLog(
      session,
      paid
        ? "[dashboard] Finished task：關閉 process，保留 Finished 卡片"
        : "[dashboard] 正在關閉呢個瀏覽器…"
    );
  }
  try {
    if (child) {
      killProc(child);
      session!.child = null;
    } else if (pid) {
      spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
        stdio: "ignore",
        shell: true,
      });
    }
  } catch {
    /* ignore kill errors */
  }

  if (session) {
    session.running = false;
    session.pid = null;
  }

  broadcast({ type: "status", state: await snapshot() });
}

async function stopAll() {
  await ensureRuntimeDir();
  // 標示 Stop all：script 停自動化；視窗保持原本位置（唔隱藏）
  await fs.writeFile(
    path.join(RUNTIME_DIR, "stop-all.flag"),
    new Date().toISOString(),
    "utf8"
  );
  for (const id of [...sessions.keys()]) {
    await stopSession(id, "release", { silent: true });
  }
  await fs.unlink(CONTINUE_ALL_FLAG).catch(() => {});
  broadcast({ type: "status", state: await snapshot() });
}

async function closeAll() {
  // 只清 Opened（未付款）；Finished／已付款一律保留
  const ids = new Set<string>([...sessions.keys()]);
  for (const id of await listPersistedSessionIds()) {
    if (!(await isDismissedBrowser(id))) ids.add(id);
  }
  for (const id of ids) {
    if (await isPaidBrowserSession(id)) {
      const session = sessions.get(normalizeBrowserId(id)) || sessions.get(id);
      if (session?.running) {
        await stopSession(id, "force");
      }
      continue;
    }
    await stopSession(id, "force");
  }
  // 唔好 sessions.clear() 掉已付款記憶體項；逐個 force 已處理
  for (const id of [...sessions.keys()]) {
    if (!(await isPaidBrowserSession(id))) sessions.delete(id);
  }
  await fs.unlink(CONTINUE_ALL_FLAG).catch(() => {});
  broadcast({ type: "status", state: await snapshot() });
}

async function spawnOneBrowser(
  config: Record<string, unknown>,
  opts?: { windowTotal?: number }
): Promise<BrowserSession> {
  await ensureRuntimeDir();
  // 輕微 jitter，減少多個 Add 同一刻打中 Apple
  await new Promise((r) => setTimeout(r, 80 + Math.floor(Math.random() * 280)));
  await refreshNextIndexFromDisk();
  const index = nextIndex++;
  const id = `b${index + 1}`;
  const {
    _windowTotalOverride: _a,
    _windowIndexHint: _b,
    ...cleanConfig
  } = config as Record<string, unknown> & {
    _windowTotalOverride?: number;
    _windowIndexHint?: number;
  };
  const sessionConfig = {
    ...cleanConfig,
    browserCount: 1,
  } as Record<string, unknown> & { browserCount: number };
  // 多個 proxy：每條最多分配畀 3 個 browser，用滿先換下一條（唔隨機重複）
  const assignedProxy = await pickProxyForNewTask(cleanConfig.proxy);
  sessionConfig.proxy = assignedProxy;
  if (assignedProxy) {
    console.log(`[proxy] ${id} 分配：${assignedProxy}`);
  }
  // 信用卡訪客模式：隨機分配加密卡（用過／拒單可再用）；Apple Pay 唔分配
  if (usesCreditCardAutofill(sessionConfig.fulfillmentPreference)) {
    const claimed = await claimCheckoutCard({
      encPath: CHECKOUT_CARDS_ENC,
      keyPath: ADD_ORDER_KEY,
      statePath: CHECKOUT_CARDS_STATE,
      assignPath: assignedCardPath(id),
      sessionId: id,
    }).catch(() => null);
    if (claimed) {
      sessionConfig.checkoutCardId = claimed.id;
      sessionConfig.checkoutCardMasked = `****${String(claimed.number).slice(-4)}`;
      if (claimed.limit != null) {
        sessionConfig.cardLimit = String(Math.round(claimed.limit));
      }
      console.log(
        `[card] ${id} 分配信用卡 ****${String(claimed.number).slice(-4)}` +
          (claimed.limit != null ? ` limit=${Math.round(claimed.limit)}` : "") +
          `（加密檔；用過／拒單可再分配）`
      );
    } else {
      console.warn(`[card] ${id} 無可用信用卡（請喺 Dashboard 貼上 卡號,mm/yy,cvv,limit 並 Save）`);
    }
  }
  const configPath = path.join(RUNTIME_DIR, `config-${id}.json`);
  await fs.writeFile(configPath, JSON.stringify(sessionConfig, null, 2), "utf8");
  await fs.writeFile(RUNTIME_CONFIG, JSON.stringify({ ...cleanConfig }, null, 2), "utf8");
  // 清走舊 stop／close／dismiss flag，避免新 session 即刻被殺或唔顯示
  await clearLaunchFlags(id);
  await fs.unlink(path.join(RUNTIME_DIR, "stop-all.flag")).catch(() => {});

  const session: BrowserSession = {
    id,
    index,
    pid: null,
    running: true,
    exitCode: null,
    startedAt: new Date().toISOString(),
    config: sessionConfig,
    logs: [],
    child: null,
  };
  sessions.set(id, session);

  const windowTotal = Math.max(
    opts?.windowTotal || 0,
    Number(config.browserCount) || 0,
    sessions.size,
    index + 1
  );

  // 完全脫離 dashboard process tree：Dashboard／tsx watch 更新唔會連 browser 一齊關
  const launched = await spawnCheckoutWorkerBreakaway(id, {
    CHECKOUT_DASHBOARD: "1",
    CHECKOUT_CONFIG_PATH: configPath,
    CHECKOUT_SESSION_ID: id,
    CHECKOUT_WINDOW_INDEX: String(index),
    CHECKOUT_WINDOW_TOTAL: String(windowTotal),
    CHECKOUT_CARD_KEY_PATH: ADD_ORDER_KEY,
    CHECKOUT_CARD_ASSIGN_PATH: assignedCardPath(id),
    CHECKOUT_CARD_STATE_PATH: CHECKOUT_CARDS_STATE,
  });
  session.child = launched.child;
  session.pid = launched.pid;
  await writeInitialOpenedBrowserStatus(id, sessionConfig, session.pid);
  await writeSessionLaunchRecord(id, sessionConfig);
  pushSessionLog(
    session,
    `[dashboard] 已啟動 pid=${session.pid} windowIndex=${index}/${windowTotal}（detached；Dashboard 更新唔會關）`
  );
  attachSessionLogTail(session, launched.logFile);
  // 都跟 .err（Windows Start-Process 分開 stderr）
  attachSessionLogTail(session, `${launched.logFile}.err`);
  if (launched.child) {
    launched.child.on("exit", (code) => {
      void onCheckoutWorkerExit(session, code);
    });
  } else {
    watchSessionPid(session);
  }

  return session;
}

/** 一開 task 即寫 status，Opened browsers 即刻有齊產品／金額／fulfill 等 */
async function writeInitialOpenedBrowserStatus(
  id: string,
  config: Record<string, unknown>,
  pid: number | null
): Promise<void> {
  const qty = Math.max(1, Number(config.quantity) || 1);
  const fulfillPref = String(config.fulfillmentPreference || "pickup");
  const deliveryMethod = fulfillmentLabelFromPreference(fulfillPref);
  const applePay = /apple_pay/i.test(fulfillPref);
  const amt = resolveOrderAmountSpent({
    model: String(config.model || ""),
    storage: String(config.storage || ""),
    quantity: qty,
  });
  const status = {
    sessionId: id,
    phase: "starting",
    pid,
    windowHidden: true,
    windowState: "minimized",
    updatedAt: new Date().toISOString(),
    lastProgressAt: new Date().toISOString(),
    stuck: false,
    config: {
      model: config.model,
      color: config.color,
      storage: config.storage,
      quantity: qty,
      fulfillmentPreference: fulfillPref,
      buyUrl: config.buyUrl,
      proxy: config.proxy || "",
    },
    card: {
      productType: config.model ?? null,
      color: config.color ?? null,
      storage: config.storage ?? null,
      quantity: qty,
      fulfillmentMode: fulfillPref,
      fulfillmentPreference: fulfillPref,
      deliveryMethod,
      total: amt.label || null,
      orderNumber: null,
      email: null,
      phone: null,
      name: null,
      cardNumber: applePay ? "Apple Pay" : null,
      cardType: applePay ? "Apple Pay" : null,
      cardCompany: applePay ? "Apple Pay" : null,
      cardLimit: null,
      remainingCreditCardLimit: null,
      remainingLimit: null,
      paymentSucceeded: false,
      proxy: config.proxy || "",
    },
  };
  await fs.writeFile(
    path.join(RUNTIME_DIR, `status-${id}.json`),
    JSON.stringify(status, null, 2),
    "utf8"
  ).catch(() => {});
}

async function launchBrowsers(config: Record<string, unknown>, count: number) {
  const n = Math.max(1, Math.min(20, Number(count) || 1));
  lastFormConfig = { ...config, browserCount: n };
  await ensureRuntimeDir();
  await refreshNextIndexFromDisk();
  await fs.unlink(path.join(RUNTIME_DIR, "stop-all.flag")).catch(() => {});
  await fs.unlink(CONTINUE_ALL_FLAG).catch(() => {});
  const created = [];
  const plannedTotal = nextIndex + n;
  for (let i = 0; i < n; i++) {
    // 錯開啟動，降低開賣高峰同一秒打爆 Apple → /shop/404
    if (i > 0) await new Promise((r) => setTimeout(r, 400));
    created.push(await spawnOneBrowser(config, { windowTotal: plannedTotal }));
  }
  broadcast({ type: "status", state: await snapshot() });
  return created;
}

async function collectOrders(): Promise<unknown[]> {
  const merged: unknown[] = [];
  const rootOrders = await readJson(ORDERS_FILE);
  if (Array.isArray(rootOrders)) merged.push(...rootOrders);

  try {
    const files = await fs.readdir(RUNTIME_DIR);
    for (const f of files) {
      if (!/^order-.*\.json$/i.test(f)) continue;
      const data = await readJson(path.join(RUNTIME_DIR, f));
      if (Array.isArray(data)) merged.push(...data);
      else if (data && typeof data === "object") merged.push(data);
    }
  } catch {
    /* empty */
  }

  // 用 status-*.json 補齊卡號／公司／剩餘額度
  const byBrowser = new Map<string, Record<string, unknown>>();
  try {
    const files = await fs.readdir(RUNTIME_DIR);
    for (const f of files) {
      const m = /^status-(b\d+)\.json$/i.exec(f);
      if (!m) continue;
      const st = await readJson(path.join(RUNTIME_DIR, f));
      if (st && typeof st === "object") {
        byBrowser.set(m[1]!.toLowerCase(), st as Record<string, unknown>);
      }
    }
  } catch {
    /* empty */
  }

  const enriched: Record<string, unknown>[] = [];
  for (const item of merged) {
    if (!item || typeof item !== "object") continue;
    const o = { ...(item as Record<string, unknown>) };
    const browser = String(o.browser || "").toLowerCase();
    const st = byBrowser.get(browser);
    const card = (st?.card as Record<string, unknown> | undefined) || {};
    const ship =
      (o.confirmationPageShipping as Record<string, unknown> | undefined) || {};

    const cardNumber = cardNumberOrApplePay(
      o.cardNumber,
      card.cardNumber,
      ship.cardNumber
    );
    o.cardNumber = cardNumber;

    if (/apple\s*pay/i.test(cardNumber)) {
      o.cardCompany = pickNonEmpty(o.cardCompany, card.cardCompany) || "Apple Pay";
      o.cardType = pickNonEmpty(o.cardType, card.cardType) || "Apple Pay";
      enriched.push(o);
      continue;
    }

    const meta = lookupCardMeta(String(cardNumber || ""));
    const vaultOpts = await vaultLimitOverrideForCard(String(cardNumber || ""));
    const peek = cardNumber
      ? await peekCardLimitInfo(
          ROOT,
          String(cardNumber),
          o.amountSpent ?? o.total,
          vaultOpts
        )
      : null;

    o.cardCompany =
      pickNonEmpty(o.cardCompany, card.cardCompany, peek?.company, meta?.company) ||
      o.cardCompany ||
      "";
    o.cardType =
      pickNonEmpty(o.cardType, card.cardType, peek?.type, meta?.type) ||
      o.cardType ||
      "";
    o.cardLimit =
      pickNonEmpty(
        o.cardLimit,
        card.cardLimit,
        peek?.cardLimit,
        vaultOpts?.originalLimit != null ? String(Math.round(vaultOpts.originalLimit)) : null,
        meta?.limit
      ) ||
      o.cardLimit ||
      "";
    const rem =
      pickNonEmpty(
        o.remainingCreditCardLimit,
        o.remainingLimit,
        card.remainingCreditCardLimit,
        card.remainingLimit,
        peek?.remainingLabel
      ) || "";
    if (rem) {
      o.remainingCreditCardLimit = rem;
      o.remainingLimit = rem;
    }
    enriched.push(o);
  }

  // de-dupe：同一訂單編號保留資料較齊嗰條
  const byOrder = new Map<string, Record<string, unknown>>();
  const noOrder: Record<string, unknown>[] = [];
  for (const o of enriched) {
    const n = String(o.orderNumber || "").trim();
    if (!n) {
      noOrder.push(o);
      continue;
    }
    const prev = byOrder.get(n);
    if (!prev || orderFieldRichness(o) > orderFieldRichness(prev)) {
      byOrder.set(n, o);
    }
  }
  return [...byOrder.values(), ...noOrder];
}

function pickNonEmpty(
  ...vals: unknown[]
): string | null {
  for (const v of vals) {
    if (v == null) continue;
    const s = String(v).trim();
    if (!s || s === "—" || /人手填/.test(s)) continue;
    return s;
  }
  return null;
}

/** 有可追蹤卡號（≥4 位數字）；否則 dashboard 標 Apple Pay */
function hasTrackableCardNumber(v: unknown): boolean {
  const s = String(v ?? "").trim();
  if (!s || s === "—" || /人手填/.test(s)) return false;
  if (/apple\s*pay/i.test(s)) return true;
  return s.replace(/\D/g, "").length >= 4;
}

function cardNumberOrApplePay(...vals: unknown[]): string {
  for (const v of vals) {
    const s = pickNonEmpty(v);
    if (!s) continue;
    if (/apple\s*pay/i.test(s)) return "Apple Pay";
    if (hasTrackableCardNumber(s)) return s;
  }
  return "Apple Pay";
}

function orderFieldRichness(o: Record<string, unknown>): number {
  let score = 0;
  if (hasTrackableCardNumber(o.cardNumber) && !/apple\s*pay/i.test(String(o.cardNumber))) {
    score += 4;
  }
  if (pickNonEmpty(o.cardCompany)) score += 2;
  if (pickNonEmpty(o.remainingCreditCardLimit, o.remainingLimit)) score += 2;
  if (pickNonEmpty(o.cardLimit)) score += 1;
  if (pickNonEmpty(o.amountSpent, o.total)) score += 1;
  if (pickNonEmpty(o.orderPlacedAt)) score += 1;
  return score;
}

async function readSessionStatus(id: string): Promise<Record<string, unknown> | null> {
  const data = await readJson(path.join(RUNTIME_DIR, `status-${id}.json`));
  return data && typeof data === "object" ? (data as Record<string, unknown>) : null;
}

async function readSessionOrder(id: string): Promise<Record<string, unknown> | null> {
  const data = await readJson(path.join(RUNTIME_DIR, `order-${id}.json`));
  if (Array.isArray(data) && data[0] && typeof data[0] === "object") {
    return data[0] as Record<string, unknown>;
  }
  if (data && typeof data === "object") return data as Record<string, unknown>;
  return null;
}

async function listPersistedSessionIds(): Promise<string[]> {
  try {
    const files = await fs.readdir(RUNTIME_DIR);
    const ids = new Set<string>();
    for (const f of files) {
      const m = /^(?:status|order)-(b\d+)\.json$/i.exec(f);
      if (m?.[1]) ids.add(m[1].toLowerCase());
    }
    return [...ids];
  } catch {
    return [];
  }
}

function browserIndexFromId(id: string): number {
  const m = /^b(\d+)$/i.exec(id);
  return m ? Math.max(0, Number(m[1]) - 1) : 0;
}

async function readRestockHistory(limit = 100): Promise<unknown[]> {
  try {
    const raw = await fs.readFile(RESTOCK_HISTORY_FILE, "utf8");
    const lines = raw.split(/\r?\n/).filter((l) => l.trim());
    const out: unknown[] = [];
    for (const line of lines.slice(-Math.max(1, limit))) {
      try {
        out.push(JSON.parse(line));
      } catch {
        /* skip bad line */
      }
    }
    // 最新喺前
    return out.reverse();
  } catch {
    return [];
  }
}

async function snapshot() {
  await recoverCheckoutSessionsFromDisk().catch(() => {});
  const browsers: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();
  const shownOrderNumbers = new Set<string>();
  const allOrders = (await collectOrders()) as Record<string, unknown>[];

  const pushBrowser = async (
    s: {
      id: string;
      index: number;
      pid: number | null;
      running: boolean;
      exitCode: number | null;
      startedAt: string;
      config: Record<string, unknown>;
      logs: string[];
    },
    orderHint?: Record<string, unknown> | null
  ) => {
    if (seen.has(s.id)) return;
    seen.add(s.id);
    const runtimeStatus = await readSessionStatus(s.id);
    const order =
      orderHint ||
      (await lookupOrderForBrowser(s.id, allOrders)) ||
      (await readSessionOrder(s.id));
    const card = (runtimeStatus?.card as Record<string, unknown> | undefined) || {};
    const orderNumber =
      (typeof card.orderNumber === "string" && card.orderNumber.trim()) ||
      (typeof order?.orderNumber === "string" && order.orderNumber.trim()) ||
      null;
    const paymentSucceeded =
      Boolean(card.paymentSucceeded) || Boolean(orderNumber);
    if (!s.running && !orderNumber && !runtimeStatus?.phase && !runtimeStatus?.card) {
      return;
    }
    if (orderNumber) shownOrderNumbers.add(orderNumber);
    const phase = paymentSucceeded
      ? "payment_succeeded"
      : String(runtimeStatus?.phase || "") ||
        (s.running ? "running" : s.exitCode == null ? "idle" : "exited");

    const fulfillApplePay = /apple_pay/i.test(
      String(
        s.config.fulfillmentPreference ||
          card.fulfillmentMode ||
          order?.fulfillmentMode ||
          ""
      )
    );
    const rawCard = pickNonEmpty(card.cardNumber, order?.cardNumber);
    const cardNumber = rawCard
      ? cardNumberOrApplePay(rawCard)
      : fulfillApplePay
        ? "Apple Pay"
        : null;
    const isApplePay = Boolean(cardNumber && /apple\s*pay/i.test(String(cardNumber)));
    const estimatedTotal = resolveOrderAmountSpent({
      scrapedAmount: card.total ?? order?.amountSpent ?? order?.total,
      model: String(
        card.productType ?? order?.productType ?? order?.productName ?? s.config.model ?? ""
      ),
      storage: String(card.storage ?? order?.storage ?? s.config.storage ?? ""),
      quantity: Number(card.quantity ?? order?.quantity ?? s.config.quantity) || 1,
    });
    const peek =
      cardNumber && !isApplePay
        ? await peekCardLimitInfo(
            ROOT,
            cardNumber,
            card.total ?? order?.amountSpent ?? order?.total ?? estimatedTotal.label,
            await vaultLimitOverrideForCard(cardNumber)
          )
        : null;
    const meta = cardNumber && !isApplePay ? lookupCardMeta(cardNumber) : null;
    const remaining = isApplePay
      ? null
      : pickNonEmpty(
          card.remainingCreditCardLimit,
          card.remainingLimit,
          order?.remainingCreditCardLimit,
          order?.remainingLimit,
          peek?.remainingLabel
        ) || null;

    const sd = (order?.shippingDetails || {}) as Record<string, unknown>;
    const contact = (order?.checkoutContactUsed || {}) as Record<string, unknown>;
    const boxes = (order?.deliveryShippingBoxes || {}) as Record<string, unknown>;
    const identity = (order?.identity || {}) as Record<string, unknown>;
    const confShip = (order?.confirmationPageShipping || {}) as Record<string, unknown>;
    const deliveryDetails =
      (card.deliveryDetails as Record<string, unknown> | null | undefined) || null;

    const lastName =
      pickNonEmpty(
        card.lastName,
        boxes.lastName,
        sd.lastName,
        contact.lastName,
        identity.lastName,
        deliveryDetails?.lastName
      ) || null;
    const firstName =
      pickNonEmpty(
        card.firstName,
        boxes.firstName,
        sd.firstName,
        contact.firstName,
        identity.firstName,
        deliveryDetails?.firstName
      ) || null;
    const email =
      pickNonEmpty(
        card.email,
        sd.email,
        contact.email,
        confShip.email,
        identity.email,
        deliveryDetails?.email
      ) || null;
    const phone =
      pickNonEmpty(
        card.phone,
        sd.phone,
        contact.phone,
        confShip.phone,
        identity.phone,
        deliveryDetails?.phone
      ) || null;
    const address =
      pickNonEmpty(
        card.address,
        sd.address,
        contact.address,
        confShip.address,
        confShip.pickupStore,
        sd.pickupStore,
        deliveryDetails?.address
      ) || null;
    const name =
      pickNonEmpty(
        card.name,
        sd.name,
        deliveryDetails?.name,
        [lastName, firstName].filter(Boolean).join(" ")
      ) || null;
    const areaDistrictStreet =
      pickNonEmpty(
        card.areaDistrictStreet,
        boxes.areaDistrictStreet,
        sd.areaDistrictStreet,
        contact.areaDistrictStreet,
        deliveryDetails?.areaDistrictStreet,
        [identity.area, identity.district, identity.street].filter(Boolean).join(" ")
      ) || null;
    const buildingFloorUnit =
      pickNonEmpty(
        card.buildingFloorUnit,
        boxes.buildingFloorUnit,
        sd.buildingFloorUnit,
        contact.buildingFloorUnit,
        identity.buildingLine,
        deliveryDetails?.buildingFloorUnit
      ) || null;

    const deliveryMethod = resolveDeliveryMethodLabel(
      card.deliveryMethod,
      order?.deliveryMethod,
      order?.fulfillmentPreference,
      card.fulfillmentPreference,
      s.config.fulfillmentPreference,
      card.fulfillmentMode,
      order?.fulfillmentMode
    );

    browsers.push({
      id: s.id,
      index: s.index,
      pid: s.pid,
      running: s.running,
      exitCode: s.exitCode,
      startedAt: s.startedAt,
      config: s.config,
      logs: s.logs.slice(-40),
      phase,
      windowHidden: Boolean(runtimeStatus?.windowHidden),
      windowState: runtimeStatus?.windowState ?? null,
      updatedAt: runtimeStatus?.updatedAt ?? null,
      lastProgressAt: runtimeStatus?.lastProgressAt ?? runtimeStatus?.updatedAt ?? null,
      stuck: Boolean(runtimeStatus?.stuck),
      stuckSince: runtimeStatus?.stuckSince ?? null,
      error: runtimeStatus?.error ?? null,
      shop404Timing: runtimeStatus?.shop404Timing ?? null,
      runtimeStatus,
      card: {
        productType:
          card.productType ?? order?.productType ?? order?.productName ?? s.config.model,
        color: card.color ?? order?.color ?? s.config.color,
        storage: card.storage ?? order?.storage ?? s.config.storage,
        quantity: card.quantity ?? order?.quantity ?? s.config.quantity,
        total:
          pickNonEmpty(card.total, order?.amountSpent, order?.total, estimatedTotal.label) ||
          null,
        fulfillmentMode:
          card.fulfillmentMode ?? order?.fulfillmentMode ?? s.config.fulfillmentPreference,
        fulfillmentPreference:
          card.fulfillmentPreference ??
          order?.fulfillmentPreference ??
          s.config.fulfillmentPreference,
        deliveryMethod,
        orderNumber,
        email,
        phone,
        address,
        name,
        proxy: card.proxy ?? order?.proxy ?? s.config.proxy ?? null,
        cardNumber,
        cardType: isApplePay
          ? pickNonEmpty(card.cardType, order?.cardType) || "Apple Pay"
          : pickNonEmpty(card.cardType, order?.cardType, peek?.type, meta?.type) || null,
        cardCompany: isApplePay
          ? pickNonEmpty(card.cardCompany, order?.cardCompany) || "Apple Pay"
          : pickNonEmpty(card.cardCompany, order?.cardCompany, peek?.company, meta?.company) ||
            null,
        cardLimit: isApplePay
          ? null
          : pickNonEmpty(
              card.cardLimit,
              order?.cardLimit,
              peek?.cardLimit,
              s.config.cardLimit,
              meta?.limit
            ) || null,
        remainingCreditCardLimit: remaining,
        remainingLimit: remaining,
        orderPlacedAt: card.orderPlacedAt ?? order?.orderPlacedAt ?? null,
        deliveryDetails: deliveryDetails || (Object.keys(sd).length ? sd : null),
        estimatedDelivery:
          pickNonEmpty(
            card.estimatedDelivery,
            order?.estimatedDelivery,
            sd.estimatedDelivery,
            deliveryDetails?.estimatedDelivery
          ) || null,
        paymentSucceeded,
        url: card.url ?? order?.url ?? null,
        lastName,
        firstName,
        areaDistrictStreet,
        buildingFloorUnit,
        message: runtimeStatus?.message ?? (paymentSucceeded ? "payment succeeded" : null),
      },
    });
  };

  for (const s of sessions.values()) {
    if (await isDismissedBrowser(s.id)) {
      if (!(await isPaidBrowserSession(s.id))) {
        sessions.delete(s.id);
        continue;
      }
    }
    await pushBrowser(s);
  }

  for (const id of await listPersistedSessionIds()) {
    if (sessions.has(id)) continue;
    if ((await isDismissedBrowser(id)) && !(await isPaidBrowserSession(id))) continue;
    const cfgPath = path.join(RUNTIME_DIR, `config-${id}.json`);
    const cfg = ((await readJson(cfgPath)) as Record<string, unknown> | null) || {
      ...lastFormConfig,
    };
    const st = await readSessionStatus(id);
    if (
      st &&
      /^(closed|idle)$/i.test(String(st.phase || "")) &&
      !(st.card as { orderNumber?: string } | undefined)?.orderNumber &&
      !(await lookupOrderForBrowser(id, allOrders))
    ) {
      continue;
    }
    const pidRaw = st?.pid;
    const pid =
      typeof pidRaw === "number"
        ? pidRaw
        : Number(pidRaw) > 0
          ? Number(pidRaw)
          : null;
    const alive = pidAlive(pid);
    await pushBrowser({
      id,
      index: browserIndexFromId(id),
      pid: alive ? pid : null,
      running: alive,
      exitCode: alive ? null : 0,
      startedAt: String(st?.updatedAt || new Date().toISOString()),
      config: cfg,
      logs: [],
      child: null,
    });
  }

  // 由 order-summary 還原最近 Finished（唔受 dismiss／清 status 影響）
  for (const o of allOrders) {
    if (!o || typeof o !== "object") continue;
    const orderNumber = String(o.orderNumber || "").trim();
    if (!orderNumber || shownOrderNumbers.has(orderNumber)) continue;
    const bid = browserIdFromOrderTag(o.browser);
    const id = bid && !seen.has(bid) ? bid : `fin-${orderNumber}`;
    await pushBrowser(
      {
        id,
        index: bid ? browserIndexFromId(bid) : 100000 + browsers.length,
        pid: null,
        running: false,
        exitCode: 0,
        startedAt: String(o.orderPlacedAt || o.updatedAt || new Date().toISOString()),
        config: {
          model: o.productType || o.productName || o.model || lastFormConfig.model,
          color: o.color || lastFormConfig.color,
          storage: o.storage || lastFormConfig.storage,
          quantity: o.quantity || lastFormConfig.quantity || 1,
          fulfillmentPreference:
            o.fulfillmentPreference ||
            o.deliveryMethod ||
            o.fulfillmentMode ||
            lastFormConfig.fulfillmentPreference,
          proxy: o.proxy || "",
        },
        logs: [],
      },
      o
    );
  }

  browsers.sort((a, b) => Number(a.index ?? 0) - Number(b.index ?? 0));

  const runningCount = browsers.filter((b) => b.running).length;
  const allLogs = browsers.flatMap((b) => (b.logs as string[]) || []).slice(-300);
  const orders = allOrders;
  const promax = getPromaxPickupStatus();
  const availableSkuCount = (promax.matrix || []).filter((m) =>
    (m.stores || []).some((s) => /^available$/i.test(String(s.pickup_display || "")))
  ).length;

  return {
    running: runningCount > 0,
    runningCount,
    totalBrowsers: browsers.length,
    config: lastFormConfig,
    browsers,
    logs: allLogs,
    orders,
    cardLimits: await getLiveCardLimits(ROOT, orders, await loadVaultLimitsMap()),
    monitor: {
      running: promax.running,
      pid: null,
      startedAt: promax.last_success_at || promax.last_attempt_at,
      autoBuy: false,
      logs: [],
      status: {
        mode: "promax-pickup",
        product: promax.product,
        lastSuccessAt: promax.last_success_at,
        lastError: promax.last_error,
        consecutiveFailures: promax.consecutive_failures,
        totalAvailableStock: availableSkuCount,
        skus: (promax.matrix || []).map((m) => ({
          model: "iPhone 18 Pro Max",
          color: m.color,
          storage: m.storage,
          name: `${m.storage} ${m.color}`,
          label: (m.stores || []).some((s) =>
            /^available$/i.test(String(s.pickup_display || ""))
          )
            ? "有門市可取"
            : "未偵測到有貨",
          stockQty: (m.stores || []).filter((s) =>
            /^available$/i.test(String(s.pickup_display || ""))
          ).length,
          buyQty: 1,
        })),
      },
      restockHistory: await readRestockHistory(120),
      promax,
    },
    durableLogs: {
      day: hkDayStamp(),
      dir: dayLogsRelativeDir(),
      absoluteDir: dayLogsAbsoluteDir(),
    },
  };
}


function sendJson(res: http.ServerResponse, code: number, body: unknown) {
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(body));
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks).toString("utf8");
}

function contentType(file: string): string {
  if (file.endsWith(".html")) return "text/html; charset=utf-8";
  if (file.endsWith(".css")) return "text/css; charset=utf-8";
  if (file.endsWith(".js")) return "text/javascript; charset=utf-8";
  return "application/octet-stream";
}

async function handleApi(req: http.IncomingMessage, res: http.ServerResponse) {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const { pathname } = url;

  if (pathname === "/api/health") return sendJson(res, 200, { ok: true });

  /** iPhone 18 Pro Max 香港門市取貨庫存 matrix（獨立模組） */
  if (pathname === "/api/promax-pickup/status" && req.method === "GET") {
    return sendJson(res, 200, getPromaxPickupStatus());
  }
  if (pathname === "/api/promax-pickup/poll" && req.method === "POST") {
    try {
      const status = await runPromaxPickupPollOnce();
      return sendJson(res, 200, status);
    } catch (err) {
      return sendJson(res, 500, {
        ...getPromaxPickupStatus(),
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  if (pathname === "/api/promax-pickup/start" && req.method === "POST") {
    await startPromaxPickupMonitor({ runImmediately: true });
    return sendJson(res, 200, getPromaxPickupStatus());
  }
  if (pathname === "/api/promax-pickup/stop" && req.method === "POST") {
    stopPromaxPickupMonitor();
    return sendJson(res, 200, getPromaxPickupStatus());
  }

  if (pathname === "/api/snapshot" && req.method === "GET") {
    return sendJson(res, 200, await snapshot());
  }
  if (pathname === "/api/config" && req.method === "GET") {
    return sendJson(res, 200, lastFormConfig);
  }

  /** Proxy 池：Save 後 Launch／Add 先用；空＝本機 IP */
  if (pathname === "/api/proxy-pool" && req.method === "GET") {
    const proxy = String(lastFormConfig.proxy || "");
    const count = parseProxyPool(proxy).length;
    const banned = await loadProxyBlacklist();
    return sendJson(res, 200, {
      ok: true,
      proxy,
      count,
      banned: banned.size,
      mode: count > 0 ? "proxy" : "local",
    });
  }

  if (pathname === "/api/proxy-pool" && req.method === "POST") {
    let body: { proxy?: string } = {};
    try {
      body = JSON.parse(await readBody(req)) as typeof body;
    } catch {
      return sendJson(res, 400, { ok: false, error: "invalid JSON" });
    }
    const proxy = String(body.proxy ?? "").replace(/^\s+|\s+$/g, "");
    lastFormConfig = { ...lastFormConfig, proxy };
    await ensureRuntimeDir();
    await fs
      .writeFile(path.join(RUNTIME_DIR, "proxy-pool.txt"), proxy, "utf8")
      .catch(() => {});
    const count = parseProxyPool(proxy).length;
    const banned = await loadProxyBlacklist();
    console.log(
      count > 0
        ? `[proxy] pool saved：${count} 條`
        : `[proxy] pool cleared → 本機 IP`
    );
    broadcast({ type: "status", state: await snapshot() });
    return sendJson(res, 200, {
      ok: true,
      proxy,
      count,
      banned: banned.size,
      mode: count > 0 ? "proxy" : "local",
    });
  }

  /** 清 proxy 黑名單，令已 Save 嘅 IP 可以再分配畀新 task */
  if (pathname === "/api/proxy-pool/reset" && req.method === "POST") {
    const cleared = await clearProxyBlacklist();
    const proxy = String(lastFormConfig.proxy || "");
    const count = parseProxyPool(proxy).length;
    broadcast({ type: "status", state: await snapshot() });
    return sendJson(res, 200, {
      ok: true,
      cleared,
      proxy,
      count,
      banned: 0,
      mode: count > 0 ? "proxy" : "local",
    });
  }

  /** 監控專用 Proxy 池（同結帳分開） */
  if (pathname === "/api/monitor-proxy-pool" && req.method === "GET") {
    const st = getMonitorProxyStatus();
    return sendJson(res, 200, {
      ok: true,
      ...st,
      proxy: getMonitorProxyPoolText(),
    });
  }

  if (pathname === "/api/monitor-proxy-pool" && req.method === "POST") {
    let body: { proxy?: string } = {};
    try {
      body = JSON.parse(await readBody(req)) as typeof body;
    } catch {
      return sendJson(res, 400, { ok: false, error: "invalid JSON" });
    }
    const proxy = String(body.proxy ?? "").replace(/^\s+|\s+$/g, "");
    await ensureRuntimeDir();
    await fs
      .writeFile(path.join(RUNTIME_DIR, "monitor-proxy-pool.txt"), proxy, "utf8")
      .catch(() => {});
    const { count } = setMonitorProxyPool(proxy);
    clearPromaxEdgeCooldown();
    const st = getMonitorProxyStatus();
    console.log(
      count > 0
        ? `[promax-proxy] pool saved：${count} 條`
        : `[promax-proxy] pool cleared → 本機 IP`
    );
    broadcast({ type: "status", state: await snapshot() });
    return sendJson(res, 200, {
      ok: true,
      proxy,
      count,
      banned: st.banned,
      mode: st.mode,
      active: st.active,
    });
  }
  if (pathname === "/api/orders" && req.method === "GET") {
    return sendJson(res, 200, await collectOrders());
  }
  if (pathname === "/api/card-limits" && req.method === "GET") {
    return sendJson(res, 200, await getLiveCardLimits(ROOT, await collectOrders(), await loadVaultLimitsMap()));
  }

  /** Checkout 信用卡池：加密存檔；只回 masked／統計 */
  if (pathname === "/api/checkout-cards" && req.method === "GET") {
    const cards = await loadCardVault(CHECKOUT_CARDS_ENC, ADD_ORDER_KEY);
    const state = await loadCardVaultState(CHECKOUT_CARDS_STATE);
    return sendJson(res, 200, {
      ok: true,
      summary: summarizeVault(cards, state),
      rows: maskedRows(cards, state),
    });
  }

  if (pathname === "/api/checkout-cards" && req.method === "POST") {
    let body: { text?: string; replace?: boolean } = {};
    try {
      body = JSON.parse(await readBody(req)) as typeof body;
    } catch {
      return sendJson(res, 400, { ok: false, error: "invalid JSON" });
    }
    const result = await upsertCardsFromText({
      encPath: CHECKOUT_CARDS_ENC,
      keyPath: ADD_ORDER_KEY,
      statePath: CHECKOUT_CARDS_STATE,
      text: String(body.text || ""),
      replace: Boolean(body.replace),
    });
    if (!result.ok) return sendJson(res, 400, result);
    const cards = await loadCardVault(CHECKOUT_CARDS_ENC, ADD_ORDER_KEY);
    await seedCardLimitsIfNeeded(
      ROOT,
      cards.map((c) => ({ number: c.number, limit: c.limit }))
    ).catch(() => 0);
    const state = await loadCardVaultState(CHECKOUT_CARDS_STATE);
    return sendJson(res, 200, {
      ...result,
      summary: summarizeVault(cards, state),
      rows: maskedRows(cards, state),
    });
  }

  if (pathname === "/api/checkout-cards/remove" && req.method === "POST") {
    let body: { ids?: string[] } = {};
    try {
      body = JSON.parse(await readBody(req)) as typeof body;
    } catch {
      return sendJson(res, 400, { ok: false, error: "invalid JSON" });
    }
    const result = await removeCardsByIds({
      encPath: CHECKOUT_CARDS_ENC,
      keyPath: ADD_ORDER_KEY,
      statePath: CHECKOUT_CARDS_STATE,
      ids: Array.isArray(body.ids) ? body.ids : [],
    });
    if (!result.ok) return sendJson(res, 400, result);
    const cards = await loadCardVault(CHECKOUT_CARDS_ENC, ADD_ORDER_KEY);
    const state = await loadCardVaultState(CHECKOUT_CARDS_STATE);
    return sendJson(res, 200, {
      ...result,
      summary: summarizeVault(cards, state),
      rows: maskedRows(cards, state),
    });
  }

  /** Live card limits → 複製 email:password:order（密碼由本機加密檔讀出） */
  if (pathname === "/api/live-card-limits/copy-info" && req.method === "POST") {
    let body: { rows?: Array<{ email?: string; orderNumber?: string }> } = {};
    try {
      body = JSON.parse(await readBody(req)) as typeof body;
    } catch {
      return sendJson(res, 400, { ok: false, error: "invalid JSON" });
    }
    const rows = Array.isArray(body.rows) ? body.rows : [];
    const password = await loadGmailCopyPassword(
      GMAIL_COPY_PASSWORD_ENC,
      ADD_ORDER_KEY,
      GMAIL_COPY_PASSWORD_BOOTSTRAP
    );
    if (!password) {
      return sendJson(res, 500, { ok: false, error: "缺少加密 Gmail 密碼檔" });
    }
    const lines: string[] = [];
    const seen = new Set<string>();
    for (const r of rows) {
      const email = String(r?.email || "").trim();
      const orderNumber = String(r?.orderNumber || "").trim();
      if (!email || email === "—" || !orderNumber || orderNumber === "—") continue;
      if (!email.includes("@")) continue;
      const key = `${email.toLowerCase()}|||${orderNumber}`;
      if (seen.has(key)) continue;
      seen.add(key);
      lines.push(`${email}:${password}:${orderNumber}`);
    }
    if (!lines.length) {
      return sendJson(res, 400, { ok: false, error: "未有有效選取列（需要 email + order number）" });
    }
    return sendJson(res, 200, {
      ok: true,
      count: lines.length,
      text: lines.join("\n"),
    });
  }

  if (pathname === "/api/orders/export-google-sheet" && req.method === "POST") {
    try {
      await ensureRuntimeDir();
      const result = await exportOrdersToGoogleSheet({
        orders: await collectOrders(),
        runtimeDir: RUNTIME_DIR,
      });
      if (!result.ok) return sendJson(res, 400, result);
      return sendJson(res, 200, result);
    } catch (err) {
      return sendJson(res, 500, {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (pathname === "/api/events" && req.method === "GET") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write(
      `data: ${JSON.stringify({
        type: "hello",
        buildId: DASHBOARD_BUILD_ID,
        state: await snapshot(),
      })}\n\n`
    );
    sseClients.add(res);
    req.on("close", () => sseClients.delete(res));
    return;
  }

  if (pathname === "/api/build-id" && req.method === "GET") {
    return sendJson(res, 200, { ok: true, buildId: DASHBOARD_BUILD_ID });
  }

  if ((pathname === "/api/run" || pathname === "/api/browsers/add") && req.method === "POST") {
    try {
      const raw = await readBody(req);
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      const config = { ...defaultConfig(), ...lastFormConfig, ...body };
      const count =
        pathname === "/api/browsers/add"
          ? Number(body.count ?? 1)
          : Number(body.browserCount ?? (config as { browserCount?: number }).browserCount ?? 1);
      await launchBrowsers(config, count);
      return sendJson(res, 200, { ok: true, state: await snapshot() });
    } catch (err) {
      return sendJson(res, 400, {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (pathname === "/api/monitor/restock-history" && req.method === "GET") {
    return sendJson(res, 200, {
      ok: true,
      updatedAt: new Date().toISOString(),
      events: await readRestockHistory(200),
    });
  }

  if (pathname === "/api/stop" && req.method === "POST") {
    await stopAll();
    return sendJson(res, 200, { ok: true, state: await snapshot() });
  }

  if (pathname === "/api/close-all" && req.method === "POST") {
    await closeAll();
    return sendJson(res, 200, { ok: true, state: await snapshot() });
  }

  if (pathname === "/api/clear-all" && req.method === "POST") {
    await closeAll();
    return sendJson(res, 200, { ok: true, state: await snapshot() });
  }

  const stopOne = pathname.match(/^\/api\/browsers\/([^/]+)\/stop$/);
  if (stopOne && req.method === "POST") {
    const raw = await readBody(req).catch(() => "");
    let mode: "release" | "force" = "release";
    try {
      if (raw) mode = (JSON.parse(raw) as { mode?: "release" | "force" }).mode || "release";
    } catch {
      mode = "release";
    }
    await stopSession(decodeURIComponent(stopOne[1]!), mode);
    return sendJson(res, 200, { ok: true, state: await snapshot() });
  }

  const closeOne = pathname.match(/^\/api\/browsers\/([^/]+)\/close$/);
  if (closeOne && req.method === "POST") {
    await stopSession(normalizeBrowserId(decodeURIComponent(closeOne[1]!)), "force");
    return sendJson(res, 200, { ok: true, state: await snapshot() });
  }

  const continueOne = pathname.match(/^\/api\/browsers\/([^/]+)\/continue$/);
  if (continueOne && req.method === "POST") {
    await ensureRuntimeDir();
    const id = decodeURIComponent(continueOne[1]!);
    // Continue 恢復步驟：清走 release，避免即刻又被 Stop 狀態卡住
    await fs.unlink(path.join(RUNTIME_DIR, `release-${id}.flag`)).catch(() => {});
    await fs.writeFile(
      path.join(RUNTIME_DIR, `continue-${id}.flag`),
      new Date().toISOString(),
      "utf8"
    );
    const stPath = path.join(RUNTIME_DIR, `status-${id}.json`);
    try {
      const prev = JSON.parse(await fs.readFile(stPath, "utf8")) as Record<string, unknown>;
      await fs.writeFile(
        stPath,
        JSON.stringify(
          {
            ...prev,
            phase: "resuming",
            message: "Dashboard Continue：繼續自動化",
            updatedAt: new Date().toISOString(),
          },
          null,
          2
        ),
        "utf8"
      );
    } catch {
      /* ignore */
    }
    return sendJson(res, 200, { ok: true, state: await snapshot() });
  }

  const showOne = pathname.match(/^\/api\/browsers\/([^/]+)\/show$/);
  if (showOne && req.method === "POST") {
    await ensureRuntimeDir();
    const id = decodeURIComponent(showOne[1]!);
    await fs.writeFile(
      path.join(RUNTIME_DIR, `show-${id}.flag`),
      new Date().toISOString(),
      "utf8"
    );
    await fs.unlink(path.join(RUNTIME_DIR, `hide-${id}.flag`)).catch(() => {});
    // 即刻標示未 hidden，等 script 還原視窗並置頂
    const stPath = path.join(RUNTIME_DIR, `status-${id}.json`);
    try {
      const prev = JSON.parse(await fs.readFile(stPath, "utf8")) as Record<string, unknown>;
      await fs.writeFile(
        stPath,
        JSON.stringify(
          {
            ...prev,
            windowHidden: false,
            windowState: "maximized",
            keepOpen: true,
            message: "Open browser requested — bringing to front",
            updatedAt: new Date().toISOString(),
          },
          null,
          2
        ),
        "utf8"
      );
    } catch {
      /* ignore */
    }
    return sendJson(res, 200, { ok: true, state: await snapshot() });
  }

  const hideOne = pathname.match(/^\/api\/browsers\/([^/]+)\/hide$/);
  if (hideOne && req.method === "POST") {
    await ensureRuntimeDir();
    const id = decodeURIComponent(hideOne[1]!);
    await fs.writeFile(
      path.join(RUNTIME_DIR, `hide-${id}.flag`),
      new Date().toISOString(),
      "utf8"
    );
    await fs.unlink(path.join(RUNTIME_DIR, `show-${id}.flag`)).catch(() => {});
    const stPath = path.join(RUNTIME_DIR, `status-${id}.json`);
    try {
      const prev = JSON.parse(await fs.readFile(stPath, "utf8")) as Record<string, unknown>;
      await fs.writeFile(
        stPath,
        JSON.stringify(
          {
            ...prev,
            windowHidden: true,
            windowState: "minimized",
            keepOpen: false,
            message: "Hide requested — minimizing",
            updatedAt: new Date().toISOString(),
          },
          null,
          2
        ),
        "utf8"
      );
    } catch {
      /* ignore */
    }
    return sendJson(res, 200, { ok: true, state: await snapshot() });
  }

  if (pathname === "/api/continue" && req.method === "POST") {
    await fs.writeFile(CONTINUE_ALL_FLAG, new Date().toISOString(), "utf8");
    // also poke each waiting session
    await ensureRuntimeDir();
    for (const s of sessions.values()) {
      await fs.writeFile(
        path.join(RUNTIME_DIR, `continue-${s.id}.flag`),
        new Date().toISOString(),
        "utf8"
      );
    }
    return sendJson(res, 200, { ok: true });
  }

  if (pathname === "/api/add-order-apple-ac/status" && req.method === "GET") {
    const tasks = await snapshotAddOrderTasks();
    const anyRunning = tasks.some((t) => t.running);
    const allLogs = [...addOrderTasks.values()].flatMap((t) =>
      t.logs.slice(-40).map((line) => redactSecrets(line))
    );
    return sendJson(res, 200, {
      ok: true,
      running: anyRunning,
      tasks,
      logs: allLogs.slice(-400),
      lastExitCode: anyRunning
        ? null
        : [...addOrderTasks.values()].at(-1)?.exitCode ?? null,
    });
  }

  if (pathname === "/api/add-order-apple-ac/logs/clear" && req.method === "POST") {
    for (const t of addOrderTasks.values()) {
      t.logs = [];
    }
    void broadcastAddOrderStatus();
    return sendJson(res, 200, { ok: true, logs: [] });
  }

  if (pathname === "/api/add-order-apple-ac/accounts" && req.method === "GET") {
    await ensureRuntimeDir();
    let text = "";
    try {
      text = await decryptFromFile(GMAIL_ACCOUNTS_ENC, ADD_ORDER_KEY);
    } catch {
      try {
        text = await fs.readFile(GMAIL_ACCOUNTS_LEGACY, "utf8");
        if (text.trim()) {
          await encryptToFile(GMAIL_ACCOUNTS_ENC, ADD_ORDER_KEY, text);
        }
        await secureWipeFile(GMAIL_ACCOUNTS_LEGACY);
      } catch {
        text = "";
      }
    }
    return sendJson(res, 200, { ok: true, text });
  }

  if (pathname === "/api/add-order-apple-ac/accounts/save" && req.method === "POST") {
    await ensureRuntimeDir();
    let body: { text?: string } = {};
    try {
      body = JSON.parse(await readBody(req)) as typeof body;
    } catch {
      return sendJson(res, 400, { ok: false, error: "invalid JSON" });
    }
    const text = String(body.text ?? "");
    await encryptToFile(GMAIL_ACCOUNTS_ENC, ADD_ORDER_KEY, text);
    await secureWipeFile(GMAIL_ACCOUNTS_LEGACY);
    return sendJson(res, 200, { ok: true, encrypted: true });
  }

  if (pathname === "/api/add-order-apple-ac/accounts/clear" && req.method === "POST") {
    await ensureRuntimeDir();
    // Clear Gmail／active tasks；保留 Finished（唔 forceClose、唔刪 status／archive）
    for (const id of [...addOrderTasks.keys()]) {
      const st = await readAddOrderStatus(id);
      if (st && isAddOrderFinishedPhase(st.phase)) {
        await archiveFinishedAddOrderTask(id, st).catch(() => {});
        continue;
      }
      await forceCloseAddOrderTask(id);
    }
    // 只移除非 Finished 出 map；Finished 留低
    for (const id of [...addOrderTasks.keys()]) {
      const st = await readAddOrderStatus(id);
      if (!st || !isAddOrderFinishedPhase(st.phase)) {
        addOrderTasks.delete(id);
      }
    }
    await secureWipeFile(GMAIL_ACCOUNTS_ENC);
    await secureWipeFile(GMAIL_ACCOUNTS_LEGACY);
    await secureWipeFile(ADD_ORDER_JOB_ENC);
    await secureWipeFile(ADD_ORDER_JOB_LEGACY);
    await secureWipeFile(ADD_ORDER_STOP_FLAG);
    // 換 key 前保留送貨地址／Gmail 複製密碼於記憶體，換完再加密寫返
    let shippingPlain = "";
    let gmailCopyPwd = "";
    let checkoutCardsPlain = "";
    try {
      shippingPlain = await decryptFromFile(SHIPPING_ENC, ADD_ORDER_KEY);
    } catch {
      shippingPlain = "";
    }
    try {
      gmailCopyPwd = await loadGmailCopyPassword(
        GMAIL_COPY_PASSWORD_ENC,
        ADD_ORDER_KEY,
        GMAIL_COPY_PASSWORD_BOOTSTRAP
      );
    } catch {
      gmailCopyPwd = "";
    }
    try {
      checkoutCardsPlain = await decryptFromFile(CHECKOUT_CARDS_ENC, ADD_ORDER_KEY);
    } catch {
      checkoutCardsPlain = "";
    }
    await rotateKey(ADD_ORDER_KEY);
    if (shippingPlain) {
      await encryptToFile(SHIPPING_ENC, ADD_ORDER_KEY, shippingPlain).catch(() => {});
    } else {
      await loadShippingAddress(SHIPPING_ENC, ADD_ORDER_KEY).catch(() => {});
    }
    if (gmailCopyPwd) {
      await encryptToFile(GMAIL_COPY_PASSWORD_ENC, ADD_ORDER_KEY, gmailCopyPwd).catch(() => {});
    }
    if (checkoutCardsPlain) {
      await encryptToFile(CHECKOUT_CARDS_ENC, ADD_ORDER_KEY, checkoutCardsPlain).catch(() => {});
    }
    // Finished status 內 shippingEnc 要用新 key 重加密
    for (const id of [...addOrderTasks.keys()]) {
      const st = await readAddOrderStatus(id);
      if (!st || !isAddOrderFinishedPhase(st.phase)) continue;
      try {
        const ship = shippingPlain
          ? (JSON.parse(shippingPlain) as ShippingAddress)
          : await loadShippingAddress(SHIPPING_ENC, ADD_ORDER_KEY);
        const blob = await encryptToBlob(ADD_ORDER_KEY, JSON.stringify(ship));
        const next: Record<string, unknown> = { ...st, shippingEnc: blob, shippingMasked: true };
        delete next.shipping;
        await fs.writeFile(
          path.join(RUNTIME_DIR, `status-${id}.json`),
          JSON.stringify(next, null, 2),
          "utf8"
        );
        await archiveFinishedAddOrderTask(id, next);
      } catch {
        /* ignore */
      }
    }
    return sendJson(res, 200, {
      ok: true,
      cleared: [
        "ui",
        "active-tasks",
        "gmail-accounts.enc",
        "logs",
        "key-rotated",
      ],
      kept: "finished-tasks+shipping-enc",
      tasks: await snapshotAddOrderTasks(),
    });
  }

  if (pathname === "/api/add-order-apple-ac/stop" && req.method === "POST") {
    await ensureRuntimeDir();
    // 只停自動化，唔關瀏覽器
    for (const t of addOrderTasks.values()) {
      stopAddOrderAutomation(t.id);
      t.logs.push(`[dashboard] stop automation @ ${new Date().toISOString()}`);
    }
    return sendJson(res, 200, {
      ok: true,
      tasks: await snapshotAddOrderTasks(),
    });
  }

  const aoAct = pathname.match(
    /^\/api\/add-order-apple-ac\/tasks\/([^/]+)\/(show|hide|stop|continue|close)$/
  );
  if (aoAct && req.method === "POST") {
    await ensureRuntimeDir();
    const id = decodeURIComponent(aoAct[1]!);
    const act = aoAct[2]!;
    const flagMap: Record<string, string> = {
      show: `show-${id}.flag`,
      hide: `hide-${id}.flag`,
      stop: `release-${id}.flag`,
      continue: `continue-${id}.flag`,
      close: `close-${id}.flag`,
    };
    const flagName = flagMap[act];
    if (!flagName) return sendJson(res, 400, { ok: false, error: "bad act" });
    const payload =
      act === "stop"
        ? `takeover\n${new Date().toISOString()}`
        : new Date().toISOString();
    await fs.writeFile(path.join(RUNTIME_DIR, flagName), payload, "utf8");
    if (act === "show") {
      // 即刻寫 keepopen，worker 就算慢啲都會拒絕 auto-minimize／自動關窗
      await fs.writeFile(
        path.join(RUNTIME_DIR, `keepopen-${id}.flag`),
        new Date().toISOString(),
        "utf8"
      );
      await fs.unlink(path.join(RUNTIME_DIR, `hide-${id}.flag`)).catch(() => {});
      try {
        const stPath = path.join(RUNTIME_DIR, `status-${id}.json`);
        const prev = JSON.parse(await fs.readFile(stPath, "utf8")) as Record<string, unknown>;
        const prevPhase = String(prev.phase || "");
        const keepFinished = /^(finished|steps_complete|shipping_saved)$/i.test(prevPhase);
        await fs.writeFile(
          stPath,
          JSON.stringify(
            {
              ...prev,
              windowHidden: false,
              windowState: "maximized",
              keepOpen: true,
              // Finished task 開窗唔改 phase
              ...(keepFinished ? { phase: "finished" } : {}),
              message: keepFinished
                ? String(prev.message || "Finished — browser kept open until Hide/Close")
                : "Open browser requested — kept open until Hide/Close",
              updatedAt: new Date().toISOString(),
            },
            null,
            2
          ),
          "utf8"
        );
      } catch {
        /* ignore */
      }
    }
    if (act === "hide") {
      await fs.unlink(path.join(RUNTIME_DIR, `keepopen-${id}.flag`)).catch(() => {});
    }
    if (act === "close") {
      await fs.unlink(path.join(RUNTIME_DIR, `keepopen-${id}.flag`)).catch(() => {});
      await forceCloseAddOrderTask(id);
    }
    void broadcastAddOrderStatus();
    return sendJson(res, 200, {
      ok: true,
      tasks: await snapshotAddOrderTasks(),
    });
  }

  if (pathname === "/api/add-order-apple-ac/start" && req.method === "POST") {
    let body: {
      accounts?: Array<{ email?: string; password?: string; orderNumber?: string }>;
      appleEmail?: string;
      applePassword?: string;
    } = {};
    try {
      body = JSON.parse(await readBody(req)) as typeof body;
    } catch {
      return sendJson(res, 400, { ok: false, error: "invalid JSON" });
    }
    const accounts = (body.accounts || [])
      .map((a) => ({
        email: String(a?.email || "").trim(),
        password: String(a?.password || ""),
        orderNumber: String(a?.orderNumber || "").trim(),
      }))
      .filter((a) => a.email && a.password && a.orderNumber);
    if (!accounts.length) {
      return sendJson(res, 400, {
        ok: false,
        error: "需要至少一個帳號：email:password:order number",
      });
    }
    const appleEmail = String(body.appleEmail || "chifung2010@yahoo.com.hk").trim();
    const applePassword = String(body.applePassword || "yY6594083");
    if (!appleEmail || !applePassword) {
      return sendJson(res, 400, { ok: false, error: "需要 Apple ID email + password" });
    }

    await ensureRuntimeDir();
    await encryptToFile(
      ADD_ORDER_JOB_ENC,
      ADD_ORDER_KEY,
      JSON.stringify({ accounts, appleEmail, applePassword })
    );
    await secureWipeFile(ADD_ORDER_JOB_LEGACY);

    const tsxCli = path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
    const script = path.join(ROOT, "src", "add-order-to-apple-ac.ts");
    const created: string[] = [];

    for (let i = 0; i < accounts.length; i++) {
      const id = `ao${addOrderNextIndex++}`;
      const emailMasked = maskEmail(accounts[i]!.email);
      const orderNumber = accounts[i]!.orderNumber;
      const task: AddOrderTask = {
        id,
        emailMasked,
        orderNumber,
        index: i,
        pid: null,
        running: true,
        startedAt: new Date().toISOString(),
        logs: [`[dashboard] start ${id} · ${emailMasked} · ${orderNumber}`],
        child: null,
        exitCode: null,
      };
      addOrderTasks.set(id, task);

      for (const f of [
        `release-${id}.flag`,
        `close-${id}.flag`,
        `continue-${id}.flag`,
        `show-${id}.flag`,
        `hide-${id}.flag`,
        `keepopen-${id}.flag`,
      ]) {
        await fs.unlink(path.join(RUNTIME_DIR, f)).catch(() => {});
      }

      const proc = spawn(process.execPath, [tsxCli, script], {
        cwd: ROOT,
        env: envForCheckoutChild({
          ADD_ORDER_JOB_ENC: ADD_ORDER_JOB_ENC,
          ADD_ORDER_KEY_PATH: ADD_ORDER_KEY,
          ADD_ORDER_SESSION_ID: id,
          ADD_ORDER_ACCOUNT_INDEX: String(i),
          ADD_ORDER_WINDOW_TOTAL: String(accounts.length),
        }),
        stdio: ["ignore", "pipe", "pipe"],
      });
      task.child = proc;
      task.pid = proc.pid ?? null;

      const pushLog = (buf: Buffer) => {
        const text = buf.toString("utf8");
        for (const line of text.split(/\r?\n/)) {
          if (!line.trim()) continue;
          task.logs.push(redactSecrets(line));
          if (task.logs.length > 300) task.logs.splice(0, task.logs.length - 300);
        }
        void broadcastAddOrderStatus();
      };
      proc.stdout?.on("data", pushLog);
      proc.stderr?.on("data", pushLog);
      proc.on("exit", (code) => {
        task.running = false;
        task.exitCode = code ?? 1;
        task.child = null;
        task.pid = null;
        task.logs.push(`[dashboard] ${id} exit=${code}`);
        void broadcastAddOrderStatus();
      });
      created.push(id);
      await new Promise((r) => setTimeout(r, 200));
    }

    void broadcastAddOrderStatus();
    return sendJson(res, 200, {
      ok: true,
      created,
      tasks: await snapshotAddOrderTasks(),
    });
  }

  sendJson(res, 404, { error: "not found" });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    if (url.pathname.startsWith("/api/")) {
      await handleApi(req, res);
      return;
    }
    let filePath = path.join(PUBLIC, url.pathname === "/" ? "index.html" : url.pathname);
    if (!filePath.startsWith(PUBLIC)) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }
    if (!existsSync(filePath)) filePath = path.join(PUBLIC, "index.html");
    res.writeHead(200, {
      "Content-Type": contentType(filePath),
      "Cache-Control": "no-store, no-cache, must-revalidate",
      Pragma: "no-cache",
    });
    createReadStream(filePath).pipe(res);
  } catch (err) {
    res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(err instanceof Error ? err.message : String(err));
  }
});

server.listen(PORT, "127.0.0.1", () => {
  startLiveReloadWatcher();
  void (async () => {
    try {
      const savedProxy = await fs.readFile(
        path.join(RUNTIME_DIR, "proxy-pool.txt"),
        "utf8"
      );
      lastFormConfig = {
        ...lastFormConfig,
        proxy: String(savedProxy || "").replace(/^\s+|\s+$/g, ""),
      };
    } catch {
      /* no saved pool */
    }
    try {
      const monProxy = await fs.readFile(
        path.join(RUNTIME_DIR, "monitor-proxy-pool.txt"),
        "utf8"
      );
      setMonitorProxyPool(String(monProxy || "").replace(/^\s+|\s+$/g, ""));
    } catch {
      /* no monitor proxy pool */
    }
    await recoverCheckoutSessionsFromDisk().catch(() => {});
    await refreshNextIndexFromDisk();
    // 獨立 Pro Max 門市庫存監控（失敗唔影響 dashboard）；有貨變化 → Live 補貨紀錄
    setPromaxPickupHooks({
      onPollComplete: async (_status, events) => {
        if (events.length) {
          broadcast({ type: "status", state: await snapshot() });
        }
      },
    });
    startPromaxPickupMonitor({ runImmediately: true }).catch((err) => {
      console.warn(
        `[promax-pickup] auto-start failed：${err instanceof Error ? err.message : String(err)}`
      );
    });
    console.log(
      `Checkout dashboard → http://127.0.0.1:${PORT} (next browser id b${nextIndex + 1}) [live-reload build=${DASHBOARD_BUILD_ID}]`
    );
  })();
});

// tsx watch／script 更新：唔好 stopAll／關 browser；只退 server，browser 保持 Hide 繼續跑
function exitLeavingBrowsers(signal: string) {
  console.log(
    `[dashboard] ${signal} — leaving Opened / waiting-payment browsers running (hidden)`
  );
  process.exit(0);
}
process.on("SIGINT", () => exitLeavingBrowsers("SIGINT"));
process.on("SIGTERM", () => exitLeavingBrowsers("SIGTERM"));

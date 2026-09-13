/**
 * Apple checkout control dashboard (multi-browser).
 * Run: npm run dashboard  →  http://127.0.0.1:8787
 */
import http from "node:http";
import fs from "node:fs/promises";
import { createReadStream, existsSync, watch as fsWatch } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcess } from "node:child_process";
import { exportOrdersToGoogleSheet } from "./export-google-sheet.js";
import {
  getLiveCardLimits,
  lookupCardMeta,
  peekCardLimitInfo,
  resolveOrderAmountSpent,
} from "./credit-card-pool.js";
import {
  fulfillmentLabelFromPreference,
  resolveDeliveryMethodLabel,
} from "./fulfillment-label.js";
import {
  decryptFromFile,
  encryptToFile,
  redactSecrets,
  rotateKey,
  secureWipeFile,
} from "./add-order-secrets.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC = path.join(ROOT, "dashboard");
const RUNTIME_DIR = path.join(ROOT, "runtime");
const RUNTIME_CONFIG = path.join(ROOT, "runtime-config.json");
const ORDERS_FILE = path.join(ROOT, "order-summary.json");
const CONTINUE_ALL_FLAG = path.join(ROOT, "dashboard-continue.flag");
const PROXY_BLACKLIST_FILE = path.join(RUNTIME_DIR, "proxy-blacklist.json");
const GMAIL_ACCOUNTS_ENC = path.join(RUNTIME_DIR, "gmail-accounts.enc");
const GMAIL_ACCOUNTS_LEGACY = path.join(RUNTIME_DIR, "gmail-accounts-saved.txt");
const ADD_ORDER_KEY = path.join(RUNTIME_DIR, ".add-order-key");
const ADD_ORDER_JOB_ENC = path.join(RUNTIME_DIR, "add-order-job.enc");
const ADD_ORDER_JOB_LEGACY = path.join(RUNTIME_DIR, "add-order-apple-ac.json");
const ADD_ORDER_STOP_FLAG = path.join(RUNTIME_DIR, "add-order-stop.flag");
const PORT = Number(process.env.DASHBOARD_PORT || 8787);
/** 每次 server 啟動／tsx watch 重載都會變 → 瀏覽器自動 refresh */
const DASHBOARD_BUILD_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

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

type MonitorState = {
  running: boolean;
  pid: number | null;
  startedAt: string | null;
  autoBuy: boolean;
  logs: string[];
  child: ChildProcess | null;
};

const monitorState: MonitorState = {
  running: false,
  pid: null,
  startedAt: null,
  autoBuy: false,
  logs: [],
  child: null,
};

type AddOrderJobState = {
  running: boolean;
  pid: number | null;
  startedAt: string | null;
  lastExitCode: number | null;
  logs: string[];
  child: ChildProcess | null;
};

const addOrderJob: AddOrderJobState = {
  running: false,
  pid: null,
  startedAt: null,
  lastExitCode: null,
  logs: [],
  child: null,
};

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

/** 改 dashboard 靜態檔即推 reload；tsx watch 重啟 server 則靠 buildId */
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
    });
  }
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

/** 每個新 task 隨機揀一個未禁用、盡量未用緊嘅 proxy */
async function pickProxyForNewTask(poolRaw: unknown): Promise<string> {
  const pool = parseProxyPool(poolRaw);
  if (!pool.length) return "";
  const banned = await loadProxyBlacklist();
  const inUse = new Set<string>();
  for (const s of sessions.values()) {
    if (!s.running) continue;
    const p = normalizeProxyKey(String(s.config?.proxy || ""));
    if (p) inUse.add(p);
  }
  const available = pool.filter((p) => !banned.has(normalizeProxyKey(p)));
  const preferred = available.filter((p) => !inUse.has(normalizeProxyKey(p)));
  const candidates = preferred.length ? preferred : available;
  if (!candidates.length) {
    console.warn("[proxy] 池入面可用 proxy 已用盡／全被禁用，呢個 task 改用本機 IP");
    return "";
  }
  return candidates[Math.floor(Math.random() * candidates.length)]!;
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
      await fs.writeFile(
        stPath,
        JSON.stringify(
          {
            ...prev,
            phase: "stop_requested",
            message: opts?.silent
              ? "Dashboard Stop all（保持原本視窗位置）"
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
        if (st?.phase === "manual_control" || !session.running) {
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
  const sessionConfig = { ...cleanConfig, browserCount: 1 };
  // 多個 proxy：每個新 task 隨機揀一個（失敗會入黑名單，之後唔再用）
  const assignedProxy = await pickProxyForNewTask(cleanConfig.proxy);
  sessionConfig.proxy = assignedProxy;
  if (assignedProxy) {
    console.log(`[proxy] ${id} 分配：${assignedProxy}`);
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

  const tsxCli = path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
  const script = path.join(ROOT, "src", "buy-iphone-17.ts");
  const proc = spawn(process.execPath, [tsxCli, script], {
    cwd: ROOT,
    env: envForCheckoutChild({
      CHECKOUT_DASHBOARD: "1",
      CHECKOUT_CONFIG_PATH: configPath,
      CHECKOUT_SESSION_ID: id,
      CHECKOUT_WINDOW_INDEX: String(index),
      CHECKOUT_WINDOW_TOTAL: String(windowTotal),
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  session.child = proc;
  session.pid = proc.pid ?? null;
  await writeInitialOpenedBrowserStatus(id, sessionConfig, session.pid);
  pushSessionLog(
    session,
    `[dashboard] 已啟動 pid=${session.pid} windowIndex=${index}/${windowTotal}`
  );

  proc.stdout?.setEncoding("utf8");
  proc.stderr?.setEncoding("utf8");
  proc.stdout?.on("data", (chunk: string | Buffer) => {
    for (const line of String(chunk).split("\n")) pushSessionLog(session, line);
  });
  proc.stderr?.on("data", (chunk: string | Buffer) => {
    for (const line of String(chunk).split("\n")) pushSessionLog(session, line);
  });
  proc.on("exit", async (code) => {
    session.running = false;
    session.exitCode = code;
    session.pid = null;
    session.child = null;
    pushSessionLog(session, `[dashboard] 進程結束 exit=${code}`);
    // 用咗 proxy 但未成功付款／落單 → 加入黑名單，之後唔再分配
    const usedProxy = String(session.config?.proxy || "").trim();
    if (usedProxy) {
      const paid = await isPaidBrowserSession(session.id);
      const st = await readSessionStatus(session.id);
      const phase = String(st?.phase || "");
      const failed =
        !paid &&
        (code !== 0 || /error|fail/i.test(phase));
      if (failed) {
        await blacklistProxy(
          usedProxy,
          `session=${session.id} exit=${code} phase=${phase || "—"}`
        ).catch(() => {});
      }
    }
    broadcast({ type: "status", state: await snapshot() });
  });

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

async function pushMonitorLog(line: string) {
  const text = line.replace(/\r/g, "");
  if (!text.trim()) return;
  const tagged = text.startsWith("[monitor]") ? text : `[monitor] ${text}`;
  monitorState.logs.push(tagged);
  if (monitorState.logs.length > 300) monitorState.logs.splice(0, monitorState.logs.length - 300);
  broadcast({ type: "monitor_log", line: tagged, at: new Date().toISOString() });
}

async function stopStockMonitor() {
  const child = monitorState.child;
  const pid = monitorState.pid ?? child?.pid ?? null;
  if (child) {
    killProc(child);
    monitorState.child = null;
  } else if (pid) {
    spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", shell: true });
  }
  monitorState.running = false;
  monitorState.pid = null;
  monitorState.startedAt = null;
  monitorState.autoBuy = false;
  await pushMonitorLog("監察已停止");
  broadcast({ type: "status", state: await snapshot() });
}

async function startStockMonitor(opts?: {
  quantity?: number;
  fulfillmentPreference?: string;
  pickupSearch?: string;
  autoBuy?: boolean;
}) {
  if (monitorState.running && monitorState.child) {
    throw new Error("庫存監察已在運行；請先 Stop monitor");
  }
  await ensureRuntimeDir();
  await fs.unlink(path.join(RUNTIME_DIR, "stop-all.flag")).catch(() => {});
  await fs.unlink(path.join(RUNTIME_DIR, "stock-resume-all.flag")).catch(() => {});

  const tsxCli = path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
  const script = path.join(ROOT, "src", "stock-monitor", "monitor.ts");
  const quantity = Math.max(1, Number(opts?.quantity) || Number(lastFormConfig.quantity) || 2);
  const fulfillment =
    opts?.fulfillmentPreference ||
    String(lastFormConfig.fulfillmentPreference || "pickup");
  const pickupSearch =
    opts?.pickupSearch || String(lastFormConfig.pickupSearch || "中環");
  const autoBuy = Boolean(opts?.autoBuy);

  const proc = spawn(process.execPath, [tsxCli, script], {
    cwd: ROOT,
    env: envForCheckoutChild({
      MONITOR_AUTO_CHECKOUT: autoBuy ? "1" : "0",
      MONITOR_FROM_DASHBOARD: "1",
      MONITOR_QUANTITY: String(quantity),
      MONITOR_FULFILLMENT: fulfillment,
      MONITOR_PICKUP_SEARCH: pickupSearch,
      DASHBOARD_PORT: String(PORT),
    }),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: false,
  });

  monitorState.child = proc;
  monitorState.pid = proc.pid ?? null;
  monitorState.running = true;
  monitorState.startedAt = new Date().toISOString();
  monitorState.autoBuy = autoBuy;
  monitorState.logs = [];
  await pushMonitorLog(
    `已啟動 ${autoBuy ? "monitor+buying" : "monitor"} pid=${monitorState.pid} quantity=${quantity} fulfillment=${fulfillment}`
  );

  proc.stdout?.setEncoding("utf8");
  proc.stderr?.setEncoding("utf8");
  proc.stdout?.on("data", (chunk: string | Buffer) => {
    for (const line of String(chunk).split("\n")) void pushMonitorLog(line);
  });
  proc.stderr?.on("data", (chunk: string | Buffer) => {
    for (const line of String(chunk).split("\n")) void pushMonitorLog(line);
  });
  proc.on("exit", async (code) => {
    monitorState.running = false;
    monitorState.pid = null;
    monitorState.child = null;
    monitorState.autoBuy = false;
    await pushMonitorLog(`監察進程結束 exit=${code}`);
    broadcast({ type: "status", state: await snapshot() });
  });

  broadcast({ type: "status", state: await snapshot() });
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
    const peek = cardNumber
      ? await peekCardLimitInfo(ROOT, String(cardNumber), o.amountSpent ?? o.total)
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
      pickNonEmpty(o.cardLimit, card.cardLimit, peek?.cardLimit, meta?.limit) ||
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

async function snapshot() {
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
            card.total ?? order?.amountSpent ?? order?.total ?? estimatedTotal.label
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
          : pickNonEmpty(card.cardLimit, order?.cardLimit, peek?.cardLimit, meta?.limit) ||
            null,
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
    await pushBrowser({
      id,
      index: browserIndexFromId(id),
      pid: null,
      running: false,
      exitCode: 0,
      startedAt: String(st?.updatedAt || new Date().toISOString()),
      config: cfg,
      logs: [],
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
  const monitorStatus = await readJson(path.join(RUNTIME_DIR, "monitor-status.json"));
  const orders = allOrders;

  return {
    running: runningCount > 0,
    runningCount,
    totalBrowsers: browsers.length,
    config: lastFormConfig,
    browsers,
    logs: allLogs,
    orders,
    cardLimits: await getLiveCardLimits(ROOT, orders),
    monitor: {
      running: monitorState.running,
      pid: monitorState.pid,
      startedAt: monitorState.startedAt,
      autoBuy: monitorState.autoBuy,
      logs: monitorState.logs.slice(-40),
      status: monitorStatus,
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
  if (pathname === "/api/snapshot" && req.method === "GET") {
    return sendJson(res, 200, await snapshot());
  }
  if (pathname === "/api/config" && req.method === "GET") {
    return sendJson(res, 200, lastFormConfig);
  }
  if (pathname === "/api/orders" && req.method === "GET") {
    return sendJson(res, 200, await collectOrders());
  }
  if (pathname === "/api/card-limits" && req.method === "GET") {
    return sendJson(res, 200, await getLiveCardLimits(ROOT, await collectOrders()));
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

  if (pathname === "/api/monitor/start" && req.method === "POST") {
    try {
      const raw = await readBody(req).catch(() => "");
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      if (body.quantity != null) lastFormConfig.quantity = Number(body.quantity);
      if (body.fulfillmentPreference) {
        lastFormConfig.fulfillmentPreference = body.fulfillmentPreference;
      }
      if (body.pickupSearch) lastFormConfig.pickupSearch = body.pickupSearch;
      await startStockMonitor({
        quantity: Number(body.quantity ?? lastFormConfig.quantity ?? 2),
        fulfillmentPreference: String(
          body.fulfillmentPreference ?? lastFormConfig.fulfillmentPreference ?? "pickup"
        ),
        pickupSearch: String(body.pickupSearch ?? lastFormConfig.pickupSearch ?? "中環"),
        autoBuy: body.autoBuy === true || body.autoBuy === "1" || body.autoBuy === 1,
      });
      return sendJson(res, 200, { ok: true, state: await snapshot() });
    } catch (err) {
      return sendJson(res, 400, {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (pathname === "/api/monitor/stop" && req.method === "POST") {
    await stopStockMonitor();
    return sendJson(res, 200, { ok: true, state: await snapshot() });
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
    // 即刻標示未 hidden，等 script 還原視窗
    const stPath = path.join(RUNTIME_DIR, `status-${id}.json`);
    try {
      const prev = JSON.parse(await fs.readFile(stPath, "utf8")) as Record<string, unknown>;
      await fs.writeFile(
        stPath,
        JSON.stringify(
          {
            ...prev,
            windowHidden: false,
            windowState: "normal",
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
    return sendJson(res, 200, { ok: true });
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
    return sendJson(res, 200, {
      ok: true,
      running: addOrderJob.running,
      pid: addOrderJob.pid,
      startedAt: addOrderJob.startedAt,
      lastExitCode: addOrderJob.lastExitCode,
      logs: addOrderJob.logs.slice(-400).map(redactSecrets),
    });
  }

  if (pathname === "/api/add-order-apple-ac/accounts" && req.method === "GET") {
    await ensureRuntimeDir();
    let text = "";
    try {
      text = await decryptFromFile(GMAIL_ACCOUNTS_ENC, ADD_ORDER_KEY);
    } catch {
      try {
        // 舊版明文 → 升格加密後刪明文
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
    // 先停 job，避免仲寫 config／log
    const child = addOrderJob.child;
    const pid = child?.pid || addOrderJob.pid;
    await fs.writeFile(ADD_ORDER_STOP_FLAG, new Date().toISOString(), "utf8").catch(() => {});
    if (child) killProc(child);
    else if (process.platform === "win32" && pid) {
      spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
        stdio: "ignore",
        shell: true,
      });
    }
    addOrderJob.running = false;
    addOrderJob.child = null;
    addOrderJob.pid = null;
    addOrderJob.lastExitCode = null;
    addOrderJob.logs = [];
    addOrderJob.startedAt = null;

    // 清晒所有相關歷史／密文／明文殘留，並換 key
    await secureWipeFile(GMAIL_ACCOUNTS_ENC);
    await secureWipeFile(GMAIL_ACCOUNTS_LEGACY);
    await secureWipeFile(ADD_ORDER_JOB_ENC);
    await secureWipeFile(ADD_ORDER_JOB_LEGACY);
    await secureWipeFile(ADD_ORDER_STOP_FLAG);
    await rotateKey(ADD_ORDER_KEY);

    return sendJson(res, 200, {
      ok: true,
      cleared: [
        "ui",
        "gmail-accounts.enc",
        "gmail-accounts-saved.txt",
        "add-order-job.enc",
        "add-order-apple-ac.json",
        "logs",
        "key-rotated",
      ],
    });
  }

  if (pathname === "/api/add-order-apple-ac/stop" && req.method === "POST") {
    await ensureRuntimeDir();
    await fs.writeFile(ADD_ORDER_STOP_FLAG, new Date().toISOString(), "utf8");
    const child = addOrderJob.child;
    const pid = child?.pid || addOrderJob.pid;
    if (child) {
      killProc(child);
    } else if (process.platform === "win32" && pid) {
      spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
        stdio: "ignore",
        shell: true,
      });
    }
    addOrderJob.running = false;
    addOrderJob.child = null;
    addOrderJob.pid = null;
    addOrderJob.lastExitCode = addOrderJob.lastExitCode ?? 1;
    addOrderJob.logs.push(`[dashboard] stop requested @ ${new Date().toISOString()}`);
    return sendJson(res, 200, { ok: true });
  }

  if (pathname === "/api/add-order-apple-ac/start" && req.method === "POST") {
    if (addOrderJob.running) {
      return sendJson(res, 409, { ok: false, error: "add-order job 已喺度跑緊" });
    }
    let body: {
      accounts?: Array<{ email?: string; password?: string }>;
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
      }))
      .filter((a) => a.email && a.password);
    if (!accounts.length) {
      return sendJson(res, 400, { ok: false, error: "需要至少一個 Gmail email + password" });
    }
    const appleEmail = String(body.appleEmail || "chifung2010@yahoo.com.hk").trim();
    const applePassword = String(body.applePassword || "yY6594083");
    if (!appleEmail || !applePassword) {
      return sendJson(res, 400, { ok: false, error: "需要 Apple ID email + password" });
    }

    await ensureRuntimeDir();
    await fs.unlink(ADD_ORDER_STOP_FLAG).catch(() => {});
    // 加密 job config（唔再寫明文 JSON）
    await encryptToFile(
      ADD_ORDER_JOB_ENC,
      ADD_ORDER_KEY,
      JSON.stringify({ accounts, appleEmail, applePassword })
    );
    await secureWipeFile(ADD_ORDER_JOB_LEGACY);

    const tsxCli = path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
    const script = path.join(ROOT, "src", "add-order-to-apple-ac.ts");
    addOrderJob.logs = [
      `[dashboard] start ${new Date().toISOString()} · ${accounts.length} Gmail (encrypted job)`,
    ];
    addOrderJob.lastExitCode = null;
    addOrderJob.startedAt = new Date().toISOString();
    addOrderJob.running = true;

    const proc = spawn(process.execPath, [tsxCli, script], {
      cwd: ROOT,
      env: envForCheckoutChild({
        ADD_ORDER_JOB_ENC: ADD_ORDER_JOB_ENC,
        ADD_ORDER_KEY_PATH: ADD_ORDER_KEY,
        ADD_ORDER_STOP_FLAG: ADD_ORDER_STOP_FLAG,
      }),
      stdio: ["ignore", "pipe", "pipe"],
    });
    addOrderJob.child = proc;
    addOrderJob.pid = proc.pid ?? null;

    const pushLog = (buf: Buffer) => {
      const text = buf.toString("utf8");
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue;
        addOrderJob.logs.push(redactSecrets(line));
        if (addOrderJob.logs.length > 800) {
          addOrderJob.logs.splice(0, addOrderJob.logs.length - 800);
        }
      }
    };
    proc.stdout?.on("data", pushLog);
    proc.stderr?.on("data", pushLog);
    proc.on("exit", (code) => {
      addOrderJob.running = false;
      addOrderJob.lastExitCode = code ?? 1;
      addOrderJob.child = null;
      addOrderJob.pid = null;
      addOrderJob.logs.push(`[dashboard] exit=${code}`);
      // 跑完即抹走 job 密文，減少落地時間
      void secureWipeFile(ADD_ORDER_JOB_ENC);
      void secureWipeFile(ADD_ORDER_JOB_LEGACY);
    });

    return sendJson(res, 200, { ok: true, pid: addOrderJob.pid });
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
  void refreshNextIndexFromDisk().then(() => {
    console.log(
      `Checkout dashboard → http://127.0.0.1:${PORT} (next browser id b${nextIndex + 1}) [live-reload build=${DASHBOARD_BUILD_ID}]`
    );
  });
});

process.on("SIGINT", async () => {
  await stopAll();
  process.exit(0);
});

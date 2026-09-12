/**
 * Apple checkout control dashboard (multi-browser).
 * Run: npm run dashboard  →  http://127.0.0.1:8787
 */
import http from "node:http";
import fs from "node:fs/promises";
import { createReadStream, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcess } from "node:child_process";
import { exportOrdersToGoogleSheet } from "./export-google-sheet.js";
import { getLiveCardLimits } from "./credit-card-pool.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC = path.join(ROOT, "dashboard");
const RUNTIME_DIR = path.join(ROOT, "runtime");
const RUNTIME_CONFIG = path.join(ROOT, "runtime-config.json");
const ORDERS_FILE = path.join(ROOT, "order-summary.json");
const CONTINUE_ALL_FLAG = path.join(ROOT, "dashboard-continue.flag");
const PORT = Number(process.env.DASHBOARD_PORT || 8787);

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

async function stopSession(
  id: string,
  mode: "release" | "force" = "release",
  opts?: { silent?: boolean }
) {
  const session = sessions.get(id);
  if (!session) return;
  await ensureRuntimeDir();

  if (mode === "release" && session.running && session.child) {
    // 停自動化、保留瀏覽器；silent=Stop all（唔開窗）
    const payload = opts?.silent
      ? `stop-all\n${new Date().toISOString()}`
      : `takeover\n${new Date().toISOString()}`;
    await fs.writeFile(path.join(RUNTIME_DIR, `release-${id}.flag`), payload, "utf8");
    // 即刻更新 status，等 script 進入 manual_control
    const stPath = path.join(RUNTIME_DIR, `status-${id}.json`);
    try {
      const prev = JSON.parse(await fs.readFile(stPath, "utf8")) as Record<string, unknown>;
      await fs.writeFile(
        stPath,
        JSON.stringify(
          {
            ...prev,
            phase: "stop_requested",
            message: opts?.silent
              ? "Dashboard Stop all（保持隱藏）"
              : "Dashboard 要求 Stop（take over）",
            windowHidden: opts?.silent ? true : prev.windowHidden,
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
        ? "[dashboard] Stop all：已要求停止自動化（保持隱藏）"
        : "[dashboard] 已要求停止自動化（Take over / Stop）"
    );
    // 即刻回 UI；背景再跟進 manual_control（避免 Stop 掣卡住 30 秒）
    broadcast({ type: "status", state: await snapshot() });
    void (async () => {
      for (let i = 0; i < 80; i++) {
        await new Promise((r) => setTimeout(r, 250));
        const st = await readSessionStatus(id);
        if (st?.phase === "manual_control" || !session.running) {
          broadcast({ type: "status", state: await snapshot() });
          break;
        }
      }
    })();
    return;
  }

  // force close：先寫 close flag，再即刻殺 process，並由 dashboard 移除卡片
  await fs.writeFile(
    path.join(RUNTIME_DIR, `close-${id}.flag`),
    new Date().toISOString(),
    "utf8"
  );
  // 唔再同時寫 release（避免同 close 搶旗導致卡喺 manual_control）
  const child = session.child;
  const pid = session.pid ?? child?.pid ?? null;
  pushSessionLog(session, "[dashboard] 正在關閉呢個瀏覽器…");
  if (child) {
    killProc(child);
    session.child = null;
  } else if (pid) {
    spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
      stdio: "ignore",
      shell: true,
    });
  }
  // 再補一刀：短延遲後若仲在就再 kill
  await new Promise((r) => setTimeout(r, 300));
  if (pid) {
    spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
      stdio: "ignore",
      shell: true,
    });
  }
  session.running = false;
  session.pid = null;
  sessions.delete(id);
  await fs.unlink(path.join(RUNTIME_DIR, `status-${id}.json`)).catch(() => {});
  await fs.unlink(path.join(RUNTIME_DIR, `release-${id}.flag`)).catch(() => {});
  // close flag 留低畀 script 自行收尾；下次 launch 會覆蓋
  broadcast({ type: "status", state: await snapshot() });
}

async function stopAll() {
  await ensureRuntimeDir();
  // 標示 Stop all：script 停自動化時唔開窗／fullscreen（多 process 共用，唔好提早刪）
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
  for (const id of [...sessions.keys()]) {
    await stopSession(id, "force");
  }
  sessions.clear();
  await fs.unlink(CONTINUE_ALL_FLAG).catch(() => {});
  broadcast({ type: "status", state: await snapshot() });
}

async function spawnOneBrowser(
  config: Record<string, unknown>,
  opts?: { windowTotal?: number }
): Promise<BrowserSession> {
  await ensureRuntimeDir();
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
  const configPath = path.join(RUNTIME_DIR, `config-${id}.json`);
  await fs.writeFile(configPath, JSON.stringify(sessionConfig, null, 2), "utf8");
  await fs.writeFile(RUNTIME_CONFIG, JSON.stringify({ ...cleanConfig }, null, 2), "utf8");
  // 清走舊 stop／close flag，避免新 session 即刻被殺
  await fs.unlink(path.join(RUNTIME_DIR, `close-${id}.flag`)).catch(() => {});
  await fs.unlink(path.join(RUNTIME_DIR, `release-${id}.flag`)).catch(() => {});
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
    env: {
      ...process.env,
      CHECKOUT_DASHBOARD: "1",
      CHECKOUT_CONFIG_PATH: configPath,
      CHECKOUT_SESSION_ID: id,
      CHECKOUT_WINDOW_INDEX: String(index),
      CHECKOUT_WINDOW_TOTAL: String(windowTotal),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  session.child = proc;
  session.pid = proc.pid ?? null;
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
    broadcast({ type: "status", state: await snapshot() });
  });

  return session;
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
    env: {
      ...process.env,
      MONITOR_AUTO_CHECKOUT: autoBuy ? "1" : "0",
      MONITOR_FROM_DASHBOARD: "1",
      MONITOR_QUANTITY: String(quantity),
      MONITOR_FULFILLMENT: fulfillment,
      MONITOR_PICKUP_SEARCH: pickupSearch,
      DASHBOARD_PORT: String(PORT),
    },
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
  const n = Math.max(1, Math.min(8, Number(count) || 1));
  lastFormConfig = { ...config, browserCount: n };
  await ensureRuntimeDir();
  await fs.unlink(path.join(RUNTIME_DIR, "stop-all.flag")).catch(() => {});
  await fs.unlink(CONTINUE_ALL_FLAG).catch(() => {});
  const created = [];
  const plannedTotal = nextIndex + n;
  for (let i = 0; i < n; i++) {
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

  // de-dupe by session+orderNumber+scrapedAt roughly
  const seen = new Set<string>();
  const out: unknown[] = [];
  for (const item of merged) {
    const o = item as Record<string, unknown>;
    const key = `${o.browser || ""}|${o.orderNumber || ""}|${o.scrapedAt || ""}|${JSON.stringify(o.identity || {})}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

async function readSessionStatus(id: string): Promise<Record<string, unknown> | null> {
  const data = await readJson(path.join(RUNTIME_DIR, `status-${id}.json`));
  return data && typeof data === "object" ? (data as Record<string, unknown>) : null;
}

async function snapshot() {
  const browsers = [];
  for (const s of sessions.values()) {
    const runtimeStatus = await readSessionStatus(s.id);
    const card = (runtimeStatus?.card as Record<string, unknown> | undefined) || {};
    browsers.push({
      id: s.id,
      index: s.index,
      pid: s.pid,
      running: s.running,
      exitCode: s.exitCode,
      startedAt: s.startedAt,
      config: s.config,
      logs: s.logs.slice(-40),
      phase:
        runtimeStatus?.phase ??
        (s.running ? "running" : s.exitCode == null ? "idle" : "exited"),
      windowHidden: Boolean(runtimeStatus?.windowHidden),
      windowState: runtimeStatus?.windowState ?? null,
      runtimeStatus,
      card: {
        productType: card.productType ?? s.config.model,
        color: card.color ?? s.config.color,
        storage: card.storage ?? s.config.storage,
        quantity: card.quantity ?? s.config.quantity,
        total: card.total ?? null,
        fulfillmentMode: card.fulfillmentMode ?? s.config.fulfillmentPreference,
        orderNumber: card.orderNumber ?? null,
        email: card.email ?? null,
        phone: card.phone ?? null,
        address: card.address ?? null,
        name: card.name ?? null,
        cardNumber: card.cardNumber ?? null,
        deliveryDetails: card.deliveryDetails ?? null,
        estimatedDelivery: card.estimatedDelivery ?? null,
        paymentSucceeded: Boolean(card.paymentSucceeded) || Boolean(card.orderNumber),
      },
    });
  }
  browsers.sort((a, b) => a.index - b.index);

  const runningCount = browsers.filter((b) => b.running).length;
  const allLogs = browsers.flatMap((b) => b.logs).slice(-300);
  const monitorStatus = await readJson(path.join(RUNTIME_DIR, "monitor-status.json"));

  return {
    running: runningCount > 0,
    runningCount,
    totalBrowsers: browsers.length,
    config: lastFormConfig,
    browsers,
    logs: allLogs,
    orders: await collectOrders(),
    cardLimits: await getLiveCardLimits(ROOT),
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
    return sendJson(res, 200, await getLiveCardLimits(ROOT));
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
    res.write(`data: ${JSON.stringify({ type: "hello", state: await snapshot() })}\n\n`);
    sseClients.add(res);
    req.on("close", () => sseClients.delete(res));
    return;
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
    await stopSession(decodeURIComponent(closeOne[1]!), "force");
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
    res.writeHead(200, { "Content-Type": contentType(filePath) });
    createReadStream(filePath).pipe(res);
  } catch (err) {
    res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(err instanceof Error ? err.message : String(err));
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Checkout dashboard → http://127.0.0.1:${PORT}`);
});

process.on("SIGINT", async () => {
  await stopAll();
  process.exit(0);
});

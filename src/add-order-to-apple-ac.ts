/**
 * Gmail → Apple Store 訂單狀態 → 「加入至 Apple ID」自動化
 * Config via ADD_ORDER_CONFIG_PATH JSON:
 * {
 *   accounts: [{ email, password, orderNumber }, ...],
 *   appleEmail, applePassword
 * }
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Frame,
  type Locator,
  type Page,
} from "playwright";
import { decryptFromFile, maskEmail, redactSecrets } from "./add-order-secrets.js";

type Account = { email: string; password: string; orderNumber: string };

type JobConfig = {
  accounts: Account[];
  appleEmail: string;
  applePassword: string;
};

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const JOB_ENC =
  process.env.ADD_ORDER_JOB_ENC || path.join(ROOT, "runtime", "add-order-job.enc");
const KEY_PATH =
  process.env.ADD_ORDER_KEY_PATH || path.join(ROOT, "runtime", ".add-order-key");
const LEGACY_CONFIG =
  process.env.ADD_ORDER_CONFIG_PATH ||
  process.env.CHECKOUT_CONFIG_PATH ||
  "";
const SESSION_ID = String(process.env.ADD_ORDER_SESSION_ID || "ao1").trim() || "ao1";
const ACCOUNT_INDEX = Math.max(0, Number(process.env.ADD_ORDER_ACCOUNT_INDEX || "0") || 0);
/** 同 Checkout Dashboard：並排鋪位用 */
const WINDOW_TOTAL = Math.max(
  1,
  Number(process.env.ADD_ORDER_WINDOW_TOTAL || process.env.ADD_ORDER_ACCOUNT_COUNT || "1") || 1
);
/** 同 buy-iphone-17 CONFIG 預設 */
const WINDOW_WIDTH = 960;
const WINDOW_HEIGHT = 980;
const STATUS_FILE = path.join(ROOT, "runtime", `status-${SESSION_ID}.json`);
const SHOW_FLAG = path.join(ROOT, "runtime", `show-${SESSION_ID}.flag`);
const HIDE_FLAG = path.join(ROOT, "runtime", `hide-${SESSION_ID}.flag`);
/** 用戶撳過 Open browser：任何自動 minimize 都忽略，直至 Hide／Close */
const KEEP_OPEN_FLAG = path.join(ROOT, "runtime", `keepopen-${SESSION_ID}.flag`);
const RELEASE_FLAG = path.join(ROOT, "runtime", `release-${SESSION_ID}.flag`);
const CONTINUE_FLAG = path.join(ROOT, "runtime", `continue-${SESSION_ID}.flag`);
const CLOSE_FLAG = path.join(ROOT, "runtime", `close-${SESSION_ID}.flag`);
const STOP_ALL_FLAG =
  process.env.ADD_ORDER_STOP_FLAG ||
  path.join(ROOT, "runtime", "add-order-stop.flag");

class StopRequestedError extends Error {
  constructor() {
    super("已收到 Stop（保留瀏覽器）");
    this.name = "StopRequestedError";
  }
}

class CloseRequestedError extends Error {
  constructor() {
    super("已收到 Close");
    this.name = "CloseRequestedError";
  }
}

let activePage: Page | null = null;
let activeBrowser: Browser | null = null;
let windowHidden = true;
/** 用戶撳過 Open browser 之後，自動化唔好再自動 minimize */
let userKeepBrowserOpen = false;
/** 同 Checkout Dashboard 嘅鋪位大小（Open browser 用） */
let windowBounds: { left: number; top: number; width: number; height: number } = {
  left: 4,
  top: 4,
  width: WINDOW_WIDTH,
  height: WINDOW_HEIGHT,
};

/** 同 Checkout Dashboard `computeWindowLayout` */
function computeWindowLayout(
  index: number,
  total: number,
  screenW: number,
  screenH: number
): { x: number; y: number; width: number; height: number } {
  const n = Math.max(1, total);
  const gap = 4;
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

async function flagExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function consumeFlag(p: string): Promise<boolean> {
  if (!(await flagExists(p))) return false;
  await fs.unlink(p).catch(() => {});
  return true;
}

async function writeStatus(patch: Record<string, unknown>): Promise<void> {
  await fs.mkdir(path.dirname(STATUS_FILE), { recursive: true }).catch(() => {});
  let prev: Record<string, unknown> = {};
  try {
    prev = JSON.parse(await fs.readFile(STATUS_FILE, "utf8")) as Record<string, unknown>;
  } catch {
    /* ignore */
  }
  const keepOpen = userKeepBrowserOpen || (await flagExists(KEEP_OPEN_FLAG).catch(() => false));
  const next = {
    ...prev,
    ...patch,
    ...(keepOpen
      ? {
          windowHidden: false,
          keepOpen: true,
          windowState: patch.windowState || prev.windowState || "maximized",
        }
      : {}),
    id: SESSION_ID,
    type: "add_order",
    updatedAt: new Date().toISOString(),
  };
  await fs.writeFile(STATUS_FILE, JSON.stringify(next, null, 2), "utf8");
}

function log(msg: string) {
  console.log(`[add-order:${SESSION_ID}] ${redactSecrets(msg)}`);
}

async function throwIfClosed(): Promise<void> {
  if (await consumeFlag(CLOSE_FLAG)) throw new CloseRequestedError();
}

async function throwIfStopped(): Promise<void> {
  await throwIfClosed();
  // 只停自動化；唔關瀏覽器。全局 Stop 會對每個 task 寫 release-*.flag
  if (await consumeFlag(RELEASE_FLAG)) {
    throw new StopRequestedError();
  }
}

async function loadConfig(): Promise<JobConfig> {
  let raw: Partial<JobConfig> = {};
  try {
    const plain = await decryptFromFile(JOB_ENC, KEY_PATH);
    raw = JSON.parse(plain) as Partial<JobConfig>;
  } catch {
    if (!LEGACY_CONFIG) throw new Error("缺少加密 job config（ADD_ORDER_JOB_ENC）");
    raw = JSON.parse(await fs.readFile(LEGACY_CONFIG, "utf8")) as Partial<JobConfig>;
  }
  const accounts = Array.isArray(raw.accounts)
    ? raw.accounts
        .map((a) => ({
          email: String(a?.email || "").trim(),
          password: String(a?.password || ""),
          orderNumber: String((a as { orderNumber?: string })?.orderNumber || "").trim(),
        }))
        .filter((a) => a.email && a.password && a.orderNumber)
    : [];
  if (!accounts.length) {
    throw new Error("未有有效帳號（格式：email:password:order number）");
  }
  const appleEmail = String(raw.appleEmail || "chifung2010@yahoo.com.hk").trim();
  const applePassword = String(raw.applePassword || "yY6594083");
  if (!appleEmail || !applePassword) throw new Error("缺少 Apple ID 電郵／密碼");
  return { accounts, appleEmail, applePassword };
}

async function readJsonLoose(file: string): Promise<unknown> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as unknown;
  } catch {
    return null;
  }
}

/** 讀 Order summary（ROOT + runtime/order-*.json） */
async function loadOrderSummaryRecords(): Promise<Record<string, unknown>[]> {
  const merged: Record<string, unknown>[] = [];
  const push = (data: unknown) => {
    if (Array.isArray(data)) {
      for (const item of data) {
        if (item && typeof item === "object") merged.push(item as Record<string, unknown>);
      }
    } else if (data && typeof data === "object") {
      merged.push(data as Record<string, unknown>);
    }
  };
  push(await readJsonLoose(path.join(ROOT, "order-summary.json")));
  const runtimeDir = path.join(ROOT, "runtime");
  try {
    const files = await fs.readdir(runtimeDir);
    for (const f of files) {
      if (!/^order-.*\.json$/i.test(f)) continue;
      push(await readJsonLoose(path.join(runtimeDir, f)));
    }
  } catch {
    /* empty */
  }
  return merged;
}

/** 由 Order summary 抽電話（同 Dashboard 顯示一致） */
function orderContactPhone(o: Record<string, unknown>): string {
  const contact = (o.checkoutContactUsed as Record<string, unknown> | undefined) || {};
  const ship = (o.confirmationPageShipping as Record<string, unknown> | undefined) || {};
  const sd = (o.shippingDetails as Record<string, unknown> | undefined) || {};
  const identity = (o.identity as Record<string, unknown> | undefined) || {};
  const delivery = (o.deliveryDetails as Record<string, unknown> | undefined) || {};
  for (const v of [
    sd.phone,
    contact.phone,
    ship.phone,
    identity.phone,
    delivery.phone,
    o.phone,
  ]) {
    const p = String(v || "").trim();
    if (p && p !== "—") return p;
  }
  return "";
}

/** Apple HK verify 頁通常要 8 位本地號碼 */
function normalizeHkMobileForApple(raw: string): string {
  let digits = String(raw || "").replace(/\D/g, "");
  if (digits.startsWith("852") && digits.length >= 11) digits = digits.slice(-8);
  if (digits.length > 8) digits = digits.slice(-8);
  return digits;
}

function orderNumbersEqual(a: string, b: string): boolean {
  const na = String(a || "").trim().toUpperCase().replace(/[\s-]/g, "");
  const nb = String(b || "").trim().toUpperCase().replace(/[\s-]/g, "");
  return Boolean(na && nb && na === nb);
}

/** 由 Apple verify URL 抽出訂單編號（?_w=W…） */
function orderNumberFromAppleUrl(url: string): string {
  try {
    const u = new URL(url);
    const w = u.searchParams.get("_w") || u.searchParams.get("orderNumber") || "";
    if (w.trim()) return w.trim();
  } catch {
    /* ignore */
  }
  const m = String(url || "").match(/[?&]_w=([A-Za-z0-9-]+)/);
  return m?.[1]?.trim() || "";
}

async function resolvePhoneForOrderNumber(orderNumber: string): Promise<string> {
  const want = String(orderNumber || "").trim();
  if (!want) throw new Error("缺少訂單編號，無法對齊電話");

  // 1) order-summary.json / runtime/order-*.json（同 Dashboard Order summary）
  const orders = await loadOrderSummaryRecords();
  for (const o of orders) {
    const n = String(o.orderNumber || "").trim();
    if (!orderNumbersEqual(n, want)) continue;
    const phone = normalizeHkMobileForApple(orderContactPhone(o));
    if (phone) {
      log(`Order summary：${want} → 電話 ${phone}`);
      return phone;
    }
  }

  // 2) status-b*.json card.phone（Finished / runtime）
  const runtimeDir = path.join(ROOT, "runtime");
  try {
    const files = await fs.readdir(runtimeDir);
    for (const f of files) {
      if (!/^status-b\d+\.json$/i.test(f) && !/^status-fin-.+\.json$/i.test(f)) continue;
      const st = (await readJsonLoose(path.join(runtimeDir, f))) as Record<string, unknown> | null;
      if (!st || typeof st !== "object") continue;
      const card = (st.card as Record<string, unknown> | undefined) || {};
      const n = String(card.orderNumber || "").trim();
      if (!orderNumbersEqual(n, want)) continue;
      const phone = normalizeHkMobileForApple(
        String(card.phone || (card.deliveryDetails as { phone?: string } | undefined)?.phone || "")
      );
      if (phone) {
        log(`runtime status：${want} → 電話 ${phone}`);
        return phone;
      }
    }
  } catch {
    /* ignore */
  }

  throw new Error(
    `Order summary 揾唔到訂單「${want}」嘅 Phone（Dashboard Order summary 請確認有該單電話）`
  );
}

function isOrderLinkVerifyUrl(url: string): boolean {
  return /\/shop\/order\/link\/verify/i.test(url);
}

/** 訂單電話驗證相關頁（verify 或 signIn/orders 轉去 verify） */
function isOrderPhoneGateUrl(url: string): boolean {
  if (isOrderLinkVerifyUrl(url)) return true;
  if (/\/shop\/signIn\/orders/i.test(url) && /order%2Flink%2Fverify|order\/link\/verify|_w=/i.test(url)) {
    return true;
  }
  return false;
}

function isAppleGuestOrderUrl(url: string): boolean {
  return (
    /\/shop\/order\/guest\//i.test(url) ||
    /\/shop\/order\/detail\//i.test(url) ||
    /vieworderstatus/i.test(url) ||
    /\/vieworder/i.test(url)
  );
}

/** 由 signIn/orders SSI 解出 continue 入面嘅 verify URL */
function extractVerifyUrlFromSignInOrders(url: string): string {
  try {
    const u = new URL(url);
    const ssi = u.searchParams.get("ssi") || "";
    // SSI 入面有 base64 嘅 https://…/order/link/verify?…
    const idx = ssi.indexOf("aHR0c"); // base64("http")
    if (idx >= 0) {
      const b64 = ssi.slice(idx).replace(/[^A-Za-z0-9+/=]/g, "");
      // 截到合理長度再 decode
      for (let len = Math.min(b64.length, 800); len > 40; len--) {
        try {
          const raw = Buffer.from(b64.slice(0, len), "base64").toString("utf8");
          const m = raw.match(/https?:\/\/[^\s"'<>]+order\/link\/verify[^\s"'<>]*/i);
          if (m?.[0]) return m[0].replace(/[|].*$/, "").trim();
        } catch {
          /* try shorter */
        }
      }
    }
  } catch {
    /* ignore */
  }
  // fallback：URL 本身已係 verify
  if (isOrderLinkVerifyUrl(url)) return url;
  return "";
}

async function frameHasPhoneField(frame: Frame): Promise<boolean> {
  const loc = frame.locator(
    [
      'input[id="orderLinkModule.phoneNumber"]',
      'input[type="tel"]',
      'input[name*="phone" i]',
      'input[id*="phone" i]',
      'input[autocomplete="tel"]',
      'input[data-autom*="phone" i]',
      'input[aria-label*="電話" i]',
      'input[aria-label*="Phone" i]',
      'input[placeholder*="電話" i]',
      'input[placeholder*="Phone" i]',
    ].join(", ")
  );
  const n = await loc.count().catch(() => 0);
  if (n <= 0) return false;
  for (let i = 0; i < Math.min(n, 5); i++) {
    if (await loc.nth(i).isVisible().catch(() => false)) return true;
  }
  return false;
}

async function pageHasOrderPhoneForm(page: Page): Promise<boolean> {
  for (const fr of page.frames()) {
    if (await frameHasPhoneField(fr)) return true;
  }
  // 有時 label 可見但 input 慢半拍
  const label = page.getByText(/電話號碼|流動電話|Phone number|Mobile number/i).first();
  return label.isVisible().catch(() => false);
}

/** 喺所有分頁搵 verify／guest／有電話欄嘅頁 */
async function findOrderVerifyPage(
  context: BrowserContext,
  preferred: Page | null,
  orderNumber: string
): Promise<Page> {
  const pages = context.pages().filter((p) => !p.isClosed());
  const want = String(orderNumber || "").trim();
  const ranked: Page[] = [];
  for (const p of pages) {
    const u = p.url();
    if (isOrderLinkVerifyUrl(u)) ranked.unshift(p);
    else if (isAppleGuestOrderUrl(u) || /\/shop\/order\/detail\//i.test(u)) ranked.push(p);
    else if (isOrderPhoneGateUrl(u)) ranked.push(p);
    else if (want && u.includes(want) && /store\.apple\.com/i.test(u)) ranked.push(p);
    else if (await pageHasOrderPhoneForm(p)) ranked.push(p);
  }
  if (preferred && !preferred.isClosed()) {
    const pu = preferred.url();
    if (
      isOrderPhoneGateUrl(pu) ||
      isAppleGuestOrderUrl(pu) ||
      /\/shop\/order\/detail\//i.test(pu) ||
      (await pageHasOrderPhoneForm(preferred))
    ) {
      return preferred;
    }
  }
  if (ranked[0]) return ranked[0]!;
  if (preferred && !preferred.isClosed()) return preferred;
  throw new Error("揾唔到 Apple 訂單 verify／訪客分頁");
}

async function sleep(ms: number) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    await syncWindowFlags().catch(() => {});
    await throwIfStopped();
    await new Promise((r) => setTimeout(r, Math.min(250, end - Date.now())));
  }
}

/** Windows：用 process tree 搵有 MainWindow 嘅 Chrome／Chromium 再還原／最大化 */
function winRestoreBrowserWindow(browser: Browser): void {
  if (process.platform !== "win32") return;
  const proc = (browser as unknown as { process?: () => { pid?: number } | null }).process?.();
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
    $h = $p.MainWindowHandle
    if ([W]::IsIconic($h)) { [void][W]::ShowWindowAsync($h, 9) } # SW_RESTORE
    [void][W]::ShowWindowAsync($h, 3) # SW_MAXIMIZE
    [void][W]::SetForegroundWindow($h)
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

function winMinimizeBrowserWindow(browser: Browser): void {
  if (process.platform !== "win32") return;
  const proc = (browser as unknown as { process?: () => { pid?: number } | null }).process?.();
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

async function getPageWindowId(page: Page): Promise<number | null> {
  try {
    const cdp = await page.context().newCDPSession(page);
    let windowId: number | undefined;
    try {
      const info = (await cdp.send("Target.getTargetInfo")) as {
        targetInfo?: { targetId?: string };
      };
      const targetId = info?.targetInfo?.targetId;
      if (targetId) {
        const got = (await cdp.send("Browser.getWindowForTarget", { targetId })) as {
          windowId?: number;
        };
        windowId = got.windowId;
      }
    } catch {
      /* fallback */
    }
    if (windowId == null) {
      const got = (await cdp.send("Browser.getWindowForTarget")) as { windowId?: number };
      windowId = got.windowId;
    }
    await cdp.detach().catch(() => {});
    return windowId ?? null;
  } catch {
    return null;
  }
}

async function applyCheckoutWindowBounds(page: Page, minimized: boolean): Promise<void> {
  // 用戶要保持開啟時，唔好再套 minimized bounds
  if (minimized && userKeepBrowserOpen) return;
  const windowId = await getPageWindowId(page);
  if (windowId == null) return;
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send("Browser.setWindowBounds", {
      windowId,
      bounds: {
        ...windowBounds,
        windowState: minimized ? "minimized" : "normal",
      },
    });
    if (!minimized) {
      await page
        .setViewportSize({
          width: Math.max(360, windowBounds.width - 16),
          height: Math.max(400, windowBounds.height - 88),
        })
        .catch(() => {});
      // 同 Checkout：先套鋪位再 maximize
      await cdp
        .send("Browser.setWindowBounds", {
          windowId,
          bounds: { windowState: "maximized" },
        })
        .catch(() => {});
    }
  } finally {
    await cdp.detach().catch(() => {});
  }
}

async function setKeepBrowserOpen(keep: boolean): Promise<void> {
  userKeepBrowserOpen = keep;
  windowHidden = !keep;
  if (keep) {
    await fs.mkdir(path.dirname(KEEP_OPEN_FLAG), { recursive: true }).catch(() => {});
    await fs.writeFile(KEEP_OPEN_FLAG, new Date().toISOString(), "utf8").catch(() => {});
  } else {
    await fs.unlink(KEEP_OPEN_FLAG).catch(() => {});
  }
}

async function loadKeepBrowserOpenFlag(): Promise<void> {
  if (await flagExists(KEEP_OPEN_FLAG)) {
    userKeepBrowserOpen = true;
    windowHidden = false;
  }
}

async function isBrowserWindowMinimized(page: Page): Promise<boolean> {
  try {
    const windowId = await getPageWindowId(page);
    if (windowId == null) return false;
    const cdp = await page.context().newCDPSession(page);
    try {
      const got = (await cdp.send("Browser.getWindowBounds", { windowId })) as {
        bounds?: { windowState?: string };
      };
      return String(got?.bounds?.windowState || "") === "minimized";
    } finally {
      await cdp.detach().catch(() => {});
    }
  } catch {
    return false;
  }
}

async function maximizeBrowserWindow(page: Page, browser: Browser): Promise<void> {
  // 一收到 Open browser 即刻鎖定，避免同時間 maybeMinimize 搶住收埋
  await setKeepBrowserOpen(true);
  log(
    `Open browser：用 Checkout 尺寸 ${windowBounds.width}x${windowBounds.height} @ (${windowBounds.left},${windowBounds.top})（保持開啟）`
  );
  try {
    await page.bringToFront().catch(() => {});
    await applyCheckoutWindowBounds(page, false);
  } catch (err) {
    log(`Open browser CDP 失敗：${err instanceof Error ? err.message : String(err)}`);
  }
  winRestoreBrowserWindow(browser);
  await page.bringToFront().catch(() => {});
  await writeStatus({
    windowHidden: false,
    windowState: "maximized",
    message: "browser opened — kept open until Hide/Close",
    keepOpen: true,
    windowBounds,
  });
}

/** 隱藏視窗（淨係 Hide 先會 force；Open browser 後自動呼叫會被拒絕） */
async function minimizeBrowserWindow(
  page: Page,
  browser: Browser,
  opts?: { force?: boolean }
): Promise<void> {
  if (userKeepBrowserOpen && !opts?.force) {
    windowHidden = false;
    log("略過 minimize：用戶已 Open browser，保持開啟");
    return;
  }
  try {
    const windowId = await getPageWindowId(page);
    if (windowId != null) {
      const cdp = await page.context().newCDPSession(page);
      await cdp.send("Browser.setWindowBounds", {
        windowId,
        bounds: { windowState: "minimized" },
      });
      await cdp.detach().catch(() => {});
    }
  } catch {
    /* ignore CDP fail */
  }
  winMinimizeBrowserWindow(browser);
  windowHidden = true;
  await writeStatus({ windowHidden: true, windowState: "minimized", keepOpen: false });
}

/** 自動化用：用戶已 Open browser 就保持開住 */
async function maybeMinimizeBrowserWindow(page: Page, browser: Browser): Promise<void> {
  if (userKeepBrowserOpen || (await flagExists(KEEP_OPEN_FLAG))) {
    userKeepBrowserOpen = true;
    windowHidden = false;
    return;
  }
  await minimizeBrowserWindow(page, browser);
}

let flagPollTimer: ReturnType<typeof setInterval> | null = null;
let lastKeepOpenReassertAt = 0;

function startFlagPoller(): void {
  if (flagPollTimer) return;
  flagPollTimer = setInterval(() => {
    void syncWindowFlags().catch(() => {});
  }, 350);
}

function stopFlagPoller(): void {
  if (flagPollTimer) {
    clearInterval(flagPollTimer);
    flagPollTimer = null;
  }
}

async function syncWindowFlags(): Promise<void> {
  // Close：任何時候都即關
  if (await flagExists(CLOSE_FLAG)) {
    await fs.unlink(CLOSE_FLAG).catch(() => {});
    await setKeepBrowserOpen(false);
    log("Close：收到關閉要求，結束 task");
    await writeStatus({ phase: "closed", message: "closed", windowHidden: true });
    try {
      await activeBrowser?.close();
    } catch {
      /* ignore */
    }
    process.exit(0);
  }
  if (!activePage || activePage.isClosed() || !activeBrowser) return;

  // 一見到 show flag 即刻 lock keep-open（maximize 前）
  if (await flagExists(SHOW_FLAG)) {
    await setKeepBrowserOpen(true);
  }
  if (await consumeFlag(SHOW_FLAG)) {
    await maximizeBrowserWindow(activePage, activeBrowser);
    log("Open browser：已顯示視窗（會保持開啟直至 Hide／Close）");
  }
  if (await consumeFlag(HIDE_FLAG)) {
    await setKeepBrowserOpen(false);
    await minimizeBrowserWindow(activePage, activeBrowser, { force: true });
    log("Hide：已隱藏視窗");
    return;
  }

  // 用戶要求保持開啟：若被系統／其他步驟收埋，自動再打開
  if (userKeepBrowserOpen || (await flagExists(KEEP_OPEN_FLAG))) {
    userKeepBrowserOpen = true;
    windowHidden = false;
    const now = Date.now();
    if (now - lastKeepOpenReassertAt > 1200) {
      lastKeepOpenReassertAt = now;
      const minimized = await isBrowserWindowMinimized(activePage).catch(() => false);
      if (minimized) {
        log("偵測到視窗被收埋 — 自動再 Open（keep-open）");
        await maximizeBrowserWindow(activePage, activeBrowser).catch(() => {});
      }
    }
  }
}

async function holdBrowserUntilClose(reason: string): Promise<"continue" | "close"> {
  await writeStatus({
    phase: "manual_control",
    message: reason,
    windowHidden: !userKeepBrowserOpen,
    keepOpen: userKeepBrowserOpen,
  });
  log(`${reason} — 瀏覽器保持開啟（Stop 唔關窗）；Continue 繼續／Close 關閉`);
  while (true) {
    if (await consumeFlag(CLOSE_FLAG)) return "close";
    await syncWindowFlags().catch(() => {});
    if (await consumeFlag(CONTINUE_FLAG)) {
      await writeStatus({ phase: "running", message: "Continue：恢復自動化" });
      return "continue";
    }
    // 全局 stop 淨係 pause，唔退出 hold
    await new Promise((r) => setTimeout(r, 400));
  }
}

const APPLE_AUTH_IFRAME_SELS = [
  "#aid-auth-widget-iFrame",
  "iframe#aid-auth-widget-iFrame",
  'iframe[src*="idmsa.apple.com"]',
  'iframe[src*="appleauth"]',
  'iframe[name*="aid-auth" i]',
];

function appleAuthFrames(page: Page): Frame[] {
  const out: Frame[] = [];
  for (const fr of page.frames()) {
    const url = fr.url() || "";
    if (/idmsa\.apple\.com|appleauth|account\.apple\.com/i.test(url)) out.push(fr);
  }
  return out;
}

/** 淨係 auth iframe；唔好喺 store 主頁撳（左上角 Apple logo → apple.com/hk） */
function authActionFrames(page: Page): Frame[] {
  const auth = appleAuthFrames(page);
  if (auth.length) return auth;
  const mainUrl = page.url() || "";
  if (/idmsa\.apple\.com|appleauth|account\.apple\.com/i.test(mainUrl)) {
    return [page.mainFrame()];
  }
  return [];
}

function isAppleMarketingHome(url: string): boolean {
  return /^https?:\/\/(www\.)?apple\.com\/(hk|hk-zh)\/?(\?|#|$)/i.test(String(url || ""));
}

/** 若誤跳去 apple.com/hk 官網，即刻返回登入頁 */
async function recoverIfLeftAppleSignIn(page: Page, signInUrl: string): Promise<boolean> {
  const url = page.url();
  if (/\/shop\/signIn/i.test(url) || /idmsa\.apple\.com/i.test(url)) return false;
  if (isAppleMarketingHome(url) || /^https?:\/\/(www\.)?apple\.com\/hk(\/|$)/i.test(url)) {
    log(`誤入官網 ${url}（多半撳咗 Apple logo）— 返回登入頁`);
    await page.goBack({ waitUntil: "domcontentloaded" }).catch(() => {});
    await sleep(500);
    if (!/\/shop\/signIn/i.test(page.url()) && signInUrl) {
      await page.goto(signInUrl, { waitUntil: "domcontentloaded", timeout: 60_000 }).catch(() => {});
    }
    return true;
  }
  return false;
}

async function fillInAppleAuthFrame(
  page: Page,
  kind: "email" | "password",
  value: string
): Promise<boolean> {
  const sels =
    kind === "email"
      ? [
          "#account_name_text_field",
          'input[type="email"]',
          'input[name="accountName"]',
          'input[autocomplete="username"]',
          'input[id*="account" i]',
        ]
      : [
          "#password_text_field",
          'input[type="password"]',
          'input[name="password"]',
          'input[autocomplete="current-password"]',
        ];

  const tryFill = async (root: Page | Frame): Promise<boolean> => {
    for (const sel of sels) {
      const loc = root.locator(sel).first();
      if ((await loc.count().catch(() => 0)) === 0) continue;
      const ok = await loc
        .fill(value, { timeout: 2500 })
        .then(() => true)
        .catch(async () => {
          await loc.click({ force: true, timeout: 800 }).catch(() => {});
          await loc.fill("", { timeout: 800 }).catch(() => {});
          return loc
            .type(value, { delay: 18, timeout: 4000 })
            .then(() => true)
            .catch(() => false);
        });
      if (ok) return true;
    }
    return false;
  };

  for (const iframeSel of APPLE_AUTH_IFRAME_SELS) {
    if ((await page.locator(iframeSel).count().catch(() => 0)) === 0) continue;
    const frame = page.frameLocator(iframeSel);
    for (const sel of sels) {
      const loc = frame.locator(sel).first();
      if ((await loc.count().catch(() => 0)) === 0) continue;
      const ok = await loc
        .fill(value, { timeout: 2500 })
        .then(() => true)
        .catch(() => false);
      if (ok) return true;
    }
  }

  for (const fr of [...appleAuthFrames(page), page.mainFrame(), ...page.frames()]) {
    if (await tryFill(fr)) return true;
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
        log(`已撳登入繼續（iframe ${sel}）`);
        return true;
      }
    }
  }

  // 只喺 auth iframe 撳，唔好掃 store 主頁（避免 Apple logo）
  for (const fr of authActionFrames(page)) {
    for (const sel of btnSels) {
      const btn = fr.locator(sel).first();
      if ((await btn.count().catch(() => 0)) === 0) continue;
      const ok = await btn
        .click({ force: true, timeout: 1000 })
        .then(() => true)
        .catch(() => false);
      if (ok) {
        log(`已撳登入繼續（auth ${sel}）`);
        return true;
      }
    }
  }
  return false;
}

async function clickLeftAuthActionButton(page: Page): Promise<boolean> {
  // 只喺 auth iframe 入面揀密碼掣；絕對唔好掃 store 主頁（左上角 Apple logo → apple.com/hk）
  for (const iframeSel of APPLE_AUTH_IFRAME_SELS) {
    if ((await page.locator(iframeSel).count().catch(() => 0)) === 0) continue;
    const frame = page.frameLocator(iframeSel);
    const pwd = frame
      .locator("#continue-password")
      .or(
        frame.getByRole("button", {
          name: /繼續使用密碼|使用密碼|Continue with Password|Use Password/i,
        })
      )
      .or(frame.getByText(/繼續使用密碼登入|使用密碼登入/i))
      .first();
    if ((await pwd.count().catch(() => 0)) === 0) continue;
    if (await pwd.click({ force: true, timeout: 1500 }).then(() => true).catch(() => false)) {
      log("已撳左邊／密碼登入掣（iframe）");
      return true;
    }
  }

  for (const fr of authActionFrames(page)) {
    const hit = await fr
      .evaluate(() => {
        const visible = (el: Element) => {
          const r = (el as HTMLElement).getBoundingClientRect();
          const s = window.getComputedStyle(el as HTMLElement);
          return (
            r.width > 12 &&
            r.height > 12 &&
            s.visibility !== "hidden" &&
            s.display !== "none" &&
            s.opacity !== "0"
          );
        };
        const labelOf = (el: HTMLElement) =>
          `${el.innerText || ""} ${el.getAttribute("aria-label") || ""} ${el.id || ""}`;

        const nodes = Array.from(
          document.querySelectorAll("button, a, [role='button']")
        ) as HTMLElement[];
        const actions = nodes.filter((el) => {
          if (!visible(el)) return false;
          const t = labelOf(el);
          const href = (el as HTMLAnchorElement).href || el.getAttribute("href") || "";
          if (/www\.apple\.com\/(hk|hk-zh)\/?$/i.test(href)) return false;
          if (/globalnav|ac-gn|logo|apple-logo/i.test(`${t} ${href} ${el.className}`)) return false;
          if (/取消|cancel|close|關閉|返回|back/i.test(t)) return false;
          if (el.id === "sign-in" && !/密碼|password/i.test(t)) return false;
          // 必須同密碼／其他選項相關
          return (
            el.id === "continue-password" ||
            /密碼|password|其他選項|other options|try another/i.test(t)
          );
        });
        if (!actions.length) return "";
        const pwdBtns = actions.filter((el) =>
          /密碼|password|continue-password/i.test(labelOf(el) + el.id)
        );
        const pool = pwdBtns.length ? pwdBtns : actions;
        pool.sort(
          (a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left
        );
        pool[0]!.click();
        return (labelOf(pool[0]!) || "left-button").trim().slice(0, 80);
      })
      .catch(() => "");
    if (hit) {
      log(`已撳左邊登入掣：${hit}`);
      return true;
    }
  }
  return false;
}

async function hasVisibleApplePasswordField(page: Page): Promise<boolean> {
  for (const fr of authActionFrames(page)) {
    const loc = fr
      .locator(
        "#password_text_field:visible, input[type='password']:visible, input[name='password']:visible, input[autocomplete='current-password']:visible"
      )
      .first();
    if ((await loc.count().catch(() => 0)) === 0) continue;
    if (await loc.isVisible().catch(() => false)) return true;
  }
  for (const iframeSel of APPLE_AUTH_IFRAME_SELS) {
    if ((await page.locator(iframeSel).count().catch(() => 0)) === 0) continue;
    const loc = page
      .frameLocator(iframeSel)
      .locator("#password_text_field, input[type='password']")
      .first();
    if ((await loc.count().catch(() => 0)) > 0 && (await loc.isVisible().catch(() => false))) {
      return true;
    }
  }
  return false;
}

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

  const clickByTexts = async (needles: string[], loosePassword = false): Promise<boolean> => {
    const frames = authActionFrames(page);
    if (!frames.length) return false;
    for (const fr of frames) {
      const hit = await fr
        .evaluate(
          ({ texts, loose }) => {
            const norm = (s: string) =>
              (s || "").replace(/[\s\u00a0\u200b\ufeff]+/g, "").toLowerCase();
            const wanted = texts.map((t) => norm(t));
            const nodes = Array.from(
              document.querySelectorAll("button, a, [role='button'], span, div, li")
            ) as HTMLElement[];
            for (const el of nodes) {
              const raw = `${el.innerText || ""} ${el.getAttribute("aria-label") || ""} ${el.getAttribute("title") || ""}`;
              const href = (el as HTMLAnchorElement).href || el.getAttribute("href") || "";
              if (/www\.apple\.com\/(hk|hk-zh)\/?$/i.test(href)) continue;
              if (/globalnav|ac-gn|logo/i.test(`${raw} ${href}`)) continue;
              const t = norm(raw);
              if (!t || t.length > 120) continue;
              const match = wanted.some((w) => t.includes(w) || w.includes(t));
              const looseHit =
                loose &&
                /密碼|password/i.test(raw) &&
                /繼續|使用|登入|continue|sign|use/i.test(raw);
              if (!match && !looseHit) continue;
              const clickable =
                (el.closest("button, a, [role='button']") as HTMLElement | null) || el;
              if (clickable.id === "sign-in" && !/密碼|password/i.test(raw)) continue;
              clickable.click();
              return true;
            }
            return false;
          },
          { texts: needles, loose: loosePassword }
        )
        .catch(() => false);
      if (hit) return true;
    }
    return false;
  };

  // 0) 左邊掣（只喺 auth iframe）
  if (await clickLeftAuthActionButton(page)) return true;

  // 1) #continue-password（idmsa）
  for (const fr of authActionFrames(page)) {
    const byId = fr
      .locator(
        "#continue-password, button#continue-password, [id*='continue-password' i], button[data-test*='password' i]"
      )
      .first();
    if ((await byId.count().catch(() => 0)) === 0) continue;
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

  // 2) iframe frameLocator only（唔撳 store 主頁）
  for (const iframeSel of APPLE_AUTH_IFRAME_SELS) {
    if ((await page.locator(iframeSel).count().catch(() => 0)) === 0) continue;
    const frame = page.frameLocator(iframeSel);
    const candidates = [
      frame.locator("#continue-password"),
      frame.getByRole("button", {
        name: /繼續使用密碼|使用密碼|Continue with Password|Use Password|Sign in with Password/i,
      }),
      frame.getByRole("link", {
        name: /繼續使用密碼|使用密碼|Continue with Password|Use Password/i,
      }),
      frame.getByText(/繼續使用密碼登入|使用密碼登入|Continue with Password/i),
    ];
    for (const loc of candidates) {
      const el = loc.first();
      if ((await el.count().catch(() => 0)) === 0) continue;
      if (
        await el
          .click({ force: true, timeout: 1500 })
          .then(() => true)
          .catch(() => false)
      ) {
        return true;
      }
    }
  }

  if (await clickByTexts(pwdNeedles, true)) return true;

  if (await clickByTexts(otherNeedles)) {
    await sleep(500);
    if (await clickLeftAuthActionButton(page)) return true;
    if (await clickByTexts(pwdNeedles, true)) return true;
  }
  return false;
}

async function pressEnterOnAppleAuthField(page: Page, kind: "email" | "password"): Promise<void> {
  const sels =
    kind === "email"
      ? ["#account_name_text_field", 'input[type="email"]', 'input[name="accountName"]']
      : ["#password_text_field", 'input[type="password"]', 'input[name="password"]'];
  for (const fr of authActionFrames(page)) {
    for (const sel of sels) {
      const loc = fr.locator(sel).first();
      if ((await loc.count().catch(() => 0)) === 0) continue;
      await loc.focus().catch(() => {});
      await page.keyboard.press("Enter").catch(() => {});
      return;
    }
  }
  for (const iframeSel of APPLE_AUTH_IFRAME_SELS) {
    if ((await page.locator(iframeSel).count().catch(() => 0)) === 0) continue;
    const loc = page.frameLocator(iframeSel).locator(sels.join(", ")).first();
    if ((await loc.count().catch(() => 0)) === 0) continue;
    await loc.focus().catch(() => {});
    await page.keyboard.press("Enter").catch(() => {});
    return;
  }
}

async function signInAppleIdOnOrderPage(
  page: Page,
  appleEmail: string,
  applePassword: string
): Promise<void> {
  log(`Apple ID 登入：${maskEmail(appleEmail)}`);
  await sleep(600);
  const signInUrl = page.url();
  await writeStatus({
    phase: "apple_sign_in",
    message: "Apple ID 登入中…",
    url: signInUrl,
  });

  let emailOk = false;
  for (let i = 0; i < 12; i++) {
    await throwIfStopped();
    await syncWindowFlags().catch(() => {});
    await recoverIfLeftAppleSignIn(page, signInUrl);
    emailOk = await fillInAppleAuthFrame(page, "email", appleEmail);
    if (emailOk) break;
    await sleep(400);
  }
  if (!emailOk) throw new Error("揾唔到／填唔入 Apple ID 電郵欄");

  let advanced = await clickAppleAuthContinue(page);
  if (!advanced) {
    await pressEnterOnAppleAuthField(page, "email");
    advanced = true;
  }
  log("已提交電郵，等左邊「繼續使用密碼登入」…");
  await sleep(900);
  await recoverIfLeftAppleSignIn(page, signInUrl);

  const pwdDeadline = Date.now() + 50_000;
  let sawPassword = false;
  let pwdContinueClicks = 0;
  while (Date.now() < pwdDeadline) {
    await throwIfStopped();
    await syncWindowFlags().catch(() => {});
    if (await recoverIfLeftAppleSignIn(page, signInUrl)) {
      await fillInAppleAuthFrame(page, "email", appleEmail).catch(() => false);
      await clickAppleAuthContinue(page).catch(() => false);
      await sleep(600);
      continue;
    }

    if (await hasVisibleApplePasswordField(page)) {
      sawPassword = true;
      break;
    }

    const clicked =
      (await clickContinueWithPasswordFast(page)) || (await clickLeftAuthActionButton(page));
    if (clicked) {
      pwdContinueClicks += 1;
      log(`已撳左邊／密碼登入掣（第 ${pwdContinueClicks} 次）`);
      await writeStatus({
        phase: "apple_sign_in",
        message: "已撳繼續使用密碼登入（左邊掣）",
        url: page.url(),
      });
      await sleep(700);
      await recoverIfLeftAppleSignIn(page, signInUrl);
    } else {
      await sleep(400);
    }
  }

  if (!sawPassword) {
    for (let i = 0; i < 8; i++) {
      await recoverIfLeftAppleSignIn(page, signInUrl);
      await clickLeftAuthActionButton(page);
      await clickContinueWithPasswordFast(page);
      await sleep(500);
      if (await hasVisibleApplePasswordField(page)) {
        sawPassword = true;
        log("補撳左邊掣後已見密碼欄");
        break;
      }
    }
  }
  if (!(await hasVisibleApplePasswordField(page))) {
    throw new Error("未見到密碼欄 — 請確認已撳左邊「繼續使用密碼登入」");
  }

  let passOk = false;
  for (let round = 1; round <= 12; round++) {
    await throwIfStopped();
    await syncWindowFlags().catch(() => {});
    await recoverIfLeftAppleSignIn(page, signInUrl);
    passOk = await fillInAppleAuthFrame(page, "password", applePassword);
    if (passOk) break;
    await clickContinueWithPasswordFast(page).catch(() => {});
    await clickLeftAuthActionButton(page).catch(() => {});
    await sleep(450);
  }
  if (!passOk) throw new Error("揾唔到／填唔入密碼欄（請確認已出現「繼續使用密碼登入」）");

  await clickAppleAuthContinue(page);
  await pressEnterOnAppleAuthField(page, "password");
  log("已提交密碼（右箭頭／繼續）");

  const leaveDeadline = Date.now() + 45_000;
  while (Date.now() < leaveDeadline) {
    await throwIfStopped();
    await syncWindowFlags().catch(() => {});
    if (await recoverIfLeftAppleSignIn(page, signInUrl)) {
      await fillInAppleAuthFrame(page, "password", applePassword).catch(() => false);
      await clickAppleAuthContinue(page).catch(() => false);
      await sleep(600);
      continue;
    }
    const url = page.url();
    if (!/\/shop\/signIn/i.test(url) && !isAppleMarketingHome(url)) {
      log(`Apple ID 登入後頁面：${url}`);
      await writeStatus({ phase: "apple_signed_in", message: "Apple ID 已登入", url });
      return;
    }
    if (await hasVisibleApplePasswordField(page)) {
      await clickAppleAuthContinue(page).catch(() => {});
    } else {
      await clickContinueWithPasswordFast(page).catch(() => {});
    }
    await sleep(600);
  }
  if (/\/shop\/signIn/i.test(page.url()) || isAppleMarketingHome(page.url())) {
    throw new Error(`Apple ID 登入後仍停喺：${page.url()}`);
  }
}

function isGmailInboxUrl(url: string): boolean {
  return (
    /mail\.google\.com\/mail\//i.test(url) ||
    (/mail\.google\.com/i.test(url) && !/accounts\.google\.com/i.test(url))
  );
}

async function dismissGmailOverlays(page: Page): Promise<void> {
  const labels = [
    /^(Got it|我知道了|了解|確定|OK|Close|關閉|稍後|Not now|暫時不要)$/i,
    /^(Accept all|全部接受)$/i,
  ];
  for (const re of labels) {
    await page
      .getByRole("button", { name: re })
      .first()
      .click({ timeout: 800 })
      .catch(() => {});
  }
}

/** 確保已喺 Gmail 收件箱 UI（登入後有時停喺 /mail/u/0/ 中轉頁） */
async function ensureGmailInbox(page: Page): Promise<void> {
  const target = "https://mail.google.com/mail/u/0/#inbox";
  const url0 = page.url();
  // 即使已係 mail.google.com，都強制入 #inbox（避免停喺 /mail/u/0/）
  if (!/#inbox\b/i.test(url0) || !isGmailInboxUrl(url0)) {
    log("導向 Gmail 收件箱 #inbox…");
    await page.goto(target, { waitUntil: "domcontentloaded", timeout: 90_000 }).catch(() => {});
  }
  await dismissGmailOverlays(page);

  for (let i = 0; i < 20; i++) {
    await throwIfStopped();
    await syncWindowFlags().catch(() => {});
    const url = page.url();
    if (/accounts\.google\.com/i.test(url)) {
      await page
        .getByRole("button", { name: /^(Next|下一步|繼續|Continue|我了解)$/i })
        .first()
        .click({ timeout: 1500 })
        .catch(() => {});
      await page.goto(target, { waitUntil: "domcontentloaded", timeout: 60_000 }).catch(() => {});
    }
    await dismissGmailOverlays(page);

    const search = page
      .locator(
        'input[aria-label*="Search" i], input[aria-label*="搜尋" i], input[name="q"], form[role="search"] input, input[placeholder*="Search mail" i]'
      )
      .first();
    if ((await search.count().catch(() => 0)) > 0 && (await search.isVisible().catch(() => false))) {
      log(`已入 Gmail 收件箱：${page.url()}`);
      await writeStatus({ phase: "gmail_ready", message: "Gmail 已開啟", url: page.url() });
      await sleep(600);
      return;
    }
    const inboxUi = page.locator('div[role="main"], div.AO, table.F, div.Cp').first();
    if ((await inboxUi.count().catch(() => 0)) > 0) {
      // 有主體但未有搜尋欄：再 refresh 一次 hash
      if (!/#inbox\b/i.test(page.url())) {
        await page.goto(target, { waitUntil: "domcontentloaded", timeout: 60_000 }).catch(() => {});
      } else {
        log(`已入 Gmail UI：${page.url()}`);
        await sleep(800);
        return;
      }
    }
    await sleep(700);
  }
  await page.goto(target, { waitUntil: "domcontentloaded", timeout: 90_000 }).catch(() => {});
  await sleep(1500);
  log(`Gmail 現況：${page.url()}`);
}

/** 真正要額外驗證嘅 challenge（唔包括密碼頁 challenge/pwd、captcha 字元頁） */
function isExtraGoogleChallenge(url: string): boolean {
  if (/\/challenge\/pwd\b/i.test(url)) return false;
  if (/captcha|recaptcha|identifier/i.test(url) && /challenge/i.test(url)) return false;
  return /\/challenge\/(totp|iap|selection|sk|dp|kpe|ootp|bc|pk|sms|wa|idv|ipp)/i.test(
    url
  ) || /\/signin\/challenge\/(?:totp|iap|selection)/i.test(url);
}

/** Google 畫面驗證碼：要輸入數字+英文字母（唔好誤判密碼頁） */
async function isCaptchaChallengePage(page: Page): Promise<boolean> {
  const url = page.url();
  // 密碼頁唔當 captcha
  if (/\/challenge\/pwd\b/i.test(url)) return false;
  const pwdVisible =
    (await page
      .locator('input[type="password"]:visible, input[name="Passwd"]:visible')
      .count()
      .catch(() => 0)) > 0;
  if (pwdVisible) return false;

  if (/[?&]captcha=|\/captcha|recaptcha|challenge\/ipp|challenge\/bc/i.test(url)) {
    return true;
  }
  const hit = await page
    .evaluate(() => {
      // 有密碼欄 = 唔係 captcha
      if (
        document.querySelector(
          'input[type="password"], input[name="Passwd"], #password'
        )
      ) {
        const pwd = document.querySelector(
          'input[type="password"], input[name="Passwd"]'
        ) as HTMLElement | null;
        if (pwd && pwd.offsetParent !== null) return false;
      }
      // 經典 captcha 圖／欄
      if (
        document.querySelector(
          'img#captchaimg, img[src*="captcha" i], #captchaimg, input[name*="captcha" i], input[id*="captcha" i]'
        )
      ) {
        return true;
      }
      const t = (document.body?.innerText || "").slice(0, 4000);
      return /輸入你看到的字|輸入畫面中的字|Type the text|Enter the characters|characters you see|Enter the letters|輸入字元/i.test(
        t
      );
    })
    .catch(() => false);
  return Boolean(hit);
}

async function tryOcrCaptchaText(imagePath: string): Promise<string | null> {
  // 需要本機已裝 tesseract（PATH）。冇就返回 null → 人手填。
  return await new Promise((resolve) => {
    const child = spawn(
      "tesseract",
      [imagePath, "stdout", "-l", "eng", "--psm", "7"],
      { windowsHide: true }
    );
    let out = "";
    let err = "";
    child.stdout?.on("data", (b) => {
      out += b.toString("utf8");
    });
    child.stderr?.on("data", (b) => {
      err += b.toString("utf8");
    });
    child.on("error", () => resolve(null));
    child.on("exit", (code) => {
      if (code !== 0) {
        if (err) log(`tesseract：${err.trim().slice(0, 120)}`);
        resolve(null);
        return;
      }
      const text = out
        .replace(/[^a-zA-Z0-9]/g, "")
        .trim();
      resolve(text.length >= 4 ? text : null);
    });
  });
}

/** 經典圖片驗證碼（數字+英文字母）盡力 OCR；reCAPTCHA／勾選式做唔到 */
async function tryAutoSolveImageCaptcha(page: Page): Promise<boolean> {
  const img = page
    .locator(
      'img#captchaimg, img[src*="captcha" i], img[alt*="captcha" i], #captcha img, form img[src*="Captcha" i]'
    )
    .first();
  if ((await img.count().catch(() => 0)) === 0) {
    log("驗證碼：唔係經典圖片 captcha（可能係 reCAPTCHA），要人手");
    return false;
  }
  const tmp = path.join(ROOT, "runtime", `captcha-${SESSION_ID}.png`);
  await fs.mkdir(path.dirname(tmp), { recursive: true }).catch(() => {});
  await img.screenshot({ path: tmp }).catch(() => null);
  const text = await tryOcrCaptchaText(tmp);
  await fs.unlink(tmp).catch(() => {});
  if (!text) {
    log("驗證碼：OCR 失敗／未裝 tesseract — 請人手輸入");
    return false;
  }
  log(`驗證碼：OCR 結果 ${text}，嘗試自動填入…`);
  const input = page
    .locator(
      'input[name*="captcha" i], input[id*="captcha" i], input[aria-label*="captcha" i], input[type="text"]:visible'
    )
    .first();
  if ((await input.count().catch(() => 0)) === 0) return false;
  await input.click({ timeout: 2000 }).catch(() => {});
  await input.fill(text, { timeout: 3000 }).catch(() => {});
  await clickGoogleNext(page, "identifier").catch(() => {});
  await page.keyboard.press("Enter").catch(() => {});
  await sleep(1200);
  return !(await isCaptchaChallengePage(page));
}

async function waitForManualCaptcha(
  page: Page,
  browser: Browser
): Promise<void> {
  if (isGmailInboxUrl(page.url())) return;
  if (!(await isCaptchaChallengePage(page))) return;
  log("Google 要輸入數字+英文字母驗證碼（保持隱藏；要睇就撳 Open browser）");
  // 登入過程唔自動開窗
  await writeStatus({
    phase: "waiting_captcha",
    message: "請 Open browser 人手輸入驗證碼，完成後撳 Continue",
    windowHidden,
  });

  try {
    if (await tryAutoSolveImageCaptcha(page)) {
      log("驗證碼：自動填入成功");
      return;
    }
  } catch (err) {
    log(`驗證碼自動填入失敗：${err instanceof Error ? err.message : String(err)}`);
  }

  log("請人手輸入驗證碼後撳 Next；或撳 Continue（瀏覽器保持隱藏）");
  const deadline = Date.now() + 15 * 60_000;
  while (Date.now() < deadline) {
    await throwIfStopped();
    await syncWindowFlags().catch(() => {});
    if (await consumeFlag(CONTINUE_FLAG)) {
      log("Continue：繼續檢查是否已過驗證碼");
    }
    // 密碼欄已出 → 驗證碼完
    if (
      (await page
        .locator('input[type="password"]:visible, input[name="Passwd"]:visible')
        .count()
        .catch(() => 0)) > 0
    ) {
      log("已見到密碼欄，離開驗證碼等待");
      return;
    }
    if (isGmailInboxUrl(page.url())) {
      log("驗證碼後已入 Gmail");
      return;
    }
    if (!(await isCaptchaChallengePage(page))) {
      log("已離開驗證碼頁");
      return;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("等驗證碼逾時（15 分鐘）");
}

async function clickGoogleNext(page: Page, which: "identifier" | "password"): Promise<void> {
  const ids =
    which === "identifier"
      ? ["#identifierNext", "#identifierNext button"]
      : ["#passwordNext", "#passwordNext button"];
  for (const sel of ids) {
    const btn = page.locator(sel).first();
    if ((await btn.count().catch(() => 0)) === 0) continue;
    const ok = await btn
      .click({ timeout: 3000 })
      .then(() => true)
      .catch(() => false);
    if (ok) return;
  }
  const textBtn = page
    .getByRole("button", { name: /^(Next|下一步|繼續|Continue)$/i })
    .first();
  if ((await textBtn.count().catch(() => 0)) > 0) {
    const ok = await textBtn.click({ timeout: 3000 }).then(() => true).catch(() => false);
    if (ok) return;
  }
  await page.keyboard.press("Enter").catch(() => {});
}

async function fillGoogleVisibleInput(
  page: Page,
  sels: string[],
  value: string,
  opts?: { isPassword?: boolean }
): Promise<boolean> {
  for (const sel of sels) {
    const loc = page.locator(sel).first();
    if ((await loc.count().catch(() => 0)) === 0) continue;
    const visible = await loc.isVisible().catch(() => false);
    if (!visible) continue;
    await loc.click({ timeout: 2000 }).catch(() => {});
    // Google 密碼欄有時要先 focus 先可入
    await loc.focus().catch(() => {});
    await page.keyboard.press("Control+A").catch(() => {});
    await page.keyboard.press("Backspace").catch(() => {});
    await loc.fill("").catch(() => {});

    let typed = await loc
      .pressSequentially(value, { delay: 40, timeout: 30_000 })
      .then(() => true)
      .catch(() => false);
    if (!typed) {
      typed = await loc
        .fill(value, { timeout: 5000 })
        .then(() => true)
        .catch(() => false);
    }
    if (!typed) {
      typed = await page.keyboard.type(value, { delay: 35 }).then(() => true).catch(() => false);
    }
    if (!typed) {
      typed = await loc
        .evaluate((el, v) => {
          const input = el as HTMLInputElement;
          input.removeAttribute("readonly");
          input.focus();
          input.value = "";
          input.value = v;
          input.dispatchEvent(new Event("input", { bubbles: true }));
          input.dispatchEvent(new Event("change", { bubbles: true }));
          return true;
        }, value)
        .then(() => true)
        .catch(() => false);
    }
    if (!typed) continue;

    // 密碼欄多數讀唔到 inputValue（保安），打完就算成功
    if (opts?.isPassword) return true;
    const got = await loc.inputValue().catch(() => "");
    if (got && got.length >= Math.min(3, value.length)) return true;
    if (opts?.isPassword) return true;
  }
  return false;
}

/** 專門填 Gmail 密碼（Google 密碼欄好刁鑽） */
async function fillGmailPassword(page: Page, password: string): Promise<boolean> {
  const sels = [
    'input[type="password"]',
    'input[name="Passwd"]',
    'input[name="password"]',
    'input[autocomplete="current-password"]',
    '#password input',
    'div[id="password"] input',
  ];
  for (let round = 1; round <= 8; round++) {
    // 等欄位出現
    for (const sel of sels) {
      const loc = page.locator(sel).first();
      if ((await loc.count().catch(() => 0)) === 0) continue;
      await loc.waitFor({ state: "visible", timeout: 3000 }).catch(() => {});
      if (!(await loc.isVisible().catch(() => false))) continue;

      await loc.click({ force: true, timeout: 2000 }).catch(() => {});
      await loc.focus().catch(() => {});
      await sleep(200);
      await page.keyboard.press("Control+A").catch(() => {});
      await page.keyboard.press("Backspace").catch(() => {});

      // 優先人手式逐字
      const okSeq = await loc
        .pressSequentially(password, { delay: 45, timeout: 45_000 })
        .then(() => true)
        .catch(() => false);
      if (okSeq) {
        log(`Gmail 密碼已填（pressSequentially 第 ${round} 次）`);
        return true;
      }

      const okType = await page.keyboard
        .type(password, { delay: 45 })
        .then(() => true)
        .catch(() => false);
      if (okType) {
        log(`Gmail 密碼已填（keyboard.type 第 ${round} 次）`);
        return true;
      }

      const okEval = await loc
        .evaluate((el, v) => {
          const input = el as HTMLInputElement;
          const setter = Object.getOwnPropertyDescriptor(
            HTMLInputElement.prototype,
            "value"
          )?.set;
          input.removeAttribute("readonly");
          input.focus();
          if (setter) setter.call(input, v);
          else input.value = v;
          input.dispatchEvent(new Event("input", { bubbles: true }));
          input.dispatchEvent(new Event("change", { bubbles: true }));
          input.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true }));
          input.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }));
          return (input.value || "").length > 0;
        }, password)
        .catch(() => false);
      if (okEval) {
        log(`Gmail 密碼已填（DOM setter 第 ${round} 次）`);
        return true;
      }
    }
    log(`Gmail 密碼填寫重試 ${round}/8…`);
    await sleep(500);
  }
  return false;
}

async function gmailLogin(page: Page, email: string, password: string): Promise<void> {
  log(`Gmail 登入：${maskEmail(email)}`);
  await page.goto(
    "https://accounts.google.com/v3/signin/identifier?continue=https%3A%2F%2Fmail.google.com%2Fmail%2Fu%2F0%2F&service=mail&flowName=GlifWebSignIn&flowEntry=ServiceLogin",
    { waitUntil: "domcontentloaded", timeout: 90_000 }
  );
  await sleep(1000);

  // 帳號選擇／已登入
  if (isGmailInboxUrl(page.url())) {
    log("已入 Gmail（既有 session）");
    await ensureGmailInbox(page);
    return;
  }

  const useAnother = page
    .getByRole("link", { name: /Use another account|使用其他帳戶|新增帳戶|Add account/i })
    .or(page.locator('div[data-identifier], li[data-identifier]').filter({ hasText: /another|其他/i }))
    .first();
  if ((await useAnother.count().catch(() => 0)) > 0) {
    await useAnother.click({ timeout: 3000 }).catch(() => {});
    await sleep(600);
  }

  // 電郵
  const emailOk = await fillGoogleVisibleInput(page, [
    'input[type="email"]',
    'input[name="identifier"]',
    "#identifierId",
    'input[autocomplete="username"]',
  ], email);
  if (!emailOk) throw new Error("揾唔到／填唔入 Gmail 電郵欄");
  await clickGoogleNext(page, "identifier");
  log("已提交電郵，等密碼頁…");

  // 等密碼頁；驗證碼後可能已直接入 Gmail，唔好再死等密碼欄
  const pwdDeadline = Date.now() + 45_000;
  let pwdReady = false;
  while (Date.now() < pwdDeadline) {
    if (isGmailInboxUrl(page.url())) {
      log("已入 Gmail（跳過密碼），繼續流程");
      await ensureGmailInbox(page);
      return;
    }
    if (activeBrowser) await waitForManualCaptcha(page, activeBrowser);
    if (isGmailInboxUrl(page.url())) {
      log("驗證碼後已入 Gmail，繼續流程");
      await ensureGmailInbox(page);
      return;
    }
    if (isExtraGoogleChallenge(page.url())) {
      if (activeBrowser) {
        // 登入期間唔自動開窗；要睇就撳 Open browser
        await writeStatus({
          phase: "waiting_user",
          message: "需要額外驗證 — 請 Open browser 人手完成後撳 Continue",
          windowHidden,
        });
        while (Date.now() < pwdDeadline) {
          await throwIfStopped();
          await syncWindowFlags().catch(() => {});
          if (isGmailInboxUrl(page.url())) {
            await ensureGmailInbox(page);
            return;
          }
          if (await consumeFlag(CONTINUE_FLAG)) break;
          if (
            (await page.locator('input[type="password"]:visible').count().catch(() => 0)) > 0
          ) {
            break;
          }
          await new Promise((r) => setTimeout(r, 400));
        }
      } else {
        throw new Error(`Gmail 需要額外驗證：${page.url()}`);
      }
    }
    const pwd = page
      .locator('input[type="password"]:visible, input[name="Passwd"]:visible, input[name="password"]:visible')
      .first();
    if ((await pwd.count().catch(() => 0)) > 0 && (await pwd.isVisible().catch(() => false))) {
      pwdReady = true;
      break;
    }
    const tryPwd = page.getByRole("button", { name: /password|密碼/i }).first();
    if ((await tryPwd.count().catch(() => 0)) > 0) {
      await tryPwd.click({ timeout: 1500 }).catch(() => {});
    }
    await sleep(350);
  }
  if (!pwdReady) {
    if (isGmailInboxUrl(page.url()) || /mail\.google\.com/i.test(page.url())) {
      log("未見密碼欄但已在 Gmail，繼續");
      await ensureGmailInbox(page);
      return;
    }
    log("未見密碼欄，嘗試直接打開 Gmail…");
    await page
      .goto("https://mail.google.com/mail/u/0/#inbox", {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      })
      .catch(() => {});
    if (isGmailInboxUrl(page.url())) {
      await ensureGmailInbox(page);
      return;
    }
    throw new Error(`等唔到密碼欄：${page.url()}`);
  }

  let passOk = false;
  for (let round = 1; round <= 3; round++) {
    if (isGmailInboxUrl(page.url())) {
      await ensureGmailInbox(page);
      return;
    }
    passOk = await fillGmailPassword(page, password);
    if (passOk) break;
    log(`密碼欄重試包 ${round}/3…`);
    await sleep(600);
  }
  if (!passOk) {
    if (activeBrowser) {
      await writeStatus({
        phase: "waiting_password",
        message: "自動填密碼失敗 — 請 Open browser 人手輸入密碼後撳 Continue",
        windowHidden,
      });
      log("自動填密碼失敗：保持隱藏；請 Open browser 入密碼後 Continue");
      const waitPwd = Date.now() + 15 * 60_000;
      while (Date.now() < waitPwd) {
        await throwIfStopped();
        await syncWindowFlags().catch(() => {});
        if (isGmailInboxUrl(page.url())) {
          await ensureGmailInbox(page);
          return;
        }
        if (await consumeFlag(CONTINUE_FLAG)) {
          log("Continue：假設密碼已人手填好，繼續");
          passOk = true;
          break;
        }
        if (isGmailInboxUrl(page.url()) || !/\/challenge\/pwd\b/i.test(page.url())) {
          if (!/accounts\.google\.com\/v3\/signin\/identifier/i.test(page.url())) {
            passOk = true;
            break;
          }
        }
        await sleep(500);
      }
    }
  }
  if (!passOk) throw new Error("填唔入 Gmail 密碼");

  if (isGmailInboxUrl(page.url())) {
    await ensureGmailInbox(page);
    return;
  }

  await clickGoogleNext(page, "password");
  log("已提交密碼，等入 Gmail…");

  const deadline = Date.now() + 15 * 60_000;
  while (Date.now() < deadline) {
    const url = page.url();
    if (isGmailInboxUrl(url)) {
      log("已入 Gmail");
      await ensureGmailInbox(page);
      return;
    }
    if (activeBrowser) await waitForManualCaptcha(page, activeBrowser);
    if (isGmailInboxUrl(page.url())) {
      await ensureGmailInbox(page);
      return;
    }
    if (isExtraGoogleChallenge(page.url())) {
      if (activeBrowser) {
        await writeStatus({
          phase: "waiting_user",
          message: "需要額外驗證 — 請 Open browser 人手完成後撳 Continue",
          windowHidden,
        });
        await syncWindowFlags().catch(() => {});
        if (await consumeFlag(CONTINUE_FLAG)) continue;
      }
    }
    if (/\/challenge\/pwd\b/i.test(url)) {
      await fillGmailPassword(page, password).catch(() => false);
      await clickGoogleNext(page, "password");
    }
    if (await consumeFlag(CONTINUE_FLAG)) {
      log("Continue：強制打開 Gmail");
      await page
        .goto("https://mail.google.com/mail/u/0/#inbox", {
          waitUntil: "domcontentloaded",
          timeout: 60_000,
        })
        .catch(() => {});
    }
    // 中轉頁：主動導去 inbox
    if (/accounts\.google\.com/i.test(url) && !/challenge|identifier|pwd/i.test(url)) {
      await page
        .goto("https://mail.google.com/mail/u/0/#inbox", {
          waitUntil: "domcontentloaded",
          timeout: 60_000,
        })
        .catch(() => {});
    }
    const err = page.locator('[aria-live="assertive"], div[jsname="B34EJ"], span[jsname="B34EJ"]').first();
    if ((await err.count().catch(() => 0)) > 0) {
      const t = ((await err.textContent().catch(() => "")) || "").trim();
      if (t && /wrong|incorrect|密碼|password|couldn't|無法/i.test(t)) {
        throw new Error(`Gmail 登入被拒：${t}`);
      }
    }
    await sleep(500);
  }
  await page
    .goto("https://mail.google.com/mail/u/0/#inbox", {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    })
    .catch(() => {});
  if (isGmailInboxUrl(page.url())) {
    await ensureGmailInbox(page);
    return;
  }
  throw new Error(`Gmail 登入逾時：${page.url()}`);
}

async function gmailSearchAndOpenOrderEmail(page: Page, orderNumber: string): Promise<void> {
  const keyword = String(orderNumber || "").trim();
  if (!keyword) throw new Error("缺少訂單編號，無法搜尋 Gmail");
  const enc = encodeURIComponent(keyword);
  const searchUrl = `https://mail.google.com/mail/u/0/#search/${enc}`;
  const urlHasKeyword = (url: string) => {
    try {
      return decodeURIComponent(url).includes(keyword) || url.includes(enc);
    } catch {
      return url.includes(enc) || url.includes(keyword);
    }
  };
  /** 淨係 #search/訂單/threadId 先算正確 —— #inbox/xxx 係錯信，唔接受 */
  const isCorrectOrderThreadUrl = (url: string) => {
    const hash = url.split("#")[1] || "";
    const parts = hash.split("/").filter(Boolean);
    if (parts[0] !== "search" || parts.length < 3) return false;
    try {
      const q = decodeURIComponent(parts[1] || "");
      return q.includes(keyword) || parts[1] === enc || urlHasKeyword(url);
    } catch {
      return urlHasKeyword(url);
    }
  };

  log(`搜尋郵件（訂單編號）：${keyword}…`);
  await writeStatus({
    phase: "search_email",
    message: `搜尋訂單「${keyword}」…`,
    url: page.url(),
    orderNumber: keyword,
  });

  // 若誤入 #inbox/亂 thread：強制返 search
  if (/#inbox\//i.test(page.url()) || !urlHasKeyword(page.url()) || !/#search\//i.test(page.url())) {
    log(`離開錯誤頁 ${page.url()} → 搜尋 ${keyword}`);
    await page
      .evaluate((q) => {
        location.hash = `#search/${encodeURIComponent(q)}`;
      }, keyword)
      .catch(() => {});
    await sleep(400);
    if (!/#search\//i.test(page.url()) || !urlHasKeyword(page.url())) {
      await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 45_000 }).catch(() => {});
    }
  }
  await dismissGmailOverlays(page);

  log(`搜尋結果頁：${page.url()}`);
  await writeStatus({
    phase: "search_email",
    message: `已搜尋「${keyword}」，點開含訂單編號嘅郵件…`,
    url: page.url(),
    orderNumber: keyword,
  });

  const probeList = async () =>
    page
      .evaluate((order) => {
        const main = document.querySelector("div[role='main']") || document.body;
        const za = document.querySelectorAll("tr.zA").length;
        const text = (main.innerText || "").replace(/\s+/g, " ");
        const hasOrder =
          !!order &&
          (text.includes(order) ||
            text.replace(/[\s-]/g, "").includes(String(order).replace(/[\s-]/g, "")));
        return { za, hasOrder, ok: za > 0 || hasOrder };
      }, keyword)
      .catch(() => ({ za: 0, hasOrder: false, ok: false }));

  const listDeadline = Date.now() + 20_000;
  let probe = await probeList();
  while (Date.now() < listDeadline && !probe.ok) {
    await throwIfStopped();
    await dismissGmailOverlays(page);
    probe = await probeList();
    if (probe.ok) break;
    const empty = await page
      .getByText(/沒有與你的搜尋相符|No messages matched|找不到任何郵件/i)
      .first()
      .isVisible()
      .catch(() => false);
    if (empty) throw new Error(`Gmail 搜尋訂單「${keyword}」冇結果`);
    await sleep(400);
  }
  if (!probe.ok) {
    await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 45_000 }).catch(() => {});
    await sleep(800);
    probe = await probeList();
  }
  if (!probe.ok) throw new Error(`Gmail 搜尋訂單「${keyword}」搵唔到郵件列`);

  // 已正確開咗 search thread 且正文有訂單 → 跳過
  if (isCorrectOrderThreadUrl(page.url()) && (await messageBodyHasOrder(page, keyword))) {
    log("搜尋結果已打開正確訂單郵件");
  } else {
    // 若而家喺 #inbox/…：先拉返 search 再開
    if (/#inbox\//i.test(page.url())) {
      log(`偵測到錯誤 inbox thread，返回搜尋：${page.url()}`);
      await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 45_000 }).catch(() => {});
      await sleep(600);
    }
    log("點開含訂單編號嘅搜尋結果（唔開 inbox 亂信）…");
    let opened = await openSelectedOrFirstGmailResult(page, keyword);
    if (!opened || /#inbox\//i.test(page.url()) || !(await messageBodyHasOrder(page, keyword))) {
      if (/#inbox\//i.test(page.url())) {
        log("開信後誤入 inbox — 返回 search 再試");
        await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 45_000 }).catch(() => {});
        await sleep(700);
      }
      opened = await openSelectedOrFirstGmailResult(page, keyword);
    }
    // 最終校驗：唔接受 #inbox/xxx
    if (/#inbox\//i.test(page.url())) {
      throw new Error(`開錯郵件（inbox thread）：${page.url()} — 應為 #search/${keyword}/…`);
    }
    if (!opened && !isCorrectOrderThreadUrl(page.url()) && !(await messageBodyHasOrder(page, keyword))) {
      throw new Error(`搜尋結果打唔開訂單「${keyword}」郵件（仍喺 ${page.url()}）`);
    }
  }

  // 再確認唔喺錯 inbox
  if (/#inbox\//i.test(page.url()) && !(await messageBodyHasOrder(page, keyword))) {
    throw new Error(`仍停喺錯誤 inbox thread：${page.url()}`);
  }

  await writeStatus({
    phase: "email_opened",
    message: `已開啟訂單「${keyword}」郵件詳情`,
    url: page.url(),
    orderNumber: keyword,
  });
}

async function messageBodyHasOrder(page: Page, orderNumber: string): Promise<boolean> {
  const n = String(orderNumber || "").trim();
  if (!n) return false;
  const hay = await page
    .locator("div.a3s, h2.hP, div.adn, div[role='main']")
    .first()
    .innerText()
    .catch(() => "");
  const t = String(hay || "");
  return (
    t.includes(n) ||
    t.replace(/[\s-]/g, "").includes(n.replace(/[\s-]/g, "")) ||
    (/訂單狀態|Order Status|View [Yy]our [Oo]rder|Apple Store/i.test(t) && /W\d{7,}/.test(t) && t.includes(n))
  );
}

/**
 * 點開搜尋結果：只開「含訂單編號」嗰封；禁止落到 #inbox/亂 thread。
 */
async function openSelectedOrFirstGmailResult(page: Page, orderNumber: string): Promise<boolean> {
  const keyword = String(orderNumber || "").trim();
  const enc = encodeURIComponent(keyword);

  const urlIsCorrectSearchThread = () => {
    const hash = page.url().split("#")[1] || "";
    const parts = hash.split("/").filter(Boolean);
    if (parts[0] !== "search" || parts.length < 3) return false;
    try {
      return decodeURIComponent(parts[1] || "").includes(keyword) || parts[1] === enc;
    } catch {
      return parts[1] === enc;
    }
  };

  const extractOrderThreadId = async (): Promise<string> => {
    return page
      .evaluate((order) => {
        const norm = (s: string) => (s || "").replace(/\s+/g, " ").trim();
        const orderN = String(order || "");
        const hasOrder = (el: Element) => {
          const t = norm((el as HTMLElement).innerText || "");
          return (
            !!orderN &&
            (t.includes(orderN) ||
              t.replace(/[\s-]/g, "").includes(orderN.replace(/[\s-]/g, "")))
          );
        };
        const tidOf = (el: Element | null): string => {
          if (!el) return "";
          const attrs = ["data-legacy-thread-id", "data-thread-id"];
          let cur: Element | null = el;
          for (let i = 0; i < 6 && cur; i++) {
            for (const a of attrs) {
              const v = (cur.getAttribute(a) || "").trim();
              if (v.length > 4) return v;
            }
            const nested = cur.querySelector("[data-legacy-thread-id], [data-thread-id]");
            if (nested) {
              for (const a of attrs) {
                const v = (nested.getAttribute(a) || "").trim();
                if (v.length > 4) return v;
              }
            }
            cur = cur.parentElement;
          }
          return "";
        };

        const rows = Array.from(
          document.querySelectorAll(
            "tr.zA, div[role='main'] div[role='row'], div[role='main'] div[role='listitem']"
          )
        ) as HTMLElement[];
        // 必須優先訂單列（唔好用 selected／第一封 —— 會開錯 inbox 信）
        const pick =
          rows.find((r) => hasOrder(r) && /Apple/i.test(norm(r.innerText || ""))) ||
          rows.find((r) => hasOrder(r)) ||
          null;
        if (!pick) {
          // 全頁 thread id 元素附近有訂單字
          for (const el of Array.from(
            document.querySelectorAll("[data-legacy-thread-id], [data-thread-id]")
          ) as HTMLElement[]) {
            const row = el.closest("tr, div[role='row'], div[role='listitem']") || el;
            if (hasOrder(row)) return tidOf(el) || tidOf(row);
          }
          return "";
        }
        return tidOf(pick);
      }, keyword)
      .catch(() => "");
  };

  const gotoSearchThread = async (tid: string): Promise<boolean> => {
    if (!tid) return false;
    const hash = `#search/${enc}/${tid}`;
    log(`用 thread id 開搜尋結果（避免 inbox）：${hash}`);
    await page
      .evaluate((h) => {
        location.hash = h;
      }, hash)
      .catch(() => {});
    await sleep(800);
    // 若 Gmail 改寫成 #inbox/… → 強制拉返 search hash
    if (/#inbox\//i.test(page.url())) {
      log(`Gmail 改寫成 inbox，強制返 search hash`);
      await page.goto(`https://mail.google.com/mail/u/0/${hash}`, {
        waitUntil: "domcontentloaded",
        timeout: 45_000,
      }).catch(() => {});
      await sleep(700);
    }
    if (/#inbox\//i.test(page.url())) return false;
    return (
      urlIsCorrectSearchThread() ||
      (await messageBodyHasOrder(page, keyword)) ||
      (await isGmailMessageOpen(page))
    );
  };

  // 0) 已正確
  if (urlIsCorrectSearchThread() && (await messageBodyHasOrder(page, keyword))) {
    log("已在正確訂單搜尋 thread");
    return true;
  }

  // 1) 優先 thread id → #search/訂單/tid（最穩，唔經 inbox）
  {
    const tid = await extractOrderThreadId();
    if (tid) {
      if (await gotoSearchThread(tid)) {
        await waitForGmailMessageOpen(page, {
          orderNumber: keyword,
          timeoutMs: 8_000,
          relaxOrderMatch: true,
        });
        if (/#inbox\//i.test(page.url()) && !(await messageBodyHasOrder(page, keyword))) {
          log("thread id 導航後仍係錯 inbox");
        } else {
          return true;
        }
      }
    } else {
      log("抽唔到含訂單嘅 thread id，改撳訂單列…");
    }
  }

  // 2) 只撳「含訂單編號」列（唔撳 selected／第一封）
  await dismissGmailOverlays(page);
  const esc = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const orderRows = [
    page.locator("tr.zA").filter({ hasText: new RegExp(esc, "i") }).first(),
    page.locator("div[role='main'] div[role='row']").filter({ hasText: new RegExp(esc, "i") }).first(),
    page.locator("div[role='main']").getByText(keyword, { exact: false }).first(),
  ];
  for (const row of orderRows) {
    if ((await row.count().catch(() => 0)) === 0) continue;
    if (!(await row.isVisible().catch(() => false))) continue;
    const subject = row.locator("span.bog, .y6 span, td.a4W, span.bqe").first();
    const clickTarget = (await subject.count().catch(() => 0)) > 0 ? subject : row;
    await clickTarget.scrollIntoViewIfNeeded().catch(() => {});
    await clickTarget.click({ timeout: 3000, force: true }).catch(() => {});
    await sleep(500);
    // 若跳去 inbox 但正文有訂單字，仍可接受；否則拉返 search
    if (/#inbox\//i.test(page.url())) {
      if (await messageBodyHasOrder(page, keyword)) {
        log("Gmail 用咗 inbox URL，但正文係正確訂單信");
        return true;
      }
      log("撳錯／被改寫去 inbox，返回 search");
      await page.goto(`https://mail.google.com/mail/u/0/#search/${enc}`, {
        waitUntil: "domcontentloaded",
        timeout: 45_000,
      }).catch(() => {});
      await sleep(500);
      continue;
    }
    if (urlIsCorrectSearchThread() || (await messageBodyHasOrder(page, keyword))) {
      log("已撳開含訂單編號郵件");
      return true;
    }
    await clickTarget.dblclick({ timeout: 2500, force: true }).catch(() => {});
    await sleep(500);
    if (/#inbox\//i.test(page.url()) && !(await messageBodyHasOrder(page, keyword))) {
      await page.goto(`https://mail.google.com/mail/u/0/#search/${enc}`, {
        waitUntil: "domcontentloaded",
        timeout: 45_000,
      }).catch(() => {});
      continue;
    }
    if (urlIsCorrectSearchThread() || (await messageBodyHasOrder(page, keyword))) return true;
    // 只對「已選中嘅訂單列」Enter（唔 ArrowDown，避免揀錯信）
    await page.keyboard.press("Enter").catch(() => {});
    await sleep(400);
    if (/#inbox\//i.test(page.url()) && !(await messageBodyHasOrder(page, keyword))) {
      await page.goto(`https://mail.google.com/mail/u/0/#search/${enc}`, {
        waitUntil: "domcontentloaded",
        timeout: 45_000,
      }).catch(() => {});
      continue;
    }
    if (urlIsCorrectSearchThread() || (await messageBodyHasOrder(page, keyword))) return true;
    break;
  }

  // 3) 再抽一次 thread id
  const tid2 = await extractOrderThreadId();
  if (tid2 && (await gotoSearchThread(tid2))) {
    return urlIsCorrectSearchThread() || (await messageBodyHasOrder(page, keyword));
  }

  // 失敗：如果而家 inbox 又冇訂單字 → false
  if (/#inbox\//i.test(page.url()) && !(await messageBodyHasOrder(page, keyword))) {
    log(`拒絕錯誤 inbox thread：${page.url()}`);
    return false;
  }
  return waitForGmailMessageOpen(page, {
    orderNumber: keyword,
    timeoutMs: 6_000,
    relaxOrderMatch: false,
  });
}

async function isGmailThreadDetailOpen(page: Page, orderNumber?: string): Promise<boolean> {
  const url = page.url();
  const hash = url.split("#")[1] || "";
  const parts = hash.split("/").filter(Boolean);
  const onSearchThread = parts[0] === "search" && parts.length >= 3;
  const onInboxThread = (parts[0] === "inbox" || parts[0] === "all") && parts.length >= 2;

  // 有訂單編號時：#inbox thread 必須正文含訂單，否則當未開對
  if (orderNumber) {
    if (onSearchThread) {
      const q = (() => {
        try {
          return decodeURIComponent(parts[1] || "");
        } catch {
          return parts[1] || "";
        }
      })();
      if (q.includes(orderNumber) && (await isGmailMessageOpen(page))) return true;
      if (await messageBodyHasOrder(page, orderNumber)) return true;
    }
    if (onInboxThread) {
      return messageBodyHasOrder(page, orderNumber);
    }
    if (await isGmailMessageOpen(page)) {
      return messageBodyHasOrder(page, orderNumber);
    }
    return false;
  }

  if ((onSearchThread || onInboxThread) && (await isGmailMessageOpen(page))) return true;
  return isGmailMessageOpen(page);
}

async function isGmailMessageOpen(page: Page): Promise<boolean> {
  // 主旨欄 或 正文
  const subject = page.locator("h2.hP").first();
  if ((await subject.isVisible().catch(() => false))) {
    const t = ((await subject.innerText().catch(() => "")) || "").trim();
    if (t.length > 2) return true;
  }
  const body = page
    .locator(
      'div.a3s.aiL, div.a3s, div.adn div.a3s, div[data-message-id], div[role="listitem"] div.ii'
    )
    .first();
  if ((await body.count().catch(() => 0)) === 0) return false;
  if (!(await body.isVisible().catch(() => false))) return false;
  const t = ((await body.innerText().catch(() => "")) || "").trim();
  return t.length > 15;
}

/** 等 Gmail 郵件正文真正打開（唔係淨係 highlight 列表） */
async function waitForGmailMessageOpen(
  page: Page,
  opts?: { orderNumber?: string; timeoutMs?: number; relaxOrderMatch?: boolean }
): Promise<boolean> {
  const orderNumber = String(opts?.orderNumber || "").trim();
  const normKey = orderNumber.replace(/[\s-]/g, "");
  const relax = opts?.relaxOrderMatch === true;
  const deadline = Date.now() + (opts?.timeoutMs ?? 20_000);
  while (Date.now() < deadline) {
    await throwIfStopped();
    await syncWindowFlags().catch(() => {});
    await page
      .getByText(/顯示完整郵件|顯示整個郵件|View entire message|View full message/i)
      .first()
      .click({ timeout: 400 })
      .catch(() => {});

    if (await isGmailThreadDetailOpen(page, orderNumber)) {
      log("郵件正文已打開");
      return true;
    }

    if (await isGmailMessageOpen(page)) {
      if (!orderNumber || relax) {
        log("郵件正文已打開");
        return true;
      }
      const bodyText = await page
        .locator("div.a3s, div.adn div.a3s, div[role='listitem'] div.ii, h2.hP")
        .first()
        .innerText()
        .catch(() => "");
      const hay = String(bodyText || "");
      if (
        hay.includes(orderNumber) ||
        hay.replace(/[\s-]/g, "").includes(normKey) ||
        /訂單狀態|查看訂單|Order Status|View [Yy]our [Oo]rder|Track [Oo]rder|Apple/i.test(hay)
      ) {
        log("郵件正文已打開（對應訂單）");
        return true;
      }
    }

    await page.keyboard.press("Enter").catch(() => {});
    await page.keyboard.press("o").catch(() => {});
    await sleep(350);
  }
  log("警告：未確認郵件正文／訂單編號");
  return false;
}

/**
 * 郵件已開時：最快路徑撳「訂單狀態」
 * — 一次 DOM 定位（優先文字＝訂單狀態，其次 Apple order href）
 * — 短等 popup／同頁導航，唔再巢狀 regex×scope 輪詢
 */
async function clickOrderStatusInEmail(page: Page, context: BrowserContext): Promise<Page> {
  log("喺郵件詳情入面撳「訂單狀態」…");
  await dismissGmailOverlays(page).catch(() => {});

  // 已在 thread URL（#search/訂單/threadId）就唔使再等正文；只短等 body
  const hashParts = (page.url().split("#")[1] || "").split("/").filter(Boolean);
  const alreadyOnThread = hashParts[0] === "search" && hashParts.length >= 3;
  if (!alreadyOnThread && !(await isGmailMessageOpen(page))) {
    await waitForGmailMessageOpen(page, { timeoutMs: 6_000 }).catch(() => false);
  }

  // 展開截斷郵件（一次、唔 sleep）
  await page
    .evaluate(() => {
      const nodes = Array.from(document.querySelectorAll("span, a, div, button")) as HTMLElement[];
      for (const el of nodes) {
        const t = (el.innerText || "").trim();
        if (/^(顯示完整郵件|顯示整個郵件|View entire message|View full message)$/i.test(t)) {
          el.click();
          return true;
        }
      }
      return false;
    })
    .catch(() => false);

  const before = new Set(context.pages());
  // 先掛 popup listener，再 click，避免錯過新分頁
  const popupPromise = context.waitForEvent("page", { timeout: 4_000 }).catch(() => null);

  // 一次 evaluate：搵最佳連結並 click（最快、最穩）
  const clickResult = await page
    .evaluate(() => {
      const norm = (s: string) => (s || "").replace(/[\s\u00a0\u200b\u200c\u200d\ufeff]+/g, "");
      const roots = Array.from(
        document.querySelectorAll("div.a3s, div.adn, div[data-message-id], div.ii")
      ) as HTMLElement[];
      const searchRoots = roots.length ? roots : [document.body];

      type Cand = { a: HTMLAnchorElement; score: number; why: string };
      const cands: Cand[] = [];

      const scoreAnchor = (a: HTMLAnchorElement): Cand | null => {
        const href = a.href || a.getAttribute("href") || "";
        const label = norm(
          `${a.innerText || ""} ${a.getAttribute("aria-label") || ""} ${a.getAttribute("title") || ""}`
        );
        let score = 0;
        let why = "";
        if (label === "訂單狀態" || label.includes("訂單狀態")) {
          score += 100;
          why = "text:訂單狀態";
        } else if (/查看訂單狀態|檢視訂單狀態|查看你的訂單|查看訂單|檢視訂單|訂單詳情/.test(label)) {
          score += 80;
          why = "text:訂單";
        } else if (/orderstatus|vieworderstatus|viewyourorder|trackorder|checkorder/i.test(label)) {
          score += 70;
          why = "text:en";
        }
        if (/store\.apple\.com|secure\d*\.store\.apple\.com/i.test(href)) score += 40;
        if (/order\/link|vieworder|order\/guest|order\/detail|\/shop\/order/i.test(href)) score += 35;
        if (/google\.com\/url/i.test(href) && /apple\.com/i.test(href)) score += 25;
        if (score < 40) return null;
        if (!why) why = "href";
        return { a, score, why };
      };

      for (const root of searchRoots) {
        for (const a of Array.from(root.querySelectorAll("a[href]")) as HTMLAnchorElement[]) {
          const c = scoreAnchor(a);
          if (c) cands.push(c);
        }
        // 有時「訂單狀態」喺 button／span，外層先係 a
        for (const el of Array.from(root.querySelectorAll("span, td, font, div, button")) as HTMLElement[]) {
          const t = norm(el.innerText || "");
          if (!t.includes("訂單狀態") && !/View\s*Order/i.test(t)) continue;
          if (t.length > 40) continue; // 避免整段正文
          const a =
            (el.closest("a") as HTMLAnchorElement | null) ||
            (el.querySelector("a[href]") as HTMLAnchorElement | null);
          if (!a) continue;
          const c = scoreAnchor(a);
          if (c) {
            c.score += 20;
            c.why = "wrap:訂單狀態";
            cands.push(c);
          }
        }
      }

      cands.sort((x, y) => y.score - x.score);
      const best = cands[0];
      if (!best) return { ok: false, why: "", href: "" };
      best.a.scrollIntoView({ block: "center", inline: "nearest" });
      const href = best.a.href || "";
      best.a.setAttribute("target", "_blank");
      best.a.click();
      return { ok: true, why: best.why, href: href.slice(0, 180), score: best.score };
    })
    .catch(() => ({ ok: false, why: "", href: "" }));

  if (!clickResult || !(clickResult as { ok?: boolean }).ok) {
    // 極短 Playwright fallback（單一 selector）
    const fallback = page
      .locator("div.a3s a, div.adn a, div.ii a")
      .filter({ hasText: /訂單狀態|Order Status|View [Yy]our [Oo]rder/i })
      .first();
    if ((await fallback.count().catch(() => 0)) === 0) {
      throw new Error("郵件詳情入面揾唔到「訂單狀態」掣／連結");
    }
    await fallback.click({ timeout: 2500, force: true }).catch(async () => {
      await fallback.evaluate((n) => {
        (n as HTMLElement).setAttribute("target", "_blank");
        (n as HTMLElement).click();
      });
    });
    log("已撳「訂單狀態」（Playwright fallback）");
  } else {
    const info = clickResult as { why: string; href: string; score?: number };
    log(`已撳「訂單狀態」（${info.why}${info.score != null ? `·${info.score}` : ""}）`);
  }

  // 短等新分頁（已喺 click 前掛 listener）
  {
    const popup = await popupPromise;
    if (popup && !popup.isClosed()) {
      await popup.waitForLoadState("domcontentloaded").catch(() => {});
      log(`已開新分頁：${popup.url()}`);
      return popup;
    }
    for (const p of context.pages()) {
      if (!before.has(p) && !p.isClosed()) {
        await p.waitForLoadState("domcontentloaded").catch(() => {});
        log(`已開新分頁：${p.url()}`);
        return p;
      }
    }
  }

  // 同頁導航（較少見）
  await page
    .waitForURL(
      (u) => /store\.apple\.com|secure\d*\.store\.apple|google\.com\/url/i.test(u.toString()),
      { timeout: 8_000 }
    )
    .catch(() => {});

  if (/google\.com\/url/i.test(page.url())) {
    try {
      const q = new URL(page.url()).searchParams.get("q");
      if (q) {
        await page.goto(q, { waitUntil: "domcontentloaded", timeout: 45_000 }).catch(() => {});
      } else {
        await page
          .waitForURL((u) => /store\.apple\.com|secure\d*\.store\.apple/i.test(u.toString()), {
            timeout: 12_000,
          })
          .catch(() => {});
      }
    } catch {
      /* ignore */
    }
  }

  if (/store\.apple\.com|secure\d*\.store\.apple/i.test(page.url())) {
    log(`訂單頁：${page.url()}`);
    return page;
  }

  // 最後再掃一次新分頁（慢網絡）
  await sleep(400);
  for (const p of context.pages()) {
    if (!before.has(p) && !p.isClosed()) {
      await p.waitForLoadState("domcontentloaded").catch(() => {});
      log(`已開新分頁：${p.url()}`);
      return p;
    }
  }

  throw new Error(`撳咗「訂單狀態」但未去到 Apple（${page.url()}）`);
}

async function waitForAppleOrderFlowPage(page: Page): Promise<void> {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    await throwIfStopped();
    await syncWindowFlags().catch(() => {});
    const url = page.url();
    if (
      isOrderLinkVerifyUrl(url) ||
      isOrderPhoneGateUrl(url) ||
      isAppleGuestOrderUrl(url) ||
      /secure\d*\.store\.apple\.com/i.test(url) ||
      (await pageHasOrderPhoneForm(page))
    ) {
      await sleep(400);
      return;
    }
    if (/google\.com\/url/i.test(url)) {
      try {
        const q = new URL(url).searchParams.get("q");
        if (q) {
          log(`跟住 Google redirect → ${q}`);
          await page.goto(q, { waitUntil: "domcontentloaded", timeout: 60_000 }).catch(() => {});
          continue;
        }
      } catch {
        /* ignore */
      }
    }
    await sleep(300);
  }
  throw new Error(`未到達 Apple 訂單頁：${page.url()}`);
}

/** 同 checkout：可靠填入受控 input（電話用數字比對；文字用 trim 比對） */
async function fillVerifiedInput(field: Locator, value: string): Promise<boolean> {
  if (!(await field.count().catch(() => 0))) return false;
  if (!(await field.isVisible().catch(() => false))) return false;
  await field.scrollIntoViewIfNeeded().catch(() => {});
  await field.click({ force: true, timeout: 2500 }).catch(() => {});
  await field.fill("").catch(() => {});
  await field.fill(value).catch(() => {});

  const digitsOnly = !/[A-Za-z\u4e00-\u9fff]/.test(value);
  const norm = (s: string) =>
    digitsOnly ? String(s || "").replace(/\D/g, "") : String(s || "").trim().replace(/\s+/g, " ");
  const want = norm(value);
  let current = norm((await field.inputValue().catch(() => "")) || "");
  if (current === want || (want && current.includes(want)) || (current && want.includes(current))) {
    return true;
  }

  await field.press("ControlOrMeta+A").catch(() => {});
  await field.press("Backspace").catch(() => {});
  await field.pressSequentially(value, { delay: 20 }).catch(async () => {
    await field.type(value, { delay: 20 }).catch(() => {});
  });
  current = norm((await field.inputValue().catch(() => "")) || "");
  if (current === want || (want && current.includes(want)) || (current && want.includes(current))) {
    return true;
  }

  return field
    .evaluate((el, v) => {
      const input = el as HTMLInputElement;
      const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
      input.focus();
      desc?.set?.call(input, "");
      input.dispatchEvent(new Event("input", { bubbles: true }));
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
      const digitsOnlyInner = !/[A-Za-z\u4e00-\u9fff]/.test(String(v));
      const n = (s: string) =>
        digitsOnlyInner ? s.replace(/\D/g, "") : s.trim().replace(/\s+/g, " ");
      const cur = n(input.value || "");
      const w = n(String(v));
      return cur === w || cur.includes(w) || w.includes(cur);
    }, value)
    .catch(() => false);
}

/** 全部 add-order task 共用：訂單詳情「送貨」編輯資料 */
const ORDER_SHIPPING_EDIT = {
  firstName: "Chi Fung", // 名字
  lastName: "Leung", // 姓氏／姓名
  /** 區域／地區／街道 */
  areaStreet: "37 ko shing street, sai ying pun",
  /** 屋苑或大廈 */
  building: "11b, tai fat building",
} as const;

async function fillLabeledField(
  page: Page,
  labels: Array<string | RegExp>,
  value: string,
  step: string
): Promise<boolean> {
  for (const label of labels) {
    const candidates = [
      page.getByLabel(label).first(),
      page.getByRole("textbox", { name: label }).first(),
      page.getByRole("combobox", { name: label }).first(),
      page.getByPlaceholder(label).first(),
    ];
    for (const field of candidates) {
      if (await fillVerifiedInput(field, value)) {
        log(`已填 ${step}：${value}`);
        return true;
      }
    }
  }
  // id / name / data-autom fallback
  const key = step.toLowerCase();
  const sels: string[] = [];
  if (/姓|last/i.test(key) || step === "姓氏" || step === "姓名") {
    sels.push(
      'input[id*="lastName" i]',
      'input[name*="lastName" i]',
      'input[data-autom*="lastName" i]',
      'input[autocomplete="family-name"]'
    );
  }
  if (/名|first/i.test(key) || step === "名字") {
    sels.push(
      'input[id*="firstName" i]',
      'input[name*="firstName" i]',
      'input[data-autom*="firstName" i]',
      'input[autocomplete="given-name"]'
    );
  }
  if (/區域|街道|street|area/i.test(key)) {
    sels.push(
      'input[id*="street" i]',
      'input[name*="street" i]',
      'input[data-autom*="street" i]',
      'input[id*="addressLine1" i]',
      'textarea[id*="street" i]'
    );
  }
  if (/屋苑|大廈|building/i.test(key)) {
    sels.push(
      'input[id*="street2" i]',
      'input[id*="addressLine2" i]',
      'input[name*="street2" i]',
      'input[data-autom*="building" i]',
      'input[id*="companyName" i]'
    );
  }
  for (const sel of sels) {
    if (await fillVerifiedInput(page.locator(sel).first(), value)) {
      log(`已填 ${step}（${sel}）：${value}`);
      return true;
    }
  }
  return false;
}

/**
 * 訂單詳情頁：喺「送貨：／標準運送」附近撳「編輯」，
 * 填 名字／姓氏／區域／屋苑，再撳「儲存」
 */
async function editOrderShippingAddress(page: Page): Promise<void> {
  log("訂單詳情：編輯送貨地址…");
  await writeStatus({
    phase: "edit_shipping",
    message: "編輯送貨地址…",
    url: page.url(),
  });

  // 等去到 order/detail（登入後可能仍喺 guest／signIn）
  const detailDeadline = Date.now() + 60_000;
  while (Date.now() < detailDeadline) {
    await throwIfStopped();
    await syncWindowFlags().catch(() => {});
    const url = page.url();
    if (/\/shop\/order\/detail\//i.test(url)) break;
    if (isAppleGuestOrderUrl(url)) {
      // guest 上可能要再撳登入
      await clickAddToAppleIdOnce(page).catch(() => {});
    }
    // 已見「送貨」+「編輯」都當可用
    const hasShippingEdit = await page
      .getByText(/標準運送|送貨\s*[:：]/i)
      .first()
      .isVisible()
      .catch(() => false);
    if (hasShippingEdit) break;
    await sleep(400);
  }

  await sleep(500);

  // 喺「送貨／標準運送」區塊搵「編輯」
  const clickedEdit = await page
    .evaluate(() => {
      const norm = (s: string) => (s || "").replace(/[\s\u00a0\u200b]+/g, "");
      const blocks = Array.from(
        document.querySelectorAll("section, div, li, article, tr, td")
      ) as HTMLElement[];
      let best: HTMLElement | null = null;
      let bestScore = 0;
      for (const el of blocks) {
        const t = norm(el.innerText || "").slice(0, 400);
        if (!t.includes("送貨")) continue;
        let score = 0;
        if (t.includes("標準運送")) score += 50;
        if (t.includes("送貨：") || t.includes("送貨:")) score += 30;
        if (/\bEdit\b|編輯/.test(t)) score += 20;
        if (score > bestScore && score >= 50) {
          bestScore = score;
          best = el;
        }
      }
      const roots = best ? [best, best.parentElement, document.body] : [document.body];
      for (const root of roots) {
        if (!root) continue;
        const links = Array.from(root.querySelectorAll("a, button, [role='button']")) as HTMLElement[];
        for (const el of links) {
          const label = norm(`${el.innerText || ""} ${el.getAttribute("aria-label") || ""}`);
          if (label === "編輯" || label === "Edit" || /^編輯/.test(label) || /^Edit$/i.test(label)) {
            // 避免頂欄／無關編輯
            if (el.closest("#globalnav")) continue;
            el.scrollIntoView({ block: "center", inline: "nearest" });
            el.click();
            return true;
          }
        }
      }
      return false;
    })
    .catch(() => false);

  if (!clickedEdit) {
    // Playwright fallback：送貨標題附近嘅「編輯」
    const shippingHeading = page.getByText(/送貨\s*[:：]|標準運送/i).first();
    const nearbyEdit = shippingHeading
      .locator("xpath=ancestor::*[self::section or self::div or self::li][1]")
      .getByRole("link", { name: /^編輯$|^Edit$/i })
      .or(
        shippingHeading
          .locator("xpath=ancestor::*[self::section or self::div or self::li][1]")
          .getByRole("button", { name: /^編輯$|^Edit$/i })
      )
      .first();
    if ((await nearbyEdit.count().catch(() => 0)) > 0) {
      await nearbyEdit.click({ force: true, timeout: 4000 });
    } else {
      const anyEdit = page
        .getByRole("link", { name: /^編輯$|^Edit$/i })
        .or(page.getByRole("button", { name: /^編輯$|^Edit$/i }))
        .first();
      if ((await anyEdit.count().catch(() => 0)) === 0) {
        throw new Error("揾唔到送貨區塊嘅「編輯」掣");
      }
      await anyEdit.click({ force: true, timeout: 4000 });
    }
  }
  log("已撳送貨「編輯」");
  await sleep(800);

  // 等編輯表單
  const formDeadline = Date.now() + 20_000;
  while (Date.now() < formDeadline) {
    await throwIfStopped();
    const ready =
      (await page.getByLabel(/名字|姓氏|姓名|First name|Last name/i).first().isVisible().catch(() => false)) ||
      (await page.locator('input[id*="firstName" i], input[id*="lastName" i]').first().isVisible().catch(() => false));
    if (ready) break;
    await sleep(300);
  }

  const { firstName, lastName, areaStreet, building } = ORDER_SHIPPING_EDIT;

  // 用戶寫「姓名」= Leung、「名字」= Chi Fung（對應 Apple 姓氏／名字）
  const lastOk =
    (await fillLabeledField(page, [/^姓氏$/, /姓氏/, /^姓名$/, /Last name/i, /Family name/i], lastName, "姓氏")) ||
    (await fillLabeledField(page, [/^姓名$/], lastName, "姓名"));
  const firstOk = await fillLabeledField(
    page,
    [/^名字$/, /名字/, /^名$/, /First name/i, /Given name/i],
    firstName,
    "名字"
  );
  const areaOk = await fillLabeledField(
    page,
    [
      /^區域$/,
      /區域\/地區\/街道/,
      /區域.*街道/,
      /街道名稱/,
      /Street/i,
      /Address Line 1/i,
      /^地區$/,
    ],
    areaStreet,
    "區域"
  );
  const buildingOk = await fillLabeledField(
    page,
    [/屋苑或大廈/, /屋苑/, /大廈/, /座數/, /Address Line 2/i, /Building/i],
    building,
    "屋苑或大廈"
  );

  if (!lastOk) throw new Error("填唔入「姓氏／姓名」");
  if (!firstOk) throw new Error("填唔入「名字」");
  if (!areaOk) throw new Error("填唔入「區域」");
  if (!buildingOk) throw new Error("填唔入「屋苑或大廈」");

  await sleep(400);

  // 撳「儲存」
  const saveClicked =
    (await page
      .getByRole("button", { name: /^儲存$|^Save$/i })
      .first()
      .click({ force: true, timeout: 4000 })
      .then(() => true)
      .catch(() => false)) ||
    (await page
      .getByRole("link", { name: /^儲存$|^Save$/i })
      .first()
      .click({ force: true, timeout: 3000 })
      .then(() => true)
      .catch(() => false)) ||
    (await page
      .evaluate(() => {
        const norm = (s: string) => (s || "").replace(/[\s\u00a0]+/g, "");
        for (const el of Array.from(
          document.querySelectorAll("button, a, [role='button'], input[type='submit']")
        ) as HTMLElement[]) {
          if (el.closest("#globalnav")) continue;
          const t = norm(
            `${el.innerText || ""} ${el.getAttribute("aria-label") || ""} ${(el as HTMLInputElement).value || ""}`
          );
          if (t === "儲存" || t === "Save" || t.startsWith("儲存")) {
            el.click();
            return true;
          }
        }
        return false;
      })
      .catch(() => false));

  if (!saveClicked) throw new Error("撳唔到「儲存」");
  log("已撳「儲存」");
  await sleep(1000);

  // 等表單收埋／返回詳情
  const doneDeadline = Date.now() + 20_000;
  while (Date.now() < doneDeadline) {
    await throwIfStopped();
    const stillEditing = await page
      .getByRole("button", { name: /^儲存$|^Save$/i })
      .first()
      .isVisible()
      .catch(() => false);
    if (!stillEditing) break;
    await sleep(400);
  }
  log("送貨地址已儲存");
  await writeStatus({
    phase: "shipping_saved",
    message: "送貨地址已儲存",
    url: page.url(),
  });
}

/**
 * order/link/verify：填 Order summary Phone → 撳「繼續」
 * 實頁欄位：#orderLinkModule.phoneNumber + #orderLinkModule.submit
 * （button accessible name =「繼續 提交你的電話號碼」，唔係淨「繼續」）
 */
async function fillOrderVerifyPhoneAndContinue(page: Page, orderNumber: string): Promise<void> {
  if (/\/shop\/signIn\/orders/i.test(page.url())) {
    const verifyUrl = extractVerifyUrlFromSignInOrders(page.url());
    if (verifyUrl) {
      log(`signIn/orders → goto verify…`);
      await page.goto(verifyUrl, { waitUntil: "domcontentloaded", timeout: 60_000 }).catch(() => {});
      await sleep(1000);
    }
  }

  const appearDeadline = Date.now() + 35_000;
  while (Date.now() < appearDeadline) {
    await throwIfStopped();
    await syncWindowFlags().catch(() => {});
    const url = page.url();
    if (isAppleGuestOrderUrl(url) || /\/shop\/order\/detail\//i.test(url)) {
      log("已過 verify，唔使填電話");
      return;
    }
    if (
      await page
        .getByText(/加入至\s*Apple\s*ID|Add to Apple ID/i)
        .first()
        .isVisible()
        .catch(() => false)
    ) {
      log("已有「加入至 Apple ID」，跳過 verify");
      return;
    }
    if (
      isOrderLinkVerifyUrl(url) ||
      (await page.locator("#orderLinkModule\\.phoneNumber, #orderLinkModule.phoneNumber").count().catch(() => 0)) > 0 ||
      (await pageHasOrderPhoneForm(page))
    ) {
      break;
    }
    if (/\/shop\/signIn\/orders/i.test(url)) {
      const verifyUrl = extractVerifyUrlFromSignInOrders(url);
      if (verifyUrl) {
        await page.goto(verifyUrl, { waitUntil: "domcontentloaded", timeout: 45_000 }).catch(() => {});
      }
    }
    await sleep(400);
  }

  const phoneField = page.locator("#orderLinkModule\\.phoneNumber, input#orderLinkModule\\.phoneNumber").or(
    page.locator('input[id="orderLinkModule.phoneNumber"]')
  );
  const hasOfficialPhone =
    (await phoneField.count().catch(() => 0)) > 0 ||
    (await pageHasOrderPhoneForm(page)) ||
    isOrderLinkVerifyUrl(page.url());
  if (!hasOfficialPhone) {
    const diag = await page
      .evaluate(() => ({
        url: location.href,
        inputs: Array.from(document.querySelectorAll("input")).slice(0, 20).map((i) => ({
          type: i.type,
          name: i.name,
          id: i.id,
          aria: i.getAttribute("aria-label"),
          ph: i.placeholder,
        })),
      }))
      .catch(() => null);
    log(`verify 診斷：${JSON.stringify(diag)}`);
    throw new Error(`未見到訂單電話欄（${page.url()}）`);
  }

  const fromUrl = orderNumberFromAppleUrl(page.url());
  const orderNo = String(orderNumber || fromUrl || "").trim() || fromUrl;
  if (!orderNo) throw new Error("缺少訂單編號（帳號第三段或 URL _w=）");

  const phone = await resolvePhoneForOrderNumber(orderNo);
  log(`verify 填電話（Order summary）：${phone} · ${orderNo}`);
  await writeStatus({
    phase: "order_verify",
    message: `填寫訂單電話 ${phone}…`,
    orderNumber: orderNo,
    url: page.url(),
  });

  const phoneCandidates: Locator[] = [
    page.locator('input[id="orderLinkModule.phoneNumber"]'),
    page.getByRole("textbox", { name: /^電話號碼$/ }),
    page.getByLabel(/^電話號碼$/),
    page.locator('input[type="tel"].form-textbox-input'),
    page.locator('input[type="tel"][autocomplete="tel"]'),
    page.locator('input[type="tel"]'),
  ];

  let filled = false;
  const fillDeadline = Date.now() + 25_000;
  while (Date.now() < fillDeadline && !filled) {
    await throwIfStopped();
    for (const field of phoneCandidates) {
      if (await fillVerifiedInput(field.first(), phone)) {
        filled = true;
        break;
      }
    }
    if (!filled) {
      filled = await page
        .evaluate((v) => {
          const el =
            (document.getElementById("orderLinkModule.phoneNumber") as HTMLInputElement | null) ||
            (document.querySelector('input[type="tel"]') as HTMLInputElement | null);
          if (!el) return false;
          const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
          el.focus();
          desc?.set?.call(el, "");
          el.dispatchEvent(new Event("input", { bubbles: true }));
          desc?.set?.call(el, v);
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
          try {
            el.dispatchEvent(new InputEvent("input", { bubbles: true, data: v, inputType: "insertText" }));
          } catch {
            /* ignore */
          }
          return (el.value || "").replace(/\D/g, "").includes(String(v).replace(/\D/g, ""));
        }, phone)
        .catch(() => false);
    }
    if (filled) break;
    await sleep(400);
  }
  if (!filled) throw new Error(`填唔入電話（Order summary Phone=${phone}）`);
  log(`已填電話 ${phone}`);
  await sleep(400);

  /** 唔好撳 globalnav 嘅 type=submit；專攻 orderLinkModule */
  const clickVerifyContinue = async (): Promise<boolean> => {
    const list = [
      page.locator('button[id="orderLinkModule.submit"]'),
      page.getByRole("button", { name: /繼續\s*提交你的電話號碼|Continue.*phone/i }),
      page.getByRole("button", { name: /繼續|Continue/i }),
      page.locator('button.form-button:has-text("繼續")'),
      page.locator('button.form-button[type="submit"]'),
    ];
    for (const btn of list) {
      const el = btn.first();
      if (!(await el.count().catch(() => 0))) continue;
      if (!(await el.isVisible().catch(() => false))) continue;
      // 等 enable（填完電話後有時短暫 disabled）
      for (let t = 0; t < 16; t++) {
        if (!(await el.isDisabled().catch(() => false))) break;
        await sleep(200);
      }
      await el.scrollIntoViewIfNeeded().catch(() => {});
      const clicked = await el
        .click({ force: true, timeout: 5000 })
        .then(() => true)
        .catch(async () => {
          await el.evaluate((n) => (n as HTMLElement).click()).catch(() => {});
          return true;
        });
      if (clicked) return true;
    }
    return page
      .evaluate(() => {
        const btn = document.getElementById("orderLinkModule.submit") as HTMLButtonElement | null;
        if (btn) {
          btn.click();
          return true;
        }
        for (const el of Array.from(document.querySelectorAll("button.form-button, button")) as HTMLElement[]) {
          const aria = (el.getAttribute("aria-label") || "").replace(/\s+/g, "");
          const text = (el.innerText || "").replace(/\s+/g, "");
          if (el.id?.includes("globalnav")) continue;
          if (aria.includes("繼續") || text === "繼續") {
            el.click();
            return true;
          }
        }
        return false;
      })
      .catch(() => false);
  };

  let continued = false;
  for (let i = 0; i < 12 && !continued; i++) {
    await throwIfStopped();
    continued = await clickVerifyContinue();
    if (continued) {
      log("已撳「繼續」（orderLinkModule.submit）");
      break;
    }
    await sleep(400);
  }
  if (!continued) throw new Error("verify 頁撳唔到「繼續」");

  const leaveDeadline = Date.now() + 35_000;
  let retried = false;
  while (Date.now() < leaveDeadline) {
    await throwIfStopped();
    await syncWindowFlags().catch(() => {});
    const url = page.url();
    if (isAppleGuestOrderUrl(url) || /\/shop\/order\/detail\//i.test(url)) {
      log(`已到訂單詳情：${url}`);
      return;
    }
    if (!isOrderLinkVerifyUrl(url) && !(await pageHasOrderPhoneForm(page))) {
      log(`已離開 verify：${url}`);
      return;
    }
    if (!retried && Date.now() > leaveDeadline - 18_000) {
      retried = true;
      log("仍喺 verify，再填＋繼續…");
      await fillVerifiedInput(page.locator('input[id="orderLinkModule.phoneNumber"]').first(), phone);
      await clickVerifyContinue();
    }
    await sleep(400);
  }
  log(`警告：仍喺 verify：${page.url()}`);
}

async function waitForAppleGuestOrderPage(page: Page): Promise<void> {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    await throwIfStopped();
    await syncWindowFlags().catch(() => {});
    const url = page.url();
    if (isAppleGuestOrderUrl(url) || /\/shop\/order\/detail\//i.test(url)) {
      await sleep(300);
      return;
    }
    // 訪客頁而家用「登入」／signin_orderpage；舊頁用「加入至 Apple ID」
    const ready = await page
      .locator('[data-autom="signin_orderpage"]')
      .or(page.getByRole("link", { name: /^登入$/ }))
      .or(page.getByRole("button", { name: /^登入$/ }))
      .or(page.getByText(/加入至\s*Apple\s*ID|Add to Apple ID|登入至你的\s*Apple\s*ID/i))
      .first()
      .isVisible()
      .catch(() => false);
    if (ready) {
      await sleep(200);
      return;
    }
    if (isOrderLinkVerifyUrl(url)) {
      const orderNo = orderNumberFromAppleUrl(url);
      if (orderNo) {
        log("Guest wait：仍喺 verify，再填電話…");
        await fillOrderVerifyPhoneAndContinue(page, orderNo).catch((err) => {
          log(`再填電話失敗：${err instanceof Error ? err.message : String(err)}`);
        });
      }
      await sleep(400);
      continue;
    }
    if (/google\.com\/url/i.test(url)) {
      try {
        const q = new URL(url).searchParams.get("q");
        if (q) {
          await page.goto(q, { waitUntil: "domcontentloaded", timeout: 60_000 }).catch(() => {});
          continue;
        }
      } catch {
        /* ignore */
      }
    }
    await sleep(300);
  }
  throw new Error(`未到達 Apple 訂單詳情頁：${page.url()}`);
}

/**
 * 訪客／訂單頁：撳「加入至 Apple ID」或新版「登入」(data-autom=signin_orderpage)
 */
async function clickAddToAppleIdOnce(page: Page): Promise<void> {
  log("撳訂單頁「登入／加入至 Apple ID」…");
  await sleep(200);

  // 已喺 signIn／idmsa：唔使再撳
  if (/\/shop\/signIn|idmsa\.apple\.com/i.test(page.url())) {
    log("已喺 Apple 登入頁，跳過再撳");
    return;
  }
  if (appleAuthFrames(page).length > 0) {
    const hasEmail = await page
      .frameLocator("#aid-auth-widget-iFrame")
      .locator("#account_name_text_field, input[type='email']")
      .first()
      .isVisible()
      .catch(() => false);
    if (hasEmail) {
      log("已見 Apple ID 登入框，跳過再撳");
      return;
    }
  }

  const tryClick = async (loc: Locator, label: string): Promise<boolean> => {
    const el = loc.first();
    if (!(await el.count().catch(() => 0))) return false;
    if (!(await el.isVisible().catch(() => false))) return false;
    await el.scrollIntoViewIfNeeded().catch(() => {});
    await el.click({ force: true, timeout: 4000 }).catch(async () => {
      await el.evaluate((n) => (n as HTMLElement).click()).catch(() => {});
    });
    log(`已撳：${label}`);
    return true;
  };

  // 1) 新版訪客頁：data-autom="signin_orderpage"（文字「登入」）
  if (await tryClick(page.locator('a[data-autom="signin_orderpage"], button[data-autom="signin_orderpage"]'), "signin_orderpage（登入）")) {
    await sleep(500);
    return;
  }

  // 2) 舊版「加入至 Apple ID」
  const addLoc = page
    .getByRole("button", { name: /加入至\s*Apple\s*ID|Add to Apple ID/i })
    .or(page.getByRole("link", { name: /加入至\s*Apple\s*ID|Add to Apple ID/i }));
  if (await tryClick(addLoc, "加入至 Apple ID")) {
    await sleep(500);
    return;
  }

  // 3) DOM：優先 signin_orderpage，再文字匹配（避開頂欄亂撳）
  const clicked = await page
    .evaluate(() => {
      const autom = document.querySelector(
        '[data-autom="signin_orderpage"]'
      ) as HTMLElement | null;
      if (autom) {
        autom.click();
        return "signin_orderpage";
      }
      const norm = (s: string) => (s || "").replace(/[\s\u00a0\u200b]+/g, "");
      const needles = ["加入至AppleID", "加入至 Apple ID", "Add to Apple ID", "加入 Apple ID"];
      for (const el of Array.from(
        document.querySelectorAll("button, a, [role='button'], input[type='submit']")
      ) as HTMLElement[]) {
        if (el.closest("#globalnav") || el.id?.includes("globalnav")) continue;
        const t = norm(
          `${el.innerText || ""} ${el.getAttribute("aria-label") || ""} ${(el as HTMLInputElement).value || ""}`
        );
        if (needles.some((n) => t.includes(norm(n)))) {
          el.click();
          return "add_to_apple_id";
        }
      }
      // 訪客頁主 CTA：短文字「登入」+ button/form-button class
      for (const el of Array.from(
        document.querySelectorAll("a.button, a.form-button, button.button, button.form-button")
      ) as HTMLElement[]) {
        if (el.closest("#globalnav")) continue;
        const t = norm(el.innerText || el.getAttribute("aria-label") || "");
        if (t === "登入" || t === "SignIn" || t === "Signin") {
          el.click();
          return "登入";
        }
      }
      return "";
    })
    .catch(() => "");

  if (!clicked) throw new Error("揾唔到「登入／加入至 Apple ID」（訪客訂單頁）");
  log(`已撳訂單登入掣（${clicked}）`);
  await sleep(500);
}

async function processOneAccount(
  browser: Browser,
  account: Account,
  appleEmail: string,
  applePassword: string
): Promise<void> {
  await throwIfStopped();
  log(`======== 開始處理 ${maskEmail(account.email)} ========`);
  await writeStatus({
    phase: "running",
    emailMasked: maskEmail(account.email),
    message: "running",
    windowHidden: true,
  });
  const context = await browser.newContext({
    locale: "zh-HK",
    timezoneId: "Asia/Hong_Kong",
    viewport: {
      width: Math.max(360, WINDOW_WIDTH - 16),
      height: Math.max(400, WINDOW_HEIGHT - 88),
    },
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  });
  const page = await context.newPage();
  activePage = page;
  activeBrowser = browser;
  startFlagPoller();

  // 同 Checkout Dashboard：讀螢幕後按總數鋪位
  const screen = await page
    .evaluate(() => ({
      w: window.screen.availWidth || 1920,
      h: window.screen.availHeight || 1080,
    }))
    .catch(() => ({ w: 1920, h: 1080 }));
  const layout = computeWindowLayout(ACCOUNT_INDEX, WINDOW_TOTAL, screen.w, screen.h);
  windowBounds = {
    left: layout.x,
    top: layout.y,
    width: layout.width,
    height: layout.height,
  };
  await page
    .setViewportSize({
      width: Math.max(360, windowBounds.width - 16),
      height: Math.max(400, windowBounds.height - 88),
    })
    .catch(() => {});
  log(
    `視窗鋪位（同 Checkout）：${windowBounds.width}x${windowBounds.height} @ (${windowBounds.left},${windowBounds.top}) · ${ACCOUNT_INDEX + 1}/${WINDOW_TOTAL}`
  );
  await applyCheckoutWindowBounds(page, true).catch(() => {});
  await maybeMinimizeBrowserWindow(page, browser);
  log(userKeepBrowserOpen ? "瀏覽器保持開啟（用戶 Open browser）" : "瀏覽器已隱藏（minimized）");

  const runSteps = async () => {
    // —— Gmail 之後步驟盡量短、可 resume ——
    const orderNumber = String(account.orderNumber || "").trim();
    if (!orderNumber) throw new Error("缺少訂單編號（格式：email:password:order number）");
    log(`用帳號提供嘅訂單編號搜尋：${orderNumber}`);
    await writeStatus({
      phase: "search_email",
      message: `訂單編號 ${orderNumber}`,
      orderNumber,
      email: account.email,
    });

    // 已喺 Apple verify／訂單頁（任何分頁）：跳過 Gmail，直接填電話／繼續
    {
      // 已喺 order/detail 且可見送貨「編輯」→ 只做送貨編輯
      const detailPage =
        context.pages().find((p) => !p.isClosed() && /\/shop\/order\/detail\//i.test(p.url())) || null;
      if (detailPage) {
        const canEdit = await detailPage
          .getByText(/標準運送|送貨\s*[:：]/i)
          .first()
          .isVisible()
          .catch(() => false);
        if (canEdit) {
          log(`已在訂單詳情（${detailPage.url()}），直接編輯送貨`);
          activePage = detailPage;
          await maybeMinimizeBrowserWindow(detailPage, browser);
          await editOrderShippingAddress(detailPage);
          await writeStatus({
            phase: "steps_complete",
            message: `步驟完成（${orderNumber}）· 送貨已儲存`,
            orderNumber,
            windowHidden: !userKeepBrowserOpen,
            keepOpen: userKeepBrowserOpen,
          });
          log(`完成：${maskEmail(account.email)} · ${orderNumber} → 送貨已儲存`);
          return;
        }
      }

      let applePage: Page | null = null;
      try {
        applePage = await findOrderVerifyPage(context, page, orderNumber);
      } catch {
        applePage =
          context.pages().find((p) => {
            if (p.isClosed()) return false;
            const u = p.url();
            return (
              isOrderLinkVerifyUrl(u) ||
              isOrderPhoneGateUrl(u) ||
              isAppleGuestOrderUrl(u) ||
              /secure\d*\.store\.apple\.com.*\/shop\/order/i.test(u)
            );
          }) || null;
      }
      if (applePage && (isOrderPhoneGateUrl(applePage.url()) || (await pageHasOrderPhoneForm(applePage)) || isAppleGuestOrderUrl(applePage.url()) || /secure\d*\.store\.apple\.com.*\/shop\/order/i.test(applePage.url()))) {
        log(`已在 Apple 訂單流程（${applePage.url()}），跳過 Gmail`);
        activePage = applePage;
        await maybeMinimizeBrowserWindow(applePage, browser);
        if (!/\/shop\/order\/detail\//i.test(applePage.url())) {
          await fillOrderVerifyPhoneAndContinue(applePage, orderNumber);
          await waitForAppleGuestOrderPage(applePage);
          await writeStatus({ phase: "add_to_apple_id", message: "加入至 Apple ID…", orderNumber });
          await clickAddToAppleIdOnce(applePage);
          await signInAppleIdOnOrderPage(applePage, appleEmail, applePassword);
        }
        await editOrderShippingAddress(applePage);
        await writeStatus({
          phase: "steps_complete",
          message: `步驟完成（${orderNumber}）· 送貨已儲存`,
          orderNumber,
          windowHidden: !userKeepBrowserOpen,
          keepOpen: userKeepBrowserOpen,
        });
        log(`完成：${maskEmail(account.email)} · ${orderNumber} → Apple ID + 送貨已儲存`);
        return;
      }
    }

    const onGmail = /mail\.google\.com/i.test(page.url());
    // 登入後先再判斷 URL（唔好用登入前嘅 inbox／舊 hash）
    if (!onGmail) {
      await writeStatus({ phase: "gmail_login", message: "Gmail 登入中…", orderNumber });
      await gmailLogin(page, account.email, account.password);
    } else {
      log(`已在 Gmail（${page.url()}），跳過登入`);
    }

    const afterUrl = page.url();
    const urlHasOrder = (() => {
      try {
        return decodeURIComponent(afterUrl).includes(orderNumber);
      } catch {
        return afterUrl.includes(orderNumber) || afterUrl.includes(encodeURIComponent(orderNumber));
      }
    })();
    const searchHash = (afterUrl.split("#")[1] || "").split("/").filter(Boolean);
    const onSearchThread =
      searchHash[0] === "search" &&
      searchHash.length >= 3 &&
      urlHasOrder;
    const onWrongInboxThread = /#inbox\//i.test(afterUrl);
    const mailOpen = await isGmailMessageOpen(page);
    const bodyOk = onSearchThread && (await messageBodyHasOrder(page, orderNumber));

    // #inbox/亂 thread 或未開正確訂單信 → 必須重新搜尋
    if (onWrongInboxThread || !onSearchThread || !bodyOk) {
      await writeStatus({
        phase: "search_email",
        message: `搜尋／開啟訂單「${orderNumber}」郵件詳情…`,
        orderNumber,
      });
      if (onWrongInboxThread) {
        log(`跳過錯誤 inbox thread：${afterUrl}`);
      }
      if (onSearchThread && mailOpen && bodyOk) {
        log("已在訂單郵件詳情，繼續撳郵件內掣");
      } else {
        await gmailSearchAndOpenOrderEmail(page, orderNumber);
      }
    }

    await writeStatus({
      phase: "order_status",
      message: "喺郵件詳情撳訂單狀態…",
      orderNumber,
    });
    let orderPage = await clickOrderStatusInEmail(page, context);
    activePage = orderPage;
    await maybeMinimizeBrowserWindow(orderPage, browser);

    await writeStatus({ phase: "apple_order", message: "等待 Apple 訂單／verify 頁…", orderNumber });
    await waitForAppleOrderFlowPage(orderPage);

    // 正確分頁：verify 先填電話；已係 guest／detail 就直接去「登入」
    orderPage = await findOrderVerifyPage(context, orderPage, orderNumber).catch(() => orderPage);
    activePage = orderPage;
    if (isOrderLinkVerifyUrl(orderPage.url()) || (await pageHasOrderPhoneForm(orderPage))) {
      await fillOrderVerifyPhoneAndContinue(orderPage, orderNumber);
    } else if (isAppleGuestOrderUrl(orderPage.url()) || /\/shop\/order\/detail\//i.test(orderPage.url())) {
      log(`已係訂單頁（${orderPage.url()}），跳過 verify 填電話`);
    } else {
      // 可能稍慢先到 verify／guest
      await fillOrderVerifyPhoneAndContinue(orderPage, orderNumber).catch((err) => {
        if (isAppleGuestOrderUrl(orderPage.url())) {
          log(`verify 跳過（已到 guest）：${err instanceof Error ? err.message : String(err)}`);
          return;
        }
        throw err;
      });
    }

    await writeStatus({ phase: "apple_order", message: "等待訂單詳情頁…", orderNumber });
    await waitForAppleGuestOrderPage(orderPage);

    await writeStatus({ phase: "add_to_apple_id", message: "登入／加入至 Apple ID…", orderNumber });
    await clickAddToAppleIdOnce(orderPage);
    await signInAppleIdOnOrderPage(orderPage, appleEmail, applePassword);
    await editOrderShippingAddress(orderPage);
    await writeStatus({
      phase: "steps_complete",
      message: `步驟完成（${orderNumber}）· 送貨已儲存`,
      orderNumber,
      windowHidden: !userKeepBrowserOpen,
      keepOpen: userKeepBrowserOpen,
    });
    log(`完成：${maskEmail(account.email)} · ${orderNumber} → Apple ID + 送貨已儲存`);
  };

  for (;;) {
    try {
      await runSteps();
      break;
    } catch (err) {
      if (err instanceof CloseRequestedError) throw err;
      if (err instanceof StopRequestedError) {
        const next = await holdBrowserUntilClose("Stop：已停自動化，瀏覽器保持開啟");
        if (next === "close") throw new CloseRequestedError();
        continue;
      }
      // 其他錯誤：唔關瀏覽器，等 Continue 再試／Close 先關
      log(`步驟錯誤：${err instanceof Error ? err.message : String(err)}`);
      await writeStatus({
        phase: "error",
        message: err instanceof Error ? err.message : String(err),
        windowHidden,
      });
      // 唔自動開窗；要睇就撳 Open browser
      const next = await holdBrowserUntilClose("出錯後保持瀏覽器開啟 — Continue 重試／Close 關閉");
      if (next === "close") throw new CloseRequestedError();
      continue;
    }
  }
  // 步驟完成後若仍喺 verify／訂單頁，Continue 會再跑 runSteps（唔好淨係空等）
  for (;;) {
    const next = await holdBrowserUntilClose("步驟完成，瀏覽器保持開啟");
    if (next === "close") throw new CloseRequestedError();
    try {
      await runSteps();
    } catch (err) {
      if (err instanceof CloseRequestedError) throw err;
      if (err instanceof StopRequestedError) continue;
      log(`Continue 重試錯誤：${err instanceof Error ? err.message : String(err)}`);
      await writeStatus({
        phase: "error",
        message: err instanceof Error ? err.message : String(err),
        windowHidden,
      });
    }
  }
}

async function launchBrowser(): Promise<Browser> {
  const common = {
    headless: false as const,
    args: [
      "--disable-blink-features=AutomationControlled",
      "--disable-features=IsolateOrigins,site-per-process",
      `--window-size=${WINDOW_WIDTH},${WINDOW_HEIGHT}`,
      "--start-minimized",
    ],
    ignoreDefaultArgs: ["--enable-automation"] as string[],
  };
  try {
    return await chromium.launch({ ...common, channel: "chrome" });
  } catch {
    log("本機 Chrome 唔用得，改用 Playwright Chromium");
    return await chromium.launch(common);
  }
}

async function main() {
  await fs.unlink(STOP_ALL_FLAG).catch(() => {});
  await fs.unlink(RELEASE_FLAG).catch(() => {});
  await fs.unlink(CLOSE_FLAG).catch(() => {});
  await fs.unlink(CONTINUE_FLAG).catch(() => {});
  await fs.unlink(SHOW_FLAG).catch(() => {});
  await fs.unlink(HIDE_FLAG).catch(() => {});
  // 新 task 預設隱藏；舊 keepopen 清走（呢次 run 用戶再開先 lock）
  await fs.unlink(KEEP_OPEN_FLAG).catch(() => {});
  userKeepBrowserOpen = false;

  const cfg = await loadConfig();
  const account = cfg.accounts[ACCOUNT_INDEX];
  if (!account) throw new Error(`冇 account index=${ACCOUNT_INDEX}`);
  log(`task ${SESSION_ID} · ${maskEmail(account.email)} · order=${account.orderNumber} · Apple ID=${maskEmail(cfg.appleEmail)}`);
  await writeStatus({
    phase: "starting",
    emailMasked: maskEmail(account.email),
    orderNumber: account.orderNumber,
    message: `starting · ${account.orderNumber}`,
    windowHidden: true,
    keepOpen: false,
    pid: process.pid,
  });

  const browser = await launchBrowser();
  activeBrowser = browser;
  startFlagPoller();
  // 若 dashboard 喺 spawn 後好快撳咗 Open，補讀 keepopen
  await loadKeepBrowserOpenFlag();
  if (userKeepBrowserOpen && activePage) {
    await maximizeBrowserWindow(activePage, browser).catch(() => {});
  }

  let closeBrowser = false;
  try {
    await processOneAccount(browser, account, cfg.appleEmail, cfg.applePassword);
    // 正常唔會走到呢度（會 hold 到 Close）
    closeBrowser = true;
  } catch (err) {
    if (err instanceof CloseRequestedError) {
      log("Close：關閉瀏覽器");
      await writeStatus({ phase: "closed", message: "closed" });
      closeBrowser = true;
    } else {
      log(`失敗：${err instanceof Error ? err.message : String(err)}`);
      await writeStatus({
        phase: "error",
        message: err instanceof Error ? err.message : String(err),
      });
      // 任何未預期錯誤都保持開住，淨係 Close 先關
      for (;;) {
        try {
          const next = await holdBrowserUntilClose("出錯後保持瀏覽器開啟");
          if (next === "close") {
            closeBrowser = true;
            break;
          }
        } catch (e2) {
          if (e2 instanceof CloseRequestedError) {
            closeBrowser = true;
            break;
          }
        }
      }
    }
  } finally {
    stopFlagPoller();
    if (closeBrowser) {
      await browser.close().catch(() => {});
      await writeStatus({ phase: "closed", message: "browser closed", windowHidden: true });
    }
    activeBrowser = null;
    activePage = null;
  }
  log("task 結束");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

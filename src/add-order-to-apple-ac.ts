/**
 * Gmail → Apple Store 訂單狀態 → 「加入至 Apple ID」自動化
 * Config via ADD_ORDER_CONFIG_PATH JSON:
 * {
 *   accounts: [{ email, password }, ...],
 *   appleEmail, applePassword
 * }
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { chromium, type Browser, type BrowserContext, type Frame, type Page } from "playwright";
import { decryptFromFile, maskEmail, redactSecrets } from "./add-order-secrets.js";

type Account = { email: string; password: string };

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
        }))
        .filter((a) => a.email && a.password)
    : [];
  if (!accounts.length) throw new Error("未有有效嘅 Gmail 帳號（email + password）");
  const appleEmail = String(raw.appleEmail || "chifung2010@yahoo.com.hk").trim();
  const applePassword = String(raw.applePassword || "yY6594083");
  if (!appleEmail || !applePassword) throw new Error("缺少 Apple ID 電郵／密碼");
  return { accounts, appleEmail, applePassword };
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
        log(`已撳登入繼續（${sel}）`);
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
        log("已撳登入右箭頭");
        return true;
      }
    }
  }

  for (const fr of [...appleAuthFrames(page), page.mainFrame(), ...page.frames()]) {
    for (const sel of [...btnSels, "button.icon-button", "button.move", "button:has(svg)"]) {
      const btn = fr.locator(sel).first();
      if ((await btn.count().catch(() => 0)) === 0) continue;
      const ok = await btn
        .click({ force: true, timeout: 1000 })
        .then(() => true)
        .catch(() => false);
      if (ok) return true;
    }
  }
  return false;
}

async function clickLeftAuthActionButton(page: Page): Promise<boolean> {
  // signIn/orders：兩個掣並排時撳最左（通常係「繼續使用密碼登入」），避開右邊通行密鑰／#sign-in 箭嘴
  for (const fr of [...appleAuthFrames(page), page.mainFrame(), ...page.frames()]) {
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
          `${el.innerText || ""} ${el.getAttribute("aria-label") || ""} ${el.id || ""} ${el.className || ""}`;

        const nodes = Array.from(
          document.querySelectorAll("button, a, [role='button']")
        ) as HTMLElement[];
        const actions = nodes.filter((el) => {
          if (!visible(el)) return false;
          const t = labelOf(el);
          if (/取消|cancel|close|關閉|返回|back/i.test(t)) return false;
          // 唔好撳電郵欄右邊藍色箭嘴 #sign-in（通常係最右）
          if (el.id === "sign-in" || /aid-continue|icon-button|move/i.test(el.className)) {
            // 除非佢文字本身係密碼
            if (!/密碼|password/i.test(t)) return false;
          }
          return true;
        });
        if (!actions.length) return "";

        // 優先：含密碼字樣
        const pwdBtns = actions.filter((el) => /密碼|password/i.test(labelOf(el)));
        const pool = pwdBtns.length ? pwdBtns : actions;
        pool.sort(
          (a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left
        );
        const target = pool[0]!;
        target.click();
        return (labelOf(target) || "left-button").trim().slice(0, 80);
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
  for (const fr of [...appleAuthFrames(page), page.mainFrame(), ...page.frames()]) {
    const loc = fr
      .locator(
        "#password_text_field:visible, input[type='password']:visible, input[name='password']:visible, input[autocomplete='current-password']:visible"
      )
      .first();
    if ((await loc.count().catch(() => 0)) === 0) continue;
    if (await loc.isVisible().catch(() => false)) return true;
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
    for (const fr of [...appleAuthFrames(page), page.mainFrame(), ...page.frames()]) {
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
              // 避開電郵步右邊 #sign-in 箭嘴
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

  // 0) 左邊掣（密碼選項通常在左）
  if (await clickLeftAuthActionButton(page)) return true;

  // 1) #continue-password（idmsa）
  for (const fr of [...appleAuthFrames(page), page.mainFrame(), ...page.frames()]) {
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

  // 2) iframe + 主頁 role／text
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

  const pageCandidates = [
    page.locator("#continue-password"),
    page.getByRole("button", {
      name: /繼續使用密碼登入|繼續使用密碼|使用密碼登入|Continue with Password|Use Password/i,
    }),
    page.getByRole("link", {
      name: /繼續使用密碼登入|繼續使用密碼|使用密碼登入|Continue with Password|Use Password/i,
    }),
    page.getByText(/繼續使用密碼登入|使用密碼登入/i),
  ];
  for (const loc of pageCandidates) {
    const el = loc.first();
    if ((await el.count().catch(() => 0)) === 0) continue;
    if (!(await el.isVisible().catch(() => false))) continue;
    if (
      await el
        .click({ force: true, timeout: 2000 })
        .then(() => true)
        .catch(async () =>
          el
            .evaluate((n) => {
              (n as HTMLElement).click();
              return true;
            })
            .catch(() => false)
        )
    ) {
      return true;
    }
  }

  if (await clickByTexts(pwdNeedles, true)) return true;

  if (await clickByTexts(otherNeedles)) {
    await sleep(500);
    if (await clickLeftAuthActionButton(page)) return true;
    if (await clickByTexts(pwdNeedles, true)) return true;
    for (const loc of pageCandidates) {
      const el = loc.first();
      if ((await el.count().catch(() => 0)) === 0) continue;
      if (await el.click({ force: true, timeout: 1500 }).then(() => true).catch(() => false)) {
        return true;
      }
    }
  }
  return false;
}

async function pressEnterOnAppleAuthField(page: Page, kind: "email" | "password"): Promise<void> {
  const sels =
    kind === "email"
      ? ["#account_name_text_field", 'input[type="email"]', 'input[name="accountName"]']
      : ["#password_text_field", 'input[type="password"]', 'input[name="password"]'];
  for (const fr of [...appleAuthFrames(page), page.mainFrame(), ...page.frames()]) {
    for (const sel of sels) {
      const loc = fr.locator(sel).first();
      if ((await loc.count().catch(() => 0)) === 0) continue;
      await loc.focus().catch(() => {});
      await page.keyboard.press("Enter").catch(() => {});
      return;
    }
  }
}

async function signInAppleIdOnOrderPage(
  page: Page,
  appleEmail: string,
  applePassword: string
): Promise<void> {
  log(`Apple ID 登入：${maskEmail(appleEmail)}`);
  await sleep(600);
  await writeStatus({
    phase: "apple_sign_in",
    message: "Apple ID 登入中…",
    url: page.url(),
  });

  let emailOk = false;
  for (let i = 0; i < 12; i++) {
    await throwIfStopped();
    await syncWindowFlags().catch(() => {});
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

  const pwdDeadline = Date.now() + 50_000;
  let sawPassword = false;
  let pwdContinueClicks = 0;
  while (Date.now() < pwdDeadline) {
    await throwIfStopped();
    await syncWindowFlags().catch(() => {});

    if (await hasVisibleApplePasswordField(page)) {
      sawPassword = true;
      break;
    }

    // 唔好再撳右邊 #sign-in；專門撳左邊／密碼掣
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
    } else {
      await sleep(400);
    }
  }

  if (!sawPassword) {
    for (let i = 0; i < 8; i++) {
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

  // 確認離開 signIn，唔好假完成
  const leaveDeadline = Date.now() + 45_000;
  while (Date.now() < leaveDeadline) {
    await throwIfStopped();
    await syncWindowFlags().catch(() => {});
    const url = page.url();
    if (!/\/shop\/signIn/i.test(url)) {
      log(`Apple ID 登入後頁面：${url}`);
      await writeStatus({ phase: "apple_signed_in", message: "Apple ID 已登入", url });
      return;
    }
    // 可能仲要撳一次繼續
    if (await hasVisibleApplePasswordField(page)) {
      await clickAppleAuthContinue(page).catch(() => {});
    } else {
      await clickContinueWithPasswordFast(page).catch(() => {});
    }
    await sleep(600);
  }
  if (/\/shop\/signIn/i.test(page.url())) {
    throw new Error(`Apple ID 登入後仍停喺 signIn：${page.url()}`);
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

async function gmailSearchAndOpenOrderEmail(page: Page): Promise<void> {
  const keyword = "出貨";
  log(`搜尋郵件：${keyword}…`);
  await writeStatus({
    phase: "search_email",
    message: `搜尋「${keyword}」郵件…`,
    url: page.url(),
  });

  // 唔好死等 inbox 載完；Gmail 頂欄搜尋通常早過郵件列表出現
  if (!/mail\.google\.com/i.test(page.url())) {
    await page
      .goto("https://mail.google.com/mail/u/0/#inbox", {
        waitUntil: "commit",
        timeout: 60_000,
      })
      .catch(() => {});
  }
  await dismissGmailOverlays(page);

  const searchBox = () =>
    page
      .locator(
        [
          'input[aria-label*="Search mail" i]',
          'input[aria-label*="Search" i]',
          'input[aria-label*="搜尋郵件" i]',
          'input[aria-label*="搜尋" i]',
          'input[name="q"]',
          'form[role="search"] input',
          'div[role="search"] input',
          'input[placeholder*="Search" i]',
          'input[placeholder*="搜尋" i]',
        ].join(", ")
      )
      .first();

  const triggerHashSearch = async (): Promise<boolean> => {
    await page
      .evaluate((q) => {
        const next = `#search/${encodeURIComponent(q)}`;
        // 強制觸發 hashchange（即使已經喺 search）
        if (location.hash === next) location.hash = "#inbox";
        location.hash = next;
      }, keyword)
      .catch(() => {});
    await sleep(900);
    return /#search\//i.test(page.url());
  };

  const typeInSearchBox = async (): Promise<boolean> => {
    // Gmail 快捷鍵「/」聚焦搜尋
    await page.keyboard.press("/").catch(() => {});
    await sleep(350);
    let box = searchBox();
    if (!(await box.isVisible().catch(() => false))) {
      // 再試撳放大鏡／搜尋掣
      await page
        .locator('button[aria-label*="Search" i], button[aria-label*="搜尋" i], div[aria-label*="Search" i]')
        .first()
        .click({ timeout: 1500 })
        .catch(() => {});
      await sleep(400);
      box = searchBox();
    }
    if (!(await box.isVisible().catch(() => false))) return false;

    await box.click({ timeout: 2500 }).catch(() => {});
    await box.fill("").catch(() => {});
    const filled = await box
      .fill(keyword)
      .then(() => true)
      .catch(() => false);
    if (!filled) {
      await page.keyboard.press("Control+A").catch(() => {});
      await page.keyboard.type(keyword, { delay: 40 }).catch(() => {});
    }
    await page.keyboard.press("Enter");
    log(`已喺搜尋欄輸入「${keyword}」並 Enter`);
    await sleep(1500);
    return /#search\//i.test(page.url()) || true;
  };

  let ok = false;
  for (let attempt = 1; attempt <= 10 && !ok; attempt++) {
    await throwIfStopped();
    await syncWindowFlags().catch(() => {});
    await dismissGmailOverlays(page);
    log(`執行搜尋「${keyword}」（第 ${attempt}/10 次）… URL=${page.url()}`);

    // 1) 優先搜尋欄（唔用 full page.goto，避免卡 #inbox loading）
    if (await typeInSearchBox()) {
      ok = true;
      break;
    }
    // 2) SPA hash（唔 reload）
    if (await triggerHashSearch()) {
      log(`已用 hash 搜尋：${page.url()}`);
      ok = true;
      break;
    }
    await sleep(700);
  }

  if (!ok || !/#search\//i.test(page.url())) {
    // 最後先用 commit（唔等 networkidle，減少卡死）
    const searchUrl = `https://mail.google.com/mail/u/0/#search/${encodeURIComponent(keyword)}`;
    log(`fallback goto：${searchUrl}`);
    await page.goto(searchUrl, { waitUntil: "commit", timeout: 45_000 }).catch(() => {});
    await sleep(1500);
    if (!/#search\//i.test(page.url())) {
      await triggerHashSearch();
    }
  }

  // 等到真正進入 search 結果
  const searchDeadline = Date.now() + 40_000;
  while (Date.now() < searchDeadline && !/#search\//i.test(page.url())) {
    await throwIfStopped();
    await syncWindowFlags().catch(() => {});
    log(`仍未入 search（而家 ${page.url()}），再試輸入…`);
    await typeInSearchBox();
    await triggerHashSearch();
    await sleep(1000);
  }
  if (!/#search\//i.test(page.url())) {
    throw new Error(`搜尋「${keyword}」失敗，仍停喺：${page.url()}`);
  }
  log(`已進入搜尋結果：${page.url()}`);
  await writeStatus({
    phase: "search_email",
    message: `已搜尋「${keyword}」`,
    url: page.url(),
  });
  await sleep(1800);
  await dismissGmailOverlays(page);

  const rows = page.locator(
    "tr.zA, div[role='main'] tr.zA, div.Cp tr.zA, div[role='list'] div[role='listitem']"
  );
  const rowDeadline = Date.now() + 45_000;
  let ready = false;
  while (Date.now() < rowDeadline) {
    await throwIfStopped();
    await syncWindowFlags().catch(() => {});
    if ((await rows.count().catch(() => 0)) > 0) {
      ready = true;
      break;
    }
    // 空結果：再觸發一次 hash search
    if (Date.now() % 8000 < 1200) {
      await triggerHashSearch();
    }
    await sleep(800);
  }
  if (!ready) {
    throw new Error(`Gmail 搜尋「${keyword}」搵唔到郵件列 — 請 Open browser 確認`);
  }

  let clicked = false;
  const n = await rows.count().catch(() => 0);
  for (let i = 0; i < Math.min(n, 40); i++) {
    await throwIfStopped();
    const row = rows.nth(i);
    const text = ((await row.innerText().catch(() => "")) || "").replace(/\s+/g, " ");
    if (!text.includes(keyword)) continue;
    // Gmail：單擊有時只係選取，雙擊／Enter 先打開
    await row.click({ timeout: 5000 }).catch(() => {});
    await sleep(400);
    await row.dblclick({ timeout: 5000 }).catch(() => {});
    await page.keyboard.press("Enter").catch(() => {});
    log(`已開啟含「${keyword}」嘅郵件：${text.slice(0, 80)}`);
    clicked = true;
    break;
  }
  if (!clicked) {
    await rows.first().click({ timeout: 5000 }).catch(() => {});
    await sleep(300);
    await rows.first().dblclick({ timeout: 5000 }).catch(() => {});
    await page.keyboard.press("Enter").catch(() => {});
    log(`搜尋結果未見「${keyword}」字樣，改開第一封`);
  }
  await writeStatus({
    phase: "email_opened",
    message: `已開啟「${keyword}」相關郵件`,
    url: page.url(),
  });
  await waitForGmailMessageOpen(page);
  await sleep(800);
}

/** 等 Gmail 郵件正文真正打開（唔係淨係 highlight 列表） */
async function waitForGmailMessageOpen(page: Page): Promise<void> {
  const deadline = Date.now() + 35_000;
  while (Date.now() < deadline) {
    await throwIfStopped();
    await syncWindowFlags().catch(() => {});
    // 展開被截斷郵件
    await page
      .getByText(/顯示完整郵件|顯示整個郵件|View entire message|View full message|全文を表示/i)
      .first()
      .click({ timeout: 600 })
      .catch(() => {});
    const body = page
      .locator(
        'div.a3s, div.adn div.a3s, div[data-message-id], h2.hP, div[role="listitem"] div.ii'
      )
      .first();
    if ((await body.count().catch(() => 0)) > 0 && (await body.isVisible().catch(() => false))) {
      const t = ((await body.innerText().catch(() => "")) || "").trim();
      if (t.length > 20) {
        log("郵件正文已打開");
        return;
      }
    }
    await sleep(500);
  }
  log("警告：未確認郵件正文，仍繼續試撳訂單狀態");
}

async function clickOrderStatusInEmail(page: Page, context: BrowserContext): Promise<Page> {
  log("撳「訂單狀態」一次…");
  await waitForGmailMessageOpen(page);
  await dismissGmailOverlays(page);

  const before = new Set(context.pages().map((p) => p));
  const nameRes = [
    /訂單狀態/,
    /查看訂單狀態/,
    /檢視訂單狀態/,
    /查看你的訂單/,
    /查看訂單/,
    /檢視訂單/,
    /訂單詳情/,
    /Order Status/i,
    /View Order Status/i,
    /View [Yy]our [Oo]rder/,
    /Check [Oo]rder/,
    /Track [Oo]rder/,
  ];

  // 1) Playwright role=link／button（含各 frame）
  const scopes: Array<Page | Frame> = [page, ...page.frames()];
  for (const scope of scopes) {
    for (const re of nameRes) {
      const candidates = [
        scope.getByRole("link", { name: re }),
        scope.getByRole("button", { name: re }),
        scope.locator("a, button, span, td").filter({ hasText: re }),
      ];
      for (const loc of candidates) {
        const el = loc.first();
        if ((await el.count().catch(() => 0)) === 0) continue;
        if (!(await el.isVisible().catch(() => false))) continue;
        const popupPromise = context.waitForEvent("page", { timeout: 8000 }).catch(() => null);
        await el.click({ timeout: 4000 }).catch(async () => {
          await el.evaluate((n) => (n as HTMLElement).click()).catch(() => {});
        });
        log(`已撳訂單狀態相關掣：${re}`);
        const popup = await popupPromise;
        if (popup && !popup.isClosed()) {
          await popup.waitForLoadState("domcontentloaded").catch(() => {});
          log(`已開新分頁：${popup.url()}`);
          return popup;
        }
        await sleep(1500);
        for (const p of context.pages()) {
          if (!before.has(p) && !p.isClosed()) {
            await p.waitForLoadState("domcontentloaded").catch(() => {});
            log(`已開新分頁：${p.url()}`);
            return p;
          }
        }
        if (/store\.apple\.com|secure\d*\.store\.apple|google\.com\/url/i.test(page.url())) {
          log(`訂單頁：${page.url()}`);
          return page;
        }
      }
    }
  }

  // 2) DOM 掃描（處理 span 包住文字／空字 image CTA）
  const clicked = await page
    .evaluate(() => {
      const norm = (s: string) => (s || "").replace(/[\s\u00a0\u200b\u200c\u200d\ufeff]+/g, "");
      const hitText = (raw: string) => {
        const t = norm(raw);
        return (
          t.includes("訂單狀態") ||
          t.includes("查看訂單") ||
          t.includes("檢視訂單") ||
          t.includes("訂單詳情") ||
          /orderstatus|vieworder|viewyourorder|checkorder|trackorder/i.test(t)
        );
      };
      const nodes = Array.from(
        document.querySelectorAll("a, button, span, td, div, font")
      ) as HTMLElement[];
      for (const el of nodes) {
        const label = `${el.innerText || ""} ${el.getAttribute("aria-label") || ""} ${el.getAttribute("title") || ""}`;
        if (!hitText(label)) continue;
        const a =
          (el.closest("a") as HTMLElement | null) ||
          (el.tagName === "A" ? el : null) ||
          (el.querySelector("a") as HTMLElement | null) ||
          el;
        a.click();
        return "text";
      }
      for (const a of Array.from(document.querySelectorAll("a[href]")) as HTMLAnchorElement[]) {
        const href = a.href || "";
        if (
          /vieworder|order\/guest|store\.apple\.com|secure\d*\.store\.apple|apple\.com\/.*order/i.test(
            href
          )
        ) {
          a.click();
          return "href";
        }
      }
      return "";
    })
    .catch(() => "");

  if (!clicked) throw new Error("郵件入面揾唔到「訂單狀態」掣／連結");
  log(`已用 DOM 掃描撳到訂單連結（${clicked}）`);
  await sleep(2000);

  for (const p of context.pages()) {
    if (!before.has(p) && !p.isClosed()) {
      await p.waitForLoadState("domcontentloaded").catch(() => {});
      log(`已開新分頁：${p.url()}`);
      return p;
    }
  }

  await page
    .waitForURL(
      (u) => /store\.apple\.com|secure\d*\.store\.apple|google\.com\/url/i.test(u.toString()),
      { timeout: 25_000 }
    )
    .catch(() => {});

  if (/google\.com\/url/i.test(page.url())) {
    await page
      .waitForURL((u) => /store\.apple\.com|secure\d*\.store\.apple/i.test(u.toString()), {
        timeout: 30_000,
      })
      .catch(() => {});
    // 有時停喺 google redirect：直接跟 q=
    if (/google\.com\/url/i.test(page.url())) {
      try {
        const q = new URL(page.url()).searchParams.get("q");
        if (q) await page.goto(q, { waitUntil: "domcontentloaded", timeout: 60_000 });
      } catch {
        /* ignore */
      }
    }
  }

  log(`訂單頁：${page.url()}`);
  return page;
}

async function waitForAppleOrderGuestPage(page: Page): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const url = page.url();
    if (/\/shop\/order\/guest\//i.test(url) || /vieworder/i.test(url) || /secure\d*\.store\.apple\.com/i.test(url)) {
      await sleep(800);
      return;
    }
    // 跟 google redirect
    if (/google\.com\/url/i.test(url)) {
      const q = new URL(url).searchParams.get("q");
      if (q) {
        log(`跟住 Google redirect → ${q}`);
        await page.goto(q, { waitUntil: "domcontentloaded", timeout: 60_000 }).catch(() => {});
        continue;
      }
    }
    await sleep(400);
  }
  throw new Error(`未到達 Apple 訂單頁：${page.url()}`);
}

async function clickAddToAppleIdOnce(page: Page): Promise<void> {
  log("撳「加入至 Apple ID」一次…");
  await sleep(600);
  const clicked = await page
    .evaluate(() => {
      const norm = (s: string) => (s || "").replace(/[\s\u00a0\u200b]+/g, "");
      const needles = ["加入至AppleID", "加入至 Apple ID", "Add to Apple ID", "加入 Apple ID"];
      const nodes = Array.from(
        document.querySelectorAll("button, a, [role='button'], input[type='submit']")
      ) as HTMLElement[];
      for (const el of nodes) {
        const t = norm(`${el.innerText || ""} ${el.getAttribute("aria-label") || ""} ${(el as HTMLInputElement).value || ""}`);
        if (needles.some((n) => t.includes(norm(n)))) {
          el.click();
          return true;
        }
      }
      return false;
    })
    .catch(() => false);

  if (!clicked) {
    const loc = page
      .getByRole("button", { name: /加入至\s*Apple\s*ID|Add to Apple ID/i })
      .or(page.getByRole("link", { name: /加入至\s*Apple\s*ID|Add to Apple ID/i }))
      .first();
    if ((await loc.count().catch(() => 0)) > 0) {
      await loc.click({ force: true, timeout: 5000 });
    } else {
      throw new Error("揾唔到「加入至 Apple ID」");
    }
  }
  log("已撳「加入至 Apple ID」");
  await sleep(1200);
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
    await writeStatus({ phase: "gmail_login", message: "Gmail 登入中…" });
    await gmailLogin(page, account.email, account.password);
    // 登入後即刻搜「出貨」——唔好先死等 #inbox 載完／再 minimize（會卡住 loading）
    await writeStatus({ phase: "search_email", message: "搜尋訂單郵件…" });
    await gmailSearchAndOpenOrderEmail(page);
    const orderPage = await clickOrderStatusInEmail(page, context);
    activePage = orderPage;
    await maybeMinimizeBrowserWindow(orderPage, browser);
    await waitForAppleOrderGuestPage(orderPage);
    await writeStatus({ phase: "add_to_apple_id", message: "加入至 Apple ID…" });
    await clickAddToAppleIdOnce(orderPage);
    await signInAppleIdOnOrderPage(orderPage, appleEmail, applePassword);
    await writeStatus({
      phase: "steps_complete",
      message: "步驟完成",
      windowHidden,
    });
    log(`完成：${maskEmail(account.email)} → 已嘗試加入 Apple ID`);
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
  for (;;) {
    const next = await holdBrowserUntilClose("步驟完成，瀏覽器保持開啟");
    if (next === "close") throw new CloseRequestedError();
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
  log(`task ${SESSION_ID} · ${maskEmail(account.email)} · Apple ID=${maskEmail(cfg.appleEmail)}`);
  await writeStatus({
    phase: "starting",
    emailMasked: maskEmail(account.email),
    message: "starting",
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

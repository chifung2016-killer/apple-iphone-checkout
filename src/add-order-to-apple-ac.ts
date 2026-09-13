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
const STATUS_FILE = path.join(ROOT, "runtime", `status-${SESSION_ID}.json`);
const SHOW_FLAG = path.join(ROOT, "runtime", `show-${SESSION_ID}.flag`);
const HIDE_FLAG = path.join(ROOT, "runtime", `hide-${SESSION_ID}.flag`);
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
  const next = {
    ...prev,
    ...patch,
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

async function maximizeBrowserWindow(page: Page, browser: Browser): Promise<void> {
  log("Open browser：還原／最大化視窗…");
  try {
    await page.bringToFront().catch(() => {});
    const windowId = await getPageWindowId(page);
    if (windowId != null) {
      const cdp = await page.context().newCDPSession(page);
      await cdp.send("Browser.setWindowBounds", {
        windowId,
        bounds: { windowState: "normal" },
      });
      await new Promise((r) => setTimeout(r, 120));
      const screen = await page
        .evaluate(() => ({
          aw: Math.max(window.screen?.availWidth || 0, 1280),
          ah: Math.max(window.screen?.availHeight || 0, 720),
        }))
        .catch(() => ({ aw: 1920, ah: 1080 }));
      await cdp
        .send("Browser.setWindowBounds", {
          windowId,
          bounds: {
            left: 0,
            top: 0,
            width: screen.aw,
            height: screen.ah,
            windowState: "normal",
          },
        })
        .catch(() => {});
      await cdp
        .send("Browser.setWindowBounds", {
          windowId,
          bounds: { windowState: "maximized" },
        })
        .catch(() => {});
      await cdp.detach().catch(() => {});
    } else {
      log("Open browser：CDP 無 windowId，改用 Windows API");
    }
  } catch (err) {
    log(`Open browser CDP 失敗：${err instanceof Error ? err.message : String(err)}`);
  }
  winRestoreBrowserWindow(browser);
  await page.bringToFront().catch(() => {});
  windowHidden = false;
  await writeStatus({
    windowHidden: false,
    windowState: "maximized",
    message: "browser opened",
  });
}

/** 同 dashboard：視窗一開就 minimize 隱藏 */
async function minimizeBrowserWindow(page: Page, browser: Browser): Promise<void> {
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
  await writeStatus({ windowHidden: true, windowState: "minimized" });
}

let flagPollTimer: ReturnType<typeof setInterval> | null = null;

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
  if (!activePage || activePage.isClosed() || !activeBrowser) return;
  if (await consumeFlag(SHOW_FLAG)) {
    await maximizeBrowserWindow(activePage, activeBrowser);
    log("Open browser：已顯示視窗");
  }
  if (await consumeFlag(HIDE_FLAG)) {
    await minimizeBrowserWindow(activePage, activeBrowser);
    log("Hide：已隱藏視窗");
  }
}

async function holdBrowserUntilClose(reason: string): Promise<"continue" | "close"> {
  await writeStatus({
    phase: "manual_control",
    message: reason,
    windowHidden,
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

async function clickContinueWithPasswordFast(page: Page): Promise<boolean> {
  const pwdNeedles = [
    "繼續使用密碼登入",
    "使用密碼登入",
    "使用密碼",
    "Continue with Password",
    "Use Password",
  ];
  const otherNeedles = ["其他選項", "Other Options", "Try Another Way"];

  const clickByTexts = async (needles: string[]): Promise<boolean> => {
    for (const fr of [...appleAuthFrames(page), page.mainFrame(), ...page.frames()]) {
      const hit = await fr
        .evaluate((texts) => {
          const norm = (s: string) =>
            (s || "").replace(/[\s\u00a0\u200b\ufeff]+/g, "").toLowerCase();
          const wanted = texts.map((t) => norm(t));
          const nodes = Array.from(
            document.querySelectorAll("button, a, [role='button'], span, div")
          ) as HTMLElement[];
          for (const el of nodes) {
            const t = norm(`${el.innerText || ""} ${el.getAttribute("aria-label") || ""}`);
            if (!t || t.length > 80) continue;
            if (wanted.some((w) => t.includes(w) || w.includes(t))) {
              el.click();
              return true;
            }
          }
          return false;
        }, needles)
        .catch(() => false);
      if (hit) return true;
    }
    return false;
  };

  for (const iframeSel of APPLE_AUTH_IFRAME_SELS) {
    if ((await page.locator(iframeSel).count().catch(() => 0)) === 0) continue;
    const frame = page.frameLocator(iframeSel);
    const byId = frame.locator("#continue-password").first();
    if ((await byId.count().catch(() => 0)) > 0) {
      if (await byId.click({ force: true, timeout: 1200 }).then(() => true).catch(() => false)) {
        return true;
      }
    }
    const btn = frame
      .getByRole("button", { name: /繼續使用密碼|使用密碼|Continue with Password|Use Password/i })
      .first();
    if ((await btn.count().catch(() => 0)) > 0) {
      if (await btn.click({ force: true, timeout: 1200 }).then(() => true).catch(() => false)) {
        return true;
      }
    }
  }

  if (await clickByTexts(pwdNeedles)) return true;
  if (await clickByTexts(otherNeedles)) {
    await sleep(400);
    return clickByTexts(pwdNeedles);
  }
  return false;
}

async function signInAppleIdOnOrderPage(
  page: Page,
  appleEmail: string,
  applePassword: string
): Promise<void> {
  log(`Apple ID 登入：${maskEmail(appleEmail)}`);
  await sleep(600);

  let emailOk = false;
  for (let i = 0; i < 12; i++) {
    emailOk = await fillInAppleAuthFrame(page, "email", appleEmail);
    if (emailOk) break;
    await sleep(400);
  }
  if (!emailOk) throw new Error("揾唔到／填唔入 Apple ID 電郵欄");

  await clickAppleAuthContinue(page);
  log("已提交電郵");
  await sleep(500);

  const pwdDeadline = Date.now() + 20000;
  let sawPassword = false;
  while (Date.now() < pwdDeadline) {
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
    if (await clickContinueWithPasswordFast(page)) {
      log("已撳「繼續使用密碼登入」");
      await sleep(450);
    } else {
      await sleep(250);
    }
  }

  let passOk = false;
  for (let round = 1; round <= 10; round++) {
    passOk = await fillInAppleAuthFrame(page, "password", applePassword);
    if (passOk) break;
    await clickContinueWithPasswordFast(page).catch(() => {});
    await sleep(400);
  }
  if (!passOk) throw new Error("揾唔到／填唔入密碼欄");

  await clickAppleAuthContinue(page);
  log("已提交密碼（右箭頭／繼續）");
  await sleep(1500);
}

function isGmailInboxUrl(url: string): boolean {
  return (
    /mail\.google\.com\/mail\//i.test(url) ||
    (/mail\.google\.com/i.test(url) && !/accounts\.google\.com/i.test(url))
  );
}

/** 確保已喺 Gmail 收件箱 UI（登入後有時停喺中轉頁） */
async function ensureGmailInbox(page: Page): Promise<void> {
  if (!isGmailInboxUrl(page.url())) {
    log("導向 Gmail 收件箱…");
    await page
      .goto("https://mail.google.com/mail/u/0/#inbox", {
        waitUntil: "domcontentloaded",
        timeout: 90_000,
      })
      .catch(() => {});
  }
  // 處理「繼續」／帳戶選擇殘留
  for (let i = 0; i < 8; i++) {
    await throwIfStopped();
    const url = page.url();
    if (/accounts\.google\.com/i.test(url)) {
      // 可能仲要撳繼續
      await page
        .getByRole("button", { name: /^(Next|下一步|繼續|Continue|我了解)$/i })
        .first()
        .click({ timeout: 1500 })
        .catch(() => {});
      await page
        .goto("https://mail.google.com/mail/u/0/#inbox", {
          waitUntil: "domcontentloaded",
          timeout: 60_000,
        })
        .catch(() => {});
    }
    const search = page
      .locator(
        'input[aria-label*="Search" i], input[aria-label*="搜尋" i], input[name="q"], form[role="search"] input'
      )
      .first();
    if ((await search.count().catch(() => 0)) > 0 && (await search.isVisible().catch(() => false))) {
      log(`已入 Gmail 收件箱：${page.url()}`);
      await writeStatus({ phase: "gmail_ready", message: "Gmail 已開啟", url: page.url() });
      await sleep(800);
      return;
    }
    // 左側 Inbox / 主要 都當入咗
    const inboxUi = page.locator('div[role="main"], div.AO, div.nH').first();
    if ((await inboxUi.count().catch(() => 0)) > 0) {
      log(`已入 Gmail UI：${page.url()}`);
      await sleep(800);
      return;
    }
    await sleep(700);
  }
  // 最後再強制 refresh 一次
  if (!isGmailInboxUrl(page.url())) {
    await page
      .goto("https://mail.google.com/mail/u/0/#inbox", {
        waitUntil: "domcontentloaded",
        timeout: 90_000,
      })
      .catch(() => {});
  }
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
  log("Google 要輸入數字+英文字母驗證碼");
  await maximizeBrowserWindow(page, browser);
  await writeStatus({
    phase: "waiting_captcha",
    message: "嘗試自動 OCR／請人手輸入驗證碼，完成後可撳 Continue",
    windowHidden: false,
  });

  // 先試自動 OCR（有 tesseract 先得）
  try {
    if (await tryAutoSolveImageCaptcha(page)) {
      log("驗證碼：自動填入成功");
      return;
    }
  } catch (err) {
    log(`驗證碼自動填入失敗：${err instanceof Error ? err.message : String(err)}`);
  }

  log("請人手輸入驗證碼後撳 Next；或撳 Continue");
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
        await maximizeBrowserWindow(page, activeBrowser);
        await writeStatus({
          phase: "waiting_user",
          message: "需要額外驗證，請人手完成後撳 Continue",
          windowHidden: false,
        });
        while (Date.now() < pwdDeadline) {
          await throwIfStopped();
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
      await maximizeBrowserWindow(page, activeBrowser);
      await writeStatus({
        phase: "waiting_password",
        message: "自動填密碼失敗 — 請人手輸入密碼後撳 Continue",
        windowHidden: false,
      });
      log("自動填密碼失敗：請人手輸入密碼，然後撳 Continue");
      const waitPwd = Date.now() + 15 * 60_000;
      while (Date.now() < waitPwd) {
        await throwIfStopped();
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
        await maximizeBrowserWindow(page, activeBrowser);
        await writeStatus({
          phase: "waiting_user",
          message: "需要額外驗證，請人手完成後撳 Continue",
          windowHidden: false,
        });
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
  await ensureGmailInbox(page);
  log('搜尋郵件：「apple store」或「出貨」…');
  await writeStatus({ phase: "search_email", message: "搜尋訂單郵件…" });

  const searchSelectors = [
    'input[aria-label*="Search" i]',
    'input[aria-label*="搜尋" i]',
    'input[name="q"]',
    'form[role="search"] input',
    'input[placeholder*="Search" i]',
    'input[placeholder*="搜尋" i]',
  ];
  let search = page.locator(searchSelectors.join(", ")).first();
  const searchDeadline = Date.now() + 45_000;
  while (Date.now() < searchDeadline) {
    await throwIfStopped();
    if ((await search.count().catch(() => 0)) > 0 && (await search.isVisible().catch(() => false))) {
      break;
    }
    await page.keyboard.press("/").catch(() => {});
    await sleep(800);
    search = page.locator(searchSelectors.join(", ")).first();
  }
  await search.waitFor({ state: "visible", timeout: 15_000 });
  await search.click({ timeout: 3000 });
  await search.fill("");
  await search.fill('("apple store" OR 出貨 OR "Apple Store")');
  await page.keyboard.press("Enter");
  await sleep(2500);

  const row = page
    .locator("tr.zA, div[role='main'] tr.zA, div.Cp tr.zA, div[role='list'] div[role='listitem']")
    .first();
  await row.waitFor({ state: "visible", timeout: 45_000 });
  await row.click({ timeout: 5000 });
  log("已開啟搜尋到嘅郵件");
  await writeStatus({ phase: "email_opened", message: "已開啟訂單相關郵件" });
  await sleep(1500);
}

async function clickOrderStatusInEmail(page: Page, context: BrowserContext): Promise<Page> {
  log("撳「訂單狀態」一次…");
  const before = new Set(context.pages().map((p) => p));

  const clicked = await page
    .evaluate(() => {
      const norm = (s: string) => (s || "").replace(/[\s\u00a0\u200b]+/g, "");
      const nodes = Array.from(
        document.querySelectorAll("a, button, span, td, div")
      ) as HTMLElement[];
      for (const el of nodes) {
        const t = norm(el.innerText || el.textContent || "");
        if (!t.includes("訂單狀態") && !/order\s*status/i.test(el.innerText || "")) continue;
        // 優先 <a>
        const a =
          el.closest("a") ||
          (el.tagName === "A" ? el : el.querySelector("a")) ||
          el;
        (a as HTMLElement).click();
        return true;
      }
      // fallback：href 含 vieworder / store.apple
      for (const a of Array.from(document.querySelectorAll("a[href]")) as HTMLAnchorElement[]) {
        const href = a.href || "";
        if (/vieworder|store\.apple\.com|secure\d*\.store\.apple/i.test(href)) {
          a.click();
          return true;
        }
      }
      return false;
    })
    .catch(() => false);

  if (!clicked) throw new Error("郵件入面揾唔到「訂單狀態」掣／連結");

  await sleep(2000);

  // 新分頁？
  for (const p of context.pages()) {
    if (!before.has(p) && !p.isClosed()) {
      await p.waitForLoadState("domcontentloaded").catch(() => {});
      log(`已開新分頁：${p.url()}`);
      return p;
    }
  }

  // 同頁導航（可能經 google redirect）
  await page.waitForURL(
    (u) => /store\.apple\.com|secure\d*\.store\.apple|google\.com\/url/i.test(u.toString()),
    { timeout: 20_000 }
  ).catch(() => {});

  if (/google\.com\/url/i.test(page.url())) {
    // 跟住 redirect
    await page.waitForURL((u) => /store\.apple\.com|secure\d*\.store\.apple/i.test(u.toString()), {
      timeout: 30_000,
    }).catch(() => {});
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
    viewport: { width: 1280, height: 900 },
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
  await minimizeBrowserWindow(page, browser);
  log("瀏覽器已隱藏（minimized）");

  const runSteps = async () => {
    await writeStatus({ phase: "gmail_login", message: "Gmail 登入中…" });
    await gmailLogin(page, account.email, account.password);
    if (windowHidden) await minimizeBrowserWindow(page, browser);
    await writeStatus({ phase: "search_email", message: "搜尋訂單郵件…" });
    await gmailSearchAndOpenOrderEmail(page);
    const orderPage = await clickOrderStatusInEmail(page, context);
    activePage = orderPage;
    if (windowHidden) await minimizeBrowserWindow(orderPage, browser);
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
      if (activeBrowser && activePage) {
        await maximizeBrowserWindow(activePage, activeBrowser).catch(() => {});
      }
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

  const cfg = await loadConfig();
  const account = cfg.accounts[ACCOUNT_INDEX];
  if (!account) throw new Error(`冇 account index=${ACCOUNT_INDEX}`);
  log(`task ${SESSION_ID} · ${maskEmail(account.email)} · Apple ID=${maskEmail(cfg.appleEmail)}`);
  await writeStatus({
    phase: "starting",
    emailMasked: maskEmail(account.email),
    message: "starting",
    windowHidden: true,
    pid: process.pid,
  });

  const browser = await launchBrowser();
  activeBrowser = browser;
  startFlagPoller();

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

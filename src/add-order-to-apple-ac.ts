/**
 * Gmail → Apple Store 訂單狀態 → 「加入至 Apple ID」自動化
 * Config via ADD_ORDER_CONFIG_PATH JSON:
 * {
 *   accounts: [{ email, password }, ...],
 *   appleEmail, applePassword
 * }
 */
import fs from "node:fs/promises";
import { chromium, type Browser, type BrowserContext, type Frame, type Page } from "playwright";

type Account = { email: string; password: string };

type JobConfig = {
  accounts: Account[];
  appleEmail: string;
  applePassword: string;
};

const CONFIG_PATH =
  process.env.ADD_ORDER_CONFIG_PATH ||
  process.env.CHECKOUT_CONFIG_PATH ||
  "";

function log(msg: string) {
  const line = `[add-order] ${msg}`;
  console.log(line);
}

async function loadConfig(): Promise<JobConfig> {
  if (!CONFIG_PATH) {
    throw new Error("缺少 ADD_ORDER_CONFIG_PATH");
  }
  const raw = JSON.parse(await fs.readFile(CONFIG_PATH, "utf8")) as Partial<JobConfig>;
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
  await new Promise((r) => setTimeout(r, ms));
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
  log(`Apple ID 登入：${appleEmail}`);
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
  return /mail\.google\.com/i.test(url) && !/accounts\.google\.com/i.test(url);
}

/** 真正要額外驗證嘅 challenge（唔包括密碼頁 challenge/pwd） */
function isExtraGoogleChallenge(url: string): boolean {
  if (/\/challenge\/pwd\b/i.test(url)) return false;
  return /\/challenge\/(totp|iap|selection|sk|dp|kpe|ootp|bc|pk|sms|wa|idv|ipp)/i.test(
    url
  ) || /\/signin\/challenge\/(?:totp|iap|selection)/i.test(url);
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
  value: string
): Promise<boolean> {
  for (const sel of sels) {
    const loc = page.locator(sel).first();
    if ((await loc.count().catch(() => 0)) === 0) continue;
    const visible = await loc.isVisible().catch(() => false);
    if (!visible) continue;
    await loc.click({ timeout: 2000 }).catch(() => {});
    await loc.fill("").catch(() => {});
    // 模擬人手打字，減少被 Google 擋
    const typed = await loc
      .pressSequentially(value, { delay: 35, timeout: 20_000 })
      .then(() => true)
      .catch(async () =>
        loc
          .fill(value, { timeout: 5000 })
          .then(() => true)
          .catch(() => false)
      );
    if (typed) {
      const got = await loc.inputValue().catch(() => "");
      if (got && got.length >= Math.min(3, value.length)) return true;
    }
  }
  return false;
}

async function gmailLogin(page: Page, email: string, password: string): Promise<void> {
  log(`Gmail 登入：${email}`);
  await page.goto(
    "https://accounts.google.com/v3/signin/identifier?continue=https%3A%2F%2Fmail.google.com%2Fmail%2Fu%2F0%2F&service=mail&flowName=GlifWebSignIn&flowEntry=ServiceLogin",
    { waitUntil: "domcontentloaded", timeout: 90_000 }
  );
  await sleep(1000);

  // 帳號選擇／已登入
  if (isGmailInboxUrl(page.url())) {
    log("已入 Gmail（既有 session）");
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

  // 等密碼頁（Google 而家係 /v3/signin/challenge/pwd —— 唔係 2FA）
  const pwdDeadline = Date.now() + 45_000;
  let pwdReady = false;
  while (Date.now() < pwdDeadline) {
    if (isExtraGoogleChallenge(page.url())) {
      throw new Error(`Gmail 需要額外驗證（2FA／電話）：${page.url()} — 請人手完成後重跑`);
    }
    const pwd = page
      .locator('input[type="password"]:visible, input[name="Passwd"]:visible, input[name="password"]:visible')
      .first();
    if ((await pwd.count().catch(() => 0)) > 0 && (await pwd.isVisible().catch(() => false))) {
      pwdReady = true;
      break;
    }
    // 有時仲要再撳「繼續使用密碼」類選項
    const tryPwd = page.getByRole("button", { name: /password|密碼/i }).first();
    if ((await tryPwd.count().catch(() => 0)) > 0) {
      await tryPwd.click({ timeout: 1500 }).catch(() => {});
    }
    await sleep(350);
  }
  if (!pwdReady) {
    throw new Error(`等唔到密碼欄：${page.url()}`);
  }

  let passOk = false;
  for (let round = 1; round <= 5; round++) {
    passOk = await fillGoogleVisibleInput(page, [
      'input[type="password"]',
      'input[name="Passwd"]',
      'input[name="password"]',
      'input[autocomplete="current-password"]',
    ], password);
    if (passOk) break;
    log(`密碼欄重試 ${round}/5…`);
    await sleep(400);
  }
  if (!passOk) throw new Error("填唔入 Gmail 密碼");

  await clickGoogleNext(page, "password");
  log("已提交密碼，等入 Gmail…");

  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const url = page.url();
    if (isGmailInboxUrl(url)) {
      log("已入 Gmail");
      await sleep(1500);
      return;
    }
    if (isExtraGoogleChallenge(url)) {
      throw new Error(`Gmail 需要額外驗證（2FA／電話）：${url} — 請人手完成後重跑`);
    }
    // 仍喺密碼頁：可能 Next 未撳到，再試一次
    if (/\/challenge\/pwd\b/i.test(url)) {
      const pwdEmpty = await page
        .locator('input[type="password"]:visible, input[name="Passwd"]:visible')
        .first()
        .inputValue()
        .catch(() => "");
      if (!pwdEmpty) {
        await fillGoogleVisibleInput(page, [
          'input[type="password"]',
          'input[name="Passwd"]',
        ], password);
      }
      await clickGoogleNext(page, "password");
    }
    // 拒絕／錯誤訊息
    const err = page.locator('[aria-live="assertive"], div[jsname="B34EJ"], span[jsname="B34EJ"]').first();
    if ((await err.count().catch(() => 0)) > 0) {
      const t = ((await err.textContent().catch(() => "")) || "").trim();
      if (t && /wrong|incorrect|密碼|password|couldn't|無法/i.test(t)) {
        throw new Error(`Gmail 登入被拒：${t}`);
      }
    }
    await sleep(500);
  }
  throw new Error(`Gmail 登入逾時：${page.url()}`);
}

async function gmailSearchAndOpenOrderEmail(page: Page): Promise<void> {
  log('搜尋郵件：「apple store」或「出貨」…');
  // 等 search box
  const search = page.locator('input[aria-label*="Search" i], input[aria-label*="搜尋" i], input[name="q"]').first();
  await search.waitFor({ state: "visible", timeout: 30_000 });
  await search.click({ timeout: 3000 });
  await search.fill('("apple store" OR 出貨 OR "Apple Store")');
  await page.keyboard.press("Enter");
  await sleep(2000);

  // 點第一封有關結果
  const row = page.locator("tr.zA, div[role='main'] tr.zA, div.Cp tr.zA").first();
  await row.waitFor({ state: "visible", timeout: 30_000 });
  await row.click({ timeout: 5000 });
  log("已開啟搜尋到嘅郵件");
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
  log(`======== 開始處理 ${account.email} ========`);
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
  try {
    await gmailLogin(page, account.email, account.password);
    await gmailSearchAndOpenOrderEmail(page);
    const orderPage = await clickOrderStatusInEmail(page, context);
    await waitForAppleOrderGuestPage(orderPage);
    await clickAddToAppleIdOnce(orderPage);
    await signInAppleIdOnOrderPage(orderPage, appleEmail, applePassword);
    log(`完成：${account.email} → 已嘗試加入 Apple ID`);
    // 保持瀏覽器一陣方便人手確認
    await sleep(4000);
  } finally {
    await context.close().catch(() => {});
  }
}

async function launchBrowser(): Promise<Browser> {
  const common = {
    headless: false as const,
    args: [
      "--disable-blink-features=AutomationControlled",
      "--disable-features=IsolateOrigins,site-per-process",
    ],
    ignoreDefaultArgs: ["--enable-automation"] as string[],
  };
  // 優先用本機 Chrome（Google 較少擋）
  try {
    return await chromium.launch({ ...common, channel: "chrome" });
  } catch {
    log("本機 Chrome 唔用得，改用 Playwright Chromium");
    return await chromium.launch(common);
  }
}

async function main() {
  const cfg = await loadConfig();
  log(`共 ${cfg.accounts.length} 個 Gmail；Apple ID=${cfg.appleEmail}`);

  const browser = await launchBrowser();

  try {
    for (const acc of cfg.accounts) {
      try {
        await processOneAccount(browser, acc, cfg.appleEmail, cfg.applePassword);
      } catch (err) {
        log(`失敗 ${acc.email}：${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } finally {
    await browser.close().catch(() => {});
  }
  log("全部帳號處理完");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

/**
 * Create a Google Sheet and paste order rows directly (no CSV download/import).
 * Uses a persistent Chromium profile so you only sign in to Google once.
 */
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { chromium, type BrowserContext, type Page } from "playwright";
import {
  findCreditCard,
  formatHkLimit,
  parseHkAmount,
} from "./credit-card-pool.js";
import {
  isDeliveryMethod,
  resolveDeliveryMethodLabel,
} from "./fulfillment-label.js";

const execFileAsync = promisify(execFile);

/** Google 帳戶（匯出試算表自動登入） */
const GOOGLE_ACCOUNT = {
  email: "chifung2016@gmail.com",
  password: "y6594083",
};

export type SheetOrderRow = Record<string, string | number>;

export type ExportGoogleSheetResult =
  | { ok: true; url: string; title: string; rowCount: number }
  | { ok: false; error: string };

let exportInFlight: Promise<ExportGoogleSheetResult> | null = null;

function hasOrderNumber(o: unknown): boolean {
  if (!o || typeof o !== "object") return false;
  const n = (o as Record<string, unknown>).orderNumber;
  return typeof n === "string" && n.trim().length > 0;
}

function detectCardType(cardNumber: unknown): string {
  const raw = String(cardNumber || "").trim();
  if (!raw || /apple\s*pay/i.test(raw)) return "";
  if (/visa/i.test(raw)) return "visa";
  if (/master/i.test(raw)) return "mastercard";
  if (/amex|american\s*express|\bAE\b/i.test(raw)) return "AE";
  const d = raw.replace(/\D/g, "");
  if (d.startsWith("4")) return "visa";
  if (/^3[47]/.test(d)) return "AE";
  const bin2 = Number(d.slice(0, 2));
  const bin4 = Number(d.slice(0, 4));
  if ((bin2 >= 51 && bin2 <= 55) || (bin4 >= 2221 && bin4 <= 2720)) return "mastercard";
  return "";
}

/** 香港時間標題／落單時間：12/9/2026 11:22am */
export function formatHkOrderDateTime(d: Date = new Date()): string {
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
  const ampm = String(parts.dayPeriod || "")
    .toLowerCase()
    .replace(/\s+/g, "");
  return `${parts.day}/${parts.month}/${parts.year} ${parts.hour}:${parts.minute}${ampm}`;
}

export function orderToSheetRow(o: Record<string, unknown>): SheetOrderRow {
  const contact = (o.checkoutContactUsed || {}) as Record<string, unknown>;
  const ship = (o.confirmationPageShipping || {}) as Record<string, unknown>;
  const sd = (o.shippingDetails || {}) as Record<string, unknown>;
  const boxes = (o.deliveryShippingBoxes || {}) as Record<string, unknown>;
  const identity = (o.identity || {}) as Record<string, unknown>;
  const cardNumber = String(o.cardNumber || ship.cardNumber || "");
  const poolCard = findCreditCard(cardNumber);
  let remaining = String(o.remainingCreditCardLimit || o.remainingLimit || "");
  if (!remaining && poolCard?.limit != null) {
    const spent = parseHkAmount(o.amountSpent || o.total);
    if (spent != null) remaining = formatHkLimit(poolCard.limit - spent);
  }
  const cardLimitOut =
    String(o.cardLimit || "") || (poolCard ? formatHkLimit(poolCard.limit) : "");
  const cardCompanyOut = String(o.cardCompany || "") || poolCard?.company || "";
  const cardTypeOut =
    String(o.cardType || detectCardType(cardNumber) || "") || poolCard?.type || "";

  const deliveryMethod = resolveDeliveryMethodLabel(
    o.deliveryMethod,
    o.fulfillmentPreference,
    o.fulfillmentMode,
    contact.mode
  );
  const isDelivery = isDeliveryMethod(deliveryMethod);

  const lastName = String(
    boxes.lastName || sd.lastName || contact.lastName || identity.lastName || ""
  );
  const firstName = String(
    boxes.firstName || sd.firstName || contact.firstName || identity.firstName || ""
  );
  const areaDistrictStreet = String(
    boxes.areaDistrictStreet ||
      sd.areaDistrictStreet ||
      contact.areaDistrictStreet ||
      (isDelivery
        ? [identity.area, identity.district, identity.street].filter(Boolean).join(" ")
        : "")
  );
  const buildingFloorUnit = String(
    boxes.buildingFloorUnit ||
      sd.buildingFloorUnit ||
      contact.buildingFloorUnit ||
      identity.buildingLine ||
      ""
  );

  return {
    "Order number": String(o.orderNumber || ""),
    "Order placed at": String(o.orderPlacedAt || ""),
    Browser: String(o.browser || ""),
    "Delivery method": deliveryMethod,
    "Product type": String(o.productType || o.productName || ""),
    Colour: String(o.color || ""),
    Storage: String(o.storage || ""),
    Qty: (o.quantity as string | number | undefined) ?? "",
    "Amount spent": String(o.amountSpent || o.total || ""),
    "Credit card": cardNumber,
    "Credit card type": cardTypeOut,
    "Credit card company": cardCompanyOut,
    "Credit card limit": cardLimitOut,
    "Remaining credit card limit": remaining,
    姓氏: lastName,
    名字: firstName,
    "區域/地區/街道名稱及號碼": areaDistrictStreet,
    "屋苑或大廈/座數/樓層/單位": buildingFloorUnit,
    Name: String(
      sd.name || [lastName, firstName].filter(Boolean).join(" ") || ship.name || ""
    ),
    Phone: String(sd.phone || contact.phone || ship.phone || ""),
    Email: String(sd.email || contact.email || ship.email || ""),
    Address: String(sd.address || contact.address || ship.address || ship.pickupStore || ""),
    "Pickup store": String(sd.pickupStore || ship.pickupStore || ""),
    "Est. delivery": String(sd.estimatedDelivery || o.estimatedDelivery || ""),
  };
}

function toTsv(rows: SheetOrderRow[]): string {
  if (!rows.length) return "";
  const headers = Object.keys(rows[0]!);
  const cell = (v: unknown) => {
    const s = String(v ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\t/g, " ");
    return s;
  };
  return [headers.join("\t"), ...rows.map((r) => headers.map((h) => cell(r[h])).join("\t"))].join(
    "\n"
  );
}

async function setSystemClipboard(text: string, runtimeDir: string): Promise<void> {
  const clipFile = path.join(runtimeDir, "sheets-clipboard.tsv");
  await fs.writeFile(clipFile, text, "utf8");
  if (process.platform === "win32") {
    const safe = clipFile.replace(/'/g, "''");
    await execFileAsync(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        `Get-Content -LiteralPath '${safe}' -Raw -Encoding UTF8 | Set-Clipboard`,
      ],
      { windowsHide: true }
    );
    return;
  }
  const { spawn } = await import("node:child_process");
  await new Promise<void>((resolve, reject) => {
    const bin = process.platform === "darwin" ? "pbcopy" : "xclip";
    const args = process.platform === "darwin" ? [] : ["-selection", "clipboard"];
    const child = spawn(bin, args);
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`${bin} failed`))));
    child.stdin.write(text);
    child.stdin.end();
  });
}

async function fillGoogleInput(page: Page, selectors: string[], value: string): Promise<boolean> {
  for (const sel of selectors) {
    const loc = page.locator(sel).first();
    if (!(await loc.isVisible().catch(() => false))) continue;
    await loc.click({ timeout: 5000 }).catch(() => {});
    await loc.fill("").catch(() => {});
    await loc.fill(value);
    const current = await loc.inputValue().catch(() => "");
    if (current.includes(value) || current === value) return true;
  }
  return false;
}

async function clickGoogleNext(page: Page, patterns: RegExp[]): Promise<void> {
  for (const re of patterns) {
    const btn = page.getByRole("button", { name: re }).first();
    if (await btn.isVisible().catch(() => false)) {
      await btn.click({ timeout: 5000 }).catch(() => {});
      return;
    }
  }
  for (const id of ["#identifierNext", "#passwordNext", "#totpNext"]) {
    const btn = page.locator(id).first();
    if (await btn.isVisible().catch(() => false)) {
      await btn.click({ timeout: 5000 }).catch(() => {});
      return;
    }
  }
  await page.keyboard.press("Enter").catch(() => {});
}

async function ensureGoogleSignedIn(page: Page): Promise<void> {
  const deadline = Date.now() + 3 * 60_000;
  while (Date.now() < deadline) {
    const url = page.url();
    if (/docs\.google\.com\/spreadsheets\/d\//i.test(url)) return;
    if (!/accounts\.google\.com/i.test(url)) {
      await page.waitForTimeout(800);
      continue;
    }

    // Email step
    const emailVisible = await page
      .locator('input[type="email"], input[name="identifier"], #identifierId')
      .first()
      .isVisible()
      .catch(() => false);
    if (emailVisible) {
      console.log("[sheets] Google 登入：填電郵…");
      await fillGoogleInput(
        page,
        ['input[type="email"]', 'input[name="identifier"]', "#identifierId"],
        GOOGLE_ACCOUNT.email
      );
      await clickGoogleNext(page, [/下一步|Next|繼續|Continue/i]);
      await page.waitForTimeout(1500);
      continue;
    }

    // Account chooser — pick matching email if shown
    const account = page.getByText(GOOGLE_ACCOUNT.email, { exact: false }).first();
    if (await account.isVisible().catch(() => false)) {
      console.log("[sheets] Google 登入：揀帳戶…");
      await account.click().catch(() => {});
      await page.waitForTimeout(1500);
      continue;
    }

    // Password step
    const passVisible = await page
      .locator('input[type="password"], input[name="Passwd"], input[name="password"]')
      .first()
      .isVisible()
      .catch(() => false);
    if (passVisible) {
      console.log("[sheets] Google 登入：填密碼…");
      await fillGoogleInput(
        page,
        ['input[type="password"]', 'input[name="Passwd"]', 'input[name="password"]'],
        GOOGLE_ACCOUNT.password
      );
      await clickGoogleNext(page, [/下一步|Next|繼續|Continue/i]);
      await page.waitForTimeout(2000);
      continue;
    }

    // "Not now" / skip recovery prompts
    for (const re of [/暫時不要|Not now|Skip|略過|稍後|稍後再說/i]) {
      const skip = page.getByRole("button", { name: re }).first();
      if (await skip.isVisible().catch(() => false)) {
        await skip.click().catch(() => {});
        await page.waitForTimeout(1000);
        break;
      }
    }

    await page.waitForTimeout(1000);
  }
}

async function waitForSpreadsheet(page: Page, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await ensureGoogleSignedIn(page).catch(() => {});
    const url = page.url();
    const m = url.match(/https:\/\/docs\.google\.com\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
    if (m) return `https://docs.google.com/spreadsheets/d/${m[1]}`;
    await page.waitForTimeout(500);
  }
  throw new Error(
    "等唔到 Google 試算表。請喺彈出嘅視窗完成 Google 登入（可能要驗證），然後再撳一次匯出。"
  );
}

async function focusSheetGrid(page: Page): Promise<void> {
  await page.waitForTimeout(2000);
  const iframe = page.locator("iframe.docs-texteventtarget-iframe").first();
  try {
    await iframe.click({ timeout: 8000, force: true });
  } catch {
    try {
      await page.locator("#waffle-grid-container, .grid-container").first().click({
        timeout: 5000,
        position: { x: 40, y: 40 },
      });
    } catch {
      await page.mouse.click(160, 260);
    }
  }
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
  await page.keyboard.press(process.platform === "darwin" ? "Meta+Home" : "Control+Home");
  await page.waitForTimeout(300);
}

async function renameDocument(page: Page, title: string): Promise<boolean> {
  console.log(`[sheets] 重新命名試算表標題：${title}`);
  const mod = process.platform === "darwin" ? "Meta" : "Control";
  const selectors = [
    "input.docs-title-input",
    ".docs-title-input input",
    "#docs-title-widget input",
    'input[aria-label*="重新命名"]',
    'input[aria-label*="Rename"]',
    "input.docs-title-input-label-inner",
    "#docs-title-input-label-inner",
  ];

  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      await page
        .waitForSelector("input.docs-title-input, .docs-title-input, #docs-title-widget", {
          timeout: 8000,
        })
        .catch(() => {});

      for (const sel of selectors) {
        const box = page.locator(sel).first();
        if (!(await box.count().catch(() => 0))) continue;
        const visible = await box.isVisible().catch(() => false);
        if (!visible) continue;

        await box.click({ timeout: 4000, clickCount: 3 }).catch(async () => {
          await box.click({ timeout: 4000 }).catch(() => {});
        });
        await page.waitForTimeout(250);
        await page.keyboard.press(`${mod}+a`).catch(() => {});
        await page.waitForTimeout(100);

        // 用 fill（input）或鍵盤輸入
        let filled = false;
        try {
          await box.fill(title, { timeout: 2000 });
          filled = true;
        } catch {
          await page.keyboard.type(title, { delay: 18 });
          filled = true;
        }
        if (!filled) continue;

        await page.keyboard.press("Enter");
        await page.waitForTimeout(900);

        const current =
          (await box.inputValue().catch(() => "")) ||
          (await box.getAttribute("value").catch(() => "")) ||
          "";
        const pageTitle = await page.title().catch(() => "");
        if (
          current === title ||
          current.includes(title.slice(0, 12)) ||
          pageTitle.includes(title.slice(0, 12)) ||
          pageTitle.includes(title)
        ) {
          console.log(`[sheets] 已改名：${title}`);
          return true;
        }
        console.warn(
          `[sheets] rename 核對未完全吻合（attempt ${attempt}）：input="${current}" title="${pageTitle}"`
        );
      }
    } catch (err) {
      console.warn(`[sheets] rename attempt ${attempt}：`, err);
    }
    await page.waitForTimeout(800);
  }
  console.warn(`[sheets] 未能將標題改成「${title}」`);
  return false;
}

async function pasteTsvIntoSheet(page: Page, tsv: string, runtimeDir: string): Promise<void> {
  await setSystemClipboard(tsv, runtimeDir);
  await focusSheetGrid(page);
  const pasteKey = process.platform === "darwin" ? "Meta+v" : "Control+v";
  await page.keyboard.press(pasteKey);
  await page.waitForTimeout(1500);
}

/** 全選後「調整欄寬以配合資料」，減少字重疊 */
async function autofitColumns(page: Page): Promise<void> {
  try {
    await focusSheetGrid(page);
    await page.keyboard.press(process.platform === "darwin" ? "Meta+a" : "Control+a");
    await page.waitForTimeout(400);

    // 開啟「格式」選單
    const formatTriggers = [
      page.locator("#docs-format-menu"),
      page.getByRole("menuitem", { name: /^格式$|^Format$/i }),
      page.locator('div[role="menubar"] >> text=格式'),
      page.locator('div[role="menubar"] >> text=Format'),
    ];
    let opened = false;
    for (const t of formatTriggers) {
      if (await t.first().isVisible().catch(() => false)) {
        await t.first().click({ timeout: 3000 }).catch(() => {});
        opened = true;
        break;
      }
    }
    if (!opened) {
      // Fallback: Alt+O often opens Format on Windows Sheets
      await page.keyboard.press("Alt+o").catch(() => {});
    }
    await page.waitForTimeout(400);

    const colItem = page
      .getByRole("menuitem", { name: /欄|Columns?/i })
      .or(page.locator('[role="menuitem"]:has-text("欄"), [role="menuitem"]:has-text("Column")'))
      .first();
    if (await colItem.isVisible().catch(() => false)) {
      await colItem.hover().catch(() => {});
      await colItem.click().catch(() => {});
      await page.waitForTimeout(300);
    }

    const fitItem = page
      .getByRole("menuitem", { name: /調整.*資料|Fit to data|Resize columns/i })
      .or(
        page.locator(
          '[role="menuitem"]:has-text("調整"), [role="menuitem"]:has-text("Fit to data")'
        )
      )
      .first();
    if (await fitItem.isVisible().catch(() => false)) {
      await fitItem.click({ timeout: 3000 });
      await page.waitForTimeout(800);
      return;
    }

    // Fallback: wrap text so long Chinese headers don't collide visually
    await page.keyboard.press("Escape").catch(() => {});
    await page.keyboard.press(process.platform === "darwin" ? "Meta+a" : "Control+a");
    await page.waitForTimeout(200);
    const format2 = page.locator("#docs-format-menu").or(page.getByText(/^格式$|^Format$/i)).first();
    if (await format2.isVisible().catch(() => false)) {
      await format2.click().catch(() => {});
      const wrap = page.getByText(/文字自動換行|Text wrapping|Wrap/i).first();
      if (await wrap.isVisible().catch(() => false)) {
        await wrap.click().catch(() => {});
        const wrapOn = page.getByText(/^溢出$|^Overflow$|自動換行|Wrap/i).first();
        await wrapOn.click().catch(() => {});
      }
    }
  } catch (err) {
    console.warn("[sheets] autofit columns failed:", err);
  }
}

async function launchSheetsContext(profileDir: string): Promise<BrowserContext> {
  await fs.mkdir(profileDir, { recursive: true });
  const common = {
    headless: false,
    viewport: { width: 1400, height: 900 } as const,
    args: ["--disable-blink-features=AutomationControlled"],
    ignoreDefaultArgs: ["--enable-automation"] as string[],
  };
  try {
    return await chromium.launchPersistentContext(profileDir, {
      ...common,
      channel: "chrome",
    });
  } catch {
    return await chromium.launchPersistentContext(profileDir, common);
  }
}

export async function exportOrdersToGoogleSheet(opts: {
  orders: unknown[];
  runtimeDir: string;
}): Promise<ExportGoogleSheetResult> {
  if (exportInFlight) return exportInFlight;

  exportInFlight = (async () => {
    const list = (Array.isArray(opts.orders) ? opts.orders : [])
      .filter(hasOrderNumber)
      .map((o) => orderToSheetRow(o as Record<string, unknown>));

    if (!list.length) {
      return { ok: false, error: "未有成功訂單可以匯出。" };
    }

    const stamp = formatHkOrderDateTime();
    const title = stamp;
    const tsv = toTsv(list);
    const profileDir = path.join(opts.runtimeDir, "google-sheets-profile");

    const g = globalThis as { __sheetsExportContext?: BrowserContext };
    if (g.__sheetsExportContext) {
      await g.__sheetsExportContext.close().catch(() => {});
      g.__sheetsExportContext = undefined;
    }

    let context: BrowserContext | null = null;
    try {
      context = await launchSheetsContext(profileDir);
      const page = context.pages()[0] || (await context.newPage());

      await page.goto("https://sheets.new", {
        waitUntil: "domcontentloaded",
        timeout: 90_000,
      });

      const url = await waitForSpreadsheet(page, 5 * 60_000);
      await page.waitForLoadState("domcontentloaded").catch(() => {});
      // 等標題列出現
      await page.waitForTimeout(1500);
      await renameDocument(page, title);
      await pasteTsvIntoSheet(page, tsv, opts.runtimeDir);
      await autofitColumns(page);
      // 貼完再改一次名，確保最終標題係真實日期時間
      await renameDocument(page, title);

      // Keep the filled sheet window open for the user.
      g.__sheetsExportContext = context;

      return { ok: true, url, title, rowCount: list.length };
    } catch (err) {
      await context?.close().catch(() => {});
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  })();

  try {
    return await exportInFlight;
  } finally {
    exportInFlight = null;
  }
}

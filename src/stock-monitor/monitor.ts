/**
 * Apple HK iPhone 庫存／開賣監察主程式
 *
 * 執行：npm run watch
 */
import { chromium, type Browser, type Page } from "playwright";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MONITOR_CONFIG, SKUS, type SkuConfig } from "./config.js";
import { launchCheckoutFromMonitor } from "./checkout-launcher.js";
import { escapeMd, formatHkNow, notifyAll, notifyTelegram, upsertTelegramStockMonitor } from "./notifier.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const RUNTIME_DIR = path.join(ROOT, "runtime");
const MONITOR_STATUS_FILE = path.join(RUNTIME_DIR, "monitor-status.json");

/** Dashboard 可透過 env 覆寫目標數量 */
function effectiveSkus(): SkuConfig[] {
  const q = Number(process.env.MONITOR_QUANTITY || "");
  if (!Number.isFinite(q) || q < 1) return SKUS;
  return SKUS.map((s) => ({ ...s, quantity: Math.floor(q) }));
}

export type StockStatus =
  | "available"
  | "out_of_stock"
  | "coming_soon"
  | "not_listed"
  | "unknown"
  | "error";

type CheckResult = {
  sku: SkuConfig;
  status: StockStatus;
  label: string;
  detail: string;
  deliveryText: string | null;
  /** 頁面偵測到嘅可買／限購數量（冇就 null） */
  stockQty: number | null;
  /** 實際會用嚟落單嘅數量 */
  buyQty: number;
  error?: string;
};

type SkuRuntime = {
  lastStatus: StockStatus | null;
  consecutiveFailures: number;
  notifiedAvailable: boolean;
  failureAlertSent: boolean;
  /** 呢次有貨週期已啟動過自動結帳 */
  checkoutTriggered: boolean;
};

const runtime = new Map<string, SkuRuntime>();

function getRuntime(name: string): SkuRuntime {
  let r = runtime.get(name);
  if (!r) {
    r = {
      lastStatus: null,
      consecutiveFailures: 0,
      notifiedAvailable: false,
      failureAlertSent: false,
      checkoutTriggered: false,
    };
    runtime.set(name, r);
  }
  return r;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function statusLabel(status: StockStatus): string {
  switch (status) {
    case "available":
      return "有貨";
    case "out_of_stock":
      return "缺貨";
    case "coming_soon":
      return "即將推出";
    case "not_listed":
      return "未上架";
    case "error":
      return "錯誤";
    default:
      return "未知";
  }
}

function isPositiveAvailable(status: StockStatus): boolean {
  return status === "available";
}

function wasUnavailable(status: StockStatus | null): boolean {
  return (
    status === null ||
    status === "out_of_stock" ||
    status === "coming_soon" ||
    status === "not_listed" ||
    status === "unknown" ||
    status === "error"
  );
}

/** 由頁面文字解析限購／可買數量 */
function parseStockQty(bodyText: string): number | null {
  const digit = bodyText.match(/每位顧客限購\s*(\d+)\s*部|限購\s*(\d+)\s*部/i);
  if (digit) {
    const n = Number(digit[1] || digit[2]);
    if (Number.isFinite(n) && n > 0) return n;
  }
  if (/限購兩部|限購\s*兩\s*部/i.test(bodyText)) return 2;
  if (/限購一部|限購\s*一\s*部/i.test(bodyText)) return 1;
  const cn = bodyText.match(/限購\s*([一二三四五六七八九十兩])\s*部/);
  if (cn?.[1]) {
    const map: Record<string, number> = {
      一: 1,
      二: 2,
      兩: 2,
      三: 3,
      四: 4,
      五: 5,
      六: 6,
      七: 7,
      八: 8,
      九: 9,
      十: 10,
    };
    return map[cn[1]] ?? null;
  }
  return null;
}

function resolveBuyQty(sku: SkuConfig, stockQty: number | null): number {
  const target = Math.max(1, Math.floor(sku.quantity) || 1);
  if (stockQty != null && stockQty > 0) return Math.min(target, stockQty);
  return target;
}

async function clickStorageIfPresent(page: Page, storage: string): Promise<boolean> {
  const autom = storage.replace(/\s+/g, "").toLowerCase();
  const candidates = [
    page.locator(`[data-autom="dimensionCapacity${autom}"]`),
    page.locator(`input[value="${autom}"]`),
    page.getByRole("radio", { name: new RegExp(storage.replace(/\s+/g, "\\s*"), "i") }),
    page.getByRole("button", { name: new RegExp(storage.replace(/\s+/g, "\\s*"), "i") }),
    page.getByText(new RegExp(`^\\s*${storage.replace(/\s+/g, "\\s*")}\\s*$`, "i")),
  ];
  for (const loc of candidates) {
    const el = loc.first();
    const count = await el.count().catch(() => 0);
    if (!count) continue;
    const visible = await el.isVisible().catch(() => false);
    if (!visible) continue;
    const disabled = await el.isDisabled().catch(() => false);
    if (disabled) return false;
    await el.click({ force: true, timeout: 5000 }).catch(async () => {
      await el.evaluate((n) => (n as HTMLElement).click()).catch(() => {});
    });
    await page.waitForTimeout(400);
    return true;
  }
  return false;
}

async function clickColorIfPresent(page: Page, color: string): Promise<boolean> {
  if (!color.trim()) return true;
  const candidates = [
    page.getByRole("radio", { name: new RegExp(color, "i") }),
    page.getByRole("button", { name: new RegExp(color, "i") }),
    page.getByLabel(new RegExp(color, "i")),
    page.getByText(color, { exact: false }),
  ];
  for (const loc of candidates) {
    const el = loc.first();
    if (!(await el.count().catch(() => 0))) continue;
    if (!(await el.isVisible().catch(() => false))) continue;
    await el.click({ force: true, timeout: 5000 }).catch(async () => {
      await el.evaluate((n) => (n as HTMLElement).click()).catch(() => {});
    });
    await page.waitForTimeout(400);
    return true;
  }
  return false;
}

async function completePurchasePrereqs(page: Page): Promise<void> {
  const noTradeIn = page.locator('[data-autom="choose-noTradeIn"]');
  if (await noTradeIn.count().catch(() => 0)) {
    await noTradeIn.first().click({ force: true, timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(600);
  }

  const noAppleCare = page.locator('[data-autom="noapplecare"]');
  if (await noAppleCare.count().catch(() => 0)) {
    const disabled = await noAppleCare.first().isDisabled().catch(() => true);
    if (!disabled) {
      await noAppleCare.first().click({ force: true, timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(600);
    }
  }
}

async function readPageSignals(page: Page): Promise<{
  bodyText: string;
  hasPurchaseCtaEnabled: boolean;
  hasPurchaseCtaDisabled: boolean;
  onAttachStep: boolean;
  deliveryText: string | null;
  stockQty: number | null;
}> {
  const bodyText = ((await page.locator("body").innerText().catch(() => "")) || "").replace(
    /\s+/g,
    " "
  );
  const onAttachStep = /[?&]step=attach\b/i.test(page.url());
  const stockQty = parseStockQty(bodyText);

  let hasPurchaseCtaEnabled = false;
  let hasPurchaseCtaDisabled = false;

  const primarySelectors = [
    '[data-autom="add-to-cart"]',
    'button[name="add-to-cart"]',
    '[data-autom="continueButton"]',
    '[data-autom="proceed"]',
  ];
  for (const sel of primarySelectors) {
    const loc = page.locator(sel);
    const count = await loc.count().catch(() => 0);
    for (let i = 0; i < Math.min(count, 3); i++) {
      const el = loc.nth(i);
      if (!(await el.isVisible().catch(() => false))) continue;
      const disabled = await el.isDisabled().catch(() => false);
      if (disabled) hasPurchaseCtaDisabled = true;
      else hasPurchaseCtaEnabled = true;
    }
  }

  if (onAttachStep) {
    const reviewBag = page.getByRole("button", { name: /查看購物袋|Review Bag/i });
    if (await reviewBag.count().catch(() => 0)) {
      const el = reviewBag.first();
      if (await el.isVisible().catch(() => false)) {
        if (await el.isDisabled().catch(() => false)) hasPurchaseCtaDisabled = true;
        else hasPurchaseCtaEnabled = true;
      }
    }
  }

  const deliveryMatch = bodyText.match(
    /(?:\d+\s*[-–]\s*\d+\s*個工作天)|(?:暫時缺貨|已售罄|暫時無貨)|(?:送貨[^。\n]{0,24})|(?:店內取貨[^。\n]{0,24})/i
  );
  const deliveryText = deliveryMatch ? deliveryMatch[0].trim() : null;

  return {
    bodyText,
    hasPurchaseCtaEnabled,
    hasPurchaseCtaDisabled,
    onAttachStep,
    deliveryText,
    stockQty,
  };
}

function classifyStatus(opts: {
  storageOk: boolean;
  bodyText: string;
  hasPurchaseCtaEnabled: boolean;
  hasPurchaseCtaDisabled: boolean;
  onAttachStep: boolean;
  url: string;
}): { status: StockStatus; detail: string } {
  const {
    storageOk,
    bodyText,
    hasPurchaseCtaEnabled,
    hasPurchaseCtaDisabled,
    onAttachStep,
    url,
  } = opts;

  const oos =
    /暫時缺貨|已售罄|暫時無貨|Currently unavailable|Out of stock/i.test(bodyText) &&
    !hasPurchaseCtaEnabled;
  const soon = /即將推出|Coming soon|Not yet available|即將發售|尚未發售/i.test(bodyText);

  if (onAttachStep || /[?&]step=attach\b/i.test(url)) {
    if (hasPurchaseCtaEnabled) {
      return { status: "available", detail: "已到 attach／可查看購物袋（可訂購）" };
    }
    if (oos) {
      return { status: "out_of_stock", detail: "attach 頁顯示缺貨" };
    }
  }

  if (!storageOk && !onAttachStep && !/[?&]product=/i.test(url)) {
    return {
      status: "not_listed",
      detail: "揾唔到／撳唔到指定容量選項（可能未上架或網址唔啱）",
    };
  }
  if (soon && !hasPurchaseCtaEnabled) {
    return { status: "coming_soon", detail: "頁面顯示即將推出／尚未發售" };
  }
  if (hasPurchaseCtaEnabled) {
    return { status: "available", detail: "偵測到可撳嘅加入購物袋／查看購物袋掣" };
  }
  if (oos) {
    return { status: "out_of_stock", detail: "頁面顯示缺貨／已售罄" };
  }
  if (hasPurchaseCtaDisabled) {
    return {
      status: "out_of_stock",
      detail: "完成選項後「加入購物袋」仍然 disabled（可能真缺貨）",
    };
  }
  return { status: "unknown", detail: "未能判斷訂購掣狀態" };
}

async function checkOneSku(browser: Browser, sku: SkuConfig): Promise<CheckResult> {
  if (!sku.url.trim()) {
    return {
      sku,
      status: "error",
      label: statusLabel("error"),
      detail: "未填 url",
      deliveryText: null,
      stockQty: null,
      buyQty: resolveBuyQty(sku, null),
      error: "config 入面 url 係空 — 請填產品頁網址",
    };
  }

  const page = await browser.newPage();
  try {
    await page.goto(sku.url, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
    await page.waitForTimeout(800);

    await page
      .getByRole("button", { name: /同意|接受全部|Allow all|Accept/i })
      .first()
      .click({ timeout: 2000 })
      .catch(() => {});

    const urlImpliesConfigured =
      /[?&]step=attach\b/i.test(sku.url) || /[?&]product=/i.test(sku.url);

    let storageOk = urlImpliesConfigured;
    if (!urlImpliesConfigured) {
      storageOk = await clickStorageIfPresent(page, sku.storage);
      if (sku.color?.trim()) {
        await clickColorIfPresent(page, sku.color.trim()).catch(() => false);
      }
      await completePurchasePrereqs(page);
    }

    const signals = await readPageSignals(page);
    const pageUrlForStatus = page.url();
    let stockQty = signals.stockQty;

    // attach 頁有時冇限購字；有貨時去 checkoutUrl／設定頁補睇「限購 N 部」
    if (stockQty == null && sku.checkoutUrl?.trim()) {
      try {
        await page.goto(sku.checkoutUrl.trim(), {
          waitUntil: "domcontentloaded",
          timeout: 30_000,
        });
        await page.waitForTimeout(600);
        const extraBody = (
          (await page.locator("body").innerText().catch(() => "")) || ""
        ).replace(/\s+/g, " ");
        stockQty = parseStockQty(extraBody);
      } catch {
        /* ignore enrich errors */
      }
    }

    const { status, detail } = classifyStatus({
      storageOk,
      bodyText: signals.bodyText,
      hasPurchaseCtaEnabled: signals.hasPurchaseCtaEnabled,
      hasPurchaseCtaDisabled: signals.hasPurchaseCtaDisabled,
      onAttachStep: signals.onAttachStep,
      url: pageUrlForStatus,
    });

    // 有貨但頁面冇寫限購 → 用目標數量當可買上限（仍標註為估計）
    const buyQty = resolveBuyQty(sku, stockQty);
    const reportedStock =
      stockQty != null
        ? stockQty
        : status === "available"
          ? buyQty
          : null;

    return {
      sku,
      status,
      label: statusLabel(status),
      detail,
      deliveryText: signals.deliveryText,
      stockQty: reportedStock,
      buyQty,
    };
  } catch (err) {
    return {
      sku,
      status: "error",
      label: statusLabel("error"),
      detail: "檢查失敗",
      deliveryText: null,
      stockQty: null,
      buyQty: resolveBuyQty(sku, null),
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    await page.close().catch(() => {});
  }
}

async function checkAllSkus(browser: Browser): Promise<CheckResult[]> {
  const list = effectiveSkus();
  if (MONITOR_CONFIG.runInParallel) {
    const tasks = list.map(async (sku, i) => {
      if (i > 0) await sleep(MONITOR_CONFIG.staggerMs * i);
      return checkOneSku(browser, sku);
    });
    return Promise.all(tasks);
  }

  const results: CheckResult[] = [];
  for (let i = 0; i < list.length; i++) {
    const sku = list[i]!;
    results.push(await checkOneSku(browser, sku));
    if (i < list.length - 1) await sleep(MONITOR_CONFIG.delayBetweenSkusMs);
  }
  return results;
}

async function handleResult(result: CheckResult): Promise<void> {
  const rt = getRuntime(result.sku.name);

  if (result.status === "error") {
    rt.consecutiveFailures += 1;
    console.warn(
      `  ! ${result.sku.name}: 錯誤 (${rt.consecutiveFailures}/${MONITOR_CONFIG.maxConsecutiveFailures}) — ${result.error || result.detail}`
    );
    if (
      rt.consecutiveFailures >= MONITOR_CONFIG.maxConsecutiveFailures &&
      !rt.failureAlertSent
    ) {
      rt.failureAlertSent = true;
      await notifyAll({
        title: "SKU 監察可能失效",
        message: `${result.sku.name} 連續失敗 ${rt.consecutiveFailures} 次。請檢查網址／selector。\n${result.error || result.detail}`,
        url: result.sku.url || undefined,
      });
    }
    rt.lastStatus = "error";
    return;
  }

  rt.consecutiveFailures = 0;
  rt.failureAlertSent = false;

  if (isPositiveAvailable(result.status) && wasUnavailable(rt.lastStatus)) {
    if (!rt.notifiedAvailable) {
      rt.notifiedAvailable = true;
      const stockNum = result.stockQty ?? result.buyQty;
      await notifyAll({
        title: "Apple 有貨／可訂購",
        message: [
          result.sku.name,
          `總庫存／可買數量：${stockNum}`,
          `將落單數量：${result.buyQty}`,
          result.detail,
          `時間：${formatHkNow()}`,
        ].join("\n"),
        url: result.sku.url,
      });
      console.log(`  → 已通知：${result.sku.name}（庫存=${stockNum} 落單×${result.buyQty}）`);
    }
  }

  if (!isPositiveAvailable(result.status) && rt.lastStatus === "available") {
    rt.notifiedAvailable = false;
    rt.checkoutTriggered = false;
  }

  rt.lastStatus = result.status;
}

/** 有貨期間每隔 spawnBrowserGapMs 再開一個 Dashboard 瀏覽器，直至空倉超過 spawnIdleStopMs */
async function maybeSpawnCheckoutBrowsers(
  results: CheckResult[],
  state: {
    lastAvailableAt: number;
    lastSpawnAt: number;
    spawningActive: boolean;
  }
): Promise<typeof state> {
  if (!MONITOR_CONFIG.autoCheckout.enabled) return state;

  const available = results.filter((r) => isPositiveAvailable(r.status));
  const now = Date.now();

  if (available.length > 0) {
    const wasIdle = !state.spawningActive || state.lastSpawnAt === 0;
    state.lastAvailableAt = now;
    state.spawningActive = true;

    const gap = MONITOR_CONFIG.spawnBrowserGapMs;
    const due = state.lastSpawnAt === 0 || now - state.lastSpawnAt >= gap;
    if (!due) return state;

    if (wasIdle) {
      await notifyTelegram({
        title: "有貨 — 開始連開瀏覽器",
        message: [
          `每 ${gap / 1000} 秒再開一個 Dashboard 瀏覽器`,
          `直至連續 ${MONITOR_CONFIG.spawnIdleStopMs / 1000} 秒冇貨先停`,
          ...available.map(
            (r) =>
              `${r.sku.name}｜庫存=${r.stockQty ?? "?"}｜落單×${r.buyQty}`
          ),
        ].join("\n"),
        url: available[0]?.sku.url,
      });
    }

    for (const r of available) {
      const rt = getRuntime(r.sku.name);
      try {
        const buyUrl = r.sku.checkoutUrl?.trim() || r.sku.url;
        console.log(
          `  → 再開新瀏覽器：${r.sku.name}｜數量=${r.buyQty}｜${buyUrl}`
        );
        const launched = await launchCheckoutFromMonitor({
          sku: r.sku,
          quantity: r.buyQty,
        });
        rt.checkoutTriggered = true;
        console.log(
          `  → session=${launched.sessionId} pid=${launched.pid} via=${launched.via}`
        );
        await notifyTelegram({
          title: "已開新瀏覽器落單",
          message: [
            r.sku.name,
            `庫存／可買：${r.stockQty ?? "?"}`,
            `落單數量：×${r.buyQty}`,
            `session：${launched.sessionId}`,
            `via：${launched.via}`,
          ].join("\n"),
          url: r.sku.url,
        });
      } catch (err) {
        console.error(
          `  → 開瀏覽器失敗：`,
          err instanceof Error ? err.message : String(err)
        );
        await notifyTelegram({
          title: "開瀏覽器失敗",
          message: `${r.sku.name}\n${err instanceof Error ? err.message : String(err)}`,
          url: r.sku.url,
        });
      }
    }
    state.lastSpawnAt = Date.now();
    return state;
  }

  if (
    state.spawningActive &&
    state.lastAvailableAt > 0 &&
    now - state.lastAvailableAt >= MONITOR_CONFIG.spawnIdleStopMs
  ) {
    state.spawningActive = false;
    state.lastSpawnAt = 0;
    for (const r of results) {
      getRuntime(r.sku.name).checkoutTriggered = false;
    }
    console.log(
      `  → 已 ${MONITOR_CONFIG.spawnIdleStopMs / 1000} 秒冇再見到有貨：停止再開新瀏覽器`
    );
    await notifyTelegram({
      title: "停止再開新瀏覽器",
      message: `已連續 ${MONITOR_CONFIG.spawnIdleStopMs / 1000} 秒冇偵測到有貨，暫停自動開瀏覽器。監察會繼續。`,
    });
  }

  return state;
}

function printCycleTable(results: CheckResult[]): void {
  console.log(`\n[${formatHkNow()}]`);
  for (const r of results) {
    const rt = getRuntime(r.sku.name);
    const mark =
      r.status === "available"
        ? rt.checkoutTriggered
          ? " ✅ (已啟動結帳)"
          : rt.notifiedAvailable
            ? " ✅ (已通知)"
            : " ✅"
        : r.status === "error"
          ? " ⚠️"
          : "";
    const qty =
      r.status === "available" || r.stockQty != null
        ? `｜庫存/可買=${r.stockQty ?? "?"} 目標=${r.sku.quantity} 落單=${r.buyQty}`
        : `｜目標數量=${r.sku.quantity}`;
    const extra = r.deliveryText ? `｜${r.deliveryText}` : "";
    const err = r.error ? `｜${r.error}` : "";
    console.log(`- ${r.sku.name}: ${r.label}${mark}${qty}${extra}${err}`);
  }
}

async function publishCycleStatus(results: CheckResult[]): Promise<void> {
  const totalAvailable = results
    .filter((r) => r.status === "available")
    .reduce((sum, r) => sum + (r.stockQty ?? r.buyQty ?? 0), 0);
  const payload = {
    updatedAt: new Date().toISOString(),
    updatedAtHk: formatHkNow(),
    autoCheckout: MONITOR_CONFIG.autoCheckout.enabled,
    totalAvailableStock: totalAvailable,
    skus: results.map((r) => ({
      name: r.sku.name,
      status: r.status,
      label: r.label,
      stockQty: r.stockQty,
      buyQty: r.buyQty,
      targetQty: r.sku.quantity,
      checkoutTriggered: getRuntime(r.sku.name).checkoutTriggered,
      url: r.sku.url,
      error: r.error || null,
    })),
  };

  await fs.mkdir(RUNTIME_DIR, { recursive: true }).catch(() => {});
  await fs.writeFile(MONITOR_STATUS_FILE, JSON.stringify(payload, null, 2), "utf8").catch(() => {});

  const lines = [
    "*Apple HK 庫存監察*",
    `時間：${escapeMd(formatHkNow())}`,
    `自動購買：${MONITOR_CONFIG.autoCheckout.enabled ? "ON" : "OFF"}`,
    "",
    `📦 *總庫存／可買數量：${totalAvailable}*`,
    "",
    ...results.map((r) => {
      const stock =
        r.stockQty != null ? String(r.stockQty) : r.status === "available" ? String(r.buyQty) : "0";
      return `· ${escapeMd(r.sku.name)}：${escapeMd(r.label)}｜庫存=*${escapeMd(stock)}*｜落單=${r.buyQty}`;
    }),
  ];
  await upsertTelegramStockMonitor(lines.join("\n"));
}

async function main(): Promise<void> {
  const skus = effectiveSkus();
  console.log("Apple HK iPhone 庫存監察啟動");
  console.log(
    `SKU 數=${skus.length}｜間隔=${MONITOR_CONFIG.checkIntervalMs / 1000}s（有貨→${MONITOR_CONFIG.fastCheckIntervalMs / 1000}s，空倉 ${MONITOR_CONFIG.fastModeIdleMs / 1000}s 後退回）｜平行=${MONITOR_CONFIG.runInParallel}`
  );
  console.log(
    `通知：desktop=${MONITOR_CONFIG.notify.desktop} telegram=${MONITOR_CONFIG.notify.telegram} liveStatus=${MONITOR_CONFIG.telegramLiveStatus}`
  );
  console.log(
    `自動結帳：${MONITOR_CONFIG.autoCheckout.enabled ? "ON" : "OFF"}｜fulfillment=${MONITOR_CONFIG.autoCheckout.fulfillmentPreference}`
  );

  await notifyTelegram({
    title: MONITOR_CONFIG.autoCheckout.enabled
      ? "監察+購買 已啟動"
      : "庫存監察 已啟動",
    message: [
      `SKU：${skus.map((s) => s.name).join("、") || "（無）"}`,
      `間隔：${MONITOR_CONFIG.checkIntervalMs / 1000}s（有貨→${MONITOR_CONFIG.fastCheckIntervalMs / 1000}s）`,
      `自動開瀏覽器：${MONITOR_CONFIG.autoCheckout.enabled ? "ON" : "OFF"}`,
      `Telegram 會持續更新庫存數量`,
    ].join("\n"),
  });

  const missingUrl = skus.filter((s) => !s.url.trim());
  if (missingUrl.length) {
    console.warn(
      `\n警告：以下 SKU 未填 url，會報錯直至你喺 config.ts 填好：\n${missingUrl
        .map((s) => `  - ${s.name}`)
        .join("\n")}\n`
    );
  }

  for (const s of skus) {
    console.log(`  · ${s.name}｜目標數量=${s.quantity}｜${s.url || "(未填 url)"}`);
  }

  const browser = await chromium.launch({
    headless: !MONITOR_CONFIG.headed,
    args: ["--disable-blink-features=AutomationControlled"],
  });

  /** 最近一次見到有貨嘅時間；用來決定快／慢輪詢 */
  let lastAvailableAt = 0;
  let usingFastInterval = false;
  let spawnState = {
    lastAvailableAt: 0,
    lastSpawnAt: 0,
    spawningActive: false,
  };

  const shutdown = async () => {
    console.log("\n正在關閉…");
    await notifyTelegram({
      title: "庫存監察 已停止",
      message: `時間：${formatHkNow()}`,
    }).catch(() => {});
    await browser.close().catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  while (true) {
    const started = Date.now();
    try {
      const results = await checkAllSkus(browser);
      for (const r of results) await handleResult(r);
      printCycleTable(results);
      await publishCycleStatus(results);

      const anyAvailable = results.some((r) => isPositiveAvailable(r.status));
      if (anyAvailable) {
        lastAvailableAt = Date.now();
        if (!usingFastInterval) {
          usingFastInterval = true;
          console.log(
            `  → 發現有貨：輪詢改為每 ${MONITOR_CONFIG.fastCheckIntervalMs / 1000} 秒；每輪再開一個瀏覽器`
          );
          await notifyTelegram({
            title: "發現有貨 — 加快監察",
            message: [
              `輪詢改為每 ${MONITOR_CONFIG.fastCheckIntervalMs / 1000} 秒`,
              MONITOR_CONFIG.autoCheckout.enabled
                ? `會每 ${MONITOR_CONFIG.spawnBrowserGapMs / 1000} 秒再開一個瀏覽器`
                : "（未開自動購買）",
              ...results
                .filter((r) => isPositiveAvailable(r.status))
                .map(
                  (r) =>
                    `${r.sku.name}｜庫存=${r.stockQty ?? "?"}｜落單×${r.buyQty}`
                ),
            ].join("\n"),
            url: results.find((r) => isPositiveAvailable(r.status))?.sku.url,
          });
        }
      } else if (
        usingFastInterval &&
        lastAvailableAt > 0 &&
        Date.now() - lastAvailableAt >= MONITOR_CONFIG.fastModeIdleMs
      ) {
        usingFastInterval = false;
        console.log(
          `  → 已 ${MONITOR_CONFIG.fastModeIdleMs / 1000} 秒冇再見到有貨：輪詢改返每 ${MONITOR_CONFIG.checkIntervalMs / 1000} 秒`
        );
        await notifyTelegram({
          title: "恢復正常監察間隔",
          message: `已 ${MONITOR_CONFIG.fastModeIdleMs / 1000} 秒冇貨，輪詢改返每 ${MONITOR_CONFIG.checkIntervalMs / 1000} 秒。`,
        });
      }

      spawnState = await maybeSpawnCheckoutBrowsers(results, spawnState);
    } catch (err) {
      console.error(
        "本輪 cycle 失敗（會繼續下一輪）：",
        err instanceof Error ? err.message : String(err)
      );
    }

    const intervalMs = usingFastInterval
      ? MONITOR_CONFIG.fastCheckIntervalMs
      : MONITOR_CONFIG.checkIntervalMs;
    const elapsed = Date.now() - started;
    const wait = Math.max(0, intervalMs - elapsed);
    console.log(
      `下一輪約 ${Math.ceil(wait / 1000)} 秒後…${usingFastInterval ? "（快輪詢）" : ""}`
    );
    await sleep(wait);
  }
}

main().catch(async (err) => {
  console.error("監察腳本致命錯誤：", err);
  process.exit(1);
});

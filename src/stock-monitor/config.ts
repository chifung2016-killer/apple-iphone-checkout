/**
 * Apple HK iPhone 庫存／開賣監察 — 設定檔
 *
 * 請自己填每個 SKU 嘅 `url`（產品頁完整網址）。
 * 腳本唔會自動砌網址。
 */
import "dotenv/config";

export type SkuConfig = {
  /** 顯示用名稱 */
  name: string;
  /** 監察用產品頁網址（必須由你自己填） */
  url: string;
  /**
   * 有貨時實際開嚟加購／結帳嘅網址。
   * 可留空 = 用 url。
   * 建議：監察用 attach 頁，結帳用已揀好容量顏色嘅設定頁（唔好淨用 step=attach，冷開會空袋）。
   */
  checkoutUrl?: string;
  /** 型號，例如 iPhone 17 */
  model: string;
  /** 容量，例如 128GB / 256GB */
  storage: string;
  /** 指定顏色；留空 "" 或 undefined = 唔限制顏色 */
  color?: string;
  /**
   * 目標購買數量（上限）。
   * 有貨時會再對照頁面「限購 N 部」，實際落單數量 = min(quantity, 偵測到嘅限購)。
   */
  quantity: number;
};

export type NotifyChannels = {
  /** Windows / macOS 桌面通知（node-notifier） */
  desktop: boolean;
  /** Telegram Bot */
  telegram: boolean;
};

export const MONITOR_CONFIG = {
  /**
   * true  = 同一個 browser 開多個 page 平行檢查
   * false = 逐個 SKU 順序檢查（較溫和）
   */
  runInParallel: false,

  /** 每個完整 cycle 間隔（毫秒）——冇貨時用 */
  checkIntervalMs: 45_000,

  /** 發現有貨後加快輪詢（毫秒） */
  fastCheckIntervalMs: 2_000,

  /** 連續幾耐冇再見到有貨，就退回原本間隔（毫秒） */
  fastModeIdleMs: 5_000,

  /**
   * 有貨期間：距離上次開瀏覽器至少幾耐先再開多一個（毫秒）
   * （同快輪詢一致 = 每輪有貨再開一個）
   */
  spawnBrowserGapMs: 2_000,

  /** 連續幾耐冇再見到有貨，就停止再開新瀏覽器（毫秒） */
  spawnIdleStopMs: 5_000,

  /** 順序模式下，每個 SKU 之間 delay（毫秒） */
  delayBetweenSkusMs: 2_500,

  /** 平行模式下，開 page 之間少少錯開（毫秒） */
  staggerMs: 800,

  /** 同一個 SKU 連續檢查失敗幾多次先發「監察可能失效」通知 */
  maxConsecutiveFailures: 5,

  /** headed: true 會見到瀏覽器（debug 用）；監察建議 false */
  headed: false,

  notify: {
    desktop: true,
    telegram: true,
  } satisfies NotifyChannels,

  /**
   * Telegram（由 .env 讀入）
   * TELEGRAM_BOT_TOKEN=...
   * TELEGRAM_CHAT_ID=...
   */
  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN || "",
    chatId: process.env.TELEGRAM_CHAT_ID || "",
  },

  /**
   * 有貨時自動啟動 buy-iphone-17.ts（加入購物袋 → 改數量 → 結帳到付款頁）
   * Dashboard「Start monitor+buying」會設 MONITOR_AUTO_CHECKOUT=1。
   * 而家流程：Dashboard 先開預熱 pickup task 停喺 Fulfillment-init；
   * 有貨時寫 stock-resume（含 model／color／storage），預熱頁只跟進同型號同色同容量，
   * 1 秒後 refresh 一次 Fulfillment-init 再繼續加購；冇新通知就返待命。
   */
  autoCheckout: {
    /** true = 偵測到有貨就自動開 headed 購買流程 */
    enabled:
      process.env.MONITOR_AUTO_CHECKOUT === "1" ||
      process.env.MONITOR_AUTO_CHECKOUT === "true",
    /** 優先經 Dashboard /api/browsers/add 開，瀏覽器會顯示喺 dashboard */
    preferDashboard: true,
    dashboardPort: Number(process.env.DASHBOARD_PORT || 8787),
    /** pickup | delivery | auto | *_apple_pay | *_applepay_guest | *_apple_ac_apple_pay */
    fulfillmentPreference: (process.env.MONITOR_FULFILLMENT ||
      "pickup") as
      | "pickup"
      | "delivery"
      | "auto"
      | "pickup_apple_pay"
      | "delivery_apple_pay"
      | "pickup_applepay_guest"
      | "delivery_applepay_guest"
      | "pickup_apple_ac_apple_pay"
      | "delivery_apple_ac_apple_pay",
    pickupSearch: process.env.MONITOR_PICKUP_SEARCH || "中環",
    pickupStoreKeywords: [
      "ifc mall",
      "Canton Road",
      "Causeway Bay",
      "Festival Walk",
      "apm Hong Kong",
      "New Town Plaza",
    ],
    skipTradeIn: true,
    addAppleCare: false,
    /** 開賣輪詢間隔（有貨即搶時用短少少） */
    productPollIntervalMs: 3_000,
  },

  /** 每個 cycle 用 Telegram 更新／編輯一則「庫存監察」訊息（含可買數量） */
  telegramLiveStatus: true,
};

/**
 * ★★★ 請喺呢度填入正確產品頁網址 ★★★
 *
 * 點攞網址：
 * 1. 用瀏覽器開 https://www.apple.com/hk-zh/shop/buy-iphone
 * 2. 揀好型號／容量／顏色，抄 address bar 完整 URL
 * 3. 貼落面 `url` 欄
 */
export const SKUS: SkuConfig[] = [
  {
    name: "iPhone 17 256GB 薰衣草紫色",
    /** 監察：attach 頁（有「查看購物袋」= 可訂） */
    url: "https://www.apple.com/hk-zh/shop/buy-iphone/iphone-17?product=mg6m4za/a&step=attach",
    /** 結帳：設定頁（可真正加入購物袋） */
    checkoutUrl:
      "https://www.apple.com/hk-zh/shop/buy-iphone/iphone-17/6.3-%E5%90%8B%E9%A1%AF%E7%A4%BA%E5%99%A8-256gb-%E8%96%B0%E8%A1%A3%E8%8D%89%E7%B4%AB%E8%89%B2",
    model: "iPhone 17",
    storage: "256GB",
    color: "薰衣草紫色",
    /** 目標數量；實際會跟頁面限購同呢個數取細 */
    quantity: 2,
  },
];

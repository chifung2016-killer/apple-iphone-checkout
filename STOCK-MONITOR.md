# Apple HK 多 SKU 庫存／開賣監察

用 Playwright 循環檢查多個 iPhone 產品頁；**有貨／可訂購嗰一刻**先桌面 + Telegram 通知。

## 檔案

```
src/stock-monitor/
  config.ts     ← SKU 清單、間隔、平行開關、通知開關
  notifier.ts   ← 桌面通知 + Telegram
  monitor.ts    ← 主循環
.env.example    ← 複製成 .env
```

## npm 套件

```bat
npm install
```

會裝／用到：

| 套件 | 用途 |
|------|------|
| `playwright` | 開頁檢查 |
| `dotenv` | 讀 `.env` |
| `node-notifier` | 桌面通知 |
| `tsx` | 直接跑 TypeScript |

（`postinstall` 會裝 Chromium。）

## .env（Telegram）

1. 複製：

```bat
copy .env.example .env
```

2. 填：

```
TELEGRAM_BOT_TOKEN=123456:ABC-DEF...
TELEGRAM_CHAT_ID=987654321
```

### 點攞 Bot Token
1. Telegram 搵 [@BotFather](https://t.me/BotFather)
2. `/newbot` → 跟指示
3. 複製 Token 填入 `TELEGRAM_BOT_TOKEN`

### 點攞 Chat ID
1. 先喺 Telegram 撳 Start 同你個 bot 傾偈
2. 搵 [@userinfobot](https://t.me/userinfobot) 或 [@getidsbot](https://t.me/getidsbot) 攞你嘅數字 ID  
   或者瀏覽器開：  
   `https://api.telegram.org/bot<你的TOKEN>/getUpdates`  
   睇 `chat":{"id": ...}`
3. 填入 `TELEGRAM_CHAT_ID`

只想用桌面通知：喺 `config.ts` 設 `notify.telegram: false`。

## 填產品頁網址

開 `src/stock-monitor/config.ts`，每個 SKU 填 `url`：

1. 瀏覽器開 [Apple HK 買 iPhone](https://www.apple.com/hk-zh/shop/buy-iphone)
2. 揀好型號／容量／顏色
3. 複製 address bar **完整 URL**
4. 貼落對應項目嘅 `url: "..."`  

腳本**唔會**自動砌網址。`url` 留空會報錯並跳過。

可選填 `color`（例如 `"布根地紅色"`）；留空 = 唔強制揀色。

## 執行

```bat
npm run watch
```

停止：終端按 `Ctrl+C`。

## 主要設定（config.ts）

| 變數 | 意思 |
|------|------|
| `runInParallel` | `true` 多 tab 平行；`false` 逐個查 |
| `checkIntervalMs` | 每個 cycle 間隔（預設 45000 = 45 秒） |
| `delayBetweenSkusMs` | 順序模式下 SKU 之間停頓 |
| `maxConsecutiveFailures` | 連續失敗幾多次先發「監察失效」通知 |
| `headed` | `true` 顯示瀏覽器（debug） |
| `notify.desktop` / `notify.telegram` | 開邊種通知 |

## 通知規則

- 只喺狀態由「缺貨／未上架／即將推出」→「有貨」嗰下通知一次
- 之後再變缺貨，下次又有貨會再通知
- 連續失敗達上限會通知一次「監察可能失效」

## Terminal 輸出例子

```
[2026-09-12 10:30:00]
- iPhone 18 Pro Max 128GB: 缺貨
- iPhone 18 Pro Max 256GB: 缺貨
- iPhone 18 Pro 256GB: 有貨 ✅ (已通知)
```

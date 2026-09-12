# Apple HK iPhone Checkout Dashboard

本機用嘅 **Apple 香港官網 iPhone 結帳輔助工具**。  
用 Dashboard 開多個瀏覽器、自動行到付款頁，**信用卡卡號同落單要人手完成**。

---

## 你需要另外下載咩？

只需一樣：

| 項目 | 要唔要下載 | 說明 |
|------|------------|------|
| **Node.js LTS（建議 20 或以上）** | **要** | 去 [https://nodejs.org](https://nodejs.org) 下載 Windows Installer |
| Playwright / Chromium | 唔使另外搵 | `npm install` 會自動裝 |
| Chrome / Edge | 唔使 | 用 Playwright 自帶 Chromium |
| 其他軟件 | 唔使 | — |

裝完 Node 之後，用 PowerShell / CMD 入專案資料夾跑下面指令即可。

> **只想監察庫存／開賣？** 睇 [STOCK-MONITOR.md](./STOCK-MONITOR.md)（`npm run watch`）。

---

## 第一次安裝（只做一次）

```bat
npm install
```

成功後會自動下載 Chromium（`postinstall`）。

若 Chromium 下載失敗，再跑：

```bat
npx playwright install chromium
```

---

## 點樣用（日常）

### 方法 A：雙擊啟動（Windows）

1. 雙擊 `start-dashboard.bat`
2. 瀏覽器開：**http://127.0.0.1:8787**

### 方法 B：指令

```bat
npm run dashboard
```

然後開：**http://127.0.0.1:8787**

---

## Dashboard 點用

1. 揀產品（iPhone 17 / iPhone 18 Pro Max 顏色）
2. 填 **Quantity**、**Launch count**
3. 揀 **Delivery method**（pickup / delivery / auto）— 唔會預設 Auto，一定要自己揀
4. 撳 **Launch browsers**
5. 任務開始後視窗會隱藏；去到 **Billing** 頁先會自動開大
6. 人手填卡號同落單
7. 落單成功後撳 **Continue**，Order summary 會顯示金額、卡號、送貨／取貨資料等

### 常用掣

| 掣 | 作用 |
|----|------|
| **Stop all** | 停晒所有自動化，**唔再開窗／fullscreen** |
| **Stop (take over)** | 停單一任務自動化，並開窗畀你接手 |
| **Open / Hide** | 顯示或隱藏該瀏覽器 |
| **Close** | 關閉該瀏覽器並移除卡片 |
| **Clear all** | 清晒所有 session |

---

## 注意

- 只輔助到 **Billing／付款頁**，唔會自動填完整卡號、唔會自動撳「下訂單」
- 建議用有線／穩定網絡；開賣前可設好 refresh interval
- 電郵池喺 `src/buy-iphone-17.ts` 嘅 `EMAIL_POOL`；用過會記喺 `used-emails.json`

---

## 檔案結構（簡）

```
apple-iphone-checkout/
  start-dashboard.bat   ← 雙擊啟動
  setup.bat             ← 第一次安裝
  package.json
  src/
    server.ts           ← Dashboard API（port 8787）
    buy-iphone-17.ts    ← 結帳自動化
  dashboard/
    index.html          ← 控制台 UI
  runtime/              ← 運行狀態（可刪）
```

---

## 監察多個容量／型號（例如 Pro Max 128 / 256、Pro 256）

Dashboard **每次 Launch／Add 只跟住你而家揀嘅嗰個產品 URL** 去 refresh 搶「繼續」。

要同時監察幾個 SKU：

1. 揀 **iPhone 18 Pro Max · 128GB** → Launch count `1` → Launch  
2. 再揀 **iPhone 18 Pro Max · 256GB** → Add browser（1）  
3. 再揀 **iPhone 18 Pro · 256GB** → Add browser（1）  

每個瀏覽器會各自 poll 自己嗰個產品頁。Refresh interval 用表單嘅毫秒數（例如 5000）。

開賣時間用 **Sale start** 欄；未開賣都會持續 refresh 試「繼續」。

---

## 完整信用卡號

付款頁你人手填卡號之後，工具會嘗試讀取 **完整卡號** 寫入 Order summary。  
（確認頁通常只顯示 `•••• 1234`；完整號碼要喺填卡當下擷取。）

---

## 故障排除

| 問題 | 處理 |
|------|------|
| `npm` 唔識 | 未裝 Node，或要重開終端機 |
| 8787 開唔到 | 睇有冇舊 process 佔用；關咗再 `npm run dashboard` |
| 瀏覽器開唔到 | `npx playwright install chromium` |
| Dashboard 改咗睇唔到 | 瀏覽器 hard-refresh（Ctrl+F5） |

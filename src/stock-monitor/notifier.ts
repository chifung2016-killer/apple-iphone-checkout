import notifier from "node-notifier";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MONITOR_CONFIG } from "./config.js";

export type StockAlertPayload = {
  title: string;
  message: string;
  url?: string;
};

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const RUNTIME_DIR = path.join(ROOT, "runtime");
const TG_MSG_FILE = path.join(RUNTIME_DIR, "telegram-monitor-msg.json");

function formatHkNow(): string {
  return new Date().toLocaleString("zh-HK", {
    timeZone: "Asia/Hong_Kong",
    hour12: false,
  });
}

export async function sendDesktopNotification(payload: StockAlertPayload): Promise<void> {
  if (!MONITOR_CONFIG.notify.desktop) return;
  await new Promise<void>((resolve) => {
    notifier.notify(
      {
        title: payload.title,
        message: payload.message,
        wait: false,
        sound: true,
      },
      () => resolve()
    );
    setTimeout(() => resolve(), 1500);
  });
}

function telegramCreds(): { token: string; chatId: string } | null {
  if (!MONITOR_CONFIG.notify.telegram) return null;
  const token = MONITOR_CONFIG.telegram.botToken.trim();
  const chatId = MONITOR_CONFIG.telegram.chatId.trim();
  if (!token || !chatId) {
    console.warn("[notifier] Telegram 未設定 TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID，跳過。");
    return null;
  }
  return { token, chatId };
}

export async function sendTelegramNotification(payload: StockAlertPayload): Promise<void> {
  const creds = telegramCreds();
  if (!creds) return;

  const text = [
    `*${escapeMd(payload.title)}*`,
    escapeMd(payload.message),
    payload.url ? `[打開產品頁](${payload.url})` : "",
    `_時間：${escapeMd(formatHkNow())}_`,
  ]
    .filter(Boolean)
    .join("\n");

  const api = `https://api.telegram.org/bot${creds.token}/sendMessage`;
  const res = await fetch(api, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: creds.chatId,
      text,
      parse_mode: "Markdown",
      disable_web_page_preview: false,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.warn(`[notifier] Telegram 發送失敗 HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
}

/**
 * 每個 cycle 更新同一則 Telegram「庫存監察」訊息（有 message_id 就 edit，冇就發新）。
 * 清楚顯示每個 SKU 嘅可買／限購數量。
 */
export async function upsertTelegramStockMonitor(text: string): Promise<void> {
  const creds = telegramCreds();
  if (!creds) return;
  if (!MONITOR_CONFIG.telegramLiveStatus) return;

  await fs.mkdir(RUNTIME_DIR, { recursive: true }).catch(() => {});
  let messageId: number | null = null;
  try {
    const prev = JSON.parse(await fs.readFile(TG_MSG_FILE, "utf8")) as {
      messageId?: number;
      chatId?: string;
    };
    if (prev.chatId === creds.chatId && typeof prev.messageId === "number") {
      messageId = prev.messageId;
    }
  } catch {
    /* first run */
  }

  const body = {
    chat_id: creds.chatId,
    text,
    parse_mode: "Markdown" as const,
    disable_web_page_preview: true,
  };

  if (messageId != null) {
    const editApi = `https://api.telegram.org/bot${creds.token}/editMessageText`;
    const res = await fetch(editApi, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, message_id: messageId }),
    });
    if (res.ok) return;
    // message deleted / too old → send new
    const errText = await res.text().catch(() => "");
    if (!/message is not modified/i.test(errText)) {
      console.warn(`[notifier] Telegram edit 失敗，改發新訊息：${errText.slice(0, 120)}`);
    } else {
      return; // identical content
    }
  }

  const sendApi = `https://api.telegram.org/bot${creds.token}/sendMessage`;
  const res = await fetch(sendApi, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    console.warn(`[notifier] Telegram monitor 發送失敗 HTTP ${res.status}: ${t.slice(0, 200)}`);
    return;
  }
  const data = (await res.json().catch(() => null)) as {
    result?: { message_id?: number };
  } | null;
  const newId = data?.result?.message_id;
  if (typeof newId === "number") {
    await fs.writeFile(
      TG_MSG_FILE,
      JSON.stringify({ messageId: newId, chatId: creds.chatId, updatedAt: new Date().toISOString() }, null, 2),
      "utf8"
    );
  }
}

export async function notifyAll(payload: StockAlertPayload): Promise<void> {
  const tasks: Promise<void>[] = [];
  if (MONITOR_CONFIG.notify.desktop) tasks.push(sendDesktopNotification(payload));
  if (MONITOR_CONFIG.notify.telegram) tasks.push(sendTelegramNotification(payload));
  await Promise.allSettled(tasks);
}

/** 淨 Telegram（頻繁事件用，避免洗 desktop） */
export async function notifyTelegram(payload: StockAlertPayload): Promise<void> {
  if (!MONITOR_CONFIG.notify.telegram) return;
  await sendTelegramNotification(payload);
}

function escapeMd(s: string): string {
  return s.replace(/([_*`\[\]])/g, "\\$1");
}

export { formatHkNow, escapeMd };

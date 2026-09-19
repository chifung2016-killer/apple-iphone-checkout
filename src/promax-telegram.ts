/**
 * Pro Max 門市監控 → Telegram（沿用 .env 嘅 TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID）
 */
import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { PromaxPickupStatus, RestockHistoryEvent } from "./promax-pickup-monitor.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RUNTIME_DIR = path.join(ROOT, "runtime");
const TG_MSG_FILE = path.join(RUNTIME_DIR, "telegram-promax-msg.json");

function telegramCreds(): { token: string; chatId: string } | null {
  const token = String(process.env.TELEGRAM_BOT_TOKEN || "").trim();
  const chatId = String(process.env.TELEGRAM_CHAT_ID || "").trim();
  if (!token || !chatId) return null;
  return { token, chatId };
}

function escapeMd(s: string): string {
  return String(s || "").replace(/([_*`\[\]])/g, "\\$1");
}

async function tgApi(
  token: string,
  method: string,
  body: Record<string, unknown>
): Promise<Record<string, unknown> | null> {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  if (!res.ok || !data?.ok) {
    console.warn(
      `[promax-tg] ${method} failed：`,
      data?.description || res.status
    );
    return null;
  }
  return data;
}

/** 有貨／售罄即時通知 */
export async function notifyPromaxTelegram(
  events: RestockHistoryEvent[]
): Promise<void> {
  const creds = telegramCreds();
  if (!creds) {
    console.warn(
      "[promax-tg] 未設定 TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID，跳過通知"
    );
    return;
  }

  const important = events.filter(
    (e) => e.event === "restock" || e.event === "sold_out"
  );
  if (!important.length) return;

  for (const ev of important) {
    const stores =
      ev.storeStocks
        ?.filter((s) => (ev.event === "restock" ? s.available : true))
        .map((s) => `${s.code}${s.available ? " ✓" : " ✗"}`)
        .join(" · ") ||
      ev.detail ||
      "—";
    const title =
      ev.event === "restock"
        ? "🟢 Pro Max 門市有貨"
        : "⚪ Pro Max 門市售罄";
    const text = [
      `*${escapeMd(title)}*`,
      `${escapeMd(ev.model)} · ${escapeMd(ev.storage)} · ${escapeMd(ev.color)}`,
      `門市：${escapeMd(stores)}`,
      ...(ev.event === "sold_out" && ev.inStockForLabel
        ? [`在架時長：約 ${escapeMd(ev.inStockForLabel)}`]
        : []),
      `時間：${escapeMd(ev.atHk || ev.at)}`,
    ].join("\n");

    await tgApi(creds.token, "sendMessage", {
      chat_id: creds.chatId,
      text,
      parse_mode: "Markdown",
      disable_web_page_preview: true,
    });
  }
}

/** 可選：更新一則 live status（edit 同一條 message） */
export async function upsertPromaxTelegramStatus(
  status: PromaxPickupStatus
): Promise<void> {
  const creds = telegramCreds();
  if (!creds) return;

  const lines: string[] = [
    "*iPhone 18 Pro Max 門市監控*",
    `狀態：${status.running ? "ON" : "OFF"} · 成功：${escapeMd(
      status.last_success_at || "—"
    )}`,
  ];
  if (status.last_error) {
    lines.push(`錯誤：${escapeMd(String(status.last_error).slice(0, 120))}`);
  }

  let anyAvail = false;
  for (const m of status.matrix || []) {
    const avail = (m.stores || []).filter((s) =>
      /^available$/i.test(String(s.pickup_display || ""))
    );
    if (!avail.length) continue;
    anyAvail = true;
    const codes = avail
      .map((s) => {
        const id = s.store_id;
        const map: Record<string, string> = {
          causeway_bay: "CWB",
          ifc: "IFC",
          festival_walk: "FW",
          apm: "APM",
          new_town_plaza: "NTP",
          canton_road: "TST",
        };
        return map[id] || s.store_name;
      })
      .join(",");
    lines.push(
      `• ${escapeMd(m.storage)} ${escapeMd(m.color)} → ${escapeMd(codes)}`
    );
  }
  if (!anyAvail) lines.push("• 暫無門市 available");

  const text = lines.join("\n");
  let messageId: number | null = null;
  try {
    const raw = await fs.readFile(TG_MSG_FILE, "utf8");
    messageId = Number((JSON.parse(raw) as { messageId?: number }).messageId);
    if (!Number.isFinite(messageId)) messageId = null;
  } catch {
    messageId = null;
  }

  if (messageId) {
    const edited = await tgApi(creds.token, "editMessageText", {
      chat_id: creds.chatId,
      message_id: messageId,
      text,
      parse_mode: "Markdown",
      disable_web_page_preview: true,
    });
    if (edited) return;
  }

  const sent = await tgApi(creds.token, "sendMessage", {
    chat_id: creds.chatId,
    text,
    parse_mode: "Markdown",
    disable_web_page_preview: true,
  });
  const result = (sent?.result || {}) as { message_id?: number };
  if (result.message_id) {
    await fs.mkdir(RUNTIME_DIR, { recursive: true }).catch(() => {});
    await fs
      .writeFile(
        TG_MSG_FILE,
        JSON.stringify({ messageId: result.message_id, at: new Date().toISOString() }),
        "utf8"
      )
      .catch(() => {});
  }
}

export function hasTelegramCreds(): boolean {
  return Boolean(telegramCreds());
}

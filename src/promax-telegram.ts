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

/** ISO／可 parse 時間 → 香港時間（Telegram 顯示用） */
function formatHkDisplay(isoOrDate: string | null | undefined): string {
  const raw = String(isoOrDate || "").trim();
  if (!raw || raw === "—") return "—";
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) return raw;
  return (
    new Intl.DateTimeFormat("zh-HK", {
      timeZone: "Asia/Hong_Kong",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).format(new Date(ms)) + " HKT"
  );
}

/** 顏色 → 相近色 emoji（放喺型號／顏色後面） */
function colorLogo(color: string): string {
  const c = String(color || "");
  if (/布根|酒紅|紅/.test(c)) return "🔴";
  if (/冰川|藍|青/.test(c)) return "🩵";
  if (/銀/.test(c)) return "⚪";
  if (/黑/.test(c)) return "⚫";
  return "📱";
}

function modelLine(model: string, storage: string, color: string): string {
  const logo = colorLogo(color);
  return `${escapeMd(model)} · ${escapeMd(storage)} · ${escapeMd(color)} ${logo}`;
}

const MODE_HELP: Record<string, string> = {
  hot: "已知補貨時段／有貨 · ~90–150s（有貨 ~25–40s）",
  peak: "非補貨時段 · ~6–10分（疏，減 541）",
};

/** 統一「而家用緊邊個模式」一行 */
export function formatMonitorModeLine(mode: string | null | undefined): string {
  const m = String(mode || "—");
  const help = MODE_HELP[m];
  return help
    ? `監控模式：*${escapeMd(m)}*（${escapeMd(help)}）`
    : `監控模式：*${escapeMd(m)}*`;
}

/** Telegram 用：顯示完整 active proxy（可含帳密） */
export function formatMonitorProxyLine(opts?: {
  activeDisplay?: string | null;
  activeFull?: string | null;
  count?: number;
  banned?: number;
  mode?: string | null;
}): string {
  const active =
    String(opts?.activeFull || "").trim() ||
    String(opts?.activeDisplay || "").trim() ||
    "本機 IP";
  const count = opts?.count ?? 0;
  const banned = opts?.banned ?? 0;
  const mode = opts?.mode || (count > 0 ? "proxy" : "local");
  if (mode === "local" || count <= 0) {
    return "監控 Proxy：本機 IP";
  }
  // Markdown：escape 特殊字元，整條完整顯示
  return (
    `監控 Proxy：${escapeMd(active)}` +
    `（池 ${count} 條` +
    (banned > 0 ? ` · 暫 ban ${banned}` : "") +
    `）`
  );
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
  events: RestockHistoryEvent[],
  opts?: {
    pollMode?: string | null;
    proxy?: {
      activeDisplay?: string | null;
      count?: number;
      banned?: number;
      mode?: string | null;
    };
  }
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
      modelLine(ev.model, ev.storage, ev.color),
      formatMonitorModeLine(opts?.pollMode),
      formatMonitorProxyLine(opts?.proxy),
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

/** 監控模式切換時推送（peak↔quiet 等） */
export async function notifyPromaxModeChange(opts: {
  from: string;
  to: string;
  reason?: string | null;
  peakWindows?: string[];
  proxy?: {
    activeDisplay?: string | null;
    count?: number;
    banned?: number;
    mode?: string | null;
  };
}): Promise<void> {
  const creds = telegramCreds();
  if (!creds) return;
  if (opts.from === opts.to) return;

  const text = [
    "*📡 監控模式已切換*",
    `${escapeMd(opts.from || "—")} → *${escapeMd(opts.to)}*`,
    formatMonitorModeLine(opts.to),
    formatMonitorProxyLine(opts.proxy),
    ...(opts.reason ? [escapeMd(opts.reason)] : []),
    ...(opts.peakWindows?.length
      ? [`補貨時段：${escapeMd(opts.peakWindows.join(" · "))}`]
      : []),
  ].join("\n");

  await tgApi(creds.token, "sendMessage", {
    chat_id: creds.chatId,
    text,
    parse_mode: "Markdown",
    disable_web_page_preview: true,
  });
}

/** 可選：更新一則 live status（edit 同一條 message） */
export async function upsertPromaxTelegramStatus(
  status: PromaxPickupStatus
): Promise<void> {
  const creds = telegramCreds();
  if (!creds) return;

  const mode = String(status.poll_mode || "—");
  const proxySt = (() => {
    try {
      // lazy: status 未必帶 proxy；由 monitor 寫入 optional 欄
      const p = (status as PromaxPickupStatus & {
        monitor_proxy?: {
          activeDisplay?: string;
          activeFull?: string;
          count?: number;
          banned?: number;
          mode?: string;
        };
      }).monitor_proxy;
      return p;
    } catch {
      return undefined;
    }
  })();
  const lines: string[] = [
    "*iPhone 18 Pro Max 門市監控*",
    `狀態：${status.running ? "ON" : "OFF"} · ${formatMonitorModeLine(mode).replace(/^監控模式：/, "")}` +
      ` · 成功：${escapeMd(formatHkDisplay(status.last_success_at))}`,
    `模式一覽：hot（補貨時段／有貨）｜peak（時段外疏掃） ← 而家 *${escapeMd(mode)}*`,
    formatMonitorProxyLine(proxySt),
  ];
  if (status.schedule?.peakWindows?.length) {
    lines.push(
      `補貨時段：${escapeMd(status.schedule.peakWindows.join(" · "))}` +
        (status.schedule.sampleDays != null
          ? `（日數 ${status.schedule.sampleDays}/${status.schedule.minSampleDays ?? 3}${
              status.schedule.graduated ? " · 已畢業" : " · 學習中"
            }）`
          : status.schedule.restockSamples != null
            ? `（樣本 ${status.schedule.restockSamples}）`
            : "")
    );
  }
  if (status.schedule?.reason) {
    lines.push(escapeMd(status.schedule.reason));
  }
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
      `• ${escapeMd(m.storage)} ${escapeMd(m.color)} ${colorLogo(m.color)} → ${escapeMd(codes)}`
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

/** Proxy 被暫時 ban 時即時通知（唔節流，每次 ban 一則） */
export async function notifyPromaxProxyBanned(opts: {
  bannedFull: string;
  reason: string;
  banMs: number;
  nextFull: string | null;
  count: number;
  banned: number;
}): Promise<void> {
  const creds = telegramCreds();
  if (!creds) return;
  const mins = Math.max(1, Math.round(opts.banMs / 60_000));
  const until = new Date(Date.now() + opts.banMs).toISOString();
  const lines = [
    "*🚫 監控 Proxy 被 Ban*",
    `被 ban：${escapeMd(opts.bannedFull)}`,
    `原因：${escapeMd(opts.reason)}`,
    `暫停：約 ${mins} 分鐘（至 ${escapeMd(formatHkDisplay(until))}）`,
    opts.nextFull
      ? `轉用：${escapeMd(opts.nextFull)}`
      : "轉用：無剩餘 proxy（本機／等解禁）",
    `池 ${opts.count} 條 · 暫 ban ${opts.banned}`,
    `時間：${escapeMd(formatHkDisplay(new Date().toISOString()))}`,
  ];
  await tgApi(creds.token, "sendMessage", {
    chat_id: creds.chatId,
    text: lines.join("\n"),
    parse_mode: "Markdown",
    disable_web_page_preview: true,
  });
}

export type PromaxHealthAlert = {
  kind: "auto_heal" | "needs_fix" | "recovered";
  reason: string;
  lastError?: string | null;
  lastSuccessAt?: string | null;
  consecutiveFailures?: number;
  rowsInLastPoll?: number;
  autoHealAttempt?: number;
  pollMode?: string | null;
  proxy?: {
    activeDisplay?: string | null;
    count?: number;
    banned?: number;
    mode?: string | null;
  };
};

let lastHealthAlertAt = 0;
let lastHealthAlertKind: string | null = null;

/** 監控失效／自動修復／恢復 → Telegram（節流，避免洗版） */
export async function notifyPromaxHealthAlert(
  alert: PromaxHealthAlert
): Promise<void> {
  const creds = telegramCreds();
  if (!creds) return;

  const now = Date.now();
  const cooldownMs =
    alert.kind === "recovered"
      ? 30_000
      : alert.kind === "auto_heal"
        ? 5 * 60_000
        : 12 * 60_000;
  if (
    lastHealthAlertKind === alert.kind &&
    now - lastHealthAlertAt < cooldownMs
  ) {
    return;
  }
  lastHealthAlertAt = now;
  lastHealthAlertKind = alert.kind;

  const lines: string[] = [];
  if (alert.kind === "recovered") {
    lines.push("*✅ Pro Max 監控已恢復*");
    lines.push(escapeMd(alert.reason));
  } else if (alert.kind === "auto_heal") {
    lines.push("*🛠️ Pro Max 監控異常 — 正在自動修復*");
    lines.push(escapeMd(alert.reason));
    if (alert.autoHealAttempt != null) {
      lines.push(`自動重試：第 ${alert.autoHealAttempt} 次`);
    }
  } else {
    lines.push("*🚨 Pro Max 監控失效 — 請 Fix*");
    lines.push(escapeMd(alert.reason));
    lines.push("");
    lines.push("*請你做：*");
    lines.push("1\\. 開 http://127\\.0\\.0\\.1:8787/api/health");
    lines.push("2\\. 睇 /api/promax\\-pickup/status（last\\_success\\_at / last\\_error）");
    lines.push("3\\. 必要時喺專案目錄重啟：`npm run dashboard`");
    lines.push("4\\. 若成日 541：稍等再試，或同我講幫手查");
  }
  lines.push(formatMonitorModeLine(alert.pollMode ?? null));
  lines.push(formatMonitorProxyLine(alert.proxy));

  if (alert.lastError) {
    lines.push(`錯誤：${escapeMd(String(alert.lastError).slice(0, 160))}`);
  }
  if (alert.lastSuccessAt) {
    lines.push(`上次成功：${escapeMd(formatHkDisplay(alert.lastSuccessAt))}`);
  }
  if (alert.consecutiveFailures != null) {
    lines.push(`連續失敗：${alert.consecutiveFailures}`);
  }
  if (alert.rowsInLastPoll != null) {
    lines.push(`今次 rows：${alert.rowsInLastPoll}`);
  }

  await tgApi(creds.token, "sendMessage", {
    chat_id: creds.chatId,
    text: lines.join("\n"),
    parse_mode: "Markdown",
    disable_web_page_preview: true,
  });
}

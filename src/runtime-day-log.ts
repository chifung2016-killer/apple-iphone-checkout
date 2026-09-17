/**
 * 全日持久化 log（monitor／checkout），方便當晚翻查。
 * 目錄：runtime/logs/YYYY-MM-DD/
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LOGS_DIR = path.join(ROOT, "runtime", "logs");

export function hkDayStamp(d = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Hong_Kong",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

export function hkTimeStamp(d = new Date()): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Hong_Kong",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(d);
}

export async function ensureDayLogDir(day = hkDayStamp()): Promise<string> {
  const dir = path.join(LOGS_DIR, day);
  await fs.mkdir(dir, { recursive: true }).catch(() => {});
  return dir;
}

export async function appendDayLog(opts: {
  channel: "checkout" | "monitor" | "dashboard";
  sessionId?: string;
  line: string;
  meta?: Record<string, unknown>;
}): Promise<void> {
  const text = String(opts.line || "").replace(/\r/g, "");
  if (!text.trim()) return;
  try {
    const day = hkDayStamp();
    const dir = await ensureDayLogDir(day);
    const ts = `${day} ${hkTimeStamp()}`;
    const sid = opts.sessionId ? String(opts.sessionId) : "";
    const plain = `[${ts}] ${text.endsWith("\n") ? text : `${text}\n`}`;

    await fs.appendFile(path.join(dir, "all.log"), plain, "utf8");
    if (opts.channel === "monitor") {
      await fs.appendFile(path.join(dir, "monitor.log"), plain, "utf8");
    } else if (opts.channel === "checkout" && sid) {
      await fs.appendFile(path.join(dir, `checkout-${sid}.log`), plain, "utf8");
    } else {
      await fs.appendFile(path.join(dir, "dashboard.log"), plain, "utf8");
    }

    await fs.appendFile(
      path.join(dir, "events.jsonl"),
      `${JSON.stringify({
        at: new Date().toISOString(),
        atHk: `${day} ${hkTimeStamp()}`,
        channel: opts.channel,
        sessionId: sid || null,
        line: text.trim(),
        ...(opts.meta || {}),
      })}\n`,
      "utf8"
    );
  } catch {
    /* ignore */
  }
}

export function dayLogsRelativeDir(day = hkDayStamp()): string {
  return path.join("runtime", "logs", day);
}

export function dayLogsAbsoluteDir(day = hkDayStamp()): string {
  return path.join(LOGS_DIR, day);
}

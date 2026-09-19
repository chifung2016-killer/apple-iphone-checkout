/**
 * 由 restock-history 學習常見補貨時段（香港時區）
 * peak → 密輪詢；quiet → 疏輪詢（唔完全停，避免錯過異常補貨）
 */
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RESTOCK_HISTORY_FILE = path.join(ROOT, "runtime", "restock-history.jsonl");
const SCHEDULE_CACHE_FILE = path.join(ROOT, "runtime", "promax-schedule.json");

export type ScheduleMode = "hot" | "peak" | "quiet" | "learning";

export type ScheduleSnapshot = {
  mode: ScheduleMode;
  /** 學習到嘅 peak 時段（HK，例如 "08:00–11:00"） */
  peakWindows: string[];
  restockSamples: number;
  reason: string;
  /** 下一個 peak 開始（ISO），若而家已喺 peak 則 null */
  nextPeakAt: string | null;
  updatedAt: string;
};

type MinuteWindow = { startMin: number; endMin: number }; // 0..24*60, end exclusive; may wrap

const HK_TZ = "Asia/Hong_Kong";

/** 至少幾多個 restock 先算「學到」 */
const MIN_SAMPLES = 3;
/** 每個補貨鐘點向前後擴（分鐘） */
const PAD_BEFORE_MIN = 75;
const PAD_AFTER_MIN = 60;
/** 鐘點出現次數達呢個先入 peak（絕對） */
const HOUR_MIN_COUNT = 1;

/** 未夠樣本時嘅預設 peak（HK 門市常見） */
const DEFAULT_WINDOWS: MinuteWindow[] = [
  { startMin: 8 * 60, endMin: 12 * 60 },
  { startMin: 14 * 60, endMin: 19 * 60 },
];

let cached: ScheduleSnapshot | null = null;
let hourCounts: Map<number, number> = new Map();
let windows: MinuteWindow[] = [...DEFAULT_WINDOWS];
let sampleCount = 0;
let lastLoadAt = 0;

function hkParts(d = new Date()): {
  hour: number;
  minute: number;
  weekday: number;
  dayMinute: number;
} {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: HK_TZ,
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
    hour12: false,
  });
  const parts = Object.fromEntries(
    fmt.formatToParts(d).map((p) => [p.type, p.value])
  ) as Record<string, string>;
  const hour = Number(parts.hour) % 24;
  const minute = Number(parts.minute);
  const wdMap: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };
  return {
    hour,
    minute,
    weekday: wdMap[parts.weekday || ""] ?? 0,
    dayMinute: hour * 60 + minute,
  };
}

function formatWindow(w: MinuteWindow): string {
  const fmt = (m: number) => {
    const mm = ((m % (24 * 60)) + 24 * 60) % (24 * 60);
    const h = Math.floor(mm / 60);
    const min = mm % 60;
    return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
  };
  return `${fmt(w.startMin)}–${fmt(w.endMin)}`;
}

function mergeWindows(list: MinuteWindow[]): MinuteWindow[] {
  if (!list.length) return [];
  const norm = list
    .map((w) => ({
      startMin: ((w.startMin % (24 * 60)) + 24 * 60) % (24 * 60),
      endMin: ((w.endMin % (24 * 60)) + 24 * 60) % (24 * 60),
    }))
    .sort((a, b) => a.startMin - b.startMin);

  // 簡化：唔處理跨日 wrap；跨日拆成兩段
  const flat: MinuteWindow[] = [];
  for (const w of norm) {
    if (w.endMin > w.startMin) flat.push(w);
    else {
      flat.push({ startMin: w.startMin, endMin: 24 * 60 });
      if (w.endMin > 0) flat.push({ startMin: 0, endMin: w.endMin });
    }
  }
  flat.sort((a, b) => a.startMin - b.startMin);
  const out: MinuteWindow[] = [];
  for (const w of flat) {
    const last = out[out.length - 1];
    if (!last || w.startMin > last.endMin + 15) {
      out.push({ ...w });
    } else {
      last.endMin = Math.max(last.endMin, w.endMin);
    }
  }
  return out;
}

function inWindows(dayMinute: number, wins: MinuteWindow[]): boolean {
  return wins.some((w) => dayMinute >= w.startMin && dayMinute < w.endMin);
}

function nextPeakStart(dayMinute: number, wins: MinuteWindow[]): Date | null {
  if (!wins.length) return null;
  const sorted = [...wins].sort((a, b) => a.startMin - b.startMin);
  for (const w of sorted) {
    if (dayMinute < w.startMin) {
      const d = new Date();
      const now = hkParts(d);
      const deltaMin = w.startMin - now.dayMinute;
      return new Date(d.getTime() + deltaMin * 60_000);
    }
  }
  // 聽日第一個
  const first = sorted[0]!;
  const d = new Date();
  const now = hkParts(d);
  const deltaMin = 24 * 60 - now.dayMinute + first.startMin;
  return new Date(d.getTime() + deltaMin * 60_000);
}

function rebuildWindowsFromHours(counts: Map<number, number>): MinuteWindow[] {
  const entries = [...counts.entries()].filter(([, c]) => c >= HOUR_MIN_COUNT);
  if (!entries.length) return [...DEFAULT_WINDOWS];
  const raw: MinuteWindow[] = entries.map(([hour]) => ({
    startMin: hour * 60 - PAD_BEFORE_MIN,
    endMin: hour * 60 + 60 + PAD_AFTER_MIN,
  }));
  return mergeWindows(raw);
}

export async function reloadPromaxSchedule(force = false): Promise<ScheduleSnapshot> {
  const now = Date.now();
  if (!force && cached && now - lastLoadAt < 60_000) return cached;

  const counts = new Map<number, number>();
  let samples = 0;
  try {
    if (existsSync(RESTOCK_HISTORY_FILE)) {
      const raw = await fs.readFile(RESTOCK_HISTORY_FILE, "utf8");
      for (const line of raw.split(/\r?\n/)) {
        if (!line.trim()) continue;
        let ev: { event?: string; at?: string; model?: string; name?: string };
        try {
          ev = JSON.parse(line) as {
            event?: string;
            at?: string;
            model?: string;
            name?: string;
          };
        } catch {
          continue;
        }
        if (ev.event !== "restock" || !ev.at) continue;
        // 優先學 Pro Max；舊機 restock 唔污染時段
        const label = `${ev.model || ""} ${ev.name || ""}`;
        if (label.trim() && !/pro\s*max/i.test(label)) continue;
        const t = Date.parse(ev.at);
        if (!Number.isFinite(t)) continue;
        const { hour } = hkParts(new Date(t));
        counts.set(hour, (counts.get(hour) || 0) + 1);
        samples += 1;
      }
    }
  } catch {
    /* ignore */
  }

  hourCounts = counts;
  sampleCount = samples;
  windows =
    samples >= MIN_SAMPLES
      ? rebuildWindowsFromHours(counts)
      : mergeWindows([...DEFAULT_WINDOWS, ...rebuildWindowsFromHours(counts)]);

  const snap = buildSnapshot("quiet");
  cached = snap;
  lastLoadAt = now;
  await persistSchedule(snap).catch(() => {});
  return snap;
}

function buildSnapshot(fallbackMode: ScheduleMode): ScheduleSnapshot {
  const now = new Date();
  const { dayMinute } = hkParts(now);
  const learning = sampleCount < MIN_SAMPLES;
  const peak = inWindows(dayMinute, windows);
  let mode: ScheduleMode = fallbackMode;
  let reason: string;
  if (learning) {
    mode = peak ? "peak" : "learning";
    reason = peak
      ? `學習中（${sampleCount} 次補貨）· 預設／已知時段內`
      : `學習中（${sampleCount}/${MIN_SAMPLES} 次補貨）· 疏輪詢`;
  } else if (peak) {
    mode = "peak";
    reason = "喺學習到嘅補貨時段內 · 密輪詢";
  } else {
    mode = "quiet";
    reason = "非補貨時段 · 疏輪詢（節省、減 541）";
  }
  const next = peak ? null : nextPeakStart(dayMinute, windows);
  return {
    mode,
    peakWindows: windows.map(formatWindow),
    restockSamples: sampleCount,
    reason,
    nextPeakAt: next ? next.toISOString() : null,
    updatedAt: now.toISOString(),
  };
}

async function persistSchedule(snap: ScheduleSnapshot): Promise<void> {
  await fs.mkdir(path.dirname(SCHEDULE_CACHE_FILE), { recursive: true });
  await fs.writeFile(
    SCHEDULE_CACHE_FILE,
    JSON.stringify(
      {
        ...snap,
        hourCounts: Object.fromEntries(hourCounts),
        windows,
      },
      null,
      2
    ),
    "utf8"
  );
}

/** 有貨時強制 hot；否則跟 schedule */
export function resolveScheduleMode(anyInStock: boolean): ScheduleSnapshot {
  const base = buildSnapshot("quiet");
  if (anyInStock) {
    return {
      ...base,
      mode: "hot",
      reason: "門市有貨 · 加密捉售罄",
    };
  }
  cached = base;
  return base;
}

export function getCachedSchedule(): ScheduleSnapshot | null {
  return cached;
}

/**
 * 依 schedule 回輪詢間隔範圍 [min,max] ms
 * quiet：12–18 分；learning 非 peak：3–5 分；peak/hot 由 caller 用 IDLE/HOT
 */
export function scheduleIntervalRange(
  mode: ScheduleMode
): { min: number; max: number } | null {
  if (mode === "quiet") return { min: 12 * 60_000, max: 18 * 60_000 };
  if (mode === "learning") return { min: 3 * 60_000, max: 5 * 60_000 };
  return null; // peak/hot → 用原本 IDLE/HOT
}

/** 新 restock 後即時計入學習 */
export function noteRestockAt(iso: string): void {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return;
  const { hour } = hkParts(new Date(t));
  hourCounts.set(hour, (hourCounts.get(hour) || 0) + 1);
  sampleCount += 1;
  windows =
    sampleCount >= MIN_SAMPLES
      ? rebuildWindowsFromHours(hourCounts)
      : mergeWindows([...DEFAULT_WINDOWS, ...rebuildWindowsFromHours(hourCounts)]);
  lastLoadAt = 0;
  cached = buildSnapshot("quiet");
  void persistSchedule(cached).catch(() => {});
}

/**
 * 由 restock-history 學習常見補貨時段（香港時區）
 *
 * 畢業前（少過 MIN_SAMPLE_DAYS 個唔同日有 Pro Max 補貨）：
 *   - 保留闊預設時段（含晏晝），時段內 = peak
 *   - 時段外 = learning（~60–90s），唔用 quiet（避免過早疏漏）
 * 畢業後：
 *   - 用學到嘅鐘點做 peak；其餘 = quiet（~12–18 分）
 * 有貨一律 hot。
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
  /** 有 Pro Max 補貨嘅唔同 HK 日數 */
  sampleDays: number;
  /** 畢業要幾多日 */
  minSampleDays: number;
  graduated: boolean;
  reason: string;
  /** 下一個 peak 開始（ISO），若而家已喺 peak 則 null */
  nextPeakAt: string | null;
  updatedAt: string;
};

type MinuteWindow = { startMin: number; endMin: number };

const HK_TZ = "Asia/Hong_Kong";

/** 要湊夠幾多個「唔同日有補貨」先畢業用 quiet */
const MIN_SAMPLE_DAYS = Number(process.env.PROMAX_SCHEDULE_MIN_DAYS || 3);
/** 每個補貨鐘點向前後擴（分鐘） */
const PAD_BEFORE_MIN = 75;
const PAD_AFTER_MIN = 60;
const HOUR_MIN_COUNT = 1;

/**
 * 學習期預設 peak：朝早到傍晚（含 12–15 晏晝）
 * 畢業前唔好縮到淨係朝早
 */
const DEFAULT_WINDOWS: MinuteWindow[] = [
  { startMin: 7 * 60 + 30, endMin: 19 * 60 },
];

let cached: ScheduleSnapshot | null = null;
let hourCounts: Map<number, number> = new Map();
let dayKeys: Set<string> = new Set();
let windows: MinuteWindow[] = [...DEFAULT_WINDOWS];
let sampleCount = 0;
let lastLoadAt = 0;

function hkParts(d = new Date()): {
  hour: number;
  minute: number;
  weekday: number;
  dayMinute: number;
  dayKey: string;
} {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: HK_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
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
    dayKey: `${parts.year}-${parts.month}-${parts.day}`,
  };
}

function isGraduated(): boolean {
  return dayKeys.size >= Math.max(1, MIN_SAMPLE_DAYS);
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

function recomputeWindows(): void {
  const learned = rebuildWindowsFromHours(hourCounts);
  // 畢業前：預設闊窗（含晏晝）∪ 已觀察鐘點；畢業後：只用學到嘅
  windows = isGraduated()
    ? learned
    : mergeWindows([...DEFAULT_WINDOWS, ...learned]);
}

export async function reloadPromaxSchedule(
  force = false
): Promise<ScheduleSnapshot> {
  const now = Date.now();
  if (!force && cached && now - lastLoadAt < 60_000) return cached;

  const counts = new Map<number, number>();
  const days = new Set<string>();
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
        const label = `${ev.model || ""} ${ev.name || ""}`;
        if (label.trim() && !/pro\s*max/i.test(label)) continue;
        const t = Date.parse(ev.at);
        if (!Number.isFinite(t)) continue;
        const parts = hkParts(new Date(t));
        counts.set(parts.hour, (counts.get(parts.hour) || 0) + 1);
        days.add(parts.dayKey);
        samples += 1;
      }
    }
  } catch {
    /* ignore */
  }

  hourCounts = counts;
  dayKeys = days;
  sampleCount = samples;
  recomputeWindows();

  const snap = buildSnapshot();
  cached = snap;
  lastLoadAt = now;
  await persistSchedule(snap).catch(() => {});
  return snap;
}

function buildSnapshot(): ScheduleSnapshot {
  const now = new Date();
  const { dayMinute } = hkParts(now);
  const graduated = isGraduated();
  const peak = inWindows(dayMinute, windows);
  let mode: ScheduleMode;
  let reason: string;

  if (!graduated) {
    // 學習期：時段內 peak；時段外 learning（唔 quiet）
    if (peak) {
      mode = "peak";
      reason = `學習中（${dayKeys.size}/${MIN_SAMPLE_DAYS} 日 · ${sampleCount} 次）· 預設／已知時段（含晏晝）· 密掃`;
    } else {
      mode = "learning";
      reason = `學習中（${dayKeys.size}/${MIN_SAMPLE_DAYS} 日 · ${sampleCount} 次）· 時段外仍 ~60–90s，湊夠日數先 quiet`;
    }
  } else if (peak) {
    mode = "peak";
    reason = `已畢業（${dayKeys.size} 日樣本）· 補貨時段內密輪詢`;
  } else {
    mode = "quiet";
    reason = `已畢業（${dayKeys.size} 日樣本）· 非時段疏輪詢（減 541）`;
  }

  const next = peak ? null : nextPeakStart(dayMinute, windows);
  return {
    mode,
    peakWindows: windows.map(formatWindow),
    restockSamples: sampleCount,
    sampleDays: dayKeys.size,
    minSampleDays: MIN_SAMPLE_DAYS,
    graduated,
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
        sampleDayKeys: [...dayKeys],
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
  const base = buildSnapshot();
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
 * quiet：12–18 分；learning：60–90 秒；peak/hot 由 caller 用 IDLE/HOT
 */
export function scheduleIntervalRange(
  mode: ScheduleMode
): { min: number; max: number } | null {
  if (mode === "quiet") return { min: 12 * 60_000, max: 18 * 60_000 };
  if (mode === "learning") return { min: 60_000, max: 90_000 };
  return null;
}

/** 新 restock 後即時計入學習 */
export function noteRestockAt(iso: string): void {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return;
  const parts = hkParts(new Date(t));
  hourCounts.set(parts.hour, (hourCounts.get(parts.hour) || 0) + 1);
  dayKeys.add(parts.dayKey);
  sampleCount += 1;
  recomputeWindows();
  lastLoadAt = 0;
  cached = buildSnapshot();
  void persistSchedule(cached).catch(() => {});
}

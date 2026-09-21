/**
 * 由 restock-history 學習常見補貨時段（香港時區）
 *
 * 模式（按你嘅定義）：
 *   - **hot**：已知會補貨嘅時間 Range（預設／學到嘅窗）· 較密
 *   - **peak**：時段之外 · 疏掃（減 541）
 *   - 門市實際有貨時亦係 hot（再加密捉售罄）
 *
 * 畢業：少過 MIN_SAMPLE_DAYS 個唔同日有 Pro Max 補貨前，預設窗保持闊（含晏晝）。
 */
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RESTOCK_HISTORY_FILE = path.join(ROOT, "runtime", "restock-history.jsonl");
const SCHEDULE_CACHE_FILE = path.join(ROOT, "runtime", "promax-schedule.json");

export type ScheduleMode = "hot" | "peak";

export type ScheduleSnapshot = {
  mode: ScheduleMode;
  /** 已知補貨時段（HK），呢段用 hot */
  peakWindows: string[];
  restockSamples: number;
  /** 有 Pro Max 補貨嘅唔同 HK 日數 */
  sampleDays: number;
  /** 畢業要幾多日 */
  minSampleDays: number;
  graduated: boolean;
  reason: string;
  /** 下一個 hot 時段開始（ISO），若而家已喺窗內則 null */
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
  const inRestockWindow = inWindows(dayMinute, windows);
  let mode: ScheduleMode;
  let reason: string;

  if (inRestockWindow) {
    mode = "hot";
    reason = graduated
      ? `已知補貨時段 · hot（較密）`
      : `學習中（${dayKeys.size}/${MIN_SAMPLE_DAYS} 日 · ${sampleCount} 次）· 預設／已知補貨時段（含晏晝）· hot`;
  } else {
    mode = "peak";
    reason = graduated
      ? `非補貨時段 · peak（疏掃，減 541）`
      : `學習中（${dayKeys.size}/${MIN_SAMPLE_DAYS} 日 · ${sampleCount} 次）· 時段外 peak 疏掃`;
  }

  const next = inRestockWindow ? null : nextPeakStart(dayMinute, windows);
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

/** 有貨時強制 hot（再加密）；否則跟時段：窗內 hot／窗外 peak */
export function resolveScheduleMode(anyInStock: boolean): ScheduleSnapshot {
  const base = buildSnapshot();
  if (anyInStock) {
    return {
      ...base,
      mode: "hot",
      reason: "門市有貨 · hot 加密捉售罄",
    };
  }
  cached = base;
  return base;
}

export function getCachedSchedule(): ScheduleSnapshot | null {
  return cached;
}

/**
 * hot（時段內、未有貨）：~50–90s（密啲捉補貨；可 .env 覆寫）
 * peak（時段外）：~2 分（疏啲，減 541；可 .env 覆寫）
 * hot + 有貨：由 caller 用 HOT_POLL（~25–40s）
 */
function envMs(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= 5_000 ? Math.floor(n) : fallback;
}

const SCHEDULE_HOT_MIN_MS = envMs("PROMAX_POLL_SCHEDULE_HOT_MIN_MS", 50_000);
const SCHEDULE_HOT_MAX_MS = envMs("PROMAX_POLL_SCHEDULE_HOT_MAX_MS", 90_000);
const PEAK_POLL_MIN_MS = envMs("PROMAX_POLL_PEAK_MIN_MS", 100_000);
const PEAK_POLL_MAX_MS = envMs("PROMAX_POLL_PEAK_MAX_MS", 140_000);

export function scheduleIntervalRange(
  mode: ScheduleMode,
  opts?: { anyInStock?: boolean }
): { min: number; max: number } | null {
  if (mode === "peak") {
    return {
      min: PEAK_POLL_MIN_MS,
      max: Math.max(PEAK_POLL_MIN_MS, PEAK_POLL_MAX_MS),
    };
  }
  if (mode === "hot" && !opts?.anyInStock) {
    return {
      min: SCHEDULE_HOT_MIN_MS,
      max: Math.max(SCHEDULE_HOT_MIN_MS, SCHEDULE_HOT_MAX_MS),
    };
  }
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

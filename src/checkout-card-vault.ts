/**
 * Checkout Dashboard 信用卡池：AES-256-GCM 加密存檔。
 * 格式每行：卡號,mm/yy,cvv,limit
 * 隨機分配、唔重複；拒單／失敗會 exclude。
 * limit 會用嚟計 Live card limits 剩餘額度（成功落單後扣減）。
 */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { decryptFromFile, encryptToFile } from "./add-order-secrets.js";

export type VaultCard = {
  id: string;
  number: string;
  exp: string; // mm/yy
  cvv: string;
  /** 信用額度（HKD）；null = 未提供 */
  limit: number | null;
};

export type CardVaultState = {
  excludedIds: string[];
  usedIds: string[];
  /** sessionId → cardId */
  inUse: Record<string, string>;
};

export type CardVaultFile = {
  cards: VaultCard[];
};

export type MaskedCardRow = {
  id: string;
  masked: string;
  limit: number | null;
  status: "available" | "in_use" | "used" | "excluded";
};

export function parseLimitField(raw: unknown): number | null {
  const s = String(raw ?? "").trim().replace(/,/g, "");
  if (!s) return null;
  const m = s.match(/(\d+(?:\.\d+)?)/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function digitsOnly(s: string | null | undefined): string {
  return String(s || "").replace(/\D/g, "");
}

export function cardIdFromParts(number: string, exp: string, cvv: string): string {
  const raw = `${digitsOnly(number)}|${String(exp).trim()}|${String(cvv).trim()}`;
  return crypto.createHash("sha256").update(raw).digest("hex").slice(0, 20);
}

export function maskCardNumber(number: string): string {
  const d = digitsOnly(number);
  if (d.length < 4) return "****";
  return `${"*".repeat(Math.max(0, d.length - 4))}${d.slice(-4)}`;
}

export function parseCardLine(line: string): VaultCard | null {
  const raw = String(line || "").trim();
  if (!raw || raw.startsWith("#")) return null;
  // 主要：卡號,mm/yy,cvv,limit；舊格式卡號:mm/yy:cvv 仍可讀；limit 可選（向後兼容）
  const parts = raw.includes(",")
    ? raw.split(",").map((p) => p.trim())
    : raw.split(":").map((p) => p.trim());
  if (parts.length < 3) return null;
  const number = digitsOnly(parts[0] || "");
  const exp = String(parts[1] || "").trim();
  const cvv = String(parts[2] || "").replace(/\s+/g, "");
  const limit = parts.length >= 4 ? parseLimitField(parts[3]) : null;
  if (number.length < 13 || number.length > 19) return null;
  if (!/^\d{1,2}\/\d{2}$/.test(exp)) return null;
  if (!/^\d{3,4}$/.test(cvv)) return null;
  const [mm, yy] = exp.split("/");
  const month = Number(mm);
  if (!Number.isFinite(month) || month < 1 || month > 12) return null;
  const normalizedExp = `${String(month).padStart(2, "0")}/${yy}`;
  return {
    id: cardIdFromParts(number, normalizedExp, cvv),
    number,
    exp: normalizedExp,
    cvv,
    limit,
  };
}

export function parseCardLines(text: string): VaultCard[] {
  const out: VaultCard[] = [];
  const seen = new Set<string>();
  for (const line of String(text || "").split(/\r?\n/)) {
    const card = parseCardLine(line);
    if (!card || seen.has(card.id)) continue;
    seen.add(card.id);
    out.push(card);
  }
  return out;
}

async function readJsonFile<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

async function writeJsonFile(file: string, data: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true }).catch(() => {});
  await fs.writeFile(file, JSON.stringify(data, null, 2), "utf8");
}

export async function loadCardVault(
  encPath: string,
  keyPath: string
): Promise<VaultCard[]> {
  try {
    const plain = await decryptFromFile(encPath, keyPath);
    if (!plain) return [];
    const parsed = JSON.parse(plain) as CardVaultFile | VaultCard[];
    const cards = Array.isArray(parsed) ? parsed : parsed.cards || [];
    return cards
      .map((c) => {
        const number = digitsOnly(c.number);
        const exp = String(c.exp || "").trim();
        const cvv = String(c.cvv || "").trim();
        if (!number || !exp || !cvv) return null;
        const limit =
          c.limit != null && Number.isFinite(Number(c.limit))
            ? Number(c.limit)
            : parseLimitField((c as { limit?: unknown }).limit);
        return {
          id: c.id || cardIdFromParts(number, exp, cvv),
          number,
          exp,
          cvv,
          limit,
        } satisfies VaultCard;
      })
      .filter((c): c is VaultCard => Boolean(c));
  } catch {
    return [];
  }
}

export async function saveCardVault(
  encPath: string,
  keyPath: string,
  cards: VaultCard[]
): Promise<void> {
  const payload: CardVaultFile = { cards };
  await encryptToFile(encPath, keyPath, JSON.stringify(payload));
}

export async function loadCardVaultState(statePath: string): Promise<CardVaultState> {
  const st = await readJsonFile<Partial<CardVaultState>>(statePath, {});
  return {
    excludedIds: Array.isArray(st.excludedIds) ? st.excludedIds.map(String) : [],
    usedIds: Array.isArray(st.usedIds) ? st.usedIds.map(String) : [],
    inUse:
      st.inUse && typeof st.inUse === "object" && !Array.isArray(st.inUse)
        ? { ...st.inUse }
        : {},
  };
}

export async function saveCardVaultState(
  statePath: string,
  state: CardVaultState
): Promise<void> {
  await writeJsonFile(statePath, state);
}

/** 合併新卡入 vault（同 id 覆蓋）；可選 replace 全換 */
export async function upsertCardsFromText(opts: {
  encPath: string;
  keyPath: string;
  statePath: string;
  text: string;
  replace?: boolean;
}): Promise<{ ok: true; total: number; added: number; parsed: number } | { ok: false; error: string }> {
  const parsed = parseCardLines(opts.text);
  if (!parsed.length) {
    return { ok: false, error: "格式唔啱。每行：卡號,mm/yy,cvv,limit" };
  }
  const existing = opts.replace ? [] : await loadCardVault(opts.encPath, opts.keyPath);
  const map = new Map(existing.map((c) => [c.id, c]));
  let added = 0;
  for (const c of parsed) {
    if (!map.has(c.id)) added += 1;
    const prev = map.get(c.id);
    // 新行冇寫 limit 時保留舊 limit
    map.set(c.id, {
      ...c,
      limit: c.limit != null ? c.limit : prev?.limit ?? null,
    });
  }
  const next = [...map.values()];
  await saveCardVault(opts.encPath, opts.keyPath, next);
  // replace 時清 used／excluded／inUse 入面已唔存在嘅 id
  const st = await loadCardVaultState(opts.statePath);
  const ids = new Set(next.map((c) => c.id));
  st.excludedIds = st.excludedIds.filter((id) => ids.has(id));
  st.usedIds = st.usedIds.filter((id) => ids.has(id));
  for (const [sid, cid] of Object.entries(st.inUse)) {
    if (!ids.has(cid)) delete st.inUse[sid];
  }
  await saveCardVaultState(opts.statePath, st);
  return { ok: true, total: next.length, added, parsed: parsed.length };
}

export function summarizeVault(cards: VaultCard[], state: CardVaultState) {
  const excluded = new Set(state.excludedIds);
  const used = new Set(state.usedIds);
  const inUseIds = new Set(Object.values(state.inUse));
  let available = 0;
  for (const c of cards) {
    if (excluded.has(c.id) || used.has(c.id) || inUseIds.has(c.id)) continue;
    available += 1;
  }
  return {
    total: cards.length,
    available,
    used: used.size,
    excluded: excluded.size,
    inUse: inUseIds.size,
  };
}

export function maskedRows(cards: VaultCard[], state: CardVaultState): MaskedCardRow[] {
  const excluded = new Set(state.excludedIds);
  const used = new Set(state.usedIds);
  const inUseIds = new Set(Object.values(state.inUse));
  return cards.map((c) => {
    let status: MaskedCardRow["status"] = "available";
    if (excluded.has(c.id)) status = "excluded";
    else if (used.has(c.id)) status = "used";
    else if (inUseIds.has(c.id)) status = "in_use";
    const lim =
      c.limit != null && Number.isFinite(c.limit) ? String(Math.round(c.limit)) : "";
    return {
      id: c.id,
      masked: lim
        ? `${maskCardNumber(c.number)},${c.exp},***,${lim}`
        : `${maskCardNumber(c.number)},${c.exp},***`,
      limit: c.limit,
      status,
    };
  });
}

function availableCards(cards: VaultCard[], state: CardVaultState): VaultCard[] {
  const excluded = new Set(state.excludedIds);
  const used = new Set(state.usedIds);
  const inUseIds = new Set(Object.values(state.inUse));
  return cards.filter(
    (c) => !excluded.has(c.id) && !used.has(c.id) && !inUseIds.has(c.id)
  );
}

/** 為 session 隨機 claim 一張未用卡；寫 assigned enc 畀 worker */
export async function claimCheckoutCard(opts: {
  encPath: string;
  keyPath: string;
  statePath: string;
  assignPath: string;
  sessionId: string;
}): Promise<VaultCard | null> {
  const cards = await loadCardVault(opts.encPath, opts.keyPath);
  const state = await loadCardVaultState(opts.statePath);
  // 釋放呢個 session 舊 claim
  if (state.inUse[opts.sessionId]) {
    delete state.inUse[opts.sessionId];
  }
  const pool = availableCards(cards, state);
  if (!pool.length) {
    await saveCardVaultState(opts.statePath, state);
    await fs.unlink(opts.assignPath).catch(() => {});
    return null;
  }
  const picked = pool[Math.floor(Math.random() * pool.length)]!;
  state.inUse[opts.sessionId] = picked.id;
  await saveCardVaultState(opts.statePath, state);
  await encryptToFile(opts.assignPath, opts.keyPath, JSON.stringify(picked));
  return picked;
}

export async function loadAssignedCheckoutCard(
  assignPath: string,
  keyPath: string
): Promise<VaultCard | null> {
  try {
    const plain = await decryptFromFile(assignPath, keyPath);
    if (!plain) return null;
    const c = JSON.parse(plain) as VaultCard;
    if (!c?.number || !c?.exp || !c?.cvv) return null;
    const limit =
      c.limit != null && Number.isFinite(Number(c.limit))
        ? Number(c.limit)
        : parseLimitField(c.limit);
    return {
      id: c.id || cardIdFromParts(c.number, c.exp, c.cvv),
      number: digitsOnly(c.number),
      exp: String(c.exp).trim(),
      cvv: String(c.cvv).trim(),
      limit,
    };
  } catch {
    return null;
  }
}

/** 用卡號（完整或尾四位唯一）喺加密池搵卡（含 limit） */
export async function findVaultCardByNumber(
  encPath: string,
  keyPath: string,
  cardNumber: string | null | undefined
): Promise<VaultCard | null> {
  const d = digitsOnly(cardNumber);
  if (!d || d.length < 4) return null;
  const cards = await loadCardVault(encPath, keyPath);
  const full = cards.find((c) => digitsOnly(c.number) === d);
  if (full) return full;
  if (d.length >= 4) {
    const last4 = d.slice(-4);
    const matches = cards.filter((c) => digitsOnly(c.number).endsWith(last4));
    if (matches.length === 1) return matches[0]!;
  }
  return null;
}

export async function finalizeCheckoutCard(opts: {
  statePath: string;
  assignPath: string;
  sessionId: string;
  outcome: "success" | "rejected" | "release";
}): Promise<void> {
  const state = await loadCardVaultState(opts.statePath);
  const cardId = state.inUse[opts.sessionId];
  if (cardId) {
    delete state.inUse[opts.sessionId];
    if (opts.outcome === "success") {
      if (!state.usedIds.includes(cardId)) state.usedIds.push(cardId);
    } else if (opts.outcome === "rejected") {
      if (!state.excludedIds.includes(cardId)) state.excludedIds.push(cardId);
      state.usedIds = state.usedIds.filter((id) => id !== cardId);
    }
  }
  await saveCardVaultState(opts.statePath, state);
  await fs.unlink(opts.assignPath).catch(() => {});
}

export async function excludeCheckoutCardById(
  statePath: string,
  cardId: string
): Promise<void> {
  if (!cardId) return;
  const state = await loadCardVaultState(statePath);
  if (!state.excludedIds.includes(cardId)) state.excludedIds.push(cardId);
  for (const [sid, cid] of Object.entries(state.inUse)) {
    if (cid === cardId) delete state.inUse[sid];
  }
  state.usedIds = state.usedIds.filter((id) => id !== cardId);
  await saveCardVaultState(statePath, state);
}

/** 由池中刪除選中嘅卡（連 state 一齊清） */
export async function removeCardsByIds(opts: {
  encPath: string;
  keyPath: string;
  statePath: string;
  ids: string[];
}): Promise<{ ok: true; removed: number; total: number } | { ok: false; error: string }> {
  const idSet = new Set(
    (Array.isArray(opts.ids) ? opts.ids : []).map((x) => String(x || "").trim()).filter(Boolean)
  );
  if (!idSet.size) {
    return { ok: false, error: "未選取任何信用卡" };
  }
  const cards = await loadCardVault(opts.encPath, opts.keyPath);
  const next = cards.filter((c) => !idSet.has(c.id));
  const removed = cards.length - next.length;
  if (!removed) {
    return { ok: false, error: "揀中嘅卡唔喺池入面" };
  }
  await saveCardVault(opts.encPath, opts.keyPath, next);
  const st = await loadCardVaultState(opts.statePath);
  st.excludedIds = st.excludedIds.filter((id) => !idSet.has(id));
  st.usedIds = st.usedIds.filter((id) => !idSet.has(id));
  for (const [sid, cid] of Object.entries(st.inUse)) {
    if (idSet.has(cid)) delete st.inUse[sid];
  }
  await saveCardVaultState(opts.statePath, st);
  return { ok: true, removed, total: next.length };
}

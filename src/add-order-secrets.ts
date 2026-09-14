/**
 * Local secret helpers for add-order Gmail accounts + shipping address.
 * AES-256-GCM at rest；Clear all 會換 key，送貨地址會用新 key 重加密保留。
 */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const ALGO = "aes-256-gcm";

export type ShippingAddress = {
  firstName: string;
  lastName: string;
  areaStreet: string;
  building: string;
};

export function maskEmail(email: string): string {
  const s = String(email || "").trim();
  const at = s.indexOf("@");
  if (at <= 0) return "***";
  const user = s.slice(0, at);
  const domain = s.slice(at + 1);
  const head = user.slice(0, 1) || "*";
  return `${head}***@${domain || "***"}`;
}

export function maskShipping(s: Partial<ShippingAddress> | null | undefined): Record<string, string> {
  return {
    firstName: s?.firstName ? "***" : "",
    lastName: s?.lastName ? "***" : "",
    areaStreet: s?.areaStreet ? "[encrypted]" : "",
    building: s?.building ? "[encrypted]" : "",
  };
}

/** 日誌／status 用：唔好洩露密碼、電郵；送貨地址片段亦遮 */
export function redactSecrets(line: string): string {
  let out = String(line || "");
  out = out.replace(
    /([A-Z0-9._%+-]+)@([A-Z0-9.-]+\.[A-Z]{2,})(\s*[:=\s,]\s*)(\S+)/gi,
    (_m, u: string, d: string, sep: string) => `${String(u).slice(0, 1)}***@${d}${sep}***`
  );
  out = out.replace(
    /([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})/gi,
    (m) => maskEmail(m)
  );
  out = out.replace(/(password|passwd|pwd|密碼)\s*[:=]\s*\S+/gi, "$1=***");
  out = out.replace(/\bChi\s*Fung\b/gi, "***");
  out = out.replace(/\bLeung\b/gi, "***");
  out = out.replace(/37\s*ko\s*shing\s*stee?t[^,\n]*/gi, "[address]");
  out = out.replace(/11b\s*,?\s*tai\s*fat\s*building/gi, "[building]");
  out = out.replace(/sai\s*ying\s*pun/gi, "[district]");
  out = out.replace(/\byY6594083\b/g, "***");
  return out;
}

async function ensureDir(filePath: string) {
  await fs.mkdir(path.dirname(filePath), { recursive: true }).catch(() => {});
}

export async function getOrCreateKey(keyPath: string): Promise<Buffer> {
  await ensureDir(keyPath);
  try {
    const raw = await fs.readFile(keyPath);
    if (raw.length >= 32) return raw.subarray(0, 32);
  } catch {
    /* create */
  }
  const key = crypto.randomBytes(32);
  await fs.writeFile(keyPath, key, { mode: 0o600 });
  return key;
}

export async function encryptToFile(
  filePath: string,
  keyPath: string,
  plaintext: string
): Promise<void> {
  await ensureDir(filePath);
  const key = await getOrCreateKey(keyPath);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  const payload = Buffer.concat([Buffer.from("v1"), iv, tag, enc]);
  await fs.writeFile(filePath, payload, { mode: 0o600 });
}

export async function decryptFromFile(
  filePath: string,
  keyPath: string
): Promise<string> {
  const key = await getOrCreateKey(keyPath);
  const buf = await fs.readFile(filePath);
  if (buf.length < 3 + 12 + 16) return "";
  const ver = buf.subarray(0, 2).toString("utf8");
  if (ver !== "v1") throw new Error("unsupported secret file version");
  const iv = buf.subarray(2, 14);
  const tag = buf.subarray(14, 30);
  const data = buf.subarray(30);
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}

/** 嵌入 status JSON 用嘅短密文（base64url） */
export async function encryptToBlob(keyPath: string, plaintext: string): Promise<string> {
  const key = await getOrCreateKey(keyPath);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([Buffer.from("v1"), iv, tag, enc]).toString("base64url");
}

export async function decryptFromBlob(keyPath: string, blob: string): Promise<string> {
  const key = await getOrCreateKey(keyPath);
  const buf = Buffer.from(String(blob || ""), "base64url");
  if (buf.length < 3 + 12 + 16) return "";
  const ver = buf.subarray(0, 2).toString("utf8");
  if (ver !== "v1") throw new Error("unsupported secret blob version");
  const iv = buf.subarray(2, 14);
  const tag = buf.subarray(14, 30);
  const data = buf.subarray(30);
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}

/** 只作首次 seed；落盤後以 encrypted file 為準，唔好再依賴呢個常數 */
const BOOTSTRAP_SHIPPING: ShippingAddress = {
  firstName: "Chi Fung",
  lastName: "Leung",
  areaStreet: "37 ko shing steet, sai ying pun",
  building: "11b, tai fat building",
};

/** 讀取／初始化加密送貨地址檔（明文唔寫入 status／git） */
export async function loadShippingAddress(
  encPath: string,
  keyPath: string
): Promise<ShippingAddress> {
  try {
    const plain = await decryptFromFile(encPath, keyPath);
    if (plain) {
      const parsed = JSON.parse(plain) as Partial<ShippingAddress>;
      if (parsed.firstName && parsed.lastName && parsed.areaStreet && parsed.building) {
        return {
          firstName: String(parsed.firstName),
          lastName: String(parsed.lastName),
          areaStreet: String(parsed.areaStreet),
          building: String(parsed.building),
        };
      }
    }
  } catch {
    /* seed */
  }
  await encryptToFile(encPath, keyPath, JSON.stringify(BOOTSTRAP_SHIPPING));
  return { ...BOOTSTRAP_SHIPPING };
}

export async function saveShippingAddress(
  encPath: string,
  keyPath: string,
  shipping: ShippingAddress
): Promise<void> {
  await encryptToFile(encPath, keyPath, JSON.stringify(shipping));
}

/** Gmail accounts 複製用預設密碼（AES 存檔；唔寫死喺前端） */
export async function loadGmailCopyPassword(
  encPath: string,
  keyPath: string,
  bootstrap = ""
): Promise<string> {
  try {
    const plain = (await decryptFromFile(encPath, keyPath)).trim();
    if (plain) return plain;
  } catch {
    /* seed */
  }
  const seed = String(bootstrap || "").trim();
  if (!seed) return "";
  await encryptToFile(encPath, keyPath, seed);
  return seed;
}

/** 覆寫隨機資料再刪，減少殘留 */
export async function secureWipeFile(filePath: string): Promise<void> {
  try {
    const st = await fs.stat(filePath);
    const size = Math.max(st.size, 64);
    const junk = crypto.randomBytes(Math.min(size, 1024 * 1024));
    await fs.writeFile(filePath, junk);
    await fs.writeFile(filePath, Buffer.alloc(0));
    await fs.unlink(filePath);
  } catch {
    await fs.unlink(filePath).catch(() => {});
  }
}

export async function rotateKey(keyPath: string): Promise<void> {
  await secureWipeFile(keyPath);
  await getOrCreateKey(keyPath);
}

/**
 * Local secret helpers for add-order Gmail accounts.
 * AES-256-GCM at rest；Clear all 會覆寫後刪檔並換 key。
 */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const ALGO = "aes-256-gcm";

export function maskEmail(email: string): string {
  const s = String(email || "").trim();
  const at = s.indexOf("@");
  if (at <= 0) return "***";
  const user = s.slice(0, at);
  const domain = s.slice(at + 1);
  const head = user.slice(0, 1) || "*";
  return `${head}***@${domain || "***"}`;
}

/** 日誌／status 用：唔好洩露密碼，電郵遮罩 */
export function redactSecrets(line: string): string {
  let out = String(line || "");
  // email:password / email password 形態
  out = out.replace(
    /([A-Z0-9._%+-]+)@([A-Z0-9.-]+\.[A-Z]{2,})(\s*[:=\s,]\s*)(\S+)/gi,
    (_m, u: string, d: string, sep: string) => `${String(u).slice(0, 1)}***@${d}${sep}***`
  );
  out = out.replace(
    /([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})/gi,
    (m) => maskEmail(m)
  );
  out = out.replace(
    /(password|passwd|pwd|密碼)\s*[:=]\s*\S+/gi,
    "$1=***"
  );
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
  // format: v1 | iv(12) | tag(16) | ciphertext
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

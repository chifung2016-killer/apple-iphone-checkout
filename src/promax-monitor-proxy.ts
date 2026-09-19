/**
 * Pro Max 監控專用 Proxy 池（同結帳 browser 池分開）
 * - HTTP/HTTPS：undici ProxyAgent
 * - SOCKS5：Playwright APIRequest（已有依賴）
 */
import { ProxyAgent, fetch as undiciFetch } from "undici";

export type ParsedProxy = {
  raw: string;
  server: string;
  username?: string;
  password?: string;
  /** undici / URL 用：含帳密 */
  href: string;
  isSocks: boolean;
};

let pool: string[] = [];
let cursor = 0;
/** raw → 解禁時間 ms */
const bannedUntil = new Map<string, number>();
let activeRaw: string | null = null;

/** Playwright request context cache */
let pwContext: {
  key: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctx: any;
} | null = null;

export function parseMonitorProxyPool(raw: unknown): string[] {
  const s = String(raw || "").trim();
  if (!s) return [];
  return s
    .split(/[\n\r,;]+/)
    .map((x) => x.trim())
    .filter(Boolean);
}

export function parseProxyConfig(raw: string): ParsedProxy | null {
  const s = String(raw || "").trim();
  if (!s) return null;
  try {
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `http://${s}`;
    const u = new URL(withScheme);
    if (!u.hostname) return null;
    const isSocks = /^socks/i.test(u.protocol);
    const port =
      u.port ||
      (isSocks ? "1080" : u.protocol === "https:" ? "443" : "80");
    const server = `${u.protocol}//${u.hostname}:${port}`;
    const username = u.username ? decodeURIComponent(u.username) : undefined;
    const password = u.password ? decodeURIComponent(u.password) : undefined;
    const auth =
      username != null
        ? `${encodeURIComponent(username)}:${encodeURIComponent(password || "")}@`
        : "";
    const href = `${u.protocol}//${auth}${u.hostname}:${port}`;
    return { raw: s, server, username, password, href, isSocks };
  } catch {
    console.warn(`[promax-proxy] 格式無效，已忽略：${s}`);
    return null;
  }
}

export function setMonitorProxyPool(raw: string): { count: number } {
  pool = parseMonitorProxyPool(raw);
  cursor = 0;
  bannedUntil.clear();
  activeRaw = null;
  void disposePwContext();
  console.log(
    pool.length
      ? `[promax-proxy] monitor pool：${pool.length} 條`
      : `[promax-proxy] monitor pool：本機 IP`
  );
  return { count: pool.length };
}

export function getMonitorProxyPoolText(): string {
  return pool.join("\n");
}

export function getMonitorProxyStatus(): {
  count: number;
  active: string | null;
  banned: number;
  mode: "proxy" | "local";
} {
  pruneBans();
  return {
    count: pool.length,
    active: activeRaw,
    banned: [...bannedUntil.keys()].length,
    mode: pool.length > 0 ? "proxy" : "local",
  };
}

function pruneBans(): void {
  const now = Date.now();
  for (const [k, until] of bannedUntil) {
    if (until <= now) bannedUntil.delete(k);
  }
}

function availableProxies(): string[] {
  pruneBans();
  return pool.filter((p) => !bannedUntil.has(p));
}

/** 揀一條可用 proxy；空池 → null（本機） */
export function pickMonitorProxy(): ParsedProxy | null {
  const avail = availableProxies();
  if (!avail.length) {
    activeRaw = null;
    return null;
  }
  if (activeRaw && avail.includes(activeRaw)) {
    return parseProxyConfig(activeRaw);
  }
  const raw = avail[cursor % avail.length]!;
  cursor = (cursor + 1) % avail.length;
  activeRaw = raw;
  return parseProxyConfig(raw);
}

/** 541/403/429 時暫ban 呢條，換下一條；有得換 → true */
export function rotateMonitorProxyOnBlock(
  reason: string,
  banMs = 30 * 60_000
): boolean {
  if (activeRaw) {
    bannedUntil.set(activeRaw, Date.now() + banMs);
    console.warn(
      `[promax-proxy] ban ${activeRaw} ${Math.round(banMs / 60_000)}m｜${reason}`
    );
    activeRaw = null;
    void disposePwContext();
  }
  const next = pickMonitorProxy();
  if (next) {
    console.log(`[promax-proxy] 轉用下一條：${next.raw}`);
    return true;
  }
  console.warn(`[promax-proxy] 無剩餘 proxy，之後用本機／等 ban 完`);
  return false;
}

async function disposePwContext(): Promise<void> {
  if (pwContext?.ctx) {
    try {
      await pwContext.ctx.dispose();
    } catch {
      /* ignore */
    }
  }
  pwContext = null;
}

export type MonitorFetchResult = {
  status: number;
  ok: boolean;
  json: () => Promise<unknown>;
  proxyUsed: string | null;
};

/**
 * 經監控 proxy（或本機）打 HTTP GET
 */
export async function monitorFetchGet(
  url: string,
  headers: Record<string, string>
): Promise<MonitorFetchResult> {
  const proxy = pickMonitorProxy();
  if (!proxy) {
    const res = await fetch(url, { method: "GET", headers, redirect: "follow" });
    return {
      status: res.status,
      ok: res.ok,
      json: () => res.json() as Promise<unknown>,
      proxyUsed: null,
    };
  }

  if (proxy.isSocks) {
    const { request } = await import("playwright");
    const key = proxy.href;
    if (!pwContext || pwContext.key !== key) {
      await disposePwContext();
      const ctx = await request.newContext({
        proxy: {
          server: proxy.server,
          username: proxy.username,
          password: proxy.password,
        },
        extraHTTPHeaders: headers,
        ignoreHTTPSErrors: true,
      });
      pwContext = { key, ctx };
    }
    const res = await pwContext.ctx.get(url, { timeout: 45_000 });
    const status = res.status();
    const body = await res.text();
    return {
      status,
      ok: status >= 200 && status < 300,
      json: async () => JSON.parse(body) as unknown,
      proxyUsed: proxy.raw,
    };
  }

  const agent = new ProxyAgent(proxy.href);
  try {
    const res = await undiciFetch(url, {
      method: "GET",
      headers,
      redirect: "follow",
      dispatcher: agent,
    });
    return {
      status: res.status,
      ok: res.ok,
      json: () => res.json() as Promise<unknown>,
      proxyUsed: proxy.raw,
    };
  } finally {
    await agent.close().catch(() => {});
  }
}

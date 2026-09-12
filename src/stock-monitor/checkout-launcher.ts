/**
 * 有貨時經 Dashboard API 啟動 buy-iphone-17（瀏覽器會出現喺 dashboard），
 * 若 dashboard 未開則 fallback 直接 spawn。
 */
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MONITOR_CONFIG, type SkuConfig } from "./config.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const RUNTIME_DIR = path.join(ROOT, "runtime");

export type LaunchCheckoutOpts = {
  sku: SkuConfig;
  /** 實際要買嘅數量（已按限購／目標數量計好） */
  quantity: number;
};

function buildSessionConfig(sku: SkuConfig, quantity: number) {
  const ac = MONITOR_CONFIG.autoCheckout;
  const saleStartIso = new Date(Date.now() - 60_000).toISOString();
  return {
    buyUrl: sku.checkoutUrl?.trim() || sku.url,
    model: sku.model,
    color: sku.color || "",
    storage: sku.storage,
    quantity,
    browserCount: 1,
    count: 1,
    skipTradeIn: ac.skipTradeIn,
    addAppleCare: ac.addAppleCare,
    fulfillmentPreference: ac.fulfillmentPreference,
    pickupSearch: ac.pickupSearch,
    pickupStoreKeywords: ac.pickupStoreKeywords,
    saleStartIso,
    productPollIntervalMs: ac.productPollIntervalMs,
    salePollLeadMs: 0,
  };
}

async function launchViaDashboard(
  sessionConfig: Record<string, unknown>
): Promise<{ sessionId: string; pid: number | null; via: "dashboard" } | null> {
  const port = MONITOR_CONFIG.autoCheckout.dashboardPort || 8787;
  const endpoint = `http://127.0.0.1:${port}/api/browsers/add`;
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(sessionConfig),
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.warn(`  Dashboard API ${res.status}: ${text.slice(0, 200)}`);
      return null;
    }
    const data = (await res.json()) as {
      ok?: boolean;
      state?: { browsers?: Array<{ id: string; pid?: number | null }> };
    };
    const browsers = data.state?.browsers || [];
    const last = browsers[browsers.length - 1];
    console.log(`  → 已經 Dashboard 開瀏覽器（http://127.0.0.1:${port}）`);
    return {
      sessionId: last?.id || "dashboard",
      pid: last?.pid ?? null,
      via: "dashboard",
    };
  } catch (err) {
    console.warn(
      `  Dashboard 未就緒（${endpoint}）：${err instanceof Error ? err.message : String(err)}`
    );
    return null;
  }
}

async function launchDirectSpawn(
  sku: SkuConfig,
  quantity: number,
  sessionConfig: Record<string, unknown>
): Promise<{ sessionId: string; pid: number | null; via: "spawn" }> {
  await fs.mkdir(RUNTIME_DIR, { recursive: true });
  const sessionId = `stock-${Date.now().toString(36)}`;
  const configPath = path.join(RUNTIME_DIR, `config-${sessionId}.json`);
  await fs.writeFile(configPath, JSON.stringify(sessionConfig, null, 2), "utf8");
  await fs
    .writeFile(
      path.join(RUNTIME_DIR, "config-latest-stock.json"),
      JSON.stringify(sessionConfig, null, 2),
      "utf8"
    )
    .catch(() => {});

  const tsxCli = path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
  const script = path.join(ROOT, "src", "buy-iphone-17.ts");

  const proc = spawn(process.execPath, [tsxCli, script], {
    cwd: ROOT,
    env: {
      ...process.env,
      CHECKOUT_DASHBOARD: "1",
      CHECKOUT_CONFIG_PATH: configPath,
      CHECKOUT_SESSION_ID: sessionId,
      CHECKOUT_WINDOW_INDEX: "0",
      CHECKOUT_WINDOW_TOTAL: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
    windowsHide: false,
  });

  proc.stdout?.setEncoding("utf8");
  proc.stderr?.setEncoding("utf8");
  const prefix = `[checkout:${sessionId}]`;
  proc.stdout?.on("data", (chunk: string) => {
    for (const line of String(chunk).split("\n")) {
      if (line.trim()) console.log(`${prefix} ${line}`);
    }
  });
  proc.stderr?.on("data", (chunk: string) => {
    for (const line of String(chunk).split("\n")) {
      if (line.trim()) console.error(`${prefix} ${line}`);
    }
  });
  proc.on("exit", (code) => {
    console.log(`${prefix} 購買進程結束 exit=${code}`);
  });
  proc.unref();

  console.warn("  → Dashboard 唔得，已 fallback 直接 spawn（未必喺 dashboard 顯示）");
  return { sessionId, pid: proc.pid ?? null, via: "spawn" };
}

export async function launchCheckoutFromMonitor(opts: LaunchCheckoutOpts): Promise<{
  sessionId: string;
  pid: number | null;
  via: "dashboard" | "spawn";
}> {
  const { sku, quantity } = opts;
  const sessionConfig = buildSessionConfig(sku, quantity);

  await fs.mkdir(RUNTIME_DIR, { recursive: true });
  await fs
    .writeFile(
      path.join(RUNTIME_DIR, "config-latest-stock.json"),
      JSON.stringify(sessionConfig, null, 2),
      "utf8"
    )
    .catch(() => {});

  if (MONITOR_CONFIG.autoCheckout.preferDashboard !== false) {
    const viaDash = await launchViaDashboard(sessionConfig);
    if (viaDash) return viaDash;
  }

  return launchDirectSpawn(sku, quantity, sessionConfig);
}

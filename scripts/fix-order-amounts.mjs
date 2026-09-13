import fs from "fs/promises";
import path from "path";
import {
  applySuccessfulCheckoutToCardLimit,
  formatHkLimit,
  resolveOrderAmountSpent,
} from "../src/credit-card-pool.ts";

const ROOT = process.cwd();
const RUNTIME = path.join(ROOT, "runtime");

function isDemo(o) {
  return (
    String(o.orderNumber || "") === "W9876543210" ||
    /demo/i.test(String(o.browser || ""))
  );
}

function fixOrder(o) {
  if (!o || typeof o !== "object" || isDemo(o)) return false;
  if (!String(o.orderNumber || "").trim()) return false;
  const resolved = resolveOrderAmountSpent({
    scrapedAmount: o.amountSpent ?? o.total,
    model: String(o.productType || o.productName || ""),
    storage: String(o.storage || ""),
    quantity: Number(o.quantity) || 2,
  });
  if (!resolved.amount) return false;
  o.total = resolved.label;
  o.amountSpent = resolved.label;
  o._amountSource = resolved.source;
  return true;
}

const summaryPath = path.join(ROOT, "order-summary.json");
let summary = [];
try {
  const raw = JSON.parse(await fs.readFile(summaryPath, "utf8"));
  summary = Array.isArray(raw) ? raw : [raw];
} catch {
  summary = [];
}
summary = summary.filter((o) => !isDemo(o));
for (const o of summary) fixOrder(o);

const byOrder = new Map();
for (const o of summary) {
  const n = String(o.orderNumber || "").trim();
  if (n) byOrder.set(n, o);
}

for (const f of await fs.readdir(RUNTIME)) {
  if (!/^order-.*\.json$/i.test(f)) continue;
  const p = path.join(RUNTIME, f);
  const data = JSON.parse(await fs.readFile(p, "utf8"));
  const arr = Array.isArray(data) ? data : [data];
  let changed = false;
  for (const o of arr) {
    if (!fixOrder(o)) continue;
    changed = true;
    const n = String(o.orderNumber || "").trim();
    if (n) {
      const prev = byOrder.get(n);
      byOrder.set(n, prev ? { ...prev, ...o } : o);
    }
  }
  if (changed) await fs.writeFile(p, JSON.stringify(arr, null, 2) + "\n", "utf8");
}

const merged = [...byOrder.values()];
await fs.writeFile(summaryPath, JSON.stringify(merged, null, 2) + "\n", "utf8");

await fs.writeFile(path.join(ROOT, "card-remaining-limits.json"), "{}\n", "utf8");
const withCard = merged
  .filter((o) => o.cardNumber && !/apple\s*pay/i.test(String(o.cardNumber)))
  .sort((a, b) =>
    String(a.orderPlacedAt || "").localeCompare(String(b.orderPlacedAt || ""))
  );

for (const o of withCard) {
  const applied = await applySuccessfulCheckoutToCardLimit(
    ROOT,
    String(o.cardNumber),
    o.amountSpent
  );
  if (applied) {
    o.cardCompany = applied.card.company;
    o.cardType = applied.card.type;
    o.cardLimit = formatHkLimit(applied.originalLimit);
    o.remainingCreditCardLimit = formatHkLimit(applied.remainingLimit);
    o.remainingLimit = o.remainingCreditCardLimit;
  }
}
await fs.writeFile(summaryPath, JSON.stringify(merged, null, 2) + "\n", "utf8");

for (const f of await fs.readdir(RUNTIME)) {
  if (!/^order-.*\.json$/i.test(f)) continue;
  const p = path.join(RUNTIME, f);
  const data = JSON.parse(await fs.readFile(p, "utf8"));
  const arr = Array.isArray(data) ? data : [data];
  let changed = false;
  for (const o of arr) {
    const n = String(o.orderNumber || "").trim();
    const sum = byOrder.get(n) || merged.find((x) => String(x.orderNumber).trim() === n);
    if (!sum) continue;
    o.total = sum.total;
    o.amountSpent = sum.amountSpent;
    o.remainingCreditCardLimit = sum.remainingCreditCardLimit;
    o.remainingLimit = sum.remainingLimit;
    o.cardLimit = sum.cardLimit || o.cardLimit;
    o.cardCompany = sum.cardCompany || o.cardCompany;
    changed = true;
  }
  if (changed) await fs.writeFile(p, JSON.stringify(arr, null, 2) + "\n", "utf8");
}

for (const f of await fs.readdir(RUNTIME)) {
  if (!/^status-b\d+\.json$/i.test(f)) continue;
  const p = path.join(RUNTIME, f);
  const st = JSON.parse(await fs.readFile(p, "utf8"));
  const id = f.replace(/^status-|\.json$/gi, "");
  const orderFile = path.join(RUNTIME, `order-${id}.json`);
  let order = null;
  try {
    const raw = JSON.parse(await fs.readFile(orderFile, "utf8"));
    order = Array.isArray(raw) ? raw[0] : raw;
  } catch {
    order = null;
  }
  if (!order?.orderNumber) continue;
  st.card = {
    ...(st.card && typeof st.card === "object" ? st.card : {}),
    total: order.amountSpent || order.total,
    orderNumber: order.orderNumber,
    paymentSucceeded: true,
    cardNumber: order.cardNumber ?? st.card?.cardNumber,
    cardCompany: order.cardCompany ?? st.card?.cardCompany,
  };
  if (st.phase !== "payment_succeeded") st.phase = "payment_succeeded";
  await fs.writeFile(p, JSON.stringify(st, null, 2) + "\n", "utf8");
}

const report = merged.map((o) => ({
  order: o.orderNumber,
  amount: o.amountSpent,
  source: o._amountSource,
  cardLast4: String(o.cardNumber || "").replace(/\D/g, "").slice(-4) || "—",
  company: o.cardCompany || "—",
  remaining: o.remainingCreditCardLimit || "—",
}));
console.log(
  JSON.stringify(
    { fixedTo: "Pro Max 256GB x2 = HK$22,998.00", count: report.length, report },
    null,
    2
  )
);

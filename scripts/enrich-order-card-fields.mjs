/**
 * Backfill card company / remaining limit onto order-*.json + status-*.json
 * from status cardNumber + credit card pool (no console dump of full PANs).
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  lookupCardMeta,
  peekCardLimitInfo,
} from "../src/credit-card-pool.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RUNTIME = path.join(ROOT, "runtime");
const ORDERS_FILE = path.join(ROOT, "order-summary.json");

function pickNonEmpty(...vals) {
  for (const v of vals) {
    if (v == null) continue;
    const s = String(v).trim();
    if (!s || s === "—" || /人手填/.test(s)) continue;
    return s;
  }
  return null;
}

function hasDigits(card) {
  const d = String(card || "").replace(/\D/g, "");
  return d.length >= 4 || /apple\s*pay/i.test(String(card || ""));
}

async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return null;
  }
}

async function enrichOne(order, statusCard = {}) {
  const ship = order.confirmationPageShipping || {};
  const cardNumber = pickNonEmpty(
    order.cardNumber,
    statusCard.cardNumber,
    ship.cardNumber
  );
  if (!cardNumber || !hasDigits(cardNumber)) {
    return { order, changed: false, filled: false };
  }
  if (/apple\s*pay/i.test(cardNumber)) {
    const next = { ...order, cardNumber };
    let changed = String(order.cardNumber || "") !== String(cardNumber);
    if (!pickNonEmpty(order.cardCompany)) {
      next.cardCompany = "Apple Pay";
      changed = true;
    }
    if (!pickNonEmpty(order.cardType)) {
      next.cardType = "Apple Pay";
      changed = true;
    }
    return { order: next, changed, filled: true };
  }
  const peek = await peekCardLimitInfo(
    ROOT,
    cardNumber,
    order.amountSpent ?? order.total
  );
  const meta = lookupCardMeta(cardNumber);
  const next = { ...order, cardNumber };
  let changed = String(order.cardNumber || "") !== String(cardNumber);
  const company = pickNonEmpty(
    order.cardCompany,
    statusCard.cardCompany,
    peek?.company,
    meta?.company
  );
  const type = pickNonEmpty(
    order.cardType,
    statusCard.cardType,
    peek?.type,
    meta?.type
  );
  const limit = pickNonEmpty(
    order.cardLimit,
    statusCard.cardLimit,
    peek?.cardLimit,
    meta?.limit
  );
  const rem = pickNonEmpty(
    order.remainingCreditCardLimit,
    order.remainingLimit,
    statusCard.remainingCreditCardLimit,
    statusCard.remainingLimit,
    peek?.remainingLabel
  );
  if (company && company !== order.cardCompany) {
    next.cardCompany = company;
    changed = true;
  }
  if (type && type !== order.cardType) {
    next.cardType = type;
    changed = true;
  }
  if (limit && String(limit) !== String(order.cardLimit || "")) {
    next.cardLimit = limit;
    changed = true;
  }
  if (rem) {
    if (rem !== order.remainingCreditCardLimit || rem !== order.remainingLimit) {
      next.remainingCreditCardLimit = rem;
      next.remainingLimit = rem;
      changed = true;
    }
  }
  return { order: next, changed, filled: true };
}

async function main() {
  const files = (await fs.readdir(RUNTIME)).filter((f) =>
    /^order-b\d+\.json$/i.test(f)
  );
  let updatedOrders = 0;
  let updatedStatus = 0;

  for (const f of files) {
    const m = /^order-(b\d+)\.json$/i.exec(f);
    if (!m) continue;
    const id = m[1].toLowerCase();
    const orderPath = path.join(RUNTIME, f);
    const statusPath = path.join(RUNTIME, `status-${id}.json`);
    const raw = await readJson(orderPath);
    if (!raw) continue;
    const isArr = Array.isArray(raw);
    const order = isArr ? raw[0] : raw;
    if (!order || typeof order !== "object") continue;
    const st = await readJson(statusPath);
    const statusCard = (st && st.card) || {};
    const { order: next, changed, filled } = await enrichOne(order, statusCard);
    if (changed) {
      await fs.writeFile(
        orderPath,
        JSON.stringify(isArr ? [next, ...raw.slice(1)] : next, null, 2),
        "utf8"
      );
      updatedOrders++;
    }
    if (filled && st && typeof st === "object") {
      const card = { ...(st.card || {}) };
      let stChanged = false;
      for (const key of [
        "cardNumber",
        "cardCompany",
        "cardType",
        "cardLimit",
        "remainingCreditCardLimit",
        "remainingLimit",
      ]) {
        if (pickNonEmpty(next[key]) && !pickNonEmpty(card[key])) {
          card[key] = next[key];
          stChanged = true;
        }
      }
      if (pickNonEmpty(next.remainingCreditCardLimit)) {
        card.remainingCreditCardLimit = next.remainingCreditCardLimit;
        card.remainingLimit = next.remainingCreditCardLimit;
        stChanged = true;
      }
      if (stChanged) {
        st.card = card;
        if (next.orderNumber) {
          st.phase = st.phase || "payment_succeeded";
          card.paymentSucceeded = true;
          card.orderNumber = card.orderNumber || next.orderNumber;
        }
        await fs.writeFile(statusPath, JSON.stringify(st, null, 2), "utf8");
        updatedStatus++;
      }
    }
  }

  const root = await readJson(ORDERS_FILE);
  if (Array.isArray(root)) {
    let rootChanged = false;
    const out = [];
    for (const item of root) {
      if (!item || typeof item !== "object") {
        out.push(item);
        continue;
      }
      const browser = String(item.browser || "").toLowerCase();
      const st = browser
        ? await readJson(path.join(RUNTIME, `status-${browser}.json`))
        : null;
      const { order: next, changed } = await enrichOne(item, (st && st.card) || {});
      if (changed) rootChanged = true;
      out.push(next);
    }
    if (rootChanged) {
      await fs.writeFile(ORDERS_FILE, JSON.stringify(out, null, 2), "utf8");
    }
  }

  console.log(
    `enrich done: order files updated=${updatedOrders}, status updated=${updatedStatus}`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

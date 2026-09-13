/**
 * Delivery method 顯示用字（同 Dashboard「Run configuration」選項一致）
 */
export function fulfillmentLabelFromPreference(pref: unknown): string {
  const p = String(pref || "").trim();
  if (!p || p === "—") return "—";
  switch (p) {
    case "pickup":
      return "pickup credit card訪客模式";
    case "delivery":
      return "delivery credit card訪客模式";
    case "pickup_apple_pay":
      return "pickup apple pay";
    case "delivery_apple_pay":
      return "delivery apple pay";
    case "pickup_apple_ac_apple_pay":
      return "pickup apple ac apple pay";
    case "delivery_apple_ac_apple_pay":
      return "delivery apple ac apple pay";
    case "auto":
      return "Auto（先取貨，失敗改送貨）";
    default:
      return p;
  }
}

/** 由多個候選欄位解析出顯示用 Delivery method */
export function resolveDeliveryMethodLabel(
  ...candidates: unknown[]
): string {
  for (const c of candidates) {
    const s = String(c ?? "").trim();
    if (!s || s === "—") continue;
    return fulfillmentLabelFromPreference(s);
  }
  return "—";
}

export function isDeliveryMethod(labelOrPref: unknown): boolean {
  return /\bdelivery\b/i.test(String(labelOrPref || ""));
}

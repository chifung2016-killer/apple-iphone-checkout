#!/usr/bin/env python3
"""
Fetch real Apple HK iPhone 18 Pro Max Part Numbers (SKU) for 256GB / 512GB
across all official colours. Writes config/sku_map.json.

Usage:
  pip install requests
  python scripts/fetch_skus.py

Optional (fallback only if HTML bootstrap missing):
  pip install playwright && playwright install chromium
  python scripts/fetch_skus.py --playwright
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
OUT_PATH = ROOT / "config" / "sku_map.json"

# Official buy flow is under iphone-18-pro; Pro Max = 6.9-inch selector.
# /iphone-18-pro-max alone 404s on Apple HK (as of 2026-09).
# Prefer hk-zh so colour keys in sku_map.json are Chinese (布根地紅色…).
PRODUCT_URLS = [
    "https://www.apple.com/hk-zh/shop/buy-iphone/iphone-18-pro",
    "https://www.apple.com/hk/shop/buy-iphone/iphone-18-pro",
    "https://www.apple.com/hk-zh/shop/buy-iphone/iphone-18-pro-max",
    "https://www.apple.com/hk/shop/buy-iphone/iphone-18-pro-max",
]

REFERER = "https://www.apple.com/hk-zh/shop/buy-iphone/iphone-18-pro"

ALLOWED_CAPACITIES = {"256gb": "256GB", "512gb": "512GB"}
PRO_MAX_SCREEN = "6_9inch"
PRO_MAX_FAMILY = "iphone18promax"

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/131.0.0.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "zh-HK,zh;q=0.9,en-US;q=0.8,en;q=0.7",
    "Referer": REFERER,
    "Cache-Control": "no-cache",
}

# Fallback if displayValues missing (should not happen on live page)
COLOR_FALLBACK_ZH = {
    "burgundy": "布根地紅色",
    "glacier": "冰川色",
    "silver": "銀色",
    "black": "黑色",
}


def _strip_html(value: str) -> str:
    text = re.sub(r"<[^>]+>", "", value or "")
    text = (
        text.replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&#39;", "'")
        .replace("&quot;", '"')
    )
    return re.sub(r"\s+", " ", text).strip()


def extract_product_selection_json(html: str) -> dict[str, Any]:
    """
    Parse window.PRODUCT_SELECTION_BOOTSTRAP = { productSelectionData: {...} };
    The outer object uses unquoted JS keys; the nested productSelectionData
    value is strict JSON.
    """
    marker = "PRODUCT_SELECTION_BOOTSTRAP"
    idx = html.find(marker)
    if idx < 0:
        raise RuntimeError("PRODUCT_SELECTION_BOOTSTRAP not found in page HTML")

    # Prefer nested JSON blob (quoted keys) — most reliable
    m = re.search(
        r"productSelectionData\s*:\s*(\{)",
        html[idx : idx + 200_000],
    )
    if not m:
        raise RuntimeError("productSelectionData object not found")

    start = idx + m.start(1)
    depth = 0
    in_str = False
    esc = False
    end = -1
    for i in range(start, len(html)):
        ch = html[i]
        if in_str:
            if esc:
                esc = False
            elif ch == "\\":
                esc = True
            elif ch == '"':
                in_str = False
            continue
        if ch == '"':
            in_str = True
            continue
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                end = i
                break
    if end < 0:
        raise RuntimeError("Failed to brace-match productSelectionData JSON")

    raw = html[start : end + 1]
    try:
        return json.loads(raw)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"productSelectionData JSON parse failed: {exc}") from exc


def fetch_html_requests(url: str, timeout: float = 45.0) -> str:
    try:
        import requests
    except ImportError as exc:
        raise SystemExit(
            "缺少 requests。請執行：pip install requests"
        ) from exc

    resp = requests.get(url, headers=HEADERS, timeout=timeout)
    resp.raise_for_status()
    resp.encoding = resp.apparent_encoding or "utf-8"
    return resp.text


def fetch_html_playwright(url: str) -> str:
    try:
        from playwright.sync_api import sync_playwright
    except ImportError as exc:
        raise SystemExit(
            "缺少 playwright。請執行：pip install playwright && playwright install chromium"
        ) from exc

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(
            locale="zh-HK",
            user_agent=HEADERS["User-Agent"],
            extra_http_headers={
                "Accept-Language": HEADERS["Accept-Language"],
                "Referer": REFERER,
            },
        )
        page = context.new_page()
        page.goto(url, wait_until="domcontentloaded", timeout=90_000)
        page.wait_for_timeout(2500)
        html = page.content()
        browser.close()
        return html


def color_label_map(selection: dict[str, Any]) -> dict[str, str]:
    display = (selection.get("displayValues") or {}).get("dimensionColor") or {}
    out: dict[str, str] = {}
    for key, meta in display.items():
        if key in ("title", "variantOrder", "variantSortOrder"):
            continue
        if isinstance(meta, dict) and meta.get("value"):
            out[key] = _strip_html(str(meta["value"]))
        elif isinstance(meta, str):
            out[key] = _strip_html(meta)
    for k, v in COLOR_FALLBACK_ZH.items():
        out.setdefault(k, v)
    return out


def build_sku_map(selection: dict[str, Any]) -> dict[str, dict[str, str]]:
    colors = color_label_map(selection)
    products = selection.get("products") or []
    sku_map: dict[str, dict[str, str]] = {"256GB": {}, "512GB": {}}
    seen: dict[tuple[str, str], str] = {}

    for p in products:
        if not isinstance(p, dict):
            continue
        part = str(p.get("partNumber") or "").strip()
        if not part or "/" not in part:
            continue

        family = str(p.get("familyType") or p.get("productLocatorFamily") or "")
        screen = str(p.get("dimensionScreensize") or "")
        is_pro_max = (
            family.lower() == PRO_MAX_FAMILY
            or screen == PRO_MAX_SCREEN
            or "pro-max" in str(p.get("imageKey") or "").lower()
        )
        if not is_pro_max:
            continue

        cap_key = str(p.get("dimensionCapacity") or "").lower()
        storage = ALLOWED_CAPACITIES.get(cap_key)
        if not storage:
            continue

        color_key = str(p.get("dimensionColor") or "").strip()
        color_name = colors.get(color_key) or COLOR_FALLBACK_ZH.get(color_key) or color_key
        if not color_name:
            continue

        dup_key = (storage, color_name)
        if dup_key in seen and seen[dup_key] != part:
            print(
                f"[warn] duplicate {storage}/{color_name}: "
                f"{seen[dup_key]} vs {part} — keeping first",
                file=sys.stderr,
            )
            continue
        seen[dup_key] = part
        sku_map[storage][color_name] = part

    # Stable colour order (official variantOrder when available)
    order = (selection.get("displayValues") or {}).get("dimensionColor", {}).get(
        "variantOrder"
    ) or list(COLOR_FALLBACK_ZH.keys())
    ordered: dict[str, dict[str, str]] = {"256GB": {}, "512GB": {}}
    for storage, mapping in sku_map.items():
        # map zh label back via color key order
        key_to_zh = {k: colors.get(k, COLOR_FALLBACK_ZH.get(k, k)) for k in order}
        for ck in order:
            zh = key_to_zh.get(ck)
            if zh and zh in mapping:
                ordered[storage][zh] = mapping[zh]
        for zh, part in mapping.items():
            ordered[storage].setdefault(zh, part)
    return ordered


def validate_sku_map(sku_map: dict[str, dict[str, str]]) -> None:
    expected_colors = 4
    for storage in ("256GB", "512GB"):
        n = len(sku_map.get(storage) or {})
        if n < expected_colors:
            raise RuntimeError(
                f"{storage} 只有 {n} 個顏色 SKU（預期 ≥ {expected_colors}）。"
                " Apple 頁面結構可能已改，請改用 --playwright 或檢查 URL。"
            )
        for color, part in sku_map[storage].items():
            if not re.fullmatch(r"[A-Z0-9]+/[A-Z]", part):
                raise RuntimeError(f"可疑 Part Number：{storage}/{color} = {part!r}")


def fetch_selection(use_playwright: bool) -> tuple[dict[str, Any], str]:
    errors: list[str] = []
    for url in PRODUCT_URLS:
        try:
            print(f"[fetch] {url}")
            html = (
                fetch_html_playwright(url)
                if use_playwright
                else fetch_html_requests(url)
            )
            if "PRODUCT_SELECTION_BOOTSTRAP" not in html:
                errors.append(f"{url}: no PRODUCT_SELECTION_BOOTSTRAP")
                continue
            selection = extract_product_selection_json(html)
            return selection, url
        except SystemExit:
            raise
        except Exception as exc:  # noqa: BLE001 — collect & try next URL
            errors.append(f"{url}: {exc}")
            print(f"[skip] {exc}", file=sys.stderr)

    # Auto-fallback to Playwright once if requests failed
    if not use_playwright:
        print("[fallback] requests 失敗，改用 Playwright…", file=sys.stderr)
        return fetch_selection(use_playwright=True)

    raise RuntimeError("所有 URL 都攞唔到 productSelectionData：\n" + "\n".join(errors))


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Fetch iPhone 18 Pro Max HK SKUs → config/sku_map.json"
    )
    parser.add_argument(
        "--playwright",
        action="store_true",
        help="用 Playwright 載入頁面（預設用 requests 解析 HTML bootstrap）",
    )
    parser.add_argument(
        "-o",
        "--output",
        type=Path,
        default=OUT_PATH,
        help=f"輸出路徑（預設 {OUT_PATH}）",
    )
    args = parser.parse_args()

    selection, used_url = fetch_selection(use_playwright=args.playwright)
    sku_map = build_sku_map(selection)
    validate_sku_map(sku_map)

    args.output.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "256GB": sku_map["256GB"],
        "512GB": sku_map["512GB"],
    }
    # Keep a sidecar meta file? User asked only sku_map format — stick to exact shape.
    args.output.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )

    print(f"[ok] source={used_url}")
    print(f"[ok] wrote {args.output}")
    for storage, mapping in payload.items():
        print(f"  {storage}:")
        for color, part in mapping.items():
            print(f"    {color}: {part}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

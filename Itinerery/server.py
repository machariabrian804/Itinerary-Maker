#!/usr/bin/env python3
"""
Local server for the Safari Quote itinerary price maker.

It does two jobs:
  1. Serves the single-page quote app.
  2. Syncs the public OneDrive contract folder and extracts rate candidates
     from contract PDFs / spreadsheets on demand.

Run:
    python3 -m pip install -r requirements.txt
    python3 server.py
Then open http://127.0.0.1:8765
"""

from __future__ import annotations

import argparse
import concurrent.futures
import datetime as dt
import hashlib
import http.cookiejar
import json
import mimetypes
import os
import re
import shutil
import sys
import threading
import traceback
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = BASE_DIR / "data"
CACHE_DIR = BASE_DIR / "cache"
INVENTORY_JSON = DATA_DIR / "inventory.json"
INVENTORY_JS = DATA_DIR / "inventory.js"
# Bump when extraction logic changes so old cached results are not reused.
EXTRACTION_VERSION = "2026-11-23.3"
DEFAULT_SHARE_URL = (
    "https://1drv.ms/f/c/c6bd9a516690d040/"
    "IgCQLxHViUcZQrIw6ovUwuDUAS7stpyD4G113ctodZqgiKs?e=P9ao7Y"
)
UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36"
)
ALLOWED_HOSTS = {
    "1drv.ms",
    "onedrive.live.com",
    "www.onedrive.live.com",
    "sharepoint.com",
    "www.sharepoint.com",
}
MAX_PAGES = 60
MAX_FILES = 4000
MAX_FOLDERS = 800
REQUEST_TIMEOUT = 45

try:
    import pdfplumber  # type: ignore
except Exception:  # pragma: no cover - optional dependency
    pdfplumber = None

try:
    import openpyxl  # type: ignore
except Exception:  # pragma: no cover - optional dependency
    openpyxl = None


# ---------------------------------------------------------------------------
# small helpers
# ---------------------------------------------------------------------------

def utc_now() -> str:
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def json_response(handler: BaseHTTPRequestHandler, status: int, payload: Any) -> None:
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(body)))
    handler.send_header("Cache-Control", "no-store")
    handler.send_header("Access-Control-Allow-Origin", "*")
    handler.end_headers()
    handler.wfile.write(body)


def error_response(handler: BaseHTTPRequestHandler, status: int, message: str) -> None:
    json_response(handler, status, {"ok": False, "error": message})


def read_json_body(handler: BaseHTTPRequestHandler) -> dict[str, Any]:
    length = int(handler.headers.get("Content-Length") or 0)
    if length <= 0 or length > 2_000_000:
        raise ValueError("Invalid request body.")
    raw = handler.rfile.read(length)
    try:
        data = json.loads(raw.decode("utf-8"))
    except Exception as exc:
        raise ValueError("Request body must be JSON.") from exc
    if not isinstance(data, dict):
        raise ValueError("Request body must be a JSON object.")
    return data


def quote_path(path: str) -> str:
    return urllib.parse.quote(path.replace("'", "''"), safe="/()'!&*,-._~")


def cache_name(path: str, ext: str = "") -> str:
    digest = hashlib.sha1(path.encode("utf-8")).hexdigest()
    return digest + (("." + ext) if ext else "")


def human_size(size: int) -> str:
    if size < 1024:
        return f"{size} B"
    if size < 1024 * 1024:
        return f"{size / 1024:.0f} KB"
    return f"{size / (1024 * 1024):.1f} MB"


def find_file(inventory: dict[str, Any], path: str) -> dict[str, Any] | None:
    for supplier in inventory.get("suppliers", []):
        for item in supplier.get("files", []):
            if item.get("path") == path:
                return {
                    **item,
                    "supplier": supplier.get("name", ""),
                    "supplierPath": supplier.get("path", ""),
                }
    return None


def root_path_from_inventory(inventory: dict[str, Any]) -> str:
    return inventory.get("rootPath") or ""


def validate_file_path(inventory: dict[str, Any], path: str) -> bool:
    root = root_path_from_inventory(inventory)
    return bool(path) and bool(root) and path.startswith(root + "/") and ".." not in path


# ---------------------------------------------------------------------------
# OneDrive public-folder client
# ---------------------------------------------------------------------------

class OneDriveError(RuntimeError):
    pass


class OneDriveClient:
    """Read a public OneDrive share with the anonymous session cookie.

    The public share page establishes an anonymous FedAuth cookie.  We keep
    that cookie and use the SharePoint REST endpoints the OneDrive web app
    itself uses.  No Microsoft account or app registration is required.
    """

    def __init__(self, share_url: str):
        self.share_url = share_url.strip()
        self.cookie_jar = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(self.cookie_jar)
        )
        self.opener.addheaders = [
            ("User-Agent", UA),
            (
                "Accept",
                "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
            ),
        ]
        self.site_id = ""
        self.root_path = ""
        self.cookie_header = ""
        self.final_url = ""

    def redeem(self) -> None:
        parsed = urllib.parse.urlparse(self.share_url)
        if parsed.scheme not in ("http", "https"):
            raise OneDriveError("The share link must start with https://")
        if parsed.hostname not in ALLOWED_HOSTS:
            raise OneDriveError("Only 1drv.ms / OneDrive share links are supported.")

        try:
            with self.opener.open(self.share_url, timeout=REQUEST_TIMEOUT) as response:
                response.read(1024)
                self.final_url = response.geturl()
        except urllib.error.HTTPError as exc:
            raise OneDriveError(f"OneDrive returned HTTP {exc.code} while opening the link.") from exc
        except Exception as exc:
            raise OneDriveError(f"Could not open the OneDrive link: {exc}") from exc

        query = urllib.parse.parse_qs(urllib.parse.urlparse(self.final_url).query)
        root = (query.get("spopath") or [""])[0]
        if not root:
            item_id = (query.get("id") or [""])[0]
            if item_id.startswith("/personal/"):
                root = item_id
        if not root:
            raise OneDriveError(
                "Could not find the shared folder path. Make sure the link points to a folder, "
                "not a single file."
            )

        parts = root.split("/")
        if len(parts) < 3 or parts[1] != "personal":
            raise OneDriveError("Unexpected OneDrive folder path.")
        self.site_id = parts[2]
        self.root_path = root

        self.cookie_header = "; ".join(
            f"{cookie.name}={cookie.value}" for cookie in self.cookie_jar
        )

    def _api_url(self, folder_path: str, endpoint: str) -> str:
        return (
            f"https://onedrive.live.com/personal/{self.site_id}/_api/web/"
            f"GetFolderByServerRelativeUrl('{quote_path(folder_path)}')/{endpoint}"
            "?$select=Name,ServerRelativeUrl,Length,TimeLastModified"
        )

    def _get_json(self, url: str) -> dict[str, Any]:
        request = urllib.request.Request(
            url,
            headers={
                "User-Agent": UA,
                "Accept": "application/json;odata=verbose",
                "Cookie": self.cookie_header,
            },
        )
        with urllib.request.urlopen(request, timeout=REQUEST_TIMEOUT) as response:
            return json.loads(response.read().decode("utf-8"))

    def list_folder(self, folder_path: str) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
        folders = self._get_json(self._api_url(folder_path, "Folders"))["d"]["results"]
        files = self._get_json(self._api_url(folder_path, "Files"))["d"]["results"]
        return folders, files

    def download(self, file_path: str, destination: Path) -> None:
        url = (
            f"https://onedrive.live.com/personal/{self.site_id}/_api/web/"
            f"GetFileByServerRelativePath(decodedurl='{quote_path(file_path)}')/$value"
        )
        request = urllib.request.Request(
            url,
            headers={
                "User-Agent": UA,
                "Cookie": self.cookie_header,
                "Accept": "*/*",
            },
        )
        destination.parent.mkdir(parents=True, exist_ok=True)
        temp = destination.with_suffix(destination.suffix + ".part")
        try:
            with urllib.request.urlopen(request, timeout=120) as response, open(temp, "wb") as fh:
                shutil.copyfileobj(response, fh, length=1024 * 256)
            temp.replace(destination)
        finally:
            if temp.exists():
                try:
                    temp.unlink()
                except OSError:
                    pass

    def sync(self, max_folders: int = MAX_FOLDERS, max_files: int = MAX_FILES) -> dict[str, Any]:
        self.redeem()

        suppliers: list[dict[str, Any]] = []
        file_total = 0
        folder_count = 0
        level = [(self.root_path, "")]
        seen: set[str] = set()

        while level and folder_count < max_folders:
            current = level
            level = []

            def fetch(item: tuple[str, str]) -> tuple[str, str, list[dict[str, Any]], list[dict[str, Any]]]:
                path, rel = item
                folders, files = self.list_folder(path)
                return path, rel, folders, files

            with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
                futures = [pool.submit(fetch, item) for item in current]
                results = []
                for future in concurrent.futures.as_completed(futures):
                    try:
                        results.append(future.result())
                    except Exception as exc:
                        results.append(("", "", [], [{"__error__": str(exc)}]))

            for path, rel, folders, files in results:
                if not path or path in seen:
                    continue
                seen.add(path)
                folder_count += 1

                clean_files = []
                for item in files:
                    if "__error__" in item:
                        continue
                    name = item.get("Name") or ""
                    if not name:
                        continue
                    ext = name.rsplit(".", 1)[-1].lower() if "." in name else ""
                    clean_files.append(
                        {
                            "name": name,
                            "size": int(item.get("Length") or 0),
                            "path": item.get("ServerRelativeUrl") or "",
                            "ext": ext,
                            "modified": item.get("TimeLastModified") or "",
                        }
                    )
                    file_total += 1
                    if file_total >= max_files:
                        break

                if rel:
                    suppliers.append(
                        {
                            "id": "sup-" + hashlib.sha1(rel.encode("utf-8")).hexdigest()[:10],
                            "name": rel,
                            "folder": rel.rsplit("/", 1)[-1],
                            "path": path,
                            "files": clean_files,
                        }
                    )
                elif clean_files:
                    suppliers.append(
                        {
                            "id": "sup-root",
                            "name": "Contract folder",
                            "folder": "Contract folder",
                            "path": path,
                            "files": clean_files,
                        }
                    )

                for folder in folders:
                    if "__error__" in folder:
                        continue
                    child_path = folder.get("ServerRelativeUrl") or ""
                    child_name = folder.get("Name") or ""
                    if not child_path or not child_name or child_path in seen:
                        continue
                    level.append((child_path, (rel + "/" + child_name) if rel else child_name))

                if file_total >= max_files:
                    break
            if file_total >= max_files:
                break

        suppliers.sort(key=lambda item: item["name"].lower())
        for supplier in suppliers:
            supplier["files"].sort(key=lambda item: item["name"].lower())

        inventory = {
            "shareUrl": self.share_url,
            "rootPath": self.root_path,
            "finalUrl": self.final_url,
            "syncedAt": utc_now(),
            "supplierCount": len(suppliers),
            "fileCount": sum(len(item["files"]) for item in suppliers),
            "pdfCount": sum(
                1 for item in suppliers for f in item["files"] if f.get("ext") == "pdf"
            ),
            "suppliers": suppliers,
        }
        return inventory


# ---------------------------------------------------------------------------
# Inventory persistence
# ---------------------------------------------------------------------------

_inventory_lock = threading.Lock()


def load_inventory() -> dict[str, Any]:
    with _inventory_lock:
        if INVENTORY_JSON.exists():
            try:
                with open(INVENTORY_JSON, "r", encoding="utf-8") as fh:
                    data = json.load(fh)
                if isinstance(data, dict) and isinstance(data.get("suppliers"), list):
                    return data
            except Exception:
                pass
    return {
        "shareUrl": DEFAULT_SHARE_URL,
        "rootPath": "",
        "syncedAt": "",
        "supplierCount": 0,
        "fileCount": 0,
        "pdfCount": 0,
        "suppliers": [],
    }


def save_inventory(inventory: dict[str, Any]) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    with _inventory_lock:
        temp = INVENTORY_JSON.with_suffix(".json.tmp")
        with open(temp, "w", encoding="utf-8") as fh:
            json.dump(inventory, fh, ensure_ascii=False, indent=2)
        temp.replace(INVENTORY_JSON)

        temp_js = INVENTORY_JS.with_suffix(".js.tmp")
        with open(temp_js, "w", encoding="utf-8") as fh:
            fh.write("window.ONEDRIVE_INVENTORY = ")
            json.dump(inventory, fh, ensure_ascii=False, separators=(",", ":"))
            fh.write(";\n")
        temp_js.replace(INVENTORY_JS)


# ---------------------------------------------------------------------------
# Rate extraction
# ---------------------------------------------------------------------------

CURRENCY_RE = re.compile(
    r"(?P<cur>US\$|USD|KES|KSh|Ksh|EUR|GBP|€|£|\$)\s*"
    r"(?P<amt>\d[\d,]*(?:\.\d{1,2})?)",
    re.IGNORECASE,
)
BARE_NUM_RE = re.compile(r"(?<![\w.])(\d[\d,]*(?:\.\d{1,2})?)(?![\w.])")
MONTH_PATTERN = (
    r"(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?"
    r"|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)"
)
DATE_TOKEN_RE = re.compile(
    rf"\b\d{{1,2}}[./-]\d{{1,2}}[./-]\d{{2,4}}\b"
    rf"|\b\d{{1,2}}\s*{MONTH_PATTERN}\b"
    rf"|\b{MONTH_PATTERN}\s*\d{{1,2}}\b"
    rf"|\b20[2-3]\d\b",
    re.IGNORECASE,
)
SEASON_RE = re.compile(
    r"\b(Peak Season|Shoulder Season|Standard Season|High Season|Low Season|"
    r"Festive Season|Green Season|Shoulder|Peak|Standard|High|Low|Festive)\b",
    re.IGNORECASE,
)
MONTH_RE = re.compile(rf"\b{MONTH_PATTERN}\b\.?", re.IGNORECASE)
SKIP_LINE_RE = re.compile(
    r"(https?://|www\.|@|tel[:.]|telephone|phone|email|website|page\s+\d+\s*(?:of|/)"
    r"|e&oe|confidential|cancellation|payment terms|deposit|bank details|account no"
    r"|invoice|commissionable|agent rates|trading terms|terms and conditions"
    r"|rate includes|rates include|includes|excludes|child policy|important"
    r"|please note|subject to change|subject to availability|date of issue"
    r"|validity|valid from|valid until|all rates|rates are quoted|rates quoted"
    r"|p\.?o\.?\s*box|min\.?\s*\d+\s*pax|get\s+\d+(?:\.\d+)?%\s*off"
    r"|^\s*ages?\b|^\s*children\s+aged|^\s*child\s+aged|^\s*first\s+\d+\s+child"
    r"|^\s*in order|^\s*our\s|^\s*this\s|^\s*an intimate|^\s*located\b"
    r"|accommodate|intimate lodge|guests?\s+enjoy|minimum\s+stay|maximum\s+of"
    r"|not applicable|free of charge|stay as our guests|available at|subject to)"
    ,
    re.IGNORECASE,
)
RATE_KEYWORD_RE = re.compile(
    r"(rate|cost|price|per\s|sharing|single|supplement|fee|package|night|day"
    r"|adult|child|transfer|vehicle|meal|lunch|dinner|breakfast|balloon"
    r"|park|conservation|guide|laundry|spa|activity|excursion|flight|charter"
    r"|accommodation|room|suite|tent|villa|cabin)",
    re.IGNORECASE,
)
PROSE_RE = re.compile(
    r"(in order to|qualify|minimum stay|maximum of|accommodate|intimate lodge"
    r"|guests?\s+enjoy|subject to|children?\s+aged|first\s+\d+|any child"
    r"|free of charge|stay as our guests|not applicable|available at"
    r"|valid\s+(?:from|until|for)|or more|and subject to|under the age"
    r"|chargeable|in case of|travelling alone|flight changes"
    r"|per\s+adult\s+sharing\s+rate\s*:\s*min)",
    re.IGNORECASE,
)
SEASON_WORD_RE = r"(?:mid|middle|peak|high|shoulder|standard|low|festive|green)"
SEASON_MONTH_CODES = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"]
NUMERIC_DATE_RE = re.compile(r"\b(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})\b")
# Season headings as printed across the top of a rate table, e.g.
# "LOW SEASON MID SEASON HIGH SEASON" or "HIGH SEASON MID & LOW SEASON".
HEADER_SEASON_RE = re.compile(
    rf"\b({SEASON_WORD_RE}(?:\s*(?:&|and|/)\s*{SEASON_WORD_RE})*\s*seasons?)\b",
    re.IGNORECASE,
)
FEE_WORD_RE = re.compile(r"\b(?:conser\w*|conserv\w*|lev(?:y|ies)|fees?)\b", re.IGNORECASE)
# Rows that open with the date band a contract prices (one band per row), e.g.
# "High Season: (02 Jan–31 Mar 2027 …) 326 435 131" or "3/1/2027 31/3/2027 200 150".
BAND_LEAD_RE = re.compile(
    rf"^\s*(?:{SEASON_WORD_RE}\s*seasons?\b|\d{{1,2}}[./-]\d{{1,2}}[./-]\d{{2,4}})",
    re.IGNORECASE,
)
# Words that label a rate table's occupancy columns ("PERIOD SINGLE DOUBLE THIRD BED",
# "Per Person in twin", "Child(4-11) Sharing", "Executive Suite"). Headings wrap over
# several lines, so they are collected word by word and keyed by x position.
OCCUPANCY_WORD_RE = re.compile(
    r"(single|double|twin|family|sharing|third|3rd|child|infant|per\b|person|adult"
    r"|bed\b|room|suite|executive|standard|deluxe|superior|triple|occupancy|pax)",
    re.IGNORECASE,
)
SEASON_ORDER = ("high", "shoulder", "low")
SECTION_STOPWORDS = {
    "client",
    "clients",
    "date",
    "dates",
    "rates",
    "rate",
    "notes",
    "note",
    "terms",
    "includes",
    "excludes",
    "inclusions",
    "exclusions",
    "important",
    "please note",
    "accommodation",
    "activities",
    "activity",
    "offers",
    "offer",
    "extras",
    "general",
    "payment",
    "cancellation",
    "validity",
    "location",
    "address",
    "contact",
    "email",
    "telephone",
    "website",
    "high season",
    "low season",
    "peak season",
    "shoulder season",
    "standard season",
    "festive season",
    "green season",
}
UNIT_RULES = [
    (r"per\s+person\s*(?:/|per\s+)?night|pppn|p\.?\s*p\.?\s*p\.?\s*n", "per_person_night"),
    (r"per\s+person\s*(?:/|per\s+)?day|pppd", "per_person_day"),
    (r"per\s+(?:room|suite|tent|villa|cabin)\s*(?:/|per\s+)?night", "per_room_night"),
    (r"per\s+child\s*(?:/|per\s+)?night|per\s+child\s+night", "per_child_night"),
    (r"per\s+child", "per_child"),
    (r"per\s+(?:vehicle|car|van|4x4|land\s*cruiser)\s*(?:/|per\s+)?day", "per_vehicle_day"),
    (r"per\s+(?:vehicle|car|van|4x4|land\s*cruiser)", "per_group"),
    (r"per\s+(?:group|booking|transfer|flight|trip|charter)", "per_group"),
    (r"per\s+(?:adult|pax|person|passenger)|per\s+p\.?p\b|\bpp\b", "per_person"),
    (r"per\s+night", "per_room_night"),
    (r"per\s+day", "per_group_day"),
    (r"per\s+meal|per\s+lunch|per\s+dinner|per\s+breakfast", "per_person"),
]
UNIT_LABELS = {
    "per_person": "Per person",
    "per_person_night": "Per person / night",
    "per_person_day": "Per person / day",
    "per_room_night": "Per room / night",
    "per_group": "Per group / flat",
    "per_group_day": "Per group / day",
    "per_child": "Per child",
    "per_child_night": "Per child / night",
    "per_vehicle": "Per vehicle",
    "per_vehicle_day": "Per vehicle / day",
    "per_night": "Per night",
    "per_day": "Per day",
    "per_single_night": "Per single room / night",
    "per_extra_person_night": "Per extra person / night",
}
CURRENCY_WORDS = [
    (re.compile(r"\bUSD\b|US\$|\bdollars?\b", re.I), "USD"),
    (re.compile(r"\bKES\b|\bKSh\b|\bKsh\b|\bshillings?\b", re.I), "KES"),
    (re.compile(r"\bEUR\b|€", re.I), "EUR"),
    (re.compile(r"\bGBP\b|£", re.I), "GBP"),
]


def normalize_number(value: str) -> float:
    try:
        return round(float(value.replace(",", "")), 2)
    except Exception:
        return 0.0


def currency_from_text(text: str) -> str:
    for regex, code in CURRENCY_WORDS:
        if regex.search(text):
            return code
    return ""


def season_labels_from_text(text: str) -> list[str]:
    labels: list[str] = []
    for match in SEASON_RE.finditer(text):
        label = match.group(1)
        key = label.lower()
        if key not in [item.lower() for item in labels]:
            labels.append(label)
    return labels


def unit_from_text(text: str) -> str:
    lowered = text.lower()
    for pattern, unit in UNIT_RULES:
        if re.search(pattern, lowered, re.I):
            return unit
    return ""


def clean_description(line: str, amounts: list[float]) -> str:
    cleaned = line
    for amount in amounts:
        variants = [
            f"{amount:,.2f}",
            f"{amount:,.0f}",
            f"{amount:.2f}",
            f"{amount:.0f}",
            f"{int(amount):,}" if amount.is_integer() else "",
        ]
        for variant in variants:
            if variant:
                cleaned = cleaned.replace(variant, " ")
    cleaned = re.sub(r"(?i)(?:US\$|USD|KES|KSh|EUR|GBP|€|£|\$)", " ", cleaned)
    cleaned = re.sub(r"(?i)\b(?:rack|margin|nett|net)\s*:", " ", cleaned)
    cleaned = re.sub(r"\s+", " ", cleaned).strip(" .;:-–—|/")
    cleaned = re.sub(r"^[•●▪◆◇✓✔\-\u2022\u25aa\uf0a8]+\s*", "", cleaned)
    cleaned = re.sub(r"\s{2,}", " ", cleaned).strip()
    if len(cleaned) > 180:
        cleaned = cleaned[:177].rstrip() + "..."
    return cleaned


def amounts_from_line(line: str) -> tuple[list[float], str, bool]:
    """Return (amounts, currency, had_currency_symbol)."""
    source = line
    if re.search(r"\bRack\s*:", source, re.I) or re.search(r"\bMargin\s*:", source, re.I):
        source = re.split(r"\bRack\s*:", source, maxsplit=1, flags=re.I)[0]

    currency = currency_from_text(source)
    currency_matches = list(CURRENCY_RE.finditer(source))
    if currency_matches:
        amounts = []
        for match in currency_matches:
            value = normalize_number(match.group("amt"))
            if value > 0:
                amounts.append(value)
        if amounts:
            return amounts, currency, True

    no_dates = DATE_TOKEN_RE.sub(" ", source)
    no_dates = re.sub(r"\b\d+(?:\.\d+)?\s*%", " ", no_dates)
    numbers = []
    for match in BARE_NUM_RE.finditer(no_dates):
        value = normalize_number(match.group(1))
        if value < 5 or value > 1_000_000:
            continue
        if 2024 <= value <= 2035 and float(value).is_integer():
            continue
        numbers.append(value)
    return numbers, currency, False


def season_header_blocks(page: Any) -> list[dict[str, Any]]:
    """Season headings with their x positions, so column order is the printed order.

    Rows are read top-to-bottom by the text extractor, but a rate table's column
    order is left-to-right. Tawi prints "HIGH SEASON" above the table and
    "MID SEASON  LOW SEASON" below it, while the actual columns are Mid, Low,
    High — only the coordinates get that right.
    """
    try:
        words = page.extract_words(x_tolerance=2, y_tolerance=2)
    except Exception:
        return []
    season_words = [
        word
        for word in words
        if re.fullmatch(SEASON_WORD_RE, str(word.get("text", "")).strip(" .,:();"), re.IGNORECASE)
    ]
    blocks: list[dict[str, Any]] = []
    for word in sorted(season_words, key=lambda item: item.get("top", 0)):
        top = float(word.get("top", 0))
        block = next((item for item in blocks if abs(item["top"] - top) <= 3.5), None)
        if block is None:
            block = {"top": top, "columns": []}
            blocks.append(block)
        label = str(word.get("text", "")).strip(" .,:();")
        suffix = next(
            (
                other
                for other in words
                if abs(float(other.get("top", 0)) - top) <= 2
                and 0 <= float(other.get("x0", 0)) - float(word.get("x1", 0)) < 30
                and re.fullmatch(r"seasons?", str(other.get("text", "")).strip(" .,:();"), re.IGNORECASE)
            ),
            None,
        )
        if suffix is not None:
            label = f"{label} season"
        block["columns"].append((float(word.get("x0", 0)), label))
    return [block for block in blocks if block["columns"]]


def merge_header_blocks(blocks: list[dict[str, Any]], top: float | None) -> list[str]:
    """All season headings around one table header, left to right."""
    if top is None:
        return []
    near = [block for block in blocks if abs(block["top"] - top) <= 18]
    seen: set[tuple[int, str]] = set()
    columns: list[tuple[float, str]] = []
    for block in near:
        for x, label in block["columns"]:
            key = (round(x / 4), label.lower())
            if key in seen:
                continue
            seen.add(key)
            columns.append((x, label))
    return [label for _, label in sorted(columns, key=lambda item: item[0])]


def extract_rows_from_page(page: Any) -> tuple[list[str], list[float], list[list[dict[str, Any]]]]:
    """Reconstruct visual rows using word coordinates.

    PDF text extraction often splits a table row into several lines because
    of cell padding.  Grouping words by vertical position keeps descriptions
    and their amounts together.  Each row's words are returned too, so table
    cells can still be placed by the x position they were printed at.
    """
    try:
        words = page.extract_words(x_tolerance=2, y_tolerance=2, keep_blank_chars=False)
    except Exception:
        words = []
    if not words:
        text = page.extract_text() or ""
        lines = [line.strip() for line in text.splitlines() if line.strip()]
        return lines, [float(index) for index in range(len(lines))], [[] for _ in lines]

    groups: list[dict[str, Any]] = []
    for word in sorted(words, key=lambda item: (item.get("top", 0), item.get("x0", 0))):
        top = float(word.get("top", 0))
        placed = False
        for group in groups:
            if abs(group["top"] - top) <= 2.2:
                group["words"].append(word)
                group["top"] = (group["top"] * (len(group["words"]) - 1) + top) / len(group["words"])
                placed = True
                break
        if not placed:
            groups.append({"top": top, "words": [word]})

    rows = []
    tops = []
    words_rows = []
    for group in sorted(groups, key=lambda item: item["top"]):
        ordered = sorted(group["words"], key=lambda item: item.get("x0", 0))
        text = " ".join(str(item.get("text", "")) for item in ordered).strip()
        if text:
            rows.append(text)
            tops.append(float(group["top"]))
            words_rows.append(ordered)
    return rows, tops, words_rows


def page_text(page: Any) -> str:
    try:
        return page.extract_text() or ""
    except Exception:
        return ""


def detect_residency(*parts: str) -> str:
    text = " ".join(part for part in parts if part).lower()
    if re.search(r"\bnon[\s-]?residents?\b|\binternational\b|\bforeign\b", text):
        return "non-resident"
    if re.search(r"\b(?:east african|e\.?\s*a\.?\s*)?residents?\b|\bcitizens?\b|\bksh?\b.*resident|\bresident.*\bksh?\b", text):
        return "resident"
    return "unknown"


def header_season_columns(text: str) -> list[str]:
    """Season headings in the order the contract prints them, left to right.

    Contract tables are read column by column in print order, so the headings
    must stay in that order — re-sorting them into a conventional
    Peak→Low order is what used to price the wrong column.
    """
    matches = list(HEADER_SEASON_RE.finditer(text))
    if not matches:
        return []
    leftover = re.sub(r"[^0-9A-Za-z]", " ", HEADER_SEASON_RE.sub(" ", text)).strip()
    if re.search(r"\d", leftover):
        return []
    if len(matches) == 1:
        # A heading on its own row is still a heading; wrapped tables put one
        # label per row. Policy lines ("Low season: 30 days") keep words/digits
        # in the leftover and are rejected above.
        if leftover and not re.fullmatch(r"(?i)seasons?", leftover):
            return []
        return [matches[0].group(1)]
    if len(leftover) > 24:
        return []
    return [match.group(1) for match in matches]


def seasons_for_label(label: str) -> list[str]:
    """Trade seasons a printed column heading covers ("Mid & Low" covers two)."""
    text = str(label or "").lower()
    seasons: list[str] = []
    if re.search(r"mid|middle|shoulder|standard", text):
        seasons.append("shoulder")
    if re.search(r"peak|high|festive", text):
        seasons.append("high")
    if re.search(r"low|green", text):
        seasons.append("low")
    return seasons


def months_in_text(text: str) -> set[str]:
    months = {match.group(0).lower()[:3] for match in MONTH_RE.finditer(text)}
    # Some contracts print bands as 3/1/2027 – 31/3/2027 instead of month names.
    for match in NUMERIC_DATE_RE.finditer(text):
        month = int(match.group(2))
        if 1 <= month <= 12:
            months.add(SEASON_MONTH_CODES[month - 1])
    return months


def season_for_months(months: set[str]) -> list[str]:
    seasons = set()
    for month in months:
        if month in ("apr", "may"):
            seasons.add("low")
        elif month in ("dec", "jul", "aug", "sep", "oct"):
            seasons.add("high")
        else:
            seasons.add("shoulder")
    return [key for key in SEASON_ORDER if key in seasons]


def season_from_dates(text: str) -> str:
    """Kenya's trade seasons applied to one printed date band."""
    seasons = season_for_months(months_in_text(text))
    # One label for the whole band: the rains price the row, then the peak.
    for key in ("low", "high", "shoulder"):
        if key in seasons:
            return key
    return ""


def band_seasons(text: str) -> list[str]:
    """Every trade season one printed rate band covers.

    Contracts price one row per band, and a band often spans two of our seasons:
    Salt Lick's "High Season" runs 02 Jan–31 Mar as well as Jul–Jan, so a January
    quote legitimately comes off that row.
    """
    seasons = set(season_for_months(months_in_text(text)))
    for match in HEADER_SEASON_RE.finditer(text):
        seasons.update(seasons_for_label(match.group(1)))
    return [key for key in SEASON_ORDER if key in seasons]


def row_season(text: str) -> str:
    """Season declared on one rate row, for contracts with a season per row."""
    seasons: set[str] = set()
    for match in HEADER_SEASON_RE.finditer(text):
        seasons.update(seasons_for_label(match.group(1)))
    if len(seasons) == 1:
        return next(iter(seasons))
    if seasons:
        return ""
    return season_from_dates(text)


def ordered_date_seasons(rows: list[str]) -> list[str]:
    """Season per date band, in the order the contract prints the bands."""
    seasons: list[str] = []
    for row in rows:
        for part in re.split(r"[;,/]| {2,}", row):
            season = season_from_dates(part)
            if season:
                seasons.append(season)
    return seasons


def column_unit(label: str) -> str:
    """What one table column is sold in ("DOUBLE" per room, "3rd adult" per person)."""
    text = str(label or "").lower()
    if re.search(r"child|infant", text):
        return "per_child_night"
    if re.search(r"3rd|third|extra bed", text):
        return "per_extra_person_night"
    if re.search(r"per\s+person|pppn|sharing", text):
        return "per_person_night"
    if re.search(r"\bsingle\b", text):
        return "per_single_night"
    if re.search(r"double|twin|family|suite|room|tent|cottage|triple|deluxe|superior|standard", text):
        return "per_room_night"
    return ""


def header_columns_above(words_rows: list[list[dict[str, Any]]], index: int) -> list[dict[str, Any]]:
    """Occupancy column headings above one rate row, keyed by x position."""
    if not words_rows or index >= len(words_rows):
        return []
    row = words_rows[index]
    if not row:
        return []
    limit = min(float(word.get("top", 0)) for word in row)
    collected: list[dict[str, Any]] = []
    for previous in range(index - 1, max(-1, index - 12), -1):
        words = [word for word in words_rows[previous] if word]
        if not words:
            continue
        baseline = max(float(word.get("top", 0)) for word in words)
        if not re.search(r"[A-Za-z]", " ".join(str(word.get("text", "")) for word in words)):
            # A wrapped date or a stray number on its own line.
            limit = baseline
            continue
        if limit - baseline > 32:
            break
        found = [
            word
            for word in words
            if OCCUPANCY_WORD_RE.search(str(word.get("text", "")))
            and not DATE_TOKEN_RE.search(str(word.get("text", "")))
        ]
        if not found:
            # Another priced row, or a short meal-plan marker ("FB"), can sit
            # between the headings and this row.
            text = " ".join(str(word.get("text", "")) for word in words)
            if amount_cells(words) or len(text) <= 12:
                limit = baseline
                continue
            break
        collected.extend(found)
        limit = baseline
    columns: list[dict[str, Any]] = []
    for word in sorted(collected, key=lambda item: (float(item.get("x0", 0)), float(item.get("top", 0)))):
        x = float(word.get("x0", 0))
        text = str(word.get("text", "")).strip(" .,;:")
        if not text:
            continue
        if columns and abs(columns[-1]["x"] - x) <= 12:
            columns[-1]["text"] = f"{columns[-1]['text']} {text}".strip()
        else:
            columns.append({"x": x, "text": text})
    return columns


def amount_cells(words: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Bare rate cells on one row with the x position they were printed at."""
    cells: list[dict[str, Any]] = []
    for word in sorted(words, key=lambda item: float(item.get("x0", 0))):
        text = str(word.get("text", "")).strip()
        if not text or "%" in text or not re.fullmatch(r"\d[\d,]*(?:\.\d{1,2})?", text):
            continue
        if DATE_TOKEN_RE.fullmatch(text):
            continue
        value = normalize_number(text)
        if value < 5 or value > 1_000_000:
            continue
        if 2024 <= value <= 2035 and float(value).is_integer():
            continue
        cells.append({"value": value, "x": float(word.get("x0", 0))})
    return cells


def match_amounts_to_columns(cells: list[dict[str, Any]], columns: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Pair each printed rate with the occupancy column printed above it."""
    if not cells or not columns:
        return []
    matched = []
    for cell in cells:
        column = min(columns, key=lambda item: abs(float(item["x"]) - cell["x"]))
        if abs(float(column["x"]) - cell["x"]) > 40:
            return []
        unit = column_unit(column["text"])
        if not unit:
            return []
        matched.append({"value": cell["value"], "label": column["text"], "unit": unit})
    return matched


def format_season_label(label: str) -> str:
    text = re.sub(r"\s+", " ", str(label or "")).strip()
    return text[:1].upper() + text[1:].lower() if text else ""


def is_season_only(text: str) -> bool:
    remainder = re.sub(
        r"(?i)\b(?:peak|high|shoulder|standard|low|festive|green)\s*season\b", " ", text
    )
    remainder = re.sub(r"[^A-Za-z]", "", remainder)
    return len(remainder) < 3


def looks_like_section(text: str, amounts: list[float], labels: list[str]) -> bool:
    if amounts or labels:
        return False
    if not (2 <= len(text) <= 60):
        return False
    if not re.search(r"[A-Za-z]", text):
        return False
    if MONTH_RE.search(text) or re.search(r"\d", text):
        return False
    if text.endswith(":") or PROSE_RE.search(text) or SKIP_LINE_RE.search(text):
        return False
    if text.lower().strip(" .-–—") in SECTION_STOPWORDS:
        return False
    if text.endswith(".") or text[:1].islower():
        return False
    words = text.split()
    if len(words) > 5:
        return False
    if not (text.isupper() or re.search(
        r"(?i)\b(?:night|package|supplement|extra|option|stay|offer|included|excluded"
        r"|camp|lodge|hotel|resort|suite|room|tent|villa|property|conservancy)\b",
        text,
    )):
        return False
    return text.isupper() or 2 <= len(words) <= 3


def build_candidates(
    rows: list[str],
    page_number: int,
    page_default_currency: str,
    tops: list[float] | None = None,
    header_blocks: list[dict[str, Any]] | None = None,
    words_rows: list[list[dict[str, Any]]] | None = None,
) -> list[dict[str, Any]]:
    candidates: list[dict[str, Any]] = []
    season_columns: list[str] = []
    header_fee = False
    header_open = False
    date_context: list[str] = []
    section_context = ""
    label_context = ""
    table_title = ""
    table_title_index = -99
    residency_context = ""

    for index, line in enumerate(rows):
        stripped = line.strip()
        if not stripped:
            continue
        row_top = tops[index] if tops and index < len(tops) else None

        amounts, line_currency, has_currency = amounts_from_line(stripped)
        labels = season_labels_from_text(stripped)

        # Season-per-row tables price each printed band on its own row, and their
        # columns are occupancies ("SINGLE DOUBLE THIRD BED", "Per Person in twin").
        # Place every amount under the heading printed above its x position.
        band_matches: list[dict[str, Any]] = []
        band_span: list[str] = []
        row_band = ""
        row_words = words_rows[index] if words_rows and index < len(words_rows) else []
        if amounts and row_words and BAND_LEAD_RE.match(stripped):
            cells = amount_cells(row_words)
            matched = match_amounts_to_columns(cells, header_columns_above(words_rows, index))
            if matched:
                band = " ".join(
                    str(word.get("text", ""))
                    for word in sorted(row_words, key=lambda item: float(item.get("x0", 0)))
                    if float(word.get("x0", 0)) < cells[0]["x"]
                )[:120]
                band_span = band_seasons(band)
                if band_span:
                    row_band, band_matches = band, matched

        if band_matches:
            # Each column can be sold differently, so only claim one unit when they agree.
            band_units = {item["unit"] for item in band_matches}
            first_unit = band_matches[0]["unit"] if len(band_units) == 1 else ""
            # Keep the room or property the table is for ("PARK VIEW ROOMS"), so four
            # prices in one band are not all described as the same room.
            title = table_title if index - table_title_index <= 10 else ""
            residency = detect_residency(row_band, stripped)
            if residency == "unknown":
                residency = residency_context or "unknown"
            candidates.append(
                {
                    "id": f"cand-{page_number}-{index}-{hashlib.sha1(stripped.encode('utf-8')).hexdigest()[:6]}",
                    "page": page_number,
                    "raw": stripped,
                    "description": clean_description(
                        " — ".join(part for part in (title, row_band) if part), []
                    ),
                    "amounts": [item["value"] for item in band_matches],
                    "amountLabels": [item["label"] for item in band_matches],
                    "amountSeasons": [band_span for _ in band_matches],
                    "amountColumns": [item["label"] for item in band_matches],
                    "amountUnits": [item["unit"] for item in band_matches],
                    "seasonSource": "row",
                    "currency": line_currency or page_default_currency or "USD",
                    "unit": first_unit,
                    "unitLabel": UNIT_LABELS.get(first_unit, first_unit) if first_unit else "Per printed column",
                    "seasonHint": row_band,
                    "confidence": "medium" if page_default_currency else "low",
                    "residency": residency,
                }
            )
            continue

        # Column headings are collected in print order. A separate "conservancy
        # fees" heading means the last amount column is a fee, not a season.
        header_columns = header_season_columns(stripped) if not amounts else []
        if header_columns:
            # Prefer the headings' x positions: that is the order the table prints
            # its columns in. Without coordinates, a wrapped header adds its
            # remaining headings one row at a time.
            placed = merge_header_blocks(header_blocks or [], row_top)
            if placed:
                if not season_columns or len(placed) >= len(season_columns):
                    season_columns = placed
                    header_open = False
            elif header_open and len(header_columns) == 1:
                season_columns += [item for item in header_columns if item not in season_columns]
            else:
                season_columns = list(header_columns)
                header_open = True
            header_fee = bool(FEE_WORD_RE.search(stripped))
        elif not amounts and season_columns and len(stripped) < 60 and FEE_WORD_RE.search(stripped):
            header_fee = True
        if amounts:
            header_open = False

        # A label ending in a colon (e.g. "Executive Suite Supplement:")
        # describes the rate row that follows it.
        if not amounts and stripped.endswith(":") and 3 <= len(stripped) <= 100:
            label_context = stripped.rstrip(":")

        if (
            MONTH_RE.search(stripped)
            and re.search(r"\d", stripped)
            and not amounts
            and len(stripped) < 90
            and not re.search(r"issue|valid|page|date", stripped, re.I)
        ):
            date_context = (date_context + [stripped])[-2:]

        if looks_like_section(stripped, amounts, labels):
            section_context = stripped
            label_context = ""

        if not amounts:
            if len(stripped) <= 100 and re.search(
                r"(?i)contract|agreement|rates|tariff", stripped
            ) and re.search(r"(?i)\b(?:non[-\s]?)?residents?\b", stripped):
                residency_context = detect_residency(stripped)
            # A table's title names the property or room it prices. Wrapped column
            # headings ("Plan Person in … room", "Suite") are not titles.
            if (
                len(stripped) <= 80
                and len(stripped.split()) >= 2
                and re.search(r"(?i)rooms?\b|suites?\b|lodge|camp\b|resort|villa|cottage|tent\b|banda|chalet", stripped)
                and not re.search(r"(?i)\b(?:per|person|plan|adult|sharing|child|meal)\b", stripped)
            ):
                table_title = stripped.rstrip(":")
                table_title_index = index

        if len(stripped) < 5 or SKIP_LINE_RE.search(stripped):
            continue
        if not re.search(r"[A-Za-z]", stripped):
            continue
        if not amounts:
            continue

        # Date/season header rows (e.g. "1 Jul – 30 Sept, 5 Jan – 28 Feb")
        # can produce bare numbers that look like rates.  Keep them as context
        # instead of turning them into quote lines.
        month_count = len(MONTH_RE.findall(stripped))
        if not has_currency and month_count >= 1:
            date_like = bool(re.search(r"\d\s*(?:–|-|to)\s*\d|\d{1,2}[./-]\d{1,2}", stripped))
            if month_count >= 2 or date_like:
                continue

        # Rows that are only a date table or a rate footnote are noisy.
        if re.fullmatch(r"[\d\s.,%/|–—-]+", stripped):
            continue

        # "Rack:" / "Margin:" rows repeat the previous net rate.  Skip them
        # unless there is a genuine net amount before the rack label.
        rack = re.search(r"\b(?:Rack|Margin)\s*:", stripped, re.I)
        if rack:
            before = stripped[: rack.start()]
            if not re.search(r"(?:US\$|USD|KES|KSh|EUR|GBP|€|£|\$)\s*\d", before, re.I):
                continue

        # Long prose sentences occasionally contain numbers.  Only keep them
        # when they carry an explicit currency amount.
        if PROSE_RE.search(stripped) and (not has_currency or len(stripped) > 100):
            continue

        description_source = re.split(r"\bRack\s*:", stripped, maxsplit=1, flags=re.I)[0]
        description = clean_description(description_source, amounts)
        if len(description) < 3:
            continue
        if re.fullmatch(
            r"(?i)(?:rate|rates|price|prices|amount|cost|per|night|day|adult|child|sharing|single)",
            description,
        ):
            continue

        used_label = False
        if label_context and is_season_only(description):
            description = label_context
            used_label = True
        elif label_context and label_context.lower() not in description.lower():
            description = f"{label_context} — {description}"
            used_label = True

        if section_context and not used_label and section_context.lower() not in description.lower():
            description = f"{section_context} — {description}"

        next_row = rows[index + 1] if index + 1 < len(rows) else ""
        age = re.search(r"\bAges?\s*(\d{1,2}\s*[-–]\s*\d{1,2})", next_row, re.I)
        if age and re.search(r"\bchild", description, re.I) and "age" not in description.lower():
            description = f"{description} (Ages {age.group(1)})"
        if used_label:
            label_context = ""

        nearby = " ".join(rows[max(0, index - 1): min(len(rows), index + 3)])
        unit = (
            unit_from_text(stripped)
            or unit_from_text(next_row)
            or unit_from_text(nearby)
            or unit_from_text(section_context)
            or unit_from_text(label_context)
        )
        if not unit:
            if re.search(r"\b(?:sharing|single|suite|tent|room|villa|cabin)\b", description, re.I):
                unit = "per_person_night" if re.search(r"\b(?:night|per person)\b", nearby, re.I) else "per_person"
            elif not has_currency and not RATE_KEYWORD_RE.search(stripped):
                continue
            else:
                unit = "per_person"

        amount_labels: list[str] = []
        amount_seasons: list[list[str]] = []
        amount_columns: list[str] = []
        season_source = "none"
        single = ""
        if len(amounts) > 1:
            columns = list(season_columns)
            if columns and header_fee and len(columns) == len(amounts) - 1:
                columns.append("Conservancy fees")
            if len(columns) > len(amounts):
                columns = columns[: len(amounts)]
            if len(columns) == len(amounts):
                season_source = "header"
            else:
                # No readable headings: fall back to the printed date bands, still
                # in the order they appear on the contract.
                dated = ordered_date_seasons(date_context)
                if dated and header_fee and len(dated) == len(amounts) - 1:
                    dated.append("")
                if len(dated) == len(amounts):
                    columns = [format_season_label(item) if item else "" for item in dated]
                    season_source = "dates"
                else:
                    columns = []
            if not columns:
                # Season-per-row tables: one heading prices every amount on the row.
                single = row_season(stripped)
                if single:
                    columns = [""] * len(amounts)
                    season_source = "row"
                    amount_seasons = [[single] for _ in amounts]
            for index in range(len(amounts)):
                label = columns[index] if index < len(columns) else ""
                if label and FEE_WORD_RE.search(label):
                    label = "Conservancy fees"
                    seasons: list[str] = []
                elif label:
                    seasons = seasons_for_label(label)
                else:
                    seasons = []
                display = format_season_label(label) if label else f"Column {index + 1}"
                amount_labels.append(display)
                if season_source == "row":
                    amount_seasons.append([single])
                else:
                    amount_seasons.append(seasons)
                amount_columns.append(f"{display} (column {index + 1})")
        elif len(amounts) == 1:
            amount_seasons = [[]]
            amount_columns = ["Column 1"]

        hint_parts = []
        if amount_labels:
            hint_parts.extend(amount_labels)
        elif season_columns:
            hint_parts.append(", ".join(season_columns))
        if date_context:
            hint_parts.append(" / ".join(date_context))
        season_hint = " · ".join(part for part in hint_parts if part)[:240]

        currency = line_currency or page_default_currency or "USD"
        if has_currency and unit:
            confidence = "high"
        elif unit and page_default_currency:
            confidence = "medium"
        else:
            confidence = "low"

        candidates.append(
            {
                "id": f"cand-{page_number}-{index}-{hashlib.sha1(stripped.encode('utf-8')).hexdigest()[:6]}",
                "page": page_number,
                "raw": stripped,
                "description": description,
                "amounts": amounts,
                "amountLabels": amount_labels,
                "amountSeasons": amount_seasons,
                "amountColumns": amount_columns,
                "seasonSource": season_source,
                "currency": currency,
                "unit": unit,
                "unitLabel": UNIT_LABELS.get(unit, unit),
                "seasonHint": season_hint,
                "confidence": confidence,
                "residency": detect_residency(description, stripped, season_hint),
            }
        )

    # Deduplicate rows repeated by PDF layout quirks.
    seen: set[tuple[Any, ...]] = set()
    deduped = []
    for candidate in candidates:
        key = (
            candidate["page"],
            candidate["description"].lower(),
            tuple(candidate["amounts"]),
        )
        if key in seen:
            continue
        seen.add(key)
        deduped.append(candidate)
    return deduped


def extract_pdf(file_path: Path, meta: dict[str, Any]) -> dict[str, Any]:
    if pdfplumber is None:
        raise RuntimeError("PDF extraction needs pdfplumber. Run: python3 -m pip install -r requirements.txt")

    pages_out = []
    all_candidates = []
    scanned_pages = 0
    with pdfplumber.open(str(file_path)) as pdf:
        total_pages = len(pdf.pages)
        limit = min(total_pages, MAX_PAGES)
        for index in range(limit):
            page = pdf.pages[index]
            text = page_text(page)
            if len(text.strip()) < 20:
                scanned_pages += 1
            default_currency = currency_from_text(text) or "USD"
            rows, tops, words_rows = extract_rows_from_page(page)
            candidates = build_candidates(
                rows,
                index + 1,
                default_currency,
                tops=tops,
                header_blocks=season_header_blocks(page),
                words_rows=words_rows,
            )
            all_candidates.extend(candidates)
            pages_out.append(
                {
                    "page": index + 1,
                    "text": text[:25000],
                    "rows": rows[:400],
                    "candidateCount": len(candidates),
                }
            )

    file_kind = detect_residency(meta.get("name", ""), meta.get("supplier", ""), meta.get("path", ""))
    if file_kind != "unknown":
        for candidate in all_candidates:
            if candidate.get("residency") == "unknown":
                candidate["residency"] = file_kind

    return {
        "file": {
            **meta,
            "pages": total_pages,
            "extractedPages": len(pages_out),
            "scannedPages": scanned_pages,
            "sizeLabel": human_size(int(meta.get("size") or file_path.stat().st_size)),
        },
        "pages": pages_out,
        "candidates": all_candidates,
        "notes": (
            "No text layer was found on some pages. Those pages may be scanned images; "
            "open the PDF and add rates manually."
            if scanned_pages and scanned_pages >= max(1, len(pages_out) // 2)
            else ""
        ),
    }


def extract_xlsx(file_path: Path, meta: dict[str, Any]) -> dict[str, Any]:
    if openpyxl is None:
        raise RuntimeError("Excel extraction needs openpyxl. Run: python3 -m pip install -r requirements.txt")

    workbook = openpyxl.load_workbook(str(file_path), data_only=True, read_only=True)
    pages_out = []
    all_candidates = []
    page_number = 0
    for sheet in workbook.worksheets:
        page_number += 1
        rows: list[str] = []
        for row in sheet.iter_rows(values_only=True):
            cells = [str(value).strip() for value in row if value is not None and str(value).strip()]
            if cells:
                rows.append(" | ".join(cells))
        text = "\n".join(rows)
        default_currency = currency_from_text(text) or "USD"
        candidates = build_candidates(rows, page_number, default_currency)
        all_candidates.extend(candidates)
        pages_out.append(
            {
                "page": page_number,
                "name": sheet.title,
                "text": text[:25000],
                "rows": rows[:400],
                "candidateCount": len(candidates),
            }
        )
    workbook.close()
    file_kind = detect_residency(meta.get("name", ""), meta.get("supplier", ""), meta.get("path", ""))
    if file_kind != "unknown":
        for candidate in all_candidates:
            if candidate.get("residency") == "unknown":
                candidate["residency"] = file_kind

    return {
        "file": {
            **meta,
            "pages": len(pages_out),
            "extractedPages": len(pages_out),
            "scannedPages": 0,
            "sizeLabel": human_size(int(meta.get("size") or file_path.stat().st_size)),
        },
        "pages": pages_out,
        "candidates": all_candidates,
        "notes": "",
    }


def get_cached_file(inventory: dict[str, Any], meta: dict[str, Any]) -> Path:
    path = meta["path"]
    ext = meta.get("ext") or Path(meta.get("name", "")).suffix.lstrip(".").lower()
    cached = CACHE_DIR / cache_name(path, ext)
    if cached.exists() and cached.stat().st_size > 0:
        return cached

    client = OneDriveClient(inventory.get("shareUrl") or DEFAULT_SHARE_URL)
    client.redeem()
    client.download(path, cached)
    return cached


def extract_file(inventory: dict[str, Any], path: str) -> dict[str, Any]:
    meta = find_file(inventory, path)
    if not meta:
        raise ValueError("That file is not in the synced contract library.")
    ext = (meta.get("ext") or "").lower()

    cache_key = hashlib.sha1(
        (
            EXTRACTION_VERSION
            + "|"
            + path
            + "|"
            + str(meta.get("size") or "")
            + "|"
            + str(meta.get("modified") or "")
        ).encode("utf-8")
    ).hexdigest()
    extraction_cache = CACHE_DIR / f"extract-{cache_key}.json"
    if extraction_cache.exists():
        try:
            with open(extraction_cache, "r", encoding="utf-8") as fh:
                return json.load(fh)
        except Exception:
            pass

    if ext not in ("pdf", "xlsx"):
        raise ValueError("Rate extraction works with PDF and XLSX contracts. Use Download to open this file.")

    file_path = get_cached_file(inventory, meta)
    if ext == "pdf":
        result = extract_pdf(file_path, meta)
    else:
        result = extract_xlsx(file_path, meta)

    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    try:
        with open(extraction_cache, "w", encoding="utf-8") as fh:
            json.dump(result, fh, ensure_ascii=False)
    except Exception:
        pass
    return result


# ---------------------------------------------------------------------------
# Condensed rates for the budget planner
# ---------------------------------------------------------------------------

MAX_RATE_ITEMS = 24
MAX_RATE_PATHS = 2
MAX_RATE_CANDIDATES = 160


def summarize_rates(result: dict[str, Any]) -> list[dict[str, Any]]:
    """Keep only what a rate list needs: amounts, labels and validity."""
    rows: list[dict[str, Any]] = []
    for candidate in result.get("candidates") or []:
        amounts = candidate.get("amounts") or []
        if not amounts:
            continue
        rows.append(
            {
                "description": candidate.get("description") or "",
                "amounts": amounts,
                "amountLabels": candidate.get("amountLabels") or [],
                "amountSeasons": candidate.get("amountSeasons") or [],
                "amountColumns": candidate.get("amountColumns") or [],
                "amountUnits": candidate.get("amountUnits") or [],
                "seasonSource": candidate.get("seasonSource") or "none",
                "currency": candidate.get("currency") or "",
                "unit": candidate.get("unit") or "",
                "unitLabel": candidate.get("unitLabel") or "",
                "seasonHint": candidate.get("seasonHint") or "",
                "residency": candidate.get("residency") or "unknown",
                "page": candidate.get("page") or 0,
            }
        )
        if len(rows) >= MAX_RATE_CANDIDATES:
            break
    return rows


def rates_for_item(inventory: dict[str, Any], item: dict[str, Any]) -> dict[str, Any]:
    paths = [path for path in (item.get("paths") or []) if isinstance(path, str)][:MAX_RATE_PATHS]
    files: list[dict[str, Any]] = []
    errors: list[str] = []
    for path in paths:
        if not validate_file_path(inventory, path):
            errors.append("That file is not in the synced contract library.")
            continue
        try:
            result = extract_file(inventory, path)
        except Exception as exc:  # a single bad contract should not fail the batch
            errors.append(str(exc))
            continue
        meta = result.get("file") or {}
        files.append(
            {
                "name": meta.get("name") or Path(path).name,
                "path": path,
                "candidates": summarize_rates(result),
                "notes": result.get("notes") or "",
            }
        )
    return {
        "key": str(item.get("key") or ""),
        "name": str(item.get("name") or ""),
        "location": str(item.get("location") or ""),
        "files": files,
        "errors": errors,
    }


# ---------------------------------------------------------------------------
# HTTP server
# ---------------------------------------------------------------------------

class Handler(BaseHTTPRequestHandler):
    server_version = "SafariQuote/1.0"

    def log_message(self, fmt: str, *args: Any) -> None:
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_GET(self) -> None:
        parsed = urllib.parse.urlparse(self.path)
        path = urllib.parse.unquote(parsed.path)
        query = urllib.parse.parse_qs(parsed.query)

        try:
            if path == "/api/status":
                inventory = load_inventory()
                json_response(
                    self,
                    200,
                    {
                        "ok": True,
                        "serverTime": utc_now(),
                        "pdfSupport": pdfplumber is not None,
                        "xlsxSupport": openpyxl is not None,
                        "inventory": inventory,
                    },
                )
                return

            if path == "/api/file":
                file_path = (query.get("path") or [""])[0]
                inventory = load_inventory()
                if not validate_file_path(inventory, file_path):
                    error_response(self, 403, "Invalid file path.")
                    return
                meta = find_file(inventory, file_path)
                if not meta:
                    error_response(self, 404, "File not found in the synced library.")
                    return
                cached = get_cached_file(inventory, meta)
                self.serve_file(cached, meta, download=bool(query.get("download")))
                return

            if path in ("", "/"):
                path = "/index.html"
            self.serve_static(path)
        except OneDriveError as exc:
            error_response(self, 502, str(exc))
        except urllib.error.HTTPError as exc:
            error_response(self, 502, f"OneDrive returned HTTP {exc.code}.")
        except Exception as exc:
            traceback.print_exc()
            error_response(self, 500, str(exc))

    def do_POST(self) -> None:
        parsed = urllib.parse.urlparse(self.path)
        path = urllib.parse.unquote(parsed.path)
        try:
            if path == "/api/sync":
                body = read_json_body(self)
                share_url = str(body.get("url") or "").strip() or DEFAULT_SHARE_URL
                client = OneDriveClient(share_url)
                inventory = client.sync()
                save_inventory(inventory)
                json_response(self, 200, {"ok": True, "inventory": inventory})
                return

            if path == "/api/extract":
                body = read_json_body(self)
                file_path = str(body.get("path") or "")
                inventory = load_inventory()
                if not validate_file_path(inventory, file_path):
                    error_response(self, 403, "Invalid file path.")
                    return
                result = extract_file(inventory, file_path)
                json_response(self, 200, {"ok": True, **result})
                return

            if path == "/api/rates":
                body = read_json_body(self)
                items = body.get("items")
                if not isinstance(items, list) or not items:
                    raise ValueError("Send at least one item to read rates for.")
                clean_items = [item for item in items if isinstance(item, dict)][:MAX_RATE_ITEMS]
                inventory = load_inventory()
                with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
                    results = list(pool.map(lambda item: rates_for_item(inventory, item), clean_items))
                json_response(self, 200, {"ok": True, "items": results})
                return

            error_response(self, 404, "Unknown API endpoint.")
        except OneDriveError as exc:
            error_response(self, 502, str(exc))
        except urllib.error.HTTPError as exc:
            error_response(self, 502, f"OneDrive returned HTTP {exc.code}.")
        except Exception as exc:
            traceback.print_exc()
            error_response(self, 500, str(exc))

    def serve_static(self, request_path: str) -> None:
        rel = request_path.lstrip("/")
        target = (BASE_DIR / rel).resolve()
        if BASE_DIR not in target.parents and target != BASE_DIR:
            error_response(self, 403, "Invalid path.")
            return
        if target.is_dir():
            target = target / "index.html"
        if not target.exists() or not target.is_file():
            error_response(self, 404, "Not found.")
            return

        mime = mimetypes.guess_type(str(target))[0] or "application/octet-stream"
        if target.suffix == ".js":
            mime = "text/javascript"
        if target.suffix == ".css":
            mime = "text/css"
        if target.suffix == ".html":
            mime = "text/html"
        if target.suffix == ".svg":
            mime = "image/svg+xml"

        with open(target, "rb") as fh:
            data = fh.read()
        self.send_response(200)
        self.send_header("Content-Type", mime + ("; charset=utf-8" if mime.startswith("text/") or mime in ("application/javascript", "text/javascript") else ""))
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(data)

    def serve_file(self, file_path: Path, meta: dict[str, Any], download: bool = False) -> None:
        mime = mimetypes.guess_type(str(file_path))[0] or "application/octet-stream"
        if meta.get("ext") == "pdf":
            mime = "application/pdf"
        disposition = "attachment" if download else "inline"
        filename = meta.get("name") or file_path.name
        quoted = urllib.parse.quote(filename)
        with open(file_path, "rb") as fh:
            size = os.fstat(fh.fileno()).st_size
            self.send_response(200)
            self.send_header("Content-Type", mime)
            self.send_header("Content-Length", str(size))
            self.send_header(
                "Content-Disposition",
                f"{disposition}; filename*=UTF-8''{quoted}",
            )
            self.send_header("Cache-Control", "private, max-age=3600")
            self.end_headers()
            shutil.copyfileobj(fh, self.wfile, length=1024 * 256)


def main() -> None:
    parser = argparse.ArgumentParser(description="Safari Quote local server")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    mimetypes.add_type("application/pdf", ".pdf")
    mimetypes.add_type("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ".xlsx")

    httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"Safari Quote is running at http://{args.host}:{args.port}")
    print("Press Ctrl+C to stop.")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping.")
    finally:
        httpd.server_close()


if __name__ == "__main__":
    main()

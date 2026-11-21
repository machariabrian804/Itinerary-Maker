# Safari Quote

A local itinerary quote builder for contract rates from the public OneDrive folder
**27年合同 肯尼亚**. It browses the supplier contracts, extracts rate candidates from
PDF and Excel files, and builds a marked-up client quotation.

Default markup: **10%** (editable per quote and per line).

## Quick start

```bash
cd /Users/sparkle/Documents/Yobra/Itinerery
python3 -m venv .venv
source .venv/bin/activate
python3 -m pip install -r requirements.txt
python3 server.py
```

Open **http://127.0.0.1:8765**.

The quote builder and printing work even if you open `index.html` directly, but the
rate library, file previews and extraction need the local server.

## How it works

1. **Quote builder** — set client, destination, dates, party size, currency and markup.
   Add lines manually or from the rate library. Every line has a basis, units and a
   nights/days multiplier, so per-person, per-room, per-group and per-vehicle rates all
   calculate correctly. A line can override the quote markup.
2. **Rate library** — the app ships with an inventory of the OneDrive folder
   (`data/inventory.json`). Pick a supplier and contract file, then **Extract rates**.
   The server downloads that one file, reconstructs visual rows from the PDF, and
   proposes rate candidates with season labels, currency and unit hints. Add any amount
   to the quote with one click. Review the candidates against the PDF; contract layouts
   vary a lot, so extraction is a shortcut, not an authority.
3. **Print / PDF** — produces a clean client-facing quotation with company details,
   itinerary lines, net/markup/total, per-person total and notes. Use the browser’s
   “Save as PDF” option for a PDF.
4. **Sync** — refreshes the supplier/file list from the public OneDrive share. It does
   not download every contract; files are fetched only when you extract a rate.

## Currency

Contract lines can be in USD, KES, EUR or GBP. The quote has one display currency, and
conversions use the editable table in **Settings → Exchange rates** (units of currency
per 1 USD). Defaults are USD 1, KES 130, EUR 0.92, GBP 0.79.

## CSV format

**Export CSV** writes a header row and one row per line. **Import CSV** accepts those
columns (header names are matched loosely):

| Column | Notes |
| --- | --- |
| Supplier | Optional |
| Description | Required |
| Basis | e.g. `per_person_night`, `per_room_night`, `per_group`; labels also work |
| Units | People, rooms, vehicles or groups |
| Nights/Days | Multiplier for night/day bases |
| Rate | Net contract rate |
| Currency | USD, KES, EUR or GBP |
| Markup % | Blank means “use the quote markup” |
| Net / Sell | Ignored on import; recalculated |
| Season | Free text, shown on the quote |
| Notes | Free text |
| Source | Contract file and page |

Import asks whether to **replace** the current lines (OK) or **append** (Cancel).

## Data and privacy

Quotes, settings and FX rates live in this browser’s `localStorage`. Use
**Settings → Export backup** before clearing browser data or moving machines.
Contract files are cached under `cache/` after extraction. Nothing is sent anywhere
except requests to the public OneDrive share.

## Notes on extraction

- The folder contains 136 supplier folders and 352 files (327 PDFs), with very
  different layouts. The extractor groups words into visual rows, recognises common
  season headers, units and currencies, and filters prose/footnote noise.
- Scanned image-only PDFs have no text layer. The app will say so; open the file and
  add the rate manually.
- The server reads the public share anonymously. If the share link is rotated or
  revoked, update it in **Settings → OneDrive library** and sync again.

## Files

```
index.html            single-page app shell
styles.css            visual system and print layout
app.js                quote engine, rate library, CSV, persistence
server.py             static server + OneDrive sync + PDF/XLSX extraction
data/inventory.json   supplier/file inventory
data/inventory.js     same inventory for file:// use
requirements.txt      pdfplumber, openpyxl
cache/                downloaded contracts and extraction cache (gitignored)
```

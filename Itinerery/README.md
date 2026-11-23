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
   Use the **Trip planner** to enter the number of days, choose **Resident** or
   **Non-resident**, and add each location with its nights. The planner suggests
   hotels/contracts for the active location and guest type. Add lines manually or from
   the rate library. Every line has a basis, units and a nights/days multiplier, so
   per-person, per-room, per-group and per-vehicle rates all calculate correctly. A line
   can override the quote markup.
2. **Itinerary framework** — the agency planning aid, and the only place an itinerary is
   built: the **Places visited** list sits inside this panel, under the framework it fills.
   Enter the nights, the **Season** (any, high, shoulder or low), pick the areas the
   clients want (or let **Suggest for these nights** choose a circuit — it also fills the
   **Places visited** list with that circuit and its nights) and the market tier
   — **Budget**, **Mid-range** or **Luxury**. **Build framework** places the nights where
   they belong: the Mara gets 3 (min 2, max 4), Amboseli 2, Naivasha, Nakuru and Nairobi 1,
   and the areas are ordered along a real circuit that avoids backtracking: Nairobi, then
   the southern leg (Amboseli → Tsavo), then the Rift Valley (Naivasha → Nakuru), then the
   north (Mount Kenya → Meru → Samburu → Laikipia), then the Mara as the finale, with the
   coast last. When a beach is in the trip, Tsavo moves to the coast leg (after the Mara)
   because it sits on the Mombasa road — that is the one stop whose position depends on the
   rest of the circuit. It then reads the net contract rates and prices each stay in the
   chosen season. Contracts print their rates in three shapes, and all three are read:

   - **One season per column** — the common case. The headings are read **in the order the
     table prints them** (low, mid, high, or high, peak, low — whatever the page does), from
     their x positions, and a trailing conservancy-fee column stays out of the season
     columns. When the headings are missing, the dates printed beside the table give the
     column order.
   - **One season per row** (Salt Lick: "High Season: (02 Jan–31 Mar 2027 …) 326 435 131").
     The dates in the band decide the season, so a band covering two of our seasons prices
     both: January is quoted from that row because it is the row the contract prints for
     January.
   - **A numeric date table** (Mara Sweet Acacia's "3/1/2027 31/3/2027 200 150 …", Sawela
     Naivasha's "01/04/2027 30/06/2027 130 170 …"). Each row is one date band, and the
     occupancy headings above it say what each amount is sold as — double, twin or family
     per room, "per person in twin" per person, "3rd adult" or child per extra person,
     single occupancy only when one guest travels.

   Resident and non-resident sections of the same PDF are kept apart, so a resident KES
   table never prices a non-resident quote, and a contract that prices several properties
   (Salt Lick's rack-rate PDF also carries Taita Hills) only prices the hotel it is filed
   under. Each stay shows which contract column priced it
   ("Priced from High season (column 2)"), so a rate is never quietly taken from another
   season: if the contract prints no column for the chosen season, the stay falls back to
   the one it does print and both the stay and the plan flag it. It then picks
   a hotel per area at the requested tier and lists the room categories each contract sells
   — B&B, half board, full board, all inclusive, suites — with their per-person prices. A
   room-category dropdown switches the stay (each option names its season), and an optional
   budget cap steps the tier down until the total fits. Every stay also shows the other hotels that were read in
   that area. A place typed into the itinerary also selects its area among the areas the
   clients want, so the two lists stay in step. **Use this framework** writes the stops and lines into the quote — one line per
   stay, per person per night on the adults sharing, the way agencies quote — and your
   markup is applied. Children are not priced in the framework; take child rates from the
   same contract page. Accommodation rates only — transfers, park fees and flights are not
   included.

   Tier bands are per person per night on the contract rates: Budget under US$250,
   Mid-range US$250–650, Luxury above US$650. When an area has no contract in the
   requested band, the nearest available hotel is used and the plan says so.
3. **Hotels sorted by location** — every supplier is filed under the area it serves
   (Masai Mara, Amboseli, Naivasha, Diani…), both in the rate library and in the planner
   matches. Use the location filter in the rate library to see one area at a time.
4. **Rate library** — the app ships with an inventory of the OneDrive folder
   (`data/inventory.json`). Pick a supplier and contract file, then **Extract rates**.
   The server downloads that one file, reconstructs visual rows from the PDF, and
   proposes rate candidates with season labels, currency, residency and unit hints.
   Extracted rates are filtered to the quote’s guest type by default; use the
   **Resident only / Non-resident only** toggle to show all rates. Add any amount to
   the quote with one click. Review the candidates against the PDF; contract layouts
   vary a lot, so extraction is a shortcut, not an authority.
5. **Print / PDF** — produces a clean client-facing quotation with company details,
   the places visited in visiting order (day range and nights for each stop), the
   itinerary lines, net/markup/total, per-person total and notes. Use the browser’s
   “Save as PDF” option for a PDF.
6. **Sync** — refreshes the supplier/file list from the public OneDrive share. It does
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

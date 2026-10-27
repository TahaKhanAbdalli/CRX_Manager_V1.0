# Quoting flexibility: what last season's quotes need from CRX

**Status: BRAINSTORM 2026-10-26. NOT RANKED, NOT STARTED.** Nothing here is approved to build. Mason ranks
these items, then they go into `docs/manual/TO_DO_LIST.md` section 1 as rows.

**Source material.** Mason's Google Sheets quoting workbook, which he uses for about 95% of his quoting and
which has Apps Script behind it. The downloaded copy is saved at
`C:\Users\mason\Desktop\CRX Manager Quoting Excel Sheet\TESTING FOR REBUILDING SPREADSHEET  (1).xlsx`. The
live sheet is `https://docs.google.com/spreadsheets/d/1t48m-n3csfkQgT44zZYAsuXfjPOp-tFNhNmbuMUoqpU`. The
`.xlsx` doesn't include the Apps Script code, so this brainstorm was built from the sheet layout and data only.
The workbook has 59 tabs: about 45 quotes sent to growers for 2026 (Yeley, Retro Farms, Schutte, Nowaskie,
Jude Holscher, Page Farms, Hills, Newlin, Tuttle and others), plus `PRODUCT_MASTER` (598 products),
`PRICE_HISTORY`, `INGREDIENT_MAP`, `UNIT_CONVERSION`, a `Price Comparison Matrix` (branded vs. generic build),
a `Notes` tab (vendor positioning) and a customer-facing `Chemical Price List - Pass out`.

**App side.** Checked against `main` on 2026-10-26: `src/pages/QuoteBuilder.tsx`, `src/lib/quotePdf.ts`,
`src/lib/quoteCalc.ts`, `src/pages/CropPrograms.tsx`, `src/pages/BrandVsGeneric.tsx` and the `quotes`,
`quote_sections`, `quote_items`, `quote_versions` and `quote_templates` tables.

**How this fits the existing plan.** The approved to-do list already covers quote *price safety*: 1.2 (sent
quotes keep their prices), 1.3 (line identity), 0.3 (last price charged to this customer), 0.5 (cost beside
each line) and 1.6–1.12. This document covers the other half Mason raised: **organizing a quote by timing and
category, and having room to put his agronomy knowledge in it.** None of the items below duplicates those rows.

---

## 1. How Mason actually builds a quote (from the sheets)

Every grower quote follows the same shape:

1. **Grouped by crop, then by application timing.** Section headers such as "Corn Pre-Emerge", "Corn Post
   Emerge Chemical", "Soybean Post 20GPA", "Corn In-Furrow 3.5GPA Fertilizer Blend", "Corn 2x2 Options",
   "Corn Side-Dress with UAN and ATS", "R2-R3 Timing Nutritional Pass", "Soybean planter box Talc
   replacement", "Corn Fungicide".
2. **A recommended program, then alternatives.** "Recommended" comes first with its own $/acre subtotal,
   followed by "Other Options" or "Option #2" (Yeley: "Other Options Corn Fungicide"; Evan Tingley: Halex GT
   as branded, then two generic builds at $18.82 and $17.08/acre against $24.16 branded). The grower picks
   one option; the alternatives aren't meant to be added up.
3. **A $/acre subtotal for each section** ("--- $29.98 Acre ---"), because that's how growers compare
   programs.
4. **Mason's own knowledge on nearly every line:**
   - premix breakdowns: "4 pt = 1.09 pt Dual Magnum + 3.34 oz Callisto + 33.44 oz 5.4# Glyphosate";
   - rate conversions: "Liquid Metribuzin 7.5 oz liquid = 5 oz dry", "old Liberty × 0.674 = Liberty Ultra
     rate";
   - performance opinions: "Lucento has been a great performer in our tests vs Miravis Top";
   - money terms: "can be financed @ 2.9% APR", "0% Finance due Nov 2026", "10% cash discount through
     TrueChoice";
   - packaging rules: "NO RETURN, FULL TOTE", "can work with pallet quantities".
5. **Free-text rows with no product**: "We do not carry Weedmaster…", "Example: 20 lb Elemental Sulfur +
   75 lb Potash, 25 lb MAP", "Still waiting on some Fulvic pricing from other suppliers".
6. **The same product in several pack sizes side by side** (Bulk, 2.5 gal, no-return 265 gal tote) so the
   grower sees the price break.
7. **Working copy and sent copy**: "Jude Chemical" / "Sent Jude Chemical", "Nowaskie Recommended Programs"
   / "SENT NOWASKI REC", and "Copy of…" tabs.
8. **Changes after sending**, written into the sheet: Retro Farms, "4/2/26: switching acres to corn: 235
   acres, beans: 365 acres".
9. **Last year next to this year**: "John Yeley Last Year Programs", "Retro Farms Current Program" vs.
   "Retro Farms – Our Recommended Program".
10. **Private knowledge that never goes to the grower** (`Notes` tab): "Don't price Corteva products, we
    are not in a good position", "FMC sitting really good on Anthem MAXX, Fierce MTZ", "Lead with Volley ATZ
    Lite, Fearless 5.6".
11. **A general price list** handed out to anyone ("December 2025 Chemical Pricing … pricing good until
    12/24 … call Mason or Chance"), not tied to one grower.
12. **Rates written per 100 gallons** ("17 lb/100 Gal", "2 qt/100 Gal") that Mason turns into a per-acre
    amount by hand for the spray volume.

## 2. What the app already does (don't rebuild)

- **Sections** with a name, notes printed above and below the items, a needed-by date and a linked field
  that can supply acres (`quote_sections`).
- **One note per line**, with a button that fills in the product's saved quoting note
  (`products.quoting_notes`, `src/lib/quoteNotes.ts`).
- **Price override per line** with reset-to-tier, and a below-cost approval check on save (`save_quote`).
- **Rate math**: oz/acre, $/acre and units needed, with unit conversions from the `unit_conversions` table
  (`src/lib/quoteCalc.ts`).
- **Versions** (a snapshot each time it's sent) with a restore option, **templates** (save a quote's
  sections, products, rates and notes without prices), **duplicate**, **roll over to next season**, and
  **planned programs** that hold inventory.
- **Cost, profit and margin hidden** from non-admins and from the PDF, plus a "Customer view" toggle.
- **PDF and email to the grower**, with three column presets ("Program Detail", "Simple Pricing", "Summary").
- **Convert to order**, partial draw-down of a booking, and making a job from a section.

## 3. The gaps (the improvement list)

Each item gives what's missing, a sheet example, what the app does today, and a rough size (S = a day or
less, M = a few days, L = a week or more, if it gets its own pull request).

### A. Organize by timing and category

| # | Improvement | Example in the sheets | App today | Size |
|---|---|---|---|---|
| A1 | **Crop and timing on every section**, picked from a fixed list (Burndown, Pre-Emerge, Early Post, Post, In-Furrow, 2x2, Side-Dress, Foliar/R2-R3, Fungicide, Planter Box, Seed Treatment). The section name stays free text for Mason's own wording. | Every quote | A section has a name only. There's no crop or timing column on quotes, sections or lines; timing exists only on the product (`products.use_timing`). | M (database change) |
| A2 | **$/acre subtotal per section** on the screen and the PDF | "--- $29.98 Acre ---" in every section | The PDF prints one QUOTE TOTAL box (`quotePdf.ts:248-265`) and no section subtotals. The default PDF columns don't include $/acre or notes (`quotePdf.ts:84`). | S |
| A3 | **Reorder lines and sections, and move a line to another section** | Mason rearranges rows constantly | No move up/down or drag. Order is renumbered only after a delete. | M |
| A4 | **Acres per section** that fill every line in it (typed, not only from a linked field) | Retro: corn post 350 ac, soybean post 255 ac, side-dress 365 ac | A section can take acres from a linked field. Otherwise acres are typed line by line. | S |
| A5 | **Sort or group the PDF by crop → timing** automatically, with a one-page "program summary" ($/acre per timing per crop, then the grand total) | How growers compare programs | No summary page | M (after A1, A2) |

### B. Recommended program vs. other options

| # | Improvement | Example in the sheets | App today | Size |
|---|---|---|---|---|
| B1 | **Option groups inside a section.** Mark one group "Recommended" and the others "Option 2", "Option 3", each with its own $/acre. Only the recommended group (or the one the grower picks) counts toward the quote total. | Evan Tingley: Halex GT branded $24.16 vs. generic build #1 $18.82 vs. #2 $17.08. Yeley fungicide options. | **Not built, and the biggest gap.** Every line counts in the total, so alternatives either inflate it or have to go on a separate quote. | L (database change, plus totals, PDF and convert) |
| B2 | **Pick the option at Convert**: the grower chooses option 2, and only those lines become the order | Page Farms "ORDER" tab = the narrowed final | Convert takes every line | M (after B1) |
| B3 | **Pack-size choices for one product** (Bulk / 2.5 gal / no-return tote) shown as a price-break choice and not as three lines that all count | Schutte, Evan Tingley: Liberty bulk vs. full tote | Separate products, all counted | S–M (can reuse B1) |
| B4 | **"Build it from generics" button** on a branded premix line. It adds an option group with the generic equivalents at the right rates, and shows the $/acre saving. | `Price Comparison Matrix` + `INGREDIENT_MAP`: "GREAT BUY – cheaper to build" | `BrandVsGeneric.tsx` keeps an `ingredient_map`, but the quote screen never uses it | M (after B1) |

### C. Room for Mason's knowledge

| # | Improvement | Example in the sheets | App today | Size |
|---|---|---|---|---|
| C1 | **Text-only rows anywhere in a section** (a header, an explanation, a fertilizer example) with no product and no price | "We do not carry Weedmaster…", "Example: 20 lb Elemental Sulfur + 75 lb Potash" | Notes go only above or below the section table. Long section notes print over the table (KI-39, `KNOWN_ISSUES.md`). | M (also fixes KI-39) |
| C2 | **Save a line note back to the product** ("make this my standard note"), so next year's quotes start with it | Premix breakdowns and rate conversions repeated in every quote | The app can *pull in* the product's quoting note but can't save one back from the quote. The sheet's dashboard shows 145 products with no note. | S |
| C3 | **Terms tags on a line**: 0% manufacturer financing, APR financing, cash discount, TrueChoice, no-return/full-tote. Each prints as a short label, and a matching terms paragraph prints once at the bottom of the PDF. | "Halex GT can be financed @ 2.9% APR", "BASF 0% finance due Nov 2026", "NO RETURN" | Free text only, typed again each time | M |
| C4 | **Internal notes that never print**, on the quote and on the product (vendor position, "lead with", "don't price") | `Notes` tab: "Don't price Corteva", "FMC sitting really good…" | Header, footer and line notes all print. No private field. | S |
| C5 | **"Price pending" line**: a product with no price yet. It prints "Call for price", stays out of totals, and blocks Convert until it's priced. | Jude: "Still waiting on Fulvic pricing"; HumiK WSP with no price | A line without a price is priced at $0 or the tier price | S–M |
| C6 | **"Why we changed it" note on a revision**, shown in version history and optionally on the re-sent PDF | Retro: "4/2/26 switching acres…" | Versions have a `notes` column. Check that the screen asks for it on re-send. | S |

### D. Rates and amounts the way Mason thinks about them

| # | Improvement | Example in the sheets | App today | Size |
|---|---|---|---|---|
| D1 | **Per-100-gallon rates with a spray volume (GPA) per section**, so "2 qt/100 gal at 15 GPA" works out per acre automatically | AMS 17 lb/100 gal, NIS 2 qt/100 gal, "Soybean Post 20GPA" | Units are converted to ounces only. There's no per-100-gal basis or GPA. Mason converts by hand. | M |
| D2 | **Round order quantities up to whole containers** (2.5 gal jugs, 51 lb bags, a 265 gal tote) on the order view, while the quote shows the exact amount | Page Farms order: 37.5 gal NutriCharge; AMS in 51# bags | Units are rounded to 2 decimals, not to containers | S–M |
| D3 | **Premix "equals" breakdown generated from the ingredient map** (so it doesn't have to be typed) | "18 oz Maverick = 3.7 oz Callisto + 2.9 oz Zidua + 3.1 oz Stinger" | Typed by hand | M (after B4) |

### E. Workflow around the quote

| # | Improvement | Example in the sheets | App today | Size |
|---|---|---|---|---|
| E1 | **Apply a Crop Program to a quote** ("Recommended Corn Post-Emerge Program" in one click) | `Recomended Corn Post Emerge Pro`, `Wells Corn Program` tabs | Crop Programs promise this (`CropPrograms.tsx:5-7`), but the quote screen never reads them; only jobs do. Quote templates also exist, so there are two overlapping systems. Recommend: merge into one "program" concept that can drop into a quote section. | M |
| E2 | **Last year vs. this year** for the same grower: last season's quote (or what was actually applied) beside the new one, with the $/acre difference per timing | "John Yeley Last Year Programs", "Retro Farms Current Program" | Roll-over copies last year forward but doesn't compare them | M |
| E3 | **Customer-facing price list PDF** by category, not tied to a grower, with a "good until" date and contact line | `Chemical Price List – Pass out` | Not built | M |
| E4 | **Bring last season's 45 sheet quotes into CRX** as history and as starting templates, so 2027 starts from them | All grower tabs | `BulkQuoteImport.tsx` exists. Check whether it can map this sheet's layout (and to-do 1.10, commas in names). | M |
| E5 | **Export a quote to Excel / Google Sheets** for the cases where Mason still wants to work in a sheet | Mason works in Sheets 95% of the time | PDF only | S–M |

## 4. Recommended order (for Mason to rank)

Smallest changes that make the biggest difference to how quotes look and read:

1. **A2** (section $/acre subtotals), **C4** (internal notes), **C2** (save note to product) and **A4**
   (section acres). These are all small, need no or little database change, and make today's quotes read like
   the sheets.
2. **A1** (crop + timing on sections), then **A3** (reorder).
3. **B1 → B2** (option groups and choosing at Convert). This is the biggest structural change, and it
   should be designed **together with to-do 1.2 / 1.3** (sent-quote price lock and line identity) because it
   changes what "the quote total" and "the lines that convert" mean.
4. **C1, C3, C5**, then **D1, D2**.
5. **E1, B4, D3, E2, E3, E4, E5** after January 1.

## 5. Questions only Mason can answer

1. **Option totals:** when a section has a recommended option and alternatives, should the quote total show
   only the recommended one (recommended), or a range ("$17.08–$24.16/acre")?
2. **Grower picks:** will growers choose an option *before* you convert (you mark it on the quote), or do
   you just build the order from what they tell you?
3. **Terms text:** do financing/discount terms (0% BASF, 2.9% APR, TrueChoice) change often enough to need
   an admin list with dates, or is a fixed set of labels enough?
4. **Timing list:** is the list in A1 right for how you sell (add Seed Treatment? split Early Post / Late
   Post? Burndown vs. Spring Burndown)?
5. **Before January 1 or after:** which of section 4's groups 1–3 have to be ready for the December
   pre-booking quotes?

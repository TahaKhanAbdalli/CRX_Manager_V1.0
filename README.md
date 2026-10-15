# CRX Manager V1.0

The operations system for **Crop RX Solutions**, an agricultural chemical distributor and custom application business. One app runs the whole season, from the first customer call to the posted invoice and the commission check:

- **Sell** — customer records and call lists, 3-tier pricing, quotes, bookings, and orders
- **Move product** — purchasing, receiving, inventory, deliveries with signatures and photos, returns
- **Apply** — field maps, spray jobs, dispatch, blend tickets, and legal application records
- **Get paid** — chemical and field-application invoicing, split billing between co-owners, payments, prepay, AR, finance charges
- **Pay out and close** — vendor bills, commissions, rebates, month-end close, and reports
- **Stay compliant** — applicator licenses, restricted-use (RUP) sales register, EPA label data, and lot recall tracing

It runs in the office on a desktop and in the field on a phone, including an offline queue for drivers and applicators.

## Tech Stack

- **Frontend:** React 19, TypeScript, Vite, Tailwind CSS
- **Backend:** Supabase (PostgreSQL, Auth, Storage, Realtime, Edge Functions)
- **Maps:** Mapbox GL JS + react-map-gl (satellite field mapping with draw tools)
- **Testing:** Vitest (unit) + Playwright (E2E)
- **Deployment:** Vercel → [croprxsolutions.app](https://croprxsolutions.app)
- **Other:** jsPDF (PDF generation), Google Vision AI (OCR), proj4/shpjs/@tmcw/togeojson (GIS import), Sentry (error tracking), Lucide React (icons)

## Quick Start

### Prerequisites
- Node.js 24 (the version pinned in `.nvmrc`; CI uses the same file)
- Supabase project with migrations applied
- Mapbox account (free tier) for satellite field maps
- Git

### Setup

```bash
git clone https://github.com/masonwells1/CRX_Manager_V1.0.git
cd CRX_Manager_V1.0
npm install
cp .env.example .env
# Edit .env with your Supabase URL, anon key, and Mapbox token
npm run dev
```

Open http://localhost:5173 in your browser.

### Environment Variables

| Variable | Description |
|----------|-------------|
| `VITE_SUPABASE_URL` | Your Supabase project URL |
| `VITE_SUPABASE_ANON_KEY` | Your Supabase anonymous/public key |
| `VITE_MAPBOX_TOKEN` | Mapbox public access token (for field maps) |
| `VITE_SENTRY_DSN` | Sentry DSN for error tracking (optional) |

All variables must start with `VITE_` to be accessible in the app. See `.env.example`.

## Commands

| Command | Description |
|---------|-------------|
| `npm run dev` | Start development server (port 5173) |
| `npm run build` | Build for production |
| `npm run preview` | Preview production build locally |
| `npm test` | Run the full unit-test suite |
| `npm run test:watch` | Run unit tests in watch mode |
| `npm run typecheck` | Check TypeScript errors |
| `npm run lint` | Run ESLint |
| `npm run test:e2e` | Run Playwright E2E tests |
| `npm run test:e2e:ui` | Interactive Playwright test UI |

> **Note:** Pre-commit runs fast checks for the files staged in the commit, plus the repository's safety and workflow-parity guards. Pre-push runs private-artifact containment, TypeScript, and the production build. CI is the full-product-proof gate: it runs lint, type checking, unit coverage, the production build, and the applicable safety checks before merge.

## User Roles

| Role | Access |
|------|--------|
| **admin** | Full access to everything |
| **sales_rep** | Any customer (read and edit; only an admin reassigns one, only an admin or the assigned rep changes its default commission split, and a customer with a posted or overdue invoice cannot be deactivated), all quotes (edits only their own), all orders (creates them and edits their lines), purchase orders (create, edit, submit, cancel and receive; deleting, reversing a receipt and over-receiving are admin-only), invoices under their own name (they can name only themselves as salesperson on orders, blend tickets and invoices), products (read-only), the RUP sales register (admin-only) |
| **driver** | Own assigned deliveries, customer addresses (read-only) |
| **applicator** | Own assigned jobs, application records, products/fields (read-only) |

Sales reps have worked with any customer, not only the customers assigned to them, since migration `20261013220000` (Mason's decision of 2026-10-13).

The database also allows a fifth role, `entity_recipient`. It is not a login role: it marks the service profiles for business entities that receive commission payments. Those profiles can never sign in and are left out of the Team Board and Settings user lists.

## Features

### Daily Command Centers

- **Today (Office Cockpit)** — One exception screen for the office: unbilled jobs, jobs needing dispatch, bookings needing attention, invoices ready to post, deliveries not yet invoiced, watchdog flags, the next 7 days of jobs, expiring licenses, overdue field-application AR, and inventory shortfalls
- **To-Ship** — What needs to go out, by product and by customer, alongside low stock, overdue or unassigned deliveries, and inbound purchase orders, with one-click Schedule and Reorder
- **Watchdog** — Standing list of flagged jobs and invoices, with one-tap dismiss and an on-demand re-check
- **Role landing** — Everyone signs in to their own starting screen: office staff to Today, drivers to My Route, applicators to My Day
- **Getting Started** — Walkthrough of the Quote → Order → Deliver cycle for office staff, and of the delivery steps for drivers

### Customers & Sales

- **Customers** — Customer 360 profile: addresses, farm fields, crops, credit limit, pricing tier, finance-charge settings, season summary, purchase history, and stored customer documents
- **Call Lists (CRM)** — Seasonal worklists: prepay prospects, customers with no recent contact, stale quotes, lapsed products, and unassigned accounts, with a call-prep summary and call logging on each row
- **Products** — Catalog with 3-tier pricing, EPA registration and restricted-use flags, container sizes, unit conversions, application rates, and cost history
- **Supplier Pricing** — Admin-only workspace for supplier quote sheets: staging and approval, comparable-cost review, product and supplier links, and a below-cost approval check on sales prices
- **Quotes** — Multi-line quote builder with tiered pricing, margin, commission splits, and a PDF that is emailed to the customer when the quote is sent; convert straight to an order
- **Orders** — Direct orders or quotes converted to orders, open-booking banners, credit-limit warnings, and an "Order Confirmed" email to the customer
- **Sell & Deliver Now** — Quick delivery path for walk-in and same-day sales
- **Crop Programs & Program Tracker** — Seasonal crop programs, with planned versus actual acres by customer
- **Brand vs Generic** — Map branded products to their generic equivalents by active ingredient

### Inventory, Purchasing & Delivery

- **Inventory** — Live stock levels, vendor-grouped reorder alerts, holds, batch adjustments, a full transaction ledger, cost valuation, and cycle counts with variance tracking
- **Purchase Orders** — Vendor POs from the catalog, with a two-step receive and receiving history
- **Receiving** — One screen with three tabs: a hub of open PO lines across all vendors, a Quick Receive wizard that matches products to the oldest open POs, and a searchable receiving log
- **Deliveries** — Driver assignment, signature capture, photos, issues, partial deliveries with remainder tracking, load sheets, backdated entry, a completion email to the customer, and a shortage badge when deliveries compete for the same stock
- **Field Mode (My Route)** — Phone-first route for drivers: every open delivery assigned to them, in-progress first and then by scheduled date; complete a delivery on site with signature, photos, and quantities
- **My Day (applicators)** — Phone view of an applicator's dispatched jobs: start a job, then complete it with weather, gallons applied, acres applied per field, and notes
- **Returns** — Return requests through approval, receipt, restock, and credit memo

### Field Application

- **Field Mapping** — Mapbox satellite maps, draw-your-own boundaries (including multi-part fields), one-click USDA field boundaries, shapefile/KML/GeoJSON import, legal-description (PLSS) lookup, and obstacle markers
- **Field Dashboard** — Per-field history: season stats, every application with weather, billing splits, and FSA details
- **Jobs** — Spray-job editor with a map-based field picker, route-order numbers on the job's field map, chemicals, vehicle and applicator, customer-supplied chemicals, application fees, and transfer to invoice
- **Dispatch** — Map-based dispatch board with applicator assignment
- **Loader & Applicator Sheets** — Multiple saved loader worksheets per job, satellite map pages and previous-application history on printed applicator sheets
- **Blend Tickets & Recipes** — Upload a ticket photo for OCR (Google Vision AI) or enter it by hand, pick units from a list, and build reusable tank-mix recipes that start a job
- **Application Records** — The legal record of every application: actual application date, applicator name and license captured at the time, and products used
- **Vehicles & Application Services** — Ground and air equipment, and application-fee pricing with per-customer rate overrides

### Billing & Money

- **Chemical Invoicing** — Invoices from orders and deliveries, payment-terms picker, batch print, posting rights and a Ready-to-Post queue, unpost, void, and write-off
- **Field-Application Invoices** — As-applied billing with tabs for unbilled work, drafts, posted, and a per-customer summary; quantities and customer shares are figured from the job
- **Split Billing** — Divide a spray job or chemical order between the co-owners of a field, each on their own invoice, rounded to the exact cent
- **Payments & Prepay** — Allocate a check across invoices with the remainder kept as prepay credit; a prepay workspace to apply credits; credit memos applied to open invoices
- **Accounts Receivable** — One workspace for aging, payment history, prepayments, and customer ledgers, plus finance charges, emailed AR reminders, and batch statements
- **Accounts Payable** — Vendor master, vendor bills (manual or from a PO) with due dates from payment terms, bill payments, and an AP dashboard with aging
- **Commissions** — Commission splits on orders and spray jobs, commission payments with a posting workflow, and ledger-backed commission history
- **Rebates** — Manufacturer rebate programs and claims
- **Month-End** — Period-close checklist, batch statements, "Roll the Month", and year-end summaries
- **Financial Dashboard** — AR aging, revenue, payments, prepay balances, and finance charges at a glance

### Compliance & Data Quality

- **Compliance** — Applicator license tracking with expiry alerts, the restricted-use product list, and an admin-only RUP Sales Register built from invoices, with CSV export
- **Lot Trace** — Enter a lot number and see every application that used it: field, date, customer, applicator, record, and invoice, for recalls and audits
- **Label Data** — EPA registration lookup, a label data-quality screen that flags missing EPA numbers with inline fixes, and a review queue where no label value reaches a product without a person accepting it
- **Integrity** — Admin data-integrity report (order totals, inventory ledger, payments, commissions, delivery-to-invoice parity, and more) and cleanup tools for the problems it finds

### Reports, Team & Mobile

- **Reports** — Profitability, field-level profitability (margin per acre), application logbook, financial and operational reports, year-end summaries, and sales and chemical history by product, customer, month, or sales rep, with a customer view that hides cost; CSV and PDF export
- **Team Board** — Notes, to-dos, and announcements linked to customers, orders, deliveries, jobs, POs, and quotes, with photos, comments, today's deliveries, and yesterday's recap, updated in real time
- **Notifications** — Real-time alerts for low stock, expiring quotes, order status, dispatch, and more
- **Bulk Import** — CSV import for customers, products, quotes, orders, POs, and blend tickets
- **Mobile & Offline** — Bottom navigation, phone card layouts, and full-screen forms on small screens; installable as an app; field work queues offline and is reviewed when the connection returns

## Database

Counts (tables, functions, migrations, Edge Functions) change with almost every release, so this page does not repeat them. Every database change is a file under `supabase/migrations/`, and each Edge Function is a folder under `supabase/functions/`. For current, dated figures and live state see [docs/manual/CURRENT_STATE.md](./docs/manual/CURRENT_STATE.md) and the [migration history](./docs/reference/migration-history.md).

See the [database schema reference](./docs/reference/database-schema.md) for the table and RLS policy inventory, and the [RPC reference](./docs/reference/rpc-functions.md) for database functions.

## Deployment

Deployed to **Vercel** at [croprxsolutions.app](https://croprxsolutions.app). Configuration in `vercel.json` with security headers.

`main` is protected: nobody pushes to it directly. A change lands through a branch, a pull request, the required CI checks, and review; merging that pull request into `main` is what deploys the live site, and Vercel keeps one-click rollback to an earlier deployment.

See [DEPLOYMENT.md](./DEPLOYMENT.md) for full deployment instructions, environment setup, and rollback procedures.

## Documentation

| File | Contents |
|------|----------|
| [AGENTS.md](./AGENTS.md) | Short shared contract and task-routing entry point for coding agents |
| [Agent onboarding](./docs/manual/AGENT_ONBOARDING.md) | First-session reading order, recurring failure modes, and verification expectations |
| [Architecture](./docs/manual/ARCHITECTURE.md) | System architecture, data flow, business logic, and code-location map |
| [Reference docs](./docs/reference/) | Current schema, RPC, route, pattern, and guardrail references |
| [TESTING.md](./TESTING.md) | Testing guide (beginner-friendly) — setup, running tests, troubleshooting |
| [DEPLOYMENT.md](./DEPLOYMENT.md) | Deployment instructions — Vercel setup, env vars, rollback |

## Current State

- Every page inside the app is lazy-loaded (the login and password pages load eagerly); the page and route list is in [docs/reference/pages-routes.md](./docs/reference/pages-routes.md)
- Unit tests (Vitest) live next to the code in `src/`; the main Playwright E2E suite (`tests/e2e/`) needs a staging Supabase project that does not exist yet (see [TESTING.md](./TESTING.md)); the self-contained Playwright proofs in `tests/row-version-ui/` and `tests/phase1a-ui/` run locally
- When a pull request is routed to full CI (any change beyond docs), CI blocks a merge on any ESLint warning, TypeScript error, failing unit test, or failed build
- Git hooks: pre-commit runs fast checks on staged files; pre-push runs TypeScript and the production build (see the note under Commands)
- **Deployed to Vercel** at [croprxsolutions.app](https://croprxsolutions.app) (live)
- Current status, open problems, and dated counts: [docs/manual/CURRENT_STATE.md](./docs/manual/CURRENT_STATE.md) and [docs/manual/KNOWN_ISSUES.md](./docs/manual/KNOWN_ISSUES.md)

## License

Private - All rights reserved

---

**Version:** 1.0
**Last Updated:** 2026-10-15

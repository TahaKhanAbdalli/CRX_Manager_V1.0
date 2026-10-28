---
tags: [start-here, glossary]
---

# Glossary

← [[Home]]

Plain-English meanings of the words used across this vault, for Mason and Taha alike. Where a word has an exact technical rule, the linked document has the full detail. Add a word here whenever one trips someone up.

## Sales and orders

| Word | Means |
|---|---|
| **Quote** | A price offer to a customer. It moves through *draft* → *sent* → *revised* (if changed and re-sent) → *accepted* or *cancelled*. |
| **Sent-price lock** | Once a quote is sent, its prices stay what the customer saw. A price change needs a revision that is re-sent before it's billed. |
| **Booking** | A quote a customer commits to ahead of time. Orders then *draw down* product from it over the season. Staff close it when it's finished; *closed short* means it was closed before everything was taken. |
| **Order** | What a customer actually wants delivered. It's created from a quote or directly. |
| **Price tier** | The price level a customer is assigned. Each product has a price per tier. |
| **Margin floor** | The lowest margin a product may sell at. A price below it, or below cost, needs an admin's approval. |
| **Quick delivery** | A shortcut for counter sales: it creates the order, the delivery and a draft invoice in one step, skipping the quote. |
| **Rep** | A sales representative, one of the four staff roles (admin, sales rep, driver, applicator). |

## Delivery and field work

| Word | Means |
|---|---|
| **Delivery** | Product physically taken to a customer. Completing a delivery moves the stock and needs a phone signal, so nothing is half-saved. |
| **Void (a delivery)** | An admin reverses a completed delivery. Stock comes back. If its invoice was already posted, a credit is issued instead of cancelling the bill. |
| **Field application** | Custom-applying product on a customer's field with a ground rig. Chemicals applied count as delivered. |
| **Job** | One scheduled field application: the field, the products, the applicator, the date. |
| **Dispatch Board** | The screen for assigning deliveries and jobs to drivers and applicators. |
| **Blend ticket** | The record of a driver or applicator mixing a blend, often photographed on paper and read by the app. Invoices can be billed from it. |
| **Applicator** | The licensed person who applies product in the field. Field staff only see the fields of jobs they're sent to. |

## Money

| Word | Means |
|---|---|
| **Draft invoice** | Still editable. Not yet a real bill. |
| **Posting** | Locking an invoice as a real bill the customer owes. Amounts can't change after posting, and the unpaid balance starts aging. |
| **Invoice group** | A set of invoices that belong together, for example a split bill. |
| **Split billing** | One sale billed to more than one party, such as a farmer and a landlord, by share. Not the same as a commission split. |
| **Commission split** | How a sale's commission is shared among salespeople. Only admins change it. |
| **Prepay** | Money a customer pays in advance. It's held as a credit and applied to invoices later. Product lines are billed only when delivered. |
| **Credit memo** | A credit on the customer's account that reduces what they owe, for example after a return or a voided delivery. |
| **AR / AP** | Accounts Receivable (money customers owe us) and Accounts Payable (money we owe suppliers). |
| **Aging** | How long an unpaid invoice has been outstanding: current, 30, 60, 90+ days. |
| **Cents** | All money is stored as whole cents, so rounding can never drift. |
| **Cost and margin** | What a product costs us and what we make on it. Admin-only. |
| **QuickBooks Desktop** | Where the company books stay. CRX will sync invoices, payments and credits into it. |
| **Stripe / ACH** | Stripe will process online card and bank (ACH) payments. CRX never stores card or bank numbers. |

## Inventory

| Word | Means |
|---|---|
| **On hand** | Product physically in the warehouse. |
| **Booked / held** | Product promised to an order but not yet delivered. |
| **Net position** | What's really available: on hand minus what's promised. Every screen reads it from one database function, so the numbers always agree. |
| **Shortage** | Not enough stock for a delivery. It warns but never blocks (Mason's decision). |
| **Receiving** | Logging product arriving from a supplier: quantity, condition, lot number, storage spot. |
| **Lot number** | The manufacturer's batch number, kept so product can be traced. |
| **Cycle count** | Physically counting part of the stock and correcting the system to match. |
| **Purchase order (PO)** | Our order to a supplier. |

## Compliance

| Word | Means |
|---|---|
| **EPA number** | The registration number on a pesticide label. |
| **RUP** | Restricted-Use Pesticide. Only certified buyers may purchase it, and every sale goes in the RUP register. |
| **RUP register** | The record of restricted-use sales that inspectors can ask for. Admin-only. |
| **WPS** | Worker Protection Standard: the safety information farm workers must get before an application. |
| **REI / PHI** | Restricted-Entry Interval (how long people must stay out of a treated field) and Pre-Harvest Interval (how long before harvest a product can be applied). |
| **Chem Man** | The outside software Crop RX bills in today. Its last new bill is 2026-12-31. |

## Software and hosting

| Word | Means |
|---|---|
| **Frontend** | The screens people see and click: the React web app in `src/`. |
| **Backend / database** | Where the data and the rules live: Supabase (PostgreSQL). |
| **Supabase** | The service that runs our database, logins, file storage and Edge Functions. |
| **Vercel** | The service that hosts the web app at croprxsolutions.app. Merging into `main` deploys it. |
| **Sentry** | Error alerts. It reports when something breaks for a user. |
| **PWA** | Progressive Web App: a website you can install on a phone like an app. CRX has no separate phone app. |
| **Edge Function** | A small server program in Supabase, for example sending email. |
| **RPC (database function)** | A function that runs inside the database. Money and inventory rules live here, so a screen can't skip them. |
| **RLS (Row Level Security)** | Database rules that decide which rows each user may see or change. |
| **Schema** | The structure of the database: its tables and columns. |
| **Migration** | A file that changes the database structure. Once applied to the live database it's never edited; fixes go in a new migration. |
| **Live / production** | The real system with real customers and money. |
| **Staging** | A separate test copy of CRX with fake money and email, where anything can be tried safely. Not built yet; it's part of Goal 6. |
| **Point-in-time recovery (PITR)** | Rewinding the database to a chosen moment after a disaster. Comes with the Supabase Pro plan. |
| **Retry-safe** | If a phone loses its connection mid-save and someone taps again, nothing is saved twice or saved wrong. |
| **Idempotency key** | The technical tag that makes a save retry-safe. |
| **Data API** | The way the web app reads and writes data. RLS controls what it can reach. |

## How we work on the code

| Word | Means |
|---|---|
| **Repository (repo)** | The whole code project on GitHub. Ours is public. |
| **`main`** | The official version of the code. What's on `main` is what's live. |
| **Branch** | A separate copy where a change is built without touching `main`. |
| **Commit** | One saved step of changes on a branch. |
| **Push** | Sending commits from a computer up to GitHub. |
| **Pull request (PR)** | A request to merge a branch into `main`. It's where changes are reviewed and checked. A *draft* PR isn't ready yet. |
| **Merge** | Accepting a PR into `main`, which makes it live. |
| **CI / checks** | Automatic tests GitHub runs on every PR. They must pass before a merge. |
| **Worktree** | A second working folder of the same repository, so two pieces of work don't collide. |
| **Claude / Codex** | The AI coding assistants that build and review much of the code. |
| **Luna / Sol** | Codex review models. Luna reviews while work is in progress; Sol gives the final independent review before a merge. |
| **CodeRabbit** | An automatic GitHub reviewer. Its comments are advice; it never approves or blocks. |
| **Hook** | An automatic guard that blocks a risky action, such as pushing straight to `main`. |
| **Graphify** | A map of the code the agents use to trace how parts connect. |

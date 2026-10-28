---
tags: [start-here, code]
---

# Codebase Map

← [[Home]]

A plain-English tour of the CRX Manager code. Code files aren't notes, so they don't appear in this vault. Open them in your code editor from the repository root (`C:\CRX_Manager` on Mason's PC). For the full technical picture, read [[manual/ARCHITECTURE|Architecture]].

## The big picture

```
Phone / PC browser
      │
      ▼
React web app (src/)  ──hosted on──►  Vercel  (croprxsolutions.app)
      │
      ▼
Supabase  (PostgreSQL database + logins + file storage + Edge Functions)
      │
      ▼
Sentry (error alerts) · email sending · EPA label lookup · AI document reading
```

- **Frontend:** React + TypeScript, built with Vite, styled with Tailwind CSS. It's a PWA (installable web app). There are no native phone apps.
- **Backend:** Supabase. The money and inventory rules live **in the database** (functions, triggers and row-level security), not only on screen.
- **Hosting:** Vercel deploys from `main`. Production is `https://croprxsolutions.app`.

## Folders at the repository root

| Folder / file | What's in it |
|---|---|
| `src/` | The web app itself (all screens and logic) |
| `supabase/migrations/` | Every database change, in date order. Applied migrations are **never edited**; changes go in a new file |
| `supabase/functions/` | Server-side Edge Functions (see below) |
| `supabase/baselines/` | A snapshot of the whole database schema, used to rebuild from scratch |
| `tests/` | Browser (Playwright) and database tests |
| `scripts/` | Helper scripts: checks, backups, agent tooling |
| `docs/` | **This vault** |
| `.claude/`, `.codex/`, `.agents/` | Setup and safety rules for the AI coding assistants (Claude and Codex) |
| `AGENTS.md`, `CLAUDE.md` | The rulebook every AI agent must follow in this repo |

## Inside `src/`

| Folder | What's in it |
|---|---|
| `src/pages/` | One file per screen (Customers, Quotes, Orders, Deliveries, Invoices, Dispatch Board, Compliance, Reports…). Tests sit beside them as `*.test.tsx` |
| `src/components/` | Reusable pieces, grouped by area: `quotes`, `orders`, `deliveries`, `invoices`, `inventory`, `field-app`, `dispatch`, `compliance`, `reports`, `ui`, `layout`… |
| `src/lib/` | Shared logic: the single database connection (`db.ts`), PDF builders, money math, email builders, error reporting |
| `src/hooks/`, `src/contexts/` | Shared React state (who's logged in, their role, and so on) |
| `src/types/` | Shared data shapes (`index.ts`) |
| `src/App.tsx`, `appPages.tsx` | The list of pages and their web addresses |

## Edge Functions (`supabase/functions/`)

| Function | What it does |
|---|---|
| `send-email` | Sends invoices, statements, quotes and receipts |
| `create-user`, `reset-user-password` | Staff account management |
| `customer-document-files` | Customer document upload and download |
| `epa-lookup` | Looks up EPA pesticide label data |
| `process-document`, `process-blend-ticket` | AI reading of uploaded paperwork and blend tickets |

## How the business flows through the code

**Quote → Order → Delivery (or Field Application) → Invoice → Payment**, with inventory moving at delivery and commissions at payment. The detailed rules:
- [[workflows/QUOTE_TO_DELIVERY|Quote to Delivery]]
- [[workflows/INVENTORY_RULES|Inventory Rules]]
- [[workflows/RLS_SECURITY_GUIDE|Who can see what (security)]]

## Staff roles

Admin, sales rep, driver and applicator, plus commission recipients. **Cost and margin are admin-only.**

## Rules every change follows

- [[workflows/SAFE_DEVELOPMENT_RULES|Safe Development Rules]]
- [[workflows/DATABASE_CHANGE_CHECKLIST|Database Change Checklist]]
- [[workflows/UI_PATTERNS|UI Patterns]]
- [[reference/coding-guidelines|Coding Guidelines]] and [[reference/gotchas|Gotchas]]
- No one pushes straight to `main`. Every change is a pull request with independent review, and money changes get extra review.

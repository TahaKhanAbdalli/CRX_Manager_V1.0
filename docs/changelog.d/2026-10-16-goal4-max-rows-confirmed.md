## 2026-10-16 — Goal 4 row-limit audit: the 1,000-row ceiling is confirmed

The Goal 4 row-limit audit (`docs/audits/2026-10-15-goal4-row-limit-inventory.md`) had assumed the database's "Max rows" setting was Supabase's default of 1,000. SQL can't read it. On 2026-10-16 Mason signed in to the Supabase dashboard, and Claude read the setting on the Data API settings page: it is **1,000**. Nothing was changed.

The audit now states this as confirmed. Every "1,000 (server)" finding stands as written. Six reads that ask for 2,000 or 5,000 rows really get 1,000: Invoices, the three Field Invoices panels, and To Ship's orders and order lines. On the Invoices and Field Invoices screens, the "some may be hidden" warning can never appear.

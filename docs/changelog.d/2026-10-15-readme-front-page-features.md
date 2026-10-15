## 2026-10-15 — README front page lists the app's current features

The repository's front page (`README.md`) described the app as it stood in early summer. It now
opens with a plain summary of what CRX Manager runs (sell, move product, apply, get paid, pay out
and close, stay compliant) and its Features section covers everything the app has today, grouped
into command centers, customers and sales, inventory and delivery, field application, billing and
money, compliance and data quality, and reports and mobile. New on the page: Today (Office
Cockpit), To-Ship, Watchdog, Field Mode, CRM call lists, Customer 360 and customer documents,
Supplier Pricing, split billing, field-application invoices, Accounts Receivable and Accounts
Payable workspaces, rebates, Lot Trace, label data tools, integrity tools, field profitability,
USDA boundaries, dispatch, loader worksheets, and the mobile layout. Drivers (My Route, with
signature and photos) and applicators (My Day, with weather, gallons and acres) are described
separately, because they use different screens.

The sales-rep row of the User Roles table no longer says the two create-invoice-from-order
functions skip the own-name check; migration `20261014210000_order_invoices_rep_own_name`, live
since 2026-10-15, added it. The row now says reps can name only themselves as salesperson on
orders, blend tickets and invoices, and that the RUP sales register is admin-only.

No code changed.

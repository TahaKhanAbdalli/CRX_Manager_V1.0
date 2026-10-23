## 2026-10-23 — services and accounts list for the developer handoff (Goal 10)

Added `docs/manual/SERVICES_AND_ACCOUNTS.md`: every outside service CRX Manager uses (GitHub,
Supabase, Vercel, Sentry, Resend, Google Vision, Mapbox, the two domains, keyless data sources,
and the agent review tools), with each secret's name and where it is stored, the account owner,
the plan and renewal date where visible, and the order to grant the incoming developer access,
starting with fork-only. Names and locations only, no secret values. Items not visible from the
code or read-only lookups are marked "Mason to confirm".

Found while checking: `vite.config.ts` falls back to the Sentry org name `crx-solutions`, but
the real org is `crop-rx-solutions`, so source-map upload depends on Vercel setting `SENTRY_ORG`.

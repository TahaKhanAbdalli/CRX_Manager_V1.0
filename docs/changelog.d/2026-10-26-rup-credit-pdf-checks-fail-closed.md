## 2026-10-26 — the RUP-license, credit-limit and invoice-PDF checks stop when they cannot read their data (To-Do 10.5, sixth money PR)

- **Restricted-use (RUP) license check** (`src/lib/rupCompliance.ts`): a products or license read
  that failed, threw, came back empty or was not a list read as "no RUP products" (or a generic
  warning that nothing acted on), so an RUP sale could reach the post confirm looking clean. It now
  returns `checkFailed`; New Order, Quote Builder and the delivery screens show "The restricted-use
  (RUP) license check could not be run. Reload the page to check again." and no longer log a failed
  check as an "RUP products … without valid license" activity. A failed check has no RUP register
  disposition.
- **Post on Invoice Detail and on the Split Billing editor:** a check that could not run (the RUP
  read, the split group's sibling read, a sibling whose lines came back missing, a group with no
  members, or a check that threw) used to fall through to the plain confirm. Post now stops with
  "… could not be run, so nothing was posted. Try again." and no confirm opens. A real RUP finding
  is still a warning on the confirm, not a gate. The Split Billing Post button stays busy while its
  checks run.
- **Credit-limit check** (`src/lib/creditLimitGuard.ts`, used by `useCreditLimitCheck` and the
  Split Billing editor): a failed or empty customer read read as "no credit limit set" and passed.
  The open balance was the caller's own invoices read, which for a sales rep only covers the
  invoices they created or sell, so a customer billed by another rep, or with another rep's draft,
  looked under the limit. The limit and the whole open exposure now come from the server's
  `customer_credit_exposure` (PR #1138: every rep's draft, unposted, posted and overdue invoices,
  not deleted, no negative balances, in bigint cents). A failed read, an unusable exposure
  or an amount or limit that is not whole cents is "Could not verify credit limit". RUP product lines
  with no customer to check a license for stop Post too.
- **That stop has no override (Mason, 2026-10-26: "keep the hard stop on both screens").** On
  Invoice Detail and New Order the could-not-verify banner no longer offers "Continue Anyway"; an
  over-limit warning still does. The override now lives in the hook and is spent by the next
  check: before, the page read a dismissed flag from an older warning, so after one "Continue
  Anyway" a later could-not-verify result also went through.
- **Invoice PDF from a list or the field editor** (`buildInvoicePdfDataFromRow`): a failed customer,
  shares, billing or applied-acres read printed the PDF with the address, split shares, terms,
  notes or diluent total silently blank. It now stops with "Could not load the invoice details
  (customer, shares, billing or field acres), so no PDF was made. Please try again." A dropped
  request gives the same message instead of a raw network error.
- **Print on Invoice Detail** took the address from the customer picker list (500 active
  customers, its read error ignored), so a customer missing from it printed a blank address. It
  now reads the billed customer by id and refuses the PDF when that read fails. **Email** on the
  same screen took the address from that list too, so a customer missing from it read as "does not
  have an email address on file"; it now reads the billed customer's email by id and, when that
  read fails, says "Could not load the customer's email address, so nothing was sent."
- Invoice Detail's grouped Post and the Split Billing editor now share one per-member RUP check
  (`groupMemberRupFinding`), so the two cannot drift apart.
- **Print Selected on the Invoices list** logged a failed customer read and printed a blank
  address, and ignored a failed shares read. Both now refuse the batch with the same message.
- Proof: new checks in `rupCompliance.test.ts`, `useGuardrails.creditLimit.test.ts` (was
  `useGuardrails.paging.test.ts`), `buildInvoicePdfDataFromRow.test.ts`,
  `splitGroupPostChecks.test.ts`, `InvoiceDetail.test.tsx` and `Invoices.batchPrint.test.tsx` fail
  when each fix is undone. Invoice Detail Post (RUP, credit limit, over-limit override and the
  no-override stop), the Split Billing editor's Post and the Field Invoices Print were each checked
  in the dev app, working and failing (error, no data, not a list, dropped connection), against a
  local fake Supabase server.
- Not changed here: the after-save credit-limit toast on Quote Builder and Job Detail
  (`warnIfOverCreditLimit`) still says nothing when its own read fails (a notice after the save,
  not a check before it); a Print All on the field-invoice lists fails the whole batch, rather
  than skipping and naming the invoice, when one invoice's details cannot be read; posting a
  draft or unposted invoice counts its balance once in the open total and again as the new amount
  (an over-warning, the safe direction, as the old check did for drafts); the credit check still
  runs in the browser before Post, so two orders entered at the same moment can both pass (a
  server-side guard is a later item); and the other post buttons (Field Application Invoice, the
  Drafts panel, Office Cockpit, batch post) run no client-side RUP or credit check at all, as before.

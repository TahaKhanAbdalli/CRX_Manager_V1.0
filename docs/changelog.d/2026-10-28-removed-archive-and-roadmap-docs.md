## 2026-10-28 — docs cleanup, part 2: archive, old roadmap and shipped designs removed

Second half of Mason's 2026-10-28 docs cleanup, for folders outside the documentation-only set.
Removes 27 already-archived files from `docs/archive/` (keeping the eight that an applied
migration, an agent instruction or the migration ledger names, now listed in a new
`docs/archive/README.md`), `docs/ROADMAP.md` and the field-boundary research (Mason's choice),
two shipped roadmap designs, the five shelved earmark SQL drafts (the summary README stays and
says so), a resolved diagnosis page, and a raw May index dump.

Every file is listed with restore steps in `docs/audits/2026-10-28-removed-finished-docs.md`.
Mentions in the scaffolding review, the holds plan, the product-data-model build plan and the
earmark README now say "removed 2026-10-28".

Proof: a repository-wide search found no unannotated reference to a removed file outside change
log history and the frozen `KNOWN_ISSUES` history file, whose header note covers them; doc checks
pass. Not verified: nothing runtime changed.

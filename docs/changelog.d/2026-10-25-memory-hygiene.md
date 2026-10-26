## 2026-10-25 — Memory backup covers the archive; agent-memory traps move into gotchas

- `scripts/backup-claude-memory.mjs`: staging now also copies every `*.md` in the sibling
  `memory-archive/` folder, flat as `archive__<name>`, so notes the new weekly memory sweep
  retires (moved, never deleted) stay in the off-site backup. They pass through the same
  plain-name rule, secret scan, byte-for-byte copy check, `--verify` and remote check. Only a
  source folder literally named `memory` has an archive. Anything that would make archived notes
  silently drop out (and so be pruned from the backup) REFUSES the run: an archive that is not a
  real directory or cannot be read, an archived note that is a link, or a missing archive while
  the previous snapshot holds `archive__` notes (an empty archive folder is the explicit way to
  drop them). Staging into or around the archive is refused, including where the archive will
  be created when it does not exist yet (Codex GitHub App finding on #1098), and a live note named `archive__*`
  refuses the run. The backup command doc says so.
- `docs/reference/gotchas.md`: two new sections of rules that had lived only in one machine's
  agent memory, where sessions found them by luck — "Agent workflow traps" (12: explicit
  `git add` paths, parked-migration row wording, the mutating-RPC scanner and its exemptions, the
  silent approved-set test, sales-rep proofs for money RPCs, the Sol wrapper's redacted stderr,
  `npm test` vs CI, clock checks after the replay lookup, the QuoteBuilder unsaved-prompt rule,
  regex comment stripping, JSX em-dashes, audit prompt docs) and "Database, money and migration
  traps" (12: JS vs SQL rounding, the `balance_cents` recompute list, frozen `unit_conversions`
  keys, `NOT IN` status guards, advisory-lock keys, the products pricing trigger in fixtures,
  PostgREST resolution codes, `tgenabled`, `.gitattributes` pins on renumber, and three
  parked-migration rules).
- Why: Mason, 2026-10-25, "do all recommendations" from the agent-memory review — the memory
  index kept overflowing because notes were never retired, and a cleanup must not lose the
  archive or the live rules.
- Every note, live or archived, is now read through one file handle whose identity (BigInt
  `dev`/`ino`, since NTFS ids exceed 2^53) must match the link check, so a note swapped for a link
  between the check and the read refuses the run instead of pulling in the link's target. The
  reserved `archive__` prefix is matched case-blind (Windows names are).
- Proof: new test cases in `scripts/backup-claude-memory.test.mjs` (273 assertions pass; each
  new refusal was mutation-checked — switching it off makes a case fail); a real stage of the
  live memory folder staged 863 files (327 archived notes) and `--verify` passed. Luna rounds 1–3
  found nine issues (archived notes that could be pruned or mis-staged, the read race, the
  case-blind prefix, two doc points); all are fixed here.

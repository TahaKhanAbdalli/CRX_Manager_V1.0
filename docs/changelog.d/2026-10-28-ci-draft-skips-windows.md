## 2026-10-28 — Draft pull requests skip the two Windows CI jobs

- Mason, 2026-10-27: draft pushes need not get the full check; once a PR is marked ready, every
  push needs it. `scripts/classify-ci-scope.mjs` now emits `windows_ci`: false only when the event
  is a pull request whose payload says `draft: true`, and also on the documentation-only lane
  (`applyDraftWindowsHold` sets it false there too, since that lane already skips Windows). `ci.yml` runs `phase3c-containment-windows` and
  `guard-hooks-windows` only when `windows_ci` is true. Marking a PR ready and every later push
  run them as before.
- The Linux parts are unchanged on drafts: lint, type check, build, Vitest with coverage,
  regression tests, SQL validation and containment still run on every push, so the "checks green
  before marking ready" step in `ship.md` still means real tests passed (its wording now says a
  draft's checks cover Linux only).
- Fail-closed: a missing or non-boolean draft flag, an unreadable event, a push to main, the
  bootstrap route and an older trusted-base classifier (which emits no `windows_ci`) all run
  Windows. The required check "Lint, Type Check, Test, Build" expects the Windows jobs skipped
  when `windows_ci` is false or `full_ci` is false, success only for `full_ci` and `windows_ci`
  both true, and is red on an invalid or empty flag. `full_ci=false` with `windows_ci=true` is
  accepted as skipped for a documentation-only run by an older trusted-base classifier, which
  emits `full_ci=false` without `windows_ci` and so leaves the pre-seeded `true` (both Windows
  jobs skip because `full_ci` is false); only a run that included
  Windows writes and publishes the full-CI proof, so a title/body edit never reuses a draft run.
- As with every classifier change, this PR's own runs use main's classifier (trusted base), so the
  skip starts on PRs opened or pushed after it merges.
- Saving: about 10 Windows minutes per draft push (about 25,000 of roughly 81,000 CI minutes in
  the 31 days to 2026-10-27 were Windows; they bill double on a private repository).
- Proof: `scripts/classify-ci-scope.test.mjs` covers the draft rule, the fail-closed cases, the
  CLI output and the workflow contract; removing the draft rule or the proof gate fails it. It
  also runs the actual required-check shell from `ci.yml` under Bash for every
  `full_ci`/`windows_ci` combination (including the older-classifier `false:true` case and
  invalid flags); restoring the pre-fix case list makes the `false:true` case fail with the
  production error "Trusted windows_ci output is invalid".

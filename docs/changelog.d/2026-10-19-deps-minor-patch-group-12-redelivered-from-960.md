## 2026-10-19 — Library updates: minor-and-patch group of 12 (re-delivered from #960)

Dependabot PR #960 bumped twelve libraries. CodeRabbit skips bot-authored PRs ("Bot user detected")
and Dependabot's PR has no candidate birth record, so this PR re-applies the same versions on top of
current `main` as an ordinary agent-authored PR, as #879 and #886 did for earlier Dependabot groups.
CodeRabbit is advisory and its approval is not a merge requirement.

| Package | From | To |
| --- | --- | --- |
| `@fullcalendar/daygrid`, `@fullcalendar/interaction`, `@fullcalendar/react` | 6.1.21 | 6.1.22 |
| `@supabase/supabase-js` | 2.117.3 | 2.118.0 |
| `jspdf-autotable` | 5.0.8 | 5.0.9 |
| `lucide-react` | 1.56.0 | 1.59.0 |
| `react`, `react-dom` | 19.3.0 | 19.3.1 |
| `@playwright/test` (dev) | 1.64.0 | 1.64.1 |
| `@vitest/coverage-v8` (dev) | 4.1.11 | 4.1.12 |
| `vitest` (dev, lockfile only; `package.json` range `^4.1.8` is unchanged) | 4.1.11 | 4.1.12 |
| `fake-indexeddb` (dev) | 6.2.5 | 6.2.6 |

`package.json` and `package-lock.json` are Dependabot's own changes (head 63ad4c3), merged with
current `main`. No database, RPC or application source changes. #960's only failing check was one
CustomerDetail test that passed 3 of 3 runs alone and in a full local run (406 files, 5,762 tests,
type-check, lint and build all green); it was a timing flake, not a package break.

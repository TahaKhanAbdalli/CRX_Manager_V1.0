## 2026-10-27 - CodeRabbit check-run read: a cut-short list is "unknown" (#1125, Luna)

The CodeRabbit requirement read takes at most 5 check suites and 10 check runs per commit. It
now also reads their totals, and a commit whose list was cut short can never prove "CodeRabbit
never reviewed this PR", so Sol cannot run first on a guess.

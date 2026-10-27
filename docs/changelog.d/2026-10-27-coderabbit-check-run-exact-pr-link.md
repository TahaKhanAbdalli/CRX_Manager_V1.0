## 2026-10-27 - CodeRabbit check-run PR link must end at the PR number (#1125, Luna)

The PR link in a CodeRabbit check-run summary now binds only when nothing but an optional `/`
follows the PR number before its query, fragment or closing bracket, so `/pull/1134/other` is not
PR 1134's review link. Refuted: a name check in the "unreadable link" test is unneeded, because
the read already returns only runs named `CodeRabbit`, and that test can only make Sol wait.

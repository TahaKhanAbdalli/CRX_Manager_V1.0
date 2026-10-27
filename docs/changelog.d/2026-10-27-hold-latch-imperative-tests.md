## 2026-10-27 - Tests pin that an imperative stop before an -ing verb latches

- Test-only, from PR #1152 review: a bare, sentence-start, addressed ("ok", "please", "claude,", "you") or "and"-joined stop followed by an -ing verb (including a hyphenated one such as "re-running") latches the hold; only a descriptive form such as "make the gate stop re-running checks" is skipped.

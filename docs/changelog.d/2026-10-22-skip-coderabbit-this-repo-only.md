## 2026-10-22 — a CodeRabbit waiver covers this repository's PRs only

- Waivers name a PR number, and numbers repeat across repositories, so both merge gates now pass the number to the
  waiver lookup only when GitHub resolves the PR in `masonwells1/CRX_Manager_V1.0` (`isSkipRepository()` in
  `coderabbit-skip-lib.mjs`); `gh pr merge -R other/repo <n>` gets no waiver (Codex App P2 on PR #1035). The
  migration landing gate does the same from the PR's `url` (see the next entry).

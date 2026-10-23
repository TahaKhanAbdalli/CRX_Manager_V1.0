## 2026-10-22 — a CodeRabbit waiver needs the PR's github.com address

- All three gates now take the PR number for the waiver lookup from `skipPullRequestFor(url, number)` in
  `coderabbit-skip-lib.mjs`, which requires GitHub's answer to be exactly
  `https://github.com/masonwells1/CRX_Manager_V1.0/pull/<that number>`; an enterprise host (`GH_HOST`), a look-alike
  host, another repository or another number gets no waiver (Codex App P2 on PR #1035).

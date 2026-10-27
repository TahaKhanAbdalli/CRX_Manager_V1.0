## 2026-10-27 - CodeRabbit's check run must name the pull request (#1125, Sol)

A check run belongs to a commit, so two PRs with the same head would share it. A check run now
counts only when its summary's CodeRabbit link (`app.coderabbit.ai/change-stack/<owner>/<repo>/pull/<n>`)
names this repository and this PR's number; the requirement read now fetches both. Proven live:
#1134 still reads "reviewed" from its check run on 4a8914672.

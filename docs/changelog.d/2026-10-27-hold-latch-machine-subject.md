## 2026-10-27 - The machine part must be the one told to stop

- From Luna round 30 on PR #1152: a "should stop …ing" sentence is skipped as description only when a machine part is the word right before the modal ("the CI job should stop retrying"), so "The CI maintainer should stop pushing" latches the hold. New guard tests also pin that writing a forged per-session hold file is refused.

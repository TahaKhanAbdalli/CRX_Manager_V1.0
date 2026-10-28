## 2026-10-27 - A look-alike CI tag no longer hides a stop

- From the seventeenth Luna review of PR #1152: a whole message counts as a CI-monitor notice only when its opening tag is exactly `<ci-monitor-event>` (or the tag followed by attributes), so a look-alike such as `<ci-monitor-event-debug>` wrapped around "stop pushing" latches the hold.

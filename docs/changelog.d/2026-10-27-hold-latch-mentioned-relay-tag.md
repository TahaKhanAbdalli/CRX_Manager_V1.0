## 2026-10-27 - A mentioned relay-style tag no longer hides a stop

- From the Sol review of PR #1152: a neutralised relay tag such as `<~heartbeat>` that Mason mentions inside his message no longer makes the whole message machine text, so his "stop" beside it latches, as on main. Such tags are still removed where they appear.

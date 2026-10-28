## 2026-10-27 - A mentioned unclosed tag no longer swallows a later stop

- From the Sol review of PR #1152: an unclosed CI-notice tag or relay-style tag that Mason mentions no longer removes the rest of his message, so a "stop" typed after it latches, as on main. Those tags are removed only as complete open-and-close pairs. Checked against main across 1,650 tag spellings and positions: nothing that latches on main stops latching.

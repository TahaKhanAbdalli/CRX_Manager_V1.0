## 2026-10-27 - A descriptive stop no longer hides a real stop after it

- From Luna round 22 on PR #1152: when deciding whether a stop is only describing a hook or gate, the hold latch now treats every kind of line break (including carriage return and the Unicode line and paragraph separators) and any earlier stop, pause or hold word as the start of a new clause, so "make the gate stop refusing" followed by a real "stop pushing" latches the hold.

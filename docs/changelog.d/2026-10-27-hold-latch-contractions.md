## 2026-10-27 - Hold latch reads contractions and hyphenated verbs

- From the fifth Luna review of PR #1152: a contraction counts as its base word when the descriptive-stop rule looks for a person, so "You'd better stop pushing" still latches; a hyphenated -ing verb ("stop re-running checks") is read whole, so it is treated as description like "stop rerunning".

## 2026-10-27 - The harmless-tail check covers every safe verb

- From Luna round 38 on PR #1152: the check that what follows a safe verb is harmless now applies to every safe verb, not only to retrying, so "make the gate stop refusing database writes" latches the hold.

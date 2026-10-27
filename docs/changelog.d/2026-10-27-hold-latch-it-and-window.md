## 2026-10-27 - "It should stop" latches, and long prompts are checked quickly

- From Luna round 25 on PR #1152: the word "it" no longer counts as a machine part, so "It should stop pushing to main" latches the hold. The descriptive-stop check now looks back at most 1,000 characters for the start of the sentence, and a sentence longer than that latches rather than being judged descriptive, so a very long prompt full of stop words is checked in milliseconds instead of seconds.

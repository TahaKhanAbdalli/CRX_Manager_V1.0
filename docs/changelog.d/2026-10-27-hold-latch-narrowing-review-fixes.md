## 2026-10-27 - Hold-latch narrowing: review fixes before landing

- From the first Luna review of PR #1152: a CI-monitor notice is machine text only when it is the whole message, so Mason's "stop" typed beside one still latches; a stop is never treated as descriptive when an earlier word in the same clause names a person or a want ("I need the agent to stop the deploy" latches); an unusual session id is hashed into the hold file's name instead of stripped, so two sessions never share a file; the bare hand-back frame check is exact; and a test pins the no-session fallback for the guard.

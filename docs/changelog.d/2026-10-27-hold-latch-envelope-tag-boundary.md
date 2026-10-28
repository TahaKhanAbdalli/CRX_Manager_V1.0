## 2026-10-27 - Envelope stripping needs an exact tag name

- From the seventeenth Luna review of PR #1152: removing machine and peer envelopes from a prompt (and the "starts with a machine tag" check) now requires the tag name to end at whitespace or ">", so a look-alike tag such as `<ci-monitor-event-debug>` cannot swallow Mason's "stop pushing". The pre-#794 parser that only gates clearing a hold is unchanged, which keeps clearing no easier.

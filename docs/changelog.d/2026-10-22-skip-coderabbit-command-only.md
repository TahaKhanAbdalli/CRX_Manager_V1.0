## 2026-10-22 — a CodeRabbit waiver saves only the command, not the rest of Mason's message

- `coderabbitSkipCommand()` returns the matched command (for example `skip coderabbit #1018`) and the prompt hook saves
  only that in the waiver file and the gates' notices; the rest of the message, which could hold unrelated private
  text, is never stored (final Sol review on PR #1035, MED).

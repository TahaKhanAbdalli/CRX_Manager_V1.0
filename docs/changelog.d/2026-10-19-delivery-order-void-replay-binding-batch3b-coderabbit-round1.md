## 2026-10-19 — replay-binding batch 3b: CodeRabbit round 1 fixes (not yet applied)

- **Delivery cancel and void buttons can no longer get stuck.** If the server's reply came back
  empty, the screen's result check threw outside any error handler, so the button stayed in its
  loading state with no message. The only way out was leaving the page, which threw away the retry
  key the fix keeps for exactly that case. Both handlers now run the call and its check inside one
  `try`, keep the binding-refusal key reset in the `catch`, and always clear the loading state in
  `finally`, the same shape void order already uses.
- The main batch 3b entry now points to the Luna round 1 entry for the draft-invoice fix.

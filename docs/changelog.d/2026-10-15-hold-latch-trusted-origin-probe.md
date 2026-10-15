## 2026-10-15 — Hold latch: trusted message origin not yet shown readable at hook time (no code change)

Follow-up to the open issue "a helper agent's report can latch, or clear, the hold" in
`docs/manual/KNOWN_ISSUES.md`. Mason chose to fix it by trusted message origin instead of by text
shape (Sol blocked the text-shape fix on PR #940). Before any code was written, a probe checked
whether the hook can read that origin when it runs. The hook input carries no origin, and the one
timed case found the transcript record missing, so reliability was not shown and no fix was built.
Hand-back timing between turns is still untested and may yet allow a check keyed on `prompt_id`.

- **Reproduced live.** A background helper's report listing "Stop, StopFailure" latched the main
  checkout's `hold.json` at 3:12 PM Central. The latched text began at `<agent-message from="…">` with
  no preamble line.
- **No origin in the hook input.** A diagnostic UserPromptSubmit hook in a throwaway Claude Code
  2.1.251 run (scratch folder, outside the repo) captured the input keys `session_id`,
  `transcript_path`, `cwd`, `prompt_id`, `permission_mode`, `hook_event_name` and `prompt`.
- **Transcript record not yet written.** In that run the transcript file did not exist when the hook
  ran for a typed prompt.
- **Record shapes differ.** A between-turns hand-back carries `origin.kind: "peer"` and a `promptId`.
  A mid-turn one is a `queued_command` attachment with no `promptId`.
- **Not probed.** The main checkout's hook could not be instrumented: Mason approved a temporary
  diagnostic, but the worktree-isolation guard refused the edit, and it was not bypassed. The main
  checkout's hook file is unchanged (sha256 `b2bd577b…eefac06` before and after).

The issue stays open; the KNOWN_ISSUES entry records the evidence and the next step.

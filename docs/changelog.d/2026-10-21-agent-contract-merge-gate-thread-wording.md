## 2026-10-21 — AGENTS.md names both merge-gate thread conditions

- Luna round 1 on the agent-contract lean pass (MED): "the merge gates deny while one is open" left
  out that a CodeRabbit thread resolved without a reply is also denied, and that the Codex GitHub App
  check looks at open threads on the exact head. The `AGENTS.md` CodeRabbit bullet now names both,
  matching `.claude/commands/ship.md` Step 8.
- The lean-pass changelog entry no longer claims `.coderabbit.yaml` documents the `docs(` title skip
  (LOW); only `ship.md` does.

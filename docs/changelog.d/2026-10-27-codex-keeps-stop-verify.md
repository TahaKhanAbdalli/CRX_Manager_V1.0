## 2026-10-27 - Codex keeps the stop-verify hook

- Luna round 1 on the dead-guard cleanup: the global verify-before-stop hook covers only Claude sessions, so `stop-verify.mjs` stays wired in `.codex/hooks.json` and is listed in `CODEX_ONLY_HOOKS` (`scripts/agent-manifest-parity.mjs`). Only Claude's wiring is dropped.

## 2026-10-27 - CodeRabbit's check run counts as its review (#1125)

Since about 01:45 UTC CodeRabbit reports a finished review as a `CodeRabbit` check run, not a
commit status, so every money PR read "missing" (#1134). The merge, landing and Sol gates now
also accept a completed SUCCESS check run from CodeRabbit's own app (id 347564) whose summary
starts "Result: Success - Review completed"; skipped runs never count. Sol's "CodeRabbit is
reviewing" wait also sees an unfinished check run. Codex App P2: follow-up patches that contain
CodeRabbit's agent-prompt marker are no longer cut short; only finding bodies drop that block.
Luna: the check-run read is capped (5 suites, 10 runs per commit), so a cut-short list never
counts as "CodeRabbit never reviewed".

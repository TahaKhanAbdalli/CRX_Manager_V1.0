## 2026-10-27 - A comma-separated list of stopped activities is read in full

- From the Codex App review of PR #1152: after a safe verb, a part after a comma that starts with another activity (an -ing word, alone or after "and" / "or") is checked too, so "make the job stop reviewing, sending invoices, and updating records" latches the hold. The words-after scan also reads a bounded window, so very long prompts stay fast.

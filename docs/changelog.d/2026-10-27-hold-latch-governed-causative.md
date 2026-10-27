## 2026-10-27 - "make" only excuses the stop it governs

- From the sixth Codex GitHub App review of PR #1152: a stop is skipped as "make the gate stop …" only when a machine part comes right before the stop and a nearby "make" governs it. "After making the build green stop pushing" now latches the hold and no longer clears an existing one, while "make the gate stop refusing" stays descriptive.

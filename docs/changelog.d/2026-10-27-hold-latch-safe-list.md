## 2026-10-27 - Descriptive stops skip only from a safe list

- From Sol's review of PR #1152 (Mason chose the safe list): a sentence that only describes a stop is skipped only when what stops is on a short list of a hook's own harmless behaviour (refusing, retrying, warning, flagging; reviews, checks, prompts, reminders). Any other wording latches the hold, so a word missing from the list can only add a hold, never lose one. Delete-type words (delete, drop, remove, wipe, purge and similar) also always latch.

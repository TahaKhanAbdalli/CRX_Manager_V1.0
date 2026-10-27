## 2026-10-27 - A stop that uses a flag as a tool latches again

- From the Sol review of PR #1152: a "to stop the …" sentence is skipped as a configuration goal only when it names a settings place (settings, config, env) or assigns a value with "=", and also uses a setting verb such as set, change or disable. "Use the emergency flag to stop the deploy" now latches the hold, as it did before this PR, while "set X=0 in my user settings to stop the per-commit security reviews" stays descriptive.

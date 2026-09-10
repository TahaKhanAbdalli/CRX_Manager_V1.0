## 2026-09-10 - Make unattended autopilot option scans quote-aware

The armed-autopilot deny scanner now replaces complete Bash and PowerShell quoted spans
and escaped characters with inert scan tokens before evaluating destructive-option rules.
This closes cases where a semicolon, pipe, ampersand, parenthesis, or continued line inside
an argument previously hid a later real `-n`, `-Recurse`, `-f`, `-d`, or recursive `rm` flag.
Quoted flags remain meaningful when they occupy an option position, but quoted text supplied to
value-taking options such as `git commit -m` remains ordinary argument data.

Malformed quotes, unterminated escapes, heredocs, and runtime shell expansions (variables,
substitutions, globs, and PowerShell splatting) now deny rather than auto-approve.
`autopilot-lib.test.mjs` exercises every reported bypass through both the library and the
real armed `unattended-autopilot.mjs` JSON boundary, including harmless quoted controls.
The secondary `bash-safety-lib.mjs` guard remains outside this change and retains the same
quoted-separator residual; it was observed independently and is recorded in the PR notes.

#!/usr/bin/env node

import assert from "node:assert/strict";

import { literalReadOnlySearch } from "./read-only-search-lib.mjs";

// Searches whose quoted pattern names a dangerous command are still only
// searches. These are the shapes Codex was refused on 2026-10-27, plus the
// everyday variants.
const recognised = [
  "rg -n 'git push' AGENTS.md",
  'rg -n "supabase db push" docs/workflows/DATABASE_CHANGE_CHECKLIST.md',
  "git grep -n 'apply-migration-file.mjs' -- AGENTS.md",
  "git --no-pager grep -n 'git reset --hard' -- docs",
  "git -C C:/CRX_Manager grep -n 'rm -rf' -- docs",
  "rg -n 'rm -rf' docs",
  'rg -n "a|b" src',
  "rg -n '$(foo)' src",
  "rg -n 'total_cents\\s*\\$' src",
  "rg -n -g '*.ts' 'p_idempotency_key' src",
  "rg --files | rg hooks",
  "rg -n 'gh pr merge' docs | head -20",
  "grep -rn 'vercel --prod' docs | wc -l",
  "Select-String -Path docs/*.md -Pattern 'git push'",
  "Get-ChildItem -Recurse docs | Select-String 'git push'",
  "Get-ChildItem -Recurse docs | Select-String 'git push' | Select-Object -First 5",
  'findstr /S /N /C:"git push" AGENTS.md',
  "rg.exe -n 'git push' AGENTS.md",
  "rg -n docs\\manual 'x'",
  "rg -n '' AGENTS.md",
];
for (const command of recognised) {
  assert.equal(literalReadOnlySearch(command), true, `recognised as a plain search: ${command}`);
}

// Anything that could run something else is NOT recognised (the caller then
// runs its ordinary checks).
const notRecognised = [
  "",
  // Windows PowerShell's legacy native argument passing re-splits an embedded `"`.
  `rg 'x" --pre=calc "y' docs`,
  `rg "x"" --pre=calc ""y" docs`,
  `rg 'x'' --pre=calc ''y' docs`,
  `git grep 'x" -O"calc" "y'`,
  // bash drops a backslash before `-`; cmd.exe splits single-quoted text and expands !VAR!.
  "rg \\--pre calc x docs",
  "rg --p\\re='node scripts/apply-migration-file.mjs' x AGENTS.md",
  "rg --p\\re=echo '^AGENTS.md$' AGENTS.md",
  "rg -\\z x docs",
  "git grep -1O'node scripts/apply-migration-file.mjs' CRX -- AGENTS.md",
  "git grep -1O'echo PAGER_EXECUTED' CRX -- AGENTS.md",
  "rg -1z x docs",
  "git grep --open-files-in-p\\ager=calc x",
  "git grep \\-Ocalc x",
  "rg -g 'x --pre calc y' docs",
  "rg -n 'a -uz b' docs",
  "git -C 'x -c core.fsmonitor=calc' grep -n y",
  // bash expands `*` into file names: `git -C -- push grep --no-verify` is a push.
  "git -C * grep --no-verify",
  "git -C ?? grep -n x",
  "git -C docs/[a-z]* grep -n x",
  "git grep -n 'a --open-files-in-pager=calc b'",
  "rg -n x '!P!'",
  'rg -n x "!P!"',
  "git push origin HEAD:main",
  "rg x; git push origin HEAD:main",
  "rg x && git push origin HEAD:main",
  "rg x & git push origin HEAD:main",
  "rg x | git push origin HEAD:main",
  "rg x | sort -o out.txt",
  "rg x > out.txt",
  "rg x 2>&1",
  "rg x < in.txt",
  "rg x\ngit push origin HEAD:main",
  "rg x $(git push origin HEAD:main)",
  "rg x `git push origin HEAD:main`",
  'rg "$(git push origin HEAD:main)" docs',
  'rg "$env:X" docs',
  'rg "`x" docs',
  'rg "%PATH%" docs',
  'rg "a\\" docs; git push origin HEAD:main; echo "',
  "rg x\\' ; git push origin HEAD:main ; echo '",
  "rg 'a & git push origin HEAD:main' docs",
  "rg 'a | b' docs",
  "rg @args",
  "rg --% x",
  "rg $x docs",
  "rg (x) docs",
  "rg {a,b} docs",
  "rg \u2018git push\u2019 docs",
  "rg --pre 'git push origin HEAD:main' x docs",
  "rg --pre=./evil.sh x docs",
  "rg '--pre=./evil.sh' x docs",
  "rg --pre-glob '*.md' x docs",
  "rg -z x docs",
  "rg -nz x docs",
  "rg --search-zip x docs",
  "rg --hostname-bin ./evil x docs",
  "rg x *",
  "grep -rn x docs/*.md",
  "git grep -O x",
  "git grep -nO x",
  "git grep --open-files-in-pager=vim x",
  "git grep --op x",
  "git grep --textconv x",
  "git grep --textc x",
  "git -c core.pager=evil grep x",
  "git --exec-path=. grep x",
  "git log -S 'git push'",
  "./tools/rg x docs",
  "C:\\tools\\rg.exe x docs",
  "node scripts/x.mjs",
  "Get-ChildItem -Recurse docs",
  "Get-ChildItem docs | Remove-Item",
  "head -5 AGENTS.md",
  "FOO=1 rg x docs",
  "rg 'unterminated",
  'rg "unterminated',
  "rg x |",
  "| rg x",
  "rg x || rg y",
];
for (const command of notRecognised) {
  assert.equal(literalReadOnlySearch(command), false, `not recognised as a plain search: ${JSON.stringify(command)}`);
}
assert.equal(literalReadOnlySearch(`rg -n '${"a".repeat(5000)}' docs`), false, "an over-long command is not inspected");
assert.equal(literalReadOnlySearch(undefined), false);
assert.equal(literalReadOnlySearch(["rg", "x"]), false, "an argv array is not a command string");

console.log("read-only-search-lib tests passed");

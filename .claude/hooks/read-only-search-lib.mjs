// Recognises a shell command that only SEARCHES text: `rg`, `grep`, `git grep`,
// `Select-String` or `findstr` (or a `Get-ChildItem` listing fed into one),
// optionally piped into another search or into
// `head` / `wc` / `Select-Object` / `Measure-Object`. Shared by bash-safety.mjs
// (Claude and Codex) and the Codex production-action-guard.mjs, which used to
// refuse searches such as `rg -n 'git push' AGENTS.md` because the quoted
// PATTERN looked like the command it names (Codex reproduced this 2026-10-27).
//
// The answer is true only when every byte of the command is accounted for: one
// line, no command separator, redirect, grouping, substitution or variable
// outside quotes, and nothing inside quotes that bash, PowerShell or cmd.exe
// would expand or treat as a separator. Anything else returns false, which
// means "not recognised" — the caller runs its ordinary checks, it does not
// mean "refuse". Search options that can START another program (`rg --pre`,
// `rg --search-zip`, `rg --hostname-bin`, `git grep --open-files-in-pager`,
// `git grep --textconv`, git's own `-c` / `--exec-path`) are not recognised.
// Reading a file is not a write, so callers keep only the checks that are about
// reading (review-proof files).

const SEARCH_HEADS = new Set(["rg", "grep", "egrep", "fgrep", "findstr", "select-string", "sls"]);
const FILTER_HEADS = new Set(["head", "wc", "select-object", "measure-object"]);
// PowerShell cmdlets: they expand their own wildcards and run nothing.
const LISTING_HEADS = new Set(["get-childitem", "gci"]);
const MAX_LENGTH = 4000;

// Smart quotes are string delimiters to PowerShell but ordinary characters to
// bash, so the two shells would split such a command differently.
const AMBIGUOUS_QUOTE_RE = /[‘’‚‛“”„‟]/;

// Splits into pipeline stages of words (quotes removed), or returns null when
// some character could mean something other than literal text to one of the
// shells the agents use.
function literalPipeline(command) {
  const stages = [[]];
  let word = null;
  let wordHasGlob = false;
  let pieces = [];
  const endWord = () => {
    if (word !== null) stages[stages.length - 1].push({ text: word, glob: wordHasGlob, pieces });
    word = null;
    wordHasGlob = false;
    pieces = [];
  };
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];
    if (ch === "'") {
      const close = command.indexOf("'", i + 1);
      if (close < 0) return null;
      const body = command.slice(i + 1, close);
      // cmd.exe does not treat ' as a quote, so its separators stay live there.
      // A `"` is refused too: Windows PowerShell's legacy argument passing
      // rebuilds a native program's command line without escaping it, so
      // `'x" --pre=calc "y'` would reach rg as a separate --pre option.
      // cmd.exe also expands `!VAR!` (delayed expansion).
      if (/[|&<>^%"!]/.test(body)) return null;
      // `'it''s'` is ONE string with a quote inside in PowerShell, two strings here.
      if (command[close + 1] === "'") return null;
      // cmd.exe splits the body at spaces, so each piece may arrive as its own
      // argument there (`rg -g 'x --pre calc y'`); the option checks see them all.
      pieces.push(...body.split(/\s+/).filter(Boolean));
      word = (word ?? "") + body;
      i = close;
      continue;
    }
    if (ch === '"') {
      const close = command.indexOf('"', i + 1);
      if (close < 0) return null;
      const body = command.slice(i + 1, close);
      // `$` and a backtick expand inside double quotes (bash and PowerShell),
      // `%` and `!VAR!` (delayed expansion) do in cmd.exe, and a backslash
      // before the closing quote ends the string in PowerShell but escapes it in bash.
      if (/[$`%!]/.test(body) || body.endsWith("\\")) return null;
      // `"x"" --pre=calc ""y"` is ONE PowerShell string holding quotes, which
      // legacy argument passing splits back into separate rg options.
      if (command[close + 1] === '"') return null;
      word = (word ?? "") + body;
      i = close;
      continue;
    }
    if (ch === " " || ch === "\t") {
      endWord();
      continue;
    }
    if (ch === "|") {
      endWord();
      if (stages[stages.length - 1].length === 0) return null;
      stages.push([]);
      continue;
    }
    // A backslash is an escape in bash (`\'`, `\;`) but a path separator in
    // PowerShell, so it is accepted only before a character neither shell
    // gives a meaning to. Not before `-`: bash drops the backslash, so
    // `rg \--pre calc` reaches rg as the --pre option the checks below refuse.
    if (ch === "\\") {
      if (!/[A-Za-z0-9_./\\]/.test(command[i + 1] ?? "")) return null;
      word = (word ?? "") + ch;
      continue;
    }
    // `@` is excluded: `@name` splats a variable in PowerShell.
    if (!/[A-Za-z0-9_.,:=+\-/~*?\[\]]/.test(ch)) return null;
    if (/[*?[\]]/.test(ch)) wordHasGlob = true;
    word = (word ?? "") + ch;
  }
  endWord();
  if (stages.some((stage) => stage.length === 0)) return null;
  return stages;
}

// A bare program name only: `./tools/rg` is whatever that file is, not ripgrep.
function headName(word) {
  if (/[\\/]/.test(word)) return "";
  return word.toLowerCase().replace(/\.exe$/, "");
}

// rg options that run another program, and its short-flag letter for one.
function rgOptionRunsProgram(option) {
  if (/^--(?:pre|pre-glob|search-zip|hostname-bin)(?:=|$)/i.test(option)) return true;
  // Any short bundle holding `z`, whatever precedes it (`-1z`, `-nz`); a `z`
  // that is really an option's value is refused too, which only costs a fallback.
  return /^-[^-]/.test(option) && option.includes("z");
}

// git accepts any unambiguous prefix of a long option, so `--op` is
// `--open-files-in-pager`; `--text` alone is a different, harmless option.
function gitGrepOptionRunsProgram(option) {
  const name = option.replace(/=.*$/, "");
  // `-O` anywhere in a short bundle, including after a context count (`-1O`).
  if (/^-[^-]/.test(name) && option.includes("O")) return true;
  if (!name.startsWith("--")) return false;
  const bare = name.slice(2).toLowerCase();
  if (bare.length >= 2 && "open-files-in-pager".startsWith(bare)) return true;
  if (bare.length >= 5 && "textconv".startsWith(bare)) return true;
  return false;
}

function searchStageIsLiteral(words) {
  const head = headName(words[0].text);
  if (head === "git") {
    // Only `git [--no-pager] [-C <dir>] grep …`.
    let i = 1;
    while (i < words.length && words[i].text !== "grep") {
      if (words[i].text === "--no-pager") i += 1;
      // A spaced `-C 'dir'` could hand git `-c key=value` under cmd.exe, and
      // bash expands an unquoted `-C *` into file names that git reads as a
      // different subcommand (`git -C -- push grep …`).
      else if (words[i].text === "-C" && i + 1 < words.length && words[i + 1].pieces.length <= 1 && !words[i + 1].glob) i += 2;
      else return false;
    }
    if (i >= words.length) return false;
    return words.slice(i + 1).every((w) => !w.glob && !asArguments(w).some(gitGrepOptionRunsProgram));
  }
  if (!SEARCH_HEADS.has(head)) return false;
  // PowerShell expands a cmdlet's wildcard path itself; for a native program
  // an unquoted wildcard is expanded by bash into file names, which could
  // arrive as options.
  const cmdlet = head === "select-string" || head === "sls";
  return words.slice(1).every((w) => (cmdlet || !w.glob) && !(head === "rg" && asArguments(w).some(rgOptionRunsProgram)));
}

// Every argument a word may reach the program as: itself, or under cmd.exe each
// space-separated piece of its single-quoted text, each also as bash reads it
// with its backslashes dropped (`--p\re` is `--pre` to bash).
function asArguments(word) {
  const spellings = [word.text, ...word.pieces];
  return [...spellings, ...spellings.map((text) => text.replace(/\\(.)/g, "$1"))];
}

function filterStageIsLiteral(words) {
  return FILTER_HEADS.has(headName(words[0].text)) && words.every((w) => !w.glob);
}

export function literalReadOnlySearch(command) {
  const text = String(command ?? "").trim();
  if (!text || text.length > MAX_LENGTH || /[\r\n]/.test(text) || AMBIGUOUS_QUOTE_RE.test(text)) return false;
  const stages = literalPipeline(text);
  if (!stages) return false;
  // `Get-ChildItem -Recurse docs | Select-String 'x'`: a file listing may feed a search.
  const listing = stages.length > 1 && LISTING_HEADS.has(headName(stages[0][0].text));
  if (!listing && !searchStageIsLiteral(stages[0])) return false;
  return stages.slice(1).every((stage) => searchStageIsLiteral(stage) || filterStageIsLiteral(stage));
}

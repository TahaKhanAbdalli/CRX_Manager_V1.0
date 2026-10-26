// Pure comparison logic for the code-health ratchet (scripts/check-code-health.mjs).
// Kept free of ESLint and Knip so the ratchet rules can be tested directly.

// Limits for app code. Existing violations are grandfathered in the baseline; only
// new ones fail. Raise a limit only with a written reason, never to pass one change.
export const SIZE_RULES = {
  'max-lines': ['error', { max: 600, skipBlankLines: true, skipComments: true }],
  'max-lines-per-function': ['error', { max: 200, skipBlankLines: true, skipComments: true }],
  complexity: ['error', 20],
  'max-depth': ['error', 4],
  'max-params': ['error', 5],
  'max-nested-callbacks': ['error', 4],
};

export const SOURCE_GLOB = 'src/**/*.{js,jsx,ts,tsx}';

// Options for `new ESLint(...)`. The repo config only registers TypeScript files, so without the
// files/JSX entry ESLint skips `.jsx` modules. An inline `eslint-disable` must not hide a size or
// complexity violation from the ratchet.
export function sizeLintOptions(cwd) {
  return {
    cwd,
    overrideConfig: {
      files: [SOURCE_GLOB],
      languageOptions: { parserOptions: { ecmaFeatures: { jsx: true } } },
      rules: SIZE_RULES,
    },
    ruleFilter: ({ ruleId }) => ruleId in SIZE_RULES,
    allowInlineConfig: false,
  };
}

// Tests may be long and repetitive, and the two type catalogs are one long list by design.
const SKIPPED_FILE = /\.test\.[jt]sx?$|^src\/tests\/|^src\/types\/(?:supabase|index)\.ts$/;

export function relativePath(root, file) {
  const normalizedRoot = root.replace(/\\/g, '/').replace(/\/$/, '');
  return file.replace(/\\/g, '/').replace(`${normalizedRoot}/`, '');
}

export function isCheckedSourceFile(relative) {
  return relative.startsWith('src/') && !SKIPPED_FILE.test(relative);
}

// ── Which function a finding belongs to ──
// ESLint's messages call most functions just "Arrow function", so findings are keyed by the
// function's place in the code instead: its owner chain from the file's syntax tree, such as
// "QuoteBuilder > handleSave > map". Fixing one grandfathered function then cannot make room
// for a different new one in the same file, for every rule, nesting depth included.

const FUNCTION_TYPES = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);
// Climbing past one of these would borrow a name from unrelated surrounding code.
const NAME_BOUNDARY = /Statement$|Declaration$|^JSXElement$|^JSXFragment$|^Program$/;

function keyName(key) {
  return key?.name ?? (key?.value != null ? String(key.value) : null);
}

// What the code calls this function: its own name, the variable, key, prop or assignment it
// is bound to, or failing those the call it is handed to (`items.map(...)` -> "map").
function functionName(node, ancestors) {
  if (node.id?.name) return node.id.name;
  let callee = null;
  for (let i = ancestors.length - 1; i >= 0; i--) {
    const a = ancestors[i];
    if (a.type === 'VariableDeclarator') return keyName(a.id) ?? callee ?? 'anonymous';
    if (['Property', 'MethodDefinition', 'PropertyDefinition'].includes(a.type)) return keyName(a.key) ?? 'anonymous';
    if (a.type === 'JSXAttribute') return keyName(a.name) ?? 'anonymous';
    if (a.type === 'AssignmentExpression') return keyName(a.left.property ?? a.left) ?? 'anonymous';
    if (a.type === 'CallExpression' && !callee) callee = keyName(a.callee.property ?? a.callee);
    if (FUNCTION_TYPES.has(a.type) || NAME_BOUNDARY.test(a.type)) break;
  }
  return callee ?? 'anonymous';
}

// Every function in the file with its location and owner chain.
export function functionSpans(ast) {
  const spans = [];
  const walk = (node, ancestors, chain) => {
    let ownChain = chain;
    if (FUNCTION_TYPES.has(node.type)) {
      ownChain = [...chain, functionName(node, ancestors)];
      // ESLint reports a method (`save() {}`, class methods, getters) at its name, which sits
      // on the parent node before the function itself starts.
      const parent = ancestors.at(-1);
      const isMethod = ['Property', 'MethodDefinition'].includes(parent?.type) && parent.value === node;
      const start = isMethod ? parent.loc.start : node.loc.start;
      spans.push({ start, end: node.loc.end, chain: ownChain.join(' > ') });
    }
    for (const [field, value] of Object.entries(node)) {
      if (field === 'parent' || field === 'loc' || field === 'range') continue;
      for (const child of Array.isArray(value) ? value : [value]) {
        if (child && typeof child.type === 'string') walk(child, [...ancestors, node], ownChain);
      }
    }
  };
  walk(ast, [], []);
  return spans;
}

const before = (a, b) => a.line < b.line || (a.line === b.line && a.column <= b.column);

// The innermost function containing an ESLint position (1-based line and column).
export function ownerAt(spans, line, column) {
  const point = { line, column: column - 1 };
  let best = null;
  for (const span of spans) {
    if (before(span.start, point) && before(point, span.end)) {
      if (!best || before(best.start, span.start)) best = span;
    }
  }
  return best?.chain ?? '(module)';
}

export function findingKey(message, spans) {
  if (message.ruleId === 'max-lines') return 'max-lines';
  return `${message.ruleId} ${ownerAt(spans, message.line, message.column)}`;
}

// ESLint results -> { file: { findingKey: count } }. `parseSource(filePath)` returns the
// file's syntax tree with locations; a file it cannot parse fails the check.
export function summarizeSizeResults(root, results, parseSource) {
  const size = {};
  for (const result of results) {
    const file = relativePath(root, result.filePath);
    if (!isCheckedSourceFile(file)) continue;
    let spans;
    for (const message of result.messages) {
      if (message.fatal) throw new Error(`${file}: ESLint could not parse the file: ${message.message}`);
      // A rule-less notice such as "File ignored because no matching configuration was supplied"
      // means the file was never measured.
      if (!message.ruleId) throw new Error(`${file}: ESLint did not measure the file: ${message.message}`);
      if (!(message.ruleId in SIZE_RULES)) continue;
      spans ??= functionSpans(parseSource(result.filePath));
      const key = findingKey(message, spans);
      size[file] ??= {};
      size[file][key] = (size[file][key] || 0) + 1;
    }
  }
  return sortKeys(size);
}

// Knip JSON report -> { file: ["export:name", "type:name", ...] }
export function summarizeUnusedResults(report) {
  if (!report || !Array.isArray(report.issues)) throw new Error('Knip returned no issues list');
  const unused = {};
  const add = (file, item) => {
    unused[file] ??= [];
    if (!unused[file].includes(item)) unused[file].push(item);
  };
  for (const file of report.files || []) add(file.replace(/\\/g, '/'), 'file');
  for (const issue of report.issues) {
    const file = issue.file.replace(/\\/g, '/');
    for (const kind of ['files', 'exports', 'types', 'duplicates']) {
      for (const item of Object.values(issue[kind] || {})) {
        if (kind === 'files') add(file, 'file');
        else add(file, `${kind.replace(/s$/, '')}:${itemName(item)}`);
      }
    }
  }
  for (const file of Object.keys(unused)) unused[file].sort();
  return sortKeys(unused);
}

function itemName(item) {
  if (Array.isArray(item)) return item.map(itemName).join('|');
  return item?.name ?? String(item);
}

function sortKeys(object) {
  return Object.fromEntries(Object.entries(object).sort(([a], [b]) => a.localeCompare(b)));
}

// Anything in current that the baseline does not already allow is a regression.
export function findRegressions(baseline, current) {
  const regressions = [];
  for (const [file, findings] of Object.entries(current.size)) {
    for (const [key, count] of Object.entries(findings)) {
      const allowed = baseline.size?.[file]?.[key] || 0;
      if (count > allowed) regressions.push(`${file}: ${key} — ${count} found, baseline allows ${allowed}`);
    }
  }
  for (const [file, items] of Object.entries(current.unused)) {
    const allowed = new Set(baseline.unused?.[file] || []);
    for (const item of items) {
      if (!allowed.has(item)) regressions.push(`${file}: unused ${item}`);
    }
  }
  return regressions;
}

// Baseline entries the code no longer has: the baseline can shrink by that much.
export function findImprovements(baseline, current) {
  const improvements = [];
  for (const [file, findings] of Object.entries(baseline.size || {})) {
    for (const [key, allowed] of Object.entries(findings)) {
      const count = current.size[file]?.[key] || 0;
      if (count < allowed) improvements.push(`${file}: ${key} ${allowed} -> ${count}`);
    }
  }
  for (const [file, items] of Object.entries(baseline.unused || {})) {
    const present = new Set(current.unused[file] || []);
    for (const item of items) {
      if (!present.has(item)) improvements.push(`${file}: unused ${item} is gone`);
    }
  }
  return improvements;
}

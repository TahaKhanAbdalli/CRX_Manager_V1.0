import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint, Linter } from 'eslint';
import tseslint from 'typescript-eslint';
import {
  findImprovements,
  findRegressions,
  isCheckedSourceFile,
  sizeLintOptions,
  summarizeSizeResults,
  summarizeUnusedResults,
} from './check-code-health-lib.mjs';

const ROOT = 'C:\\repo';
const parse = (source) => () => tseslint.parser.parseForESLint(source, { jsx: true, loc: true, range: true }).ast;

// A finding located at the first `needle` on 1-based line `line` of `source`.
const finding = (source, ruleId, line, needle) => {
  const column = source.split('\n')[line - 1].indexOf(needle) + 1;
  assert.ok(column > 0, `test setup: "${needle}" not on line ${line}`);
  return { ruleId, message: 'over the limit', line, column };
};

const BIG = [
  'export function Big() {',
  '  const handleSave = useCallback(async () => {',
  '    if (a) { if (b) { if (c) { if (d) { if (e) { go(); } } } } }',
  '  }, []);',
  '  const rows = list.filter((row) => row.ok);',
  '  return <ul>{items.map((item) => <li onClick={() => save(item)} />)}</ul>;',
  '}',
  'export const top = run(1, 2, 3, 4, 5, 6);',
].join('\n');
assert.deepEqual(
  summarizeSizeResults(ROOT, [
    {
      filePath: 'C:\\repo\\src\\pages\\Big.tsx',
      messages: [
        finding(BIG, 'complexity', 1, 'function Big'),
        finding(BIG, 'complexity', 2, 'async ()'),
        finding(BIG, 'max-depth', 3, 'if (e)'),
        finding(BIG, 'complexity', 5, '(row)'),
        finding(BIG, 'complexity', 6, '(item)'),
        finding(BIG, 'complexity', 6, '() => save'),
        finding(BIG, 'max-nested-callbacks', 8, 'run('),
        { ruleId: 'max-lines', message: 'File has too many lines (700).', line: 601, column: 1 },
        { ruleId: 'no-console', message: 'Unexpected console statement.', line: 1, column: 1 },
      ],
    },
    { filePath: 'C:\\repo\\src\\pages\\Big.test.tsx', messages: [finding(BIG, 'complexity', 1, 'function')] },
    { filePath: 'C:\\repo\\src\\legacy\\old.test.js', messages: [finding(BIG, 'complexity', 1, 'function')] },
    { filePath: 'C:\\repo\\src\\types\\supabase.ts', messages: [{ ruleId: 'max-lines', message: 'x', line: 1, column: 1 }] },
  ], parse(BIG)),
  {
    'src/pages/Big.tsx': {
      'complexity Big': 1,
      'complexity Big > handleSave': 1,
      'complexity Big > map': 1,
      'complexity Big > map > onClick': 1,
      'complexity Big > rows': 1,
      'max-depth Big > handleSave': 1,
      'max-lines': 1,
      'max-nested-callbacks (module)': 1,
    },
  },
  'every finding is keyed by the owner chain of the function it sits in; tests and type catalogs are skipped',
);

// Codex App P2 on #1117: moving a violation from one arrow handler to another must not pass,
// and neither may moving a deep block from one function to another (Luna round 3).
const HANDLERS = [
  'const oldHandler = () => { if (a) { if (b) { if (c) { if (d) { if (e) {} } } } } };',
  'const newHandler = () => { if (a) { if (b) { if (c) { if (d) { if (e) {} } } } } };',
].join('\n');
const at = (ruleId, line, needle) => summarizeSizeResults(ROOT, [{
  filePath: 'C:\\repo\\src\\pages\\H.tsx',
  messages: [finding(HANDLERS, ruleId, line, needle)],
}], parse(HANDLERS));
assert.deepEqual(
  findRegressions({ size: at('complexity', 1, '() =>'), unused: {} }, { size: at('complexity', 2, '() =>'), unused: {} }),
  ['src/pages/H.tsx: complexity newHandler — 1 found, baseline allows 0'],
  'fixing one arrow handler does not make room for a different new one',
);
assert.deepEqual(
  findRegressions({ size: at('max-depth', 1, 'if (e)'), unused: {} }, { size: at('max-depth', 2, 'if (e)'), unused: {} }),
  ['src/pages/H.tsx: max-depth newHandler — 1 found, baseline allows 0'],
  'fixing one deep block does not make room for a different new one',
);
// Codex App P2 on #1117 (second round): ESLint reports methods at their name, before the
// function node starts. Real ESLint positions must still land on the method, not its parent.
const METHODS = [
  'export function App() {',
  '  const api = { save(a) { return a ? 1 : 2; }, get total() { return x ? 1 : 2; } };',
  '  class Store { load(b) { return b ? 1 : 2; } static make(c) { return c ? 1 : 2; } }',
  '  return [api, Store];',
  '}',
].join('\n');
const linted = new Linter({ configType: 'flat' }).verify(METHODS, {
  files: ['**/*.ts'],
  languageOptions: { parser: tseslint.parser },
  rules: { complexity: ['error', 1] },
}, 'Methods.ts');
assert.deepEqual(
  summarizeSizeResults(ROOT, [{ filePath: 'C:\\repo\\src\\Methods.ts', messages: linted }], parse(METHODS)),
  {
    'src/Methods.ts': {
      'complexity App > load': 1,
      'complexity App > make': 1,
      'complexity App > save': 1,
      'complexity App > total': 1,
    },
  },
  'shorthand, getter, and class methods keep their own identity with real ESLint positions',
);

// Codex App P2 on #1117 (third round): the repo's ESLint config only registers TypeScript, so a
// `.jsx` module went unmeasured. Lint through the real repo config with the ratchet's options.
const REPO = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const PROBE = 'export function probe(a, b, c, d, e, f) { return <i>{a + b + c + d + e + f}</i>; }\n';
const repoLint = new ESLint(sizeLintOptions(REPO));
for (const ext of ['jsx', 'tsx', 'js', 'ts']) {
  const code = ext.endsWith('x') ? PROBE : 'export function probe(a, b, c, d, e, f) { return a + b + c + d + e + f; }\n';
  const filePath = path.join(REPO, 'src', `__ratchet_probe__.${ext}`);
  const [result] = await repoLint.lintText(code, { filePath });
  assert.deepEqual(
    summarizeSizeResults(REPO, [result], () => tseslint.parser.parseForESLint(code, { jsx: true, loc: true, range: true }).ast),
    { [`src/__ratchet_probe__.${ext}`]: { 'max-params probe': 1 } },
    `a .${ext} module is measured through the repo ESLint config`,
  );
}
assert.throws(
  () => summarizeSizeResults(ROOT, [{
    filePath: 'C:\\repo\\src\\a.jsx',
    messages: [{ ruleId: null, message: 'File ignored because no matching configuration was supplied.' }],
  }], parse(BIG)),
  /did not measure/,
  'a file ESLint skipped fails closed instead of passing unmeasured',
);

assert.throws(
  () => summarizeSizeResults(ROOT, [{ filePath: 'C:\\repo\\src\\a.ts', messages: [{ fatal: true, message: 'bad' }] }], parse(BIG)),
  /could not parse/,
  'a file ESLint cannot parse fails closed instead of passing unmeasured',
);
assert.equal(isCheckedSourceFile('src/lib/money.ts'), true);
assert.equal(isCheckedSourceFile('scripts/x.mjs'), false);

assert.deepEqual(
  summarizeUnusedResults({
    files: ['src\\lib\\orphan.ts'],
    issues: [{ file: 'src/lib/a.ts', exports: { foo: { name: 'foo' } }, types: [{ name: 'Bar' }], duplicates: [[{ name: 'x' }, { name: 'y' }]] }],
  }),
  { 'src/lib/a.ts': ['duplicate:x|y', 'export:foo', 'type:Bar'], 'src/lib/orphan.ts': ['file'] },
  'Knip findings become stable per-file labels',
);
assert.throws(() => summarizeUnusedResults({}), /no issues list/, 'an unreadable Knip report fails closed');

const OLD = "complexity Function 'Old'";
const baseline = {
  size: { 'src/pages/Big.tsx': { [OLD]: 1, 'max-depth': 2 } },
  unused: { 'src/lib/a.ts': ['export:foo'] },
};
assert.deepEqual(findRegressions(baseline, baseline), [], 'the baseline itself passes');
assert.deepEqual(
  findRegressions(baseline, {
    size: { 'src/pages/Big.tsx': { 'max-depth': 3 }, 'src/pages/New.tsx': { 'max-depth': 1 } },
    unused: { 'src/lib/a.ts': ['export:foo', 'export:bar'] },
  }),
  [
    'src/pages/Big.tsx: max-depth — 3 found, baseline allows 2',
    'src/pages/New.tsx: max-depth — 1 found, baseline allows 0',
    'src/lib/a.ts: unused export:bar',
  ],
  'a grandfathered file cannot gain violations, a new file gets none, and new unused exports fail',
);
assert.deepEqual(
  findRegressions(baseline, {
    size: { 'src/pages/Big.tsx': { "complexity Function 'New'": 1, 'max-depth': 2 } },
    unused: {},
  }),
  ["src/pages/Big.tsx: complexity Function 'New' — 1 found, baseline allows 0"],
  'fixing one grandfathered function does not make room for a different new one',
);
assert.deepEqual(
  findImprovements(baseline, { size: { 'src/pages/Big.tsx': { 'max-depth': 1 } }, unused: {} }),
  [
    `src/pages/Big.tsx: ${OLD} 1 -> 0`,
    'src/pages/Big.tsx: max-depth 2 -> 1',
    'src/lib/a.ts: unused export:foo is gone',
  ],
  'fixed debt is reported so the baseline can shrink',
);

console.log('PASS - code-health ratchet blocks new debt and only lets the baseline shrink.');

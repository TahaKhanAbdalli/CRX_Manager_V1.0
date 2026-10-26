#!/usr/bin/env node
// Code-health ratchet for src/: fails on NEW oversized or tangled code (ESLint size and
// complexity rules) and NEW unused files or exports (Knip). What already exists is listed in
// scripts/code-health-baseline.json and grandfathered. The baseline may only shrink:
// `--update` rewrites it after a cleanup and refuses while any regression remains.
//
//   node scripts/check-code-health.mjs           check (CI)
//   node scripts/check-code-health.mjs --update  shrink the baseline after a cleanup

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import tseslint from 'typescript-eslint';
import {
  SOURCE_GLOB,
  findImprovements,
  findRegressions,
  sizeLintOptions,
  summarizeSizeResults,
  summarizeUnusedResults,
} from './check-code-health-lib.mjs';

const ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const BASELINE = path.join(ROOT, 'scripts', 'code-health-baseline.json');
const update = process.argv.includes('--update');
const init = process.argv.includes('--init');

function parseSource(file) {
  const source = readFileSync(file, 'utf8');
  return tseslint.parser.parseForESLint(source, { jsx: /\.[jt]sx$/.test(file), loc: true, range: true }).ast;
}

async function measureSize() {
  const eslint = new ESLint(sizeLintOptions(ROOT));
  const results = await eslint.lintFiles([SOURCE_GLOB]);
  return summarizeSizeResults(ROOT, results, parseSource);
}

// A change could raise its own baseline to admit new debt, so the baseline here must allow
// nothing the base branch's copy does not. CI sets CODE_HEALTH_BASE to the PR's base branch.
function baselineGrowth(baseline) {
  const base = process.env.CODE_HEALTH_BASE || 'origin/main';
  const git = (...args) => spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (git('rev-parse', '--verify', '--quiet', `${base}^{commit}`).status !== 0) {
    throw new Error(`Cannot find ${base} to compare the baseline against; fetch it first.`);
  }
  const basePath = `${base}:scripts/code-health-baseline.json`;
  if (git('cat-file', '-e', basePath).status !== 0) return []; // the base predates the baseline
  const shown = git('show', basePath);
  if (shown.status !== 0) throw new Error(`Could not read ${basePath}: ${shown.stderr}`);
  return findRegressions(JSON.parse(shown.stdout), baseline);
}

// Unused exported TYPES are deliberately not checked: exporting the parameter or result type of a
// shared function is normal practice even when no other file names it, and the queued-PR pre-check
// on 2026-10-26 showed that category failing most ordinary changes for no cleanliness gain.
function measureUnused() {
  const knip = spawnSync(
    process.execPath,
    [path.join(ROOT, 'node_modules', 'knip', 'bin', 'knip.js'), '--no-progress', '--no-config-hints',
      '--include', 'files,exports,duplicates', '--reporter', 'json'],
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  // Knip exits 1 when it finds issues; anything else, or unreadable output, fails closed.
  if (knip.error || (knip.status !== 0 && knip.status !== 1)) {
    throw new Error(`Knip failed to run (exit ${knip.status}): ${knip.error?.message || knip.stderr}`);
  }
  try {
    return summarizeUnusedResults(JSON.parse(knip.stdout));
  } catch (error) {
    throw new Error(`Knip output was not a readable report: ${error.message}\n${knip.stderr}`);
  }
}

function write(current) {
  writeFileSync(BASELINE, `${JSON.stringify(current, null, 2)}\n`);
}

const current = { size: await measureSize(), unused: measureUnused() };

if (!existsSync(BASELINE)) {
  if (!init) {
    console.error(`FAIL - ${path.relative(ROOT, BASELINE)} is missing. Restore it from git; --init is for first setup only.`);
    process.exit(1);
  }
  write(current);
  console.log('PASS - code-health baseline created.');
  process.exit(0);
}

const baseline = JSON.parse(readFileSync(BASELINE, 'utf8'));
const growth = baselineGrowth(baseline);
if (growth.length) {
  console.error('FAIL - scripts/code-health-baseline.json allows debt its base-branch copy does not:');
  for (const line of growth) console.error(`  ${line}`);
  console.error('\nThe baseline may only shrink. Fix the code instead, or merge the latest main if a');
  console.error('cleanup there already shrank it.');
  process.exit(1);
}
const regressions = findRegressions(baseline, current);
const improvements = findImprovements(baseline, current);

if (regressions.length) {
  console.error('FAIL - new oversized, tangled, or unused code in src/:');
  for (const line of regressions) console.error(`  ${line}`);
  console.error('\nSplit the function or file, simplify the logic, or delete the unused export/file.');
  console.error('Limits: scripts/check-code-health-lib.mjs. Existing debt is grandfathered in');
  console.error('scripts/code-health-baseline.json, which may only shrink (--update refuses growth).');
  process.exit(1);
}

if (update) {
  write(current);
  console.log(`PASS - baseline shrunk by ${improvements.length} entr${improvements.length === 1 ? 'y' : 'ies'}.`);
} else {
  if (improvements.length) {
    console.log(`Note: ${improvements.length} grandfathered entr${improvements.length === 1 ? 'y is' : 'ies are'} fixed; run with --update to lock that in.`);
  }
  console.log('PASS - no new oversized, tangled, or unused code in src/.');
}

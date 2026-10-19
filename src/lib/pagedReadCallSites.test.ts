import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

// fetchAllRows only checks a paged read against the server's row count when
// each page carries `count`, i.e. when the query selects with
// `{ count: 'exact' }`. Without it the check is skipped silently and a list
// that changed mid-read can come back short. Every paged read on a page must
// therefore request the count.

const PAGES_DIR = join(__dirname, '..', 'pages');

// Files not checked yet, each with its reason.
const EXEMPT: Record<string, string> = {
  'Reports.tsx': 'open PRs #954/#955/#957 change this file; Goal 4 follow-up',
  'SalesReports.tsx': 'open PRs #954/#955/#957 change this file; Goal 4 follow-up',
  'Deliveries.tsx': 'open PRs #954/#955/#957 change this file; Goal 4 follow-up',
};

const CALL_PATTERN = /\bfetchAllRows(?:ForIds)?\s*(?:<[^()]*?>)?\s*\(/g;

type CallSite = { file: string; line: number; callback: string };

// Shared readers outside src/pages that page with fetchAllRows. The integrity
// checks recompute ledgers from these reads, so a short read is a false result.
const LIB_FILES = ['reconciliation.ts'];

function findCallSites(): CallSite[] {
  const sites: CallSite[] = [];
  const pageFiles = readdirSync(PAGES_DIR).sort()
    .filter((file) => file.endsWith('.tsx') && !file.endsWith('.test.tsx') && !(file in EXEMPT))
    .map((file) => ({ file: `src/pages/${file}`, path: join(PAGES_DIR, file) }));
  const libFiles = LIB_FILES.map((file) => ({ file: `src/lib/${file}`, path: join(__dirname, file) }));
  for (const { file, path } of [...pageFiles, ...libFiles]) {
    // Comments are blanked (same length, newlines kept, so lines still match)
    // so a comment mentioning the count cannot satisfy the check. Blanking only
    // removes text, so a misread string can only make a site fail, never pass.
    const source = readFileSync(path, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
      .replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length));
    const starts = [...source.matchAll(CALL_PATTERN)].map((m) => m.index ?? 0);
    starts.forEach((start, i) => {
      const nextCall = i + 1 < starts.length ? starts[i + 1] : source.length;
      const rangeAt = source.indexOf('.range(', start);
      const line = source.slice(0, start).split('\n').length;
      // The callback's `.range(` must come before the next paged call; otherwise
      // a later query's count could mask this one, so record nothing and fail.
      const ownsRange = rangeAt !== -1 && rangeAt < nextCall;
      sites.push({ file, line, callback: ownsRange ? source.slice(start, rangeAt) : '' });
    });
  }
  return sites;
}

describe('paged list reads request the exact row count', () => {
  const sites = findCallSites();

  it('finds the paged reads (a pattern that matches nothing must fail)', () => {
    expect(sites.length).toBeGreaterThanOrEqual(20);
    expect(sites.filter((site) => site.file === 'src/lib/reconciliation.ts').length).toBeGreaterThanOrEqual(10);
  });

  it("every fetchAllRows / fetchAllRowsForIds call selects with { count: 'exact' }", () => {
    const offenders = sites
      .filter((site) => !site.callback.includes("count: 'exact'"))
      .map((site) => `${site.file}:${site.line}`);
    expect(offenders, `paged reads without { count: 'exact' }:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('every exempt file still exists (drop the entry once the file is covered)', () => {
    const files = new Set(readdirSync(PAGES_DIR));
    for (const file of Object.keys(EXEMPT)) expect(files.has(file), file).toBe(true);
  });
});

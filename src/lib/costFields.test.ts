/**
 * Cost and margin are ADMIN-ONLY (Mason, 2026-10-15; Goal 1 part 3). Step 3 revokes the cost
 * columns from the API roles, admins included, so these guards fail the build when:
 *  - any screen reads a cost table with `*` (or a bare `.select()` after a write), directly or
 *    through an embedded relation, or names one of its cost columns in a select string;
 *  - a column list in costFields.ts drifts from the schema registry.
 * Admin screens read cost only through get_admin_cost_fields (withAdminCosts and friends).
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const rpc = vi.fn();
// The real assertRpcResult (no side effects), so an empty reply still fails the helpers (CodeRabbit).
vi.mock('./db', async (importOriginal) => ({
  supabase: { rpc: (...args: unknown[]) => rpc(...args) },
  assertRpcResult: (await importOriginal<typeof import('./db')>()).assertRpcResult,
}));

import * as costFieldsModule from './costFields';
import {
  COST_COLUMNS,
  SAFE_COLUMNS,
  withAdminCosts,
  withAdminNestedCosts,
  type CostTable,
} from './costFields';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, '..');
const COST_TABLES = Object.keys(COST_COLUMNS) as CostTable[];

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sourceFiles(path, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name) && !name.endsWith('.d.ts')) out.push(path);
  }
  return out;
}

/** The vetted column-list constants a select may name or interpolate (costFields.ts `*_COLUMNS`). */
const VETTED = new Set(Object.keys(costFieldsModule).filter((name) => name.endsWith('_COLUMNS')));
const UNVETTED = '__UNVETTED_INTERPOLATION__';

/** The literal text of a select argument: vetted constants removed, anything else marked. */
function literalText(arg: string): string {
  return arg.replace(/\$\{\s*([^}]*?)\s*\}/g, (_all, name: string) => (VETTED.has(name) ? ' ' : ` ${UNVETTED} `));
}

function costColumnNamed(text: string, table: CostTable): string | null {
  for (const column of COST_COLUMNS[table]) {
    if (new RegExp(`(^|[^A-Za-z0-9_])${column}([^A-Za-z0-9_]|$)`).test(text)) return column;
  }
  return null;
}

/** Every `<cost table>[!fk](...)` embed inside a select string, with its column list. */
function costEmbeds(text: string): Array<{ table: CostTable; columns: string }> {
  const found: Array<{ table: CostTable; columns: string }> = [];
  const re = new RegExp(`(?:^|[^A-Za-z0-9_])(${COST_TABLES.join('|')})(?:![A-Za-z0-9_]+)?\\(`, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    let depth = 1;
    let i = m.index + m[0].length;
    const start = i;
    while (i < text.length && depth > 0) {
      if (text[i] === '(') depth += 1;
      else if (text[i] === ')') depth -= 1;
      i += 1;
    }
    // Only the embed's own level counts; nested embeds are visited by the same loop.
    const own = text.slice(start, i - 1).replace(/\([^()]*\)/g, '()');
    found.push({ table: m[1] as CostTable, columns: own });
  }
  return found;
}

interface Offence { file: string; line: number; problem: string }

/** The text of `const NAME = '...'` (or a template) declared in the same file, if any. */
function sameFileStringConstant(src: string, name: string): string | undefined {
  const m = new RegExp(`const\\s+${name}\\s*=\\s*(['"\`])([\\s\\S]*?)\\1`).exec(src);
  return m ? m[2] : undefined;
}

function scan(): Offence[] {
  const offences: Offence[] = [];
  const fromRe = new RegExp(`\\.from\\(\\s*['"](${COST_TABLES.join('|')})['"]\\s*\\)`, 'g');
  const selectRe = /\.select\(\s*(?:(['"`])([\s\S]*?)\1|\))/g;
  for (const file of sourceFiles(SRC)) {
    const src = readFileSync(file, 'utf8');
    const rel = relative(SRC, file).replace(/\\/g, '/');
    const lineOf = (index: number) => src.slice(0, index).split('\n').length;

    // 1. The first select of every chain on a cost table.
    let m: RegExpExecArray | null;
    fromRe.lastIndex = 0;
    while ((m = fromRe.exec(src)) !== null) {
      const table = m[1] as CostTable;
      const rest = src.slice(m.index + m[0].length);
      const end = rest.search(/;|\.from\(/);
      const chain = end === -1 ? rest : rest.slice(0, end);
      const sel = /\.select\(\s*(?:(['"`])([\s\S]*?)\1|\)|([A-Za-z_$][\w$]*)\s*[,)])/.exec(chain);
      if (!sel) continue; // a write without a returned row, or a delete
      let selectText: string | undefined = sel[2];
      if (sel[3] !== undefined) {
        if (VETTED.has(sel[3])) continue;
        // A column list held in a same-file string constant is checked like an inline one.
        selectText = sameFileStringConstant(src, sel[3]);
        if (selectText === undefined) {
          offences.push({ file: rel, line: lineOf(m.index), problem: `${table}: .select(${sel[3]}) is neither a vetted *_COLUMNS constant nor a same-file string constant` });
          continue;
        }
      }
      if (selectText === undefined) {
        offences.push({ file: rel, line: lineOf(m.index), problem: `${table}: bare .select() returns every column` });
        continue;
      }
      const text = literalText(selectText);
      const topLevel = text.replace(/\([^()]*\)/g, '()');
      if (/(^|[\s,])\*/.test(topLevel)) {
        offences.push({ file: rel, line: lineOf(m.index), problem: `${table}: select('*')` });
      }
      const named = costColumnNamed(topLevel, table);
      if (named) offences.push({ file: rel, line: lineOf(m.index), problem: `${table}: names cost column ${named}` });
      if (topLevel.includes(UNVETTED)) {
        offences.push({ file: rel, line: lineOf(m.index), problem: `${table}: interpolates something other than a *_COLUMNS constant` });
      }
    }

    // 2. Embedded cost tables inside ANY select string.
    selectRe.lastIndex = 0;
    while ((m = selectRe.exec(src)) !== null) {
      if (m[2] === undefined) continue;
      for (const embed of costEmbeds(literalText(m[2]))) {
        if (/(^|[\s,])\*/.test(embed.columns)) {
          offences.push({ file: rel, line: lineOf(m.index), problem: `embedded ${embed.table}(*)` });
        }
        const named = costColumnNamed(embed.columns, embed.table);
        if (named) offences.push({ file: rel, line: lineOf(m.index), problem: `embedded ${embed.table} names cost column ${named}` });
        if (embed.columns.includes(UNVETTED)) {
          offences.push({ file: rel, line: lineOf(m.index), problem: `embedded ${embed.table} interpolates something other than a *_COLUMNS constant` });
        }
      }
    }
  }
  return offences;
}

describe('cost columns are never read by the screens', () => {
  it('no wildcard read and no cost column on any cost table in src/', () => {
    expect(scan()).toEqual([]);
  });

  it('the scanner catches each shape it exists for (mutation guard)', () => {
    const embeds = costEmbeds("id, product:products(*, product_family:product_families(name)), items:order_items(id, cost_per_unit)");
    expect(embeds.map((e) => e.table)).toEqual(['products', 'order_items']);
    expect(/(^|[\s,])\*/.test(embeds[0].columns)).toBe(true);
    expect(costColumnNamed(embeds[1].columns, 'order_items')).toBe('cost_per_unit');
    expect(costColumnNamed('id, unit_cost_cents_note', 'purchase_order_items')).toBeNull();
    expect(costColumnNamed('id, current_cost', 'products')).toBe('current_cost');
    expect(sameFileStringConstant("const SEL = 'id, current_cost';", 'SEL')).toBe('id, current_cost');
    expect(sameFileStringConstant('const other = 1;', 'SEL')).toBeUndefined();
    expect(literalText('${PRODUCT_COLUMNS}, x')).not.toContain(UNVETTED);
    expect(literalText('${someVariable}, x')).toContain(UNVETTED);
    expect(costEmbeds(literalText('id, product:products(${cols})'))[0].columns).toContain(UNVETTED);
  });
});

describe('column lists match the schema registry', () => {
  const registry = JSON.parse(
    readFileSync(join(HERE, '..', '..', '.claude', 'schema-registry.json'), 'utf8'),
  ) as { columns: Record<string, string[]> };

  for (const table of COST_TABLES) {
    it(`${table}: SAFE_COLUMNS + COST_COLUMNS is exactly the table`, () => {
      const live = registry.columns[table];
      expect(live, `${table} missing from the registry`).toBeDefined();
      const cost: string[] = [...COST_COLUMNS[table]];
      for (const column of cost) expect(live).toContain(column);
      const safe = SAFE_COLUMNS[table].split(',').map((c) => c.trim());
      expect(new Set(safe).size).toBe(safe.length);
      expect([...safe].sort()).toEqual(live.filter((c) => !cost.includes(c)).sort());
    });
  }
});

describe('admin cost helpers', () => {
  beforeEach(() => rpc.mockReset());

  it('a non-admin never calls the admin cost function and gets the rows unchanged', async () => {
    const rows = [{ id: 'a', product_name: 'X' }];
    expect(await withAdminCosts('products', rows, false)).toEqual(rows);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('an admin gets each row merged with its cost fields', async () => {
    rpc.mockResolvedValue({ data: { a: { current_cost: 12.5 } }, error: null });
    const merged = await withAdminCosts('products', [{ id: 'a' }, { id: 'b' }], true);
    expect(rpc).toHaveBeenCalledWith('get_admin_cost_fields', { p_table: 'products', p_ids: ['a', 'b'] });
    expect(merged).toEqual([{ id: 'a', current_cost: 12.5 }, { id: 'b' }]);
  });

  it('an admin cost read with an empty reply fails instead of merging nothing', async () => {
    rpc.mockResolvedValue({ data: null, error: null });
    await expect(withAdminCosts('products', [{ id: 'a' }], true)).rejects.toThrow();
  });

  it('chunks large id lists under the server limit', async () => {
    rpc.mockResolvedValue({ data: {}, error: null });
    const rows = Array.from({ length: 2500 }, (_, i) => ({ id: `id-${i}` }));
    await withAdminCosts('order_items', rows, true);
    expect(rpc).toHaveBeenCalledTimes(3);
    for (const call of rpc.mock.calls) expect((call[1] as { p_ids: string[] }).p_ids.length).toBeLessThanOrEqual(1000);
  });

  it('a failed cost read throws instead of returning rows without cost', async () => {
    rpc.mockResolvedValue({ data: null, error: new Error('Permission denied: requires admin role') });
    await expect(withAdminCosts('products', [{ id: 'a' }], true)).rejects.toThrow('requires admin role');
  });

  it('merges a nested object by its own id', async () => {
    rpc.mockResolvedValue({ data: { p1: { current_cost: 3 } }, error: null });
    const merged = await withAdminNestedCosts('products', [{ id: 'i1', product: { id: 'p1', product_name: 'P' } }], 'product', true);
    expect(merged).toEqual([{ id: 'i1', product: { id: 'p1', product_name: 'P', current_cost: 3 } }]);
  });
});

// The posting version is a computed field: it receives the whole row, so it may only be selected from
// invoices_postable (migration 20261022090000), whose row has no cost column. On `invoices` it fails
// for everyone once the cost column lock revokes total_cost_cents.
const VERSION_TOKEN = /\binvoice_post_version\b|\bINVOICE_POST_VERSION_COLUMNS\b/;

/** Every exported string constant in src/, so a select that names an imported constant is resolved too. */
function exportedStringConstants(files: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const file of files) {
    for (const m of readFileSync(file, 'utf8').matchAll(/export\s+const\s+([A-Z][A-Z0-9_]*)\s*=\s*(['"`])([\s\S]*?)\2/g)) {
      out.set(m[1], m[3]);
    }
  }
  return out;
}

function versionReadsOffView(src: string, exported: Map<string, string> = new Map()): number[] {
  const lines: number[] = [];
  const fromRe = /\.from\(\s*([^)]*?)\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = fromRe.exec(src)) !== null) {
    const rest = src.slice(m.index + m[0].length);
    const end = rest.search(/;|\.from\(/);
    const chain = end === -1 ? rest : rest.slice(0, end);
    const select = /\.select\(\s*([\s\S]*?)\s*(?:,\s*\{|\)\s*(?:\.|$))/.exec(chain);
    if (!select) continue;
    const arg = select[1].trim();
    const constant = /^[A-Z][A-Z0-9_]*$/.test(arg) ? (sameFileStringConstant(src, arg) ?? exported.get(arg)) : undefined;
    if (!VERSION_TOKEN.test(arg) && !(constant !== undefined && VERSION_TOKEN.test(constant))) continue;
    if (!['INVOICES_POSTABLE', "'invoices_postable'", '"invoices_postable"'].includes(m[1])) {
      lines.push(src.slice(0, m.index).split('\n').length);
    }
  }
  return lines;
}

/** An ALTER TABLE on public.invoices that adds, drops or renames a column. */
function changesInvoiceColumns(sql: string): boolean {
  for (const m of sql.matchAll(/ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?(?:"?public"?\s*\.\s*)?"?invoices"?\s+([^;]*);/gi)) {
    // ADD/DROP COLUMN, or the bare form `ADD name type` / `DROP name` (not a constraint, nor an
    // ALTER COLUMN sub-action such as DROP NOT NULL / DROP DEFAULT / DROP EXPRESSION / DROP IDENTITY).
    if (/\b(ADD|DROP)\s+(COLUMN\b|(?!(?:CONSTRAINT|PRIMARY|UNIQUE|FOREIGN|CHECK|EXCLUDE|NOT|DEFAULT|EXPRESSION|IDENTITY)\b)\w+\s)/i.test(m[1])) return true;
    if (/\bRENAME\s+(COLUMN\s+)?\w+\s+TO\b/i.test(m[1])) return true;
  }
  return false;
}

describe('the posting version is read only from invoices_postable', () => {
  it('every select of invoice_post_version in src/ is on invoices_postable', () => {
    const offences: string[] = [];
    const files = sourceFiles(SRC);
    const exported = exportedStringConstants(files);
    for (const file of files) {
      for (const line of versionReadsOffView(readFileSync(file, 'utf8'), exported)) offences.push(`${relative(SRC, file).replace(/\\/g, '/')}:${line}`);
    }
    expect(offences).toEqual([]);
  });

  it('the scanner catches each shape it exists for (mutation guard)', () => {
    expect(versionReadsOffView("supabase.from('invoices').select(`${INVOICE_COLUMNS}, ${INVOICE_POST_VERSION_COLUMNS}`).eq('id', x);")).toEqual([1]);
    expect(versionReadsOffView("supabase.from('invoices').select('id, invoice_post_version, status').eq('id', x);")).toEqual([1]);
    expect(versionReadsOffView("const LIST = `${INVOICE_POST_VERSION_COLUMNS}, id`;\nsupabase.from('invoices').select(LIST, { count: 'exact' });")).toEqual([2]);
    expect(versionReadsOffView("supabase.from(INVOICES_POSTABLE).select(`${INVOICE_COLUMNS}, ${INVOICE_POST_VERSION_COLUMNS}`).eq('id', x);")).toEqual([]);
    expect(versionReadsOffView("supabase.from('invoices').select('id, status').eq('id', x);")).toEqual([]);
    // A constant imported from another file (Luna round 3).
    const exported = new Map([['POSTING_COLUMNS', '${INVOICE_COLUMNS}, ${INVOICE_POST_VERSION_COLUMNS}']]);
    expect(versionReadsOffView("supabase.from('invoices').select(POSTING_COLUMNS).eq('id', x);", exported)).toEqual([1]);
    expect(versionReadsOffView("supabase.from(INVOICES_POSTABLE).select(POSTING_COLUMNS).eq('id', x);", exported)).toEqual([]);
    expect(exportedStringConstants([join(HERE, 'costFields.ts')]).get('INVOICE_POST_VERSION_COLUMNS')).toBe('invoice_post_version');
  });

  it("the view's columns are every invoices column except the cost columns (schema registry)", () => {
    const registry = JSON.parse(
      readFileSync(join(HERE, '..', '..', '.claude', 'schema-registry.json'), 'utf8'),
    ) as { columns: Record<string, string[]> };
    const migrations = join(HERE, '..', '..', 'supabase', 'migrations');
    const defining = readdirSync(migrations).filter((n) => n.endsWith('.sql')).sort()
      .filter((n) => /CREATE\s+(OR\s+REPLACE\s+)?VIEW\s+public\.invoices_postable\b/i.test(readFileSync(join(migrations, n), 'utf8')));
    expect(defining.length, 'no migration defines public.invoices_postable').toBeGreaterThan(0);
    const sql = readFileSync(join(migrations, defining[defining.length - 1]), 'utf8').replace(/--[^\n]*/g, '');
    const body = /VIEW\s+public\.invoices_postable\b[^;]*?\bAS\s+SELECT\s+([\s\S]*?)\s+FROM\s+public\.invoices\b/i.exec(sql);
    expect(body, 'could not read the view column list').not.toBeNull();
    const viewColumns = body![1].split(',').map((c) => c.trim());
    const cost: string[] = [...COST_COLUMNS.invoices];
    expect([...viewColumns].sort()).toEqual(registry.columns.invoices.filter((c) => !cost.includes(c)).sort());
  });

  // The registry is refreshed after a live apply, so the test above can lag a migration on disk. Any
  // migration after the view's newest definition that adds, drops or renames an invoices column must
  // re-create the view in the same file (a DROP COLUMN ... CASCADE would silently drop it).
  it('a migration that changes invoices columns after the view re-creates the view', () => {
    const migrations = join(HERE, '..', '..', 'supabase', 'migrations');
    const names = readdirSync(migrations).filter((n) => n.endsWith('.sql')).sort();
    const defines = (sql: string) => /CREATE\s+(OR\s+REPLACE\s+)?VIEW\s+public\.invoices_postable\b/i.test(sql);
    const firstView = names.findIndex((n) => defines(readFileSync(join(migrations, n), 'utf8')));
    expect(firstView).toBeGreaterThanOrEqual(0);
    const offences = names.slice(firstView + 1).filter((n) => {
      const sql = readFileSync(join(migrations, n), 'utf8').replace(/--[^\n]*/g, '');
      return changesInvoiceColumns(sql) && !defines(sql);
    });
    expect(offences, 're-create public.invoices_postable (every invoices column but cost) in the same migration').toEqual([]);
  });

  it('the invoices column-change detector catches each shape it exists for (mutation guard)', () => {
    expect(changesInvoiceColumns('ALTER TABLE public.invoices ADD COLUMN zz text;')).toBe(true);
    expect(changesInvoiceColumns('alter table only invoices drop column if exists zz cascade;')).toBe(true);
    expect(changesInvoiceColumns('ALTER TABLE public.invoices RENAME COLUMN a TO b;')).toBe(true);
    expect(changesInvoiceColumns('ALTER TABLE public.invoices RENAME a TO b;')).toBe(true);
    expect(changesInvoiceColumns('ALTER TABLE public.invoices ADD CONSTRAINT zz CHECK (true);')).toBe(false);
    expect(changesInvoiceColumns('ALTER TABLE public.invoice_items ADD COLUMN zz text;')).toBe(false);
    expect(changesInvoiceColumns('ALTER TABLE public.invoices ALTER COLUMN zz SET DEFAULT 0;')).toBe(false);
    expect(changesInvoiceColumns('ALTER TABLE public.invoices ALTER COLUMN zz DROP NOT NULL, ALTER COLUMN yy DROP DEFAULT;')).toBe(false);
    expect(changesInvoiceColumns('ALTER TABLE public.invoices ADD zz integer;')).toBe(true);
    expect(changesInvoiceColumns('ALTER TABLE "public"."invoices" ADD COLUMN zz text;')).toBe(true);
    expect(changesInvoiceColumns('ALTER TABLE IF EXISTS ONLY "invoices" DROP COLUMN zz;')).toBe(true);
    expect(changesInvoiceColumns('ALTER TABLE "public"."invoices_postable" ADD COLUMN zz text;')).toBe(false);
  });
});

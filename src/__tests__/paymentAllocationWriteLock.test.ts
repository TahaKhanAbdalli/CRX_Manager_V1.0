import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// Standing guard for 20261022040000: the payment-allocation tables are payment truth and are written
// only by SECURITY DEFINER functions (allocate_payment, void_payment, void_invoice,
// update_order_items). A later migration that hands a browser role a write grant or a write policy on
// them, or a screen that writes them directly, re-opens the fake-payment hole this migration closed.
const root = process.cwd();
const MIGRATIONS = path.join(root, 'supabase/migrations');
const LOCK = '20261022040000_payment_allocation_tables_no_direct_writes.sql';
const TABLES = ['allocation_sets', 'invoice_line_allocations', 'order_line_allocations'];
const TABLE = `(?:"?public"?\\.)?"?(?:${TABLES.join('|')})"?`;

const strip = (sql: string) => sql.replace(/\r\n/g, '\n').replace(/--[^\n]*/g, '');
const lock = strip(readFileSync(path.join(MIGRATIONS, LOCK), 'utf8'));
const later = readdirSync(MIGRATIONS)
  .filter((name) => name.endsWith('.sql') && name > LOCK)
  .map((name) => ({ name, sql: strip(readFileSync(path.join(MIGRATIONS, name), 'utf8')) }));

// A GRANT of a privilege the lock revokes (a write, or REFERENCES, TRIGGER or MAINTAIN) on one of the tables, or on every table in public, to a browser role
// (or PUBLIC, which reaches them).
const GRANT_WRITE = new RegExp(
  `GRANT\\s+[^;]*\\b(INSERT|UPDATE|DELETE|TRUNCATE|REFERENCES|TRIGGER|MAINTAIN|ALL)\\b[^;]*\\bON\\s+(TABLE\\s+[^;]*${TABLE}|[^;]*${TABLE}|ALL\\s+TABLES\\s+IN\\s+SCHEMA\\s+[^;]*\\bpublic\\b)[^;]*\\bTO\\s+[^;]*\\b(anon|authenticated|PUBLIC)\\b`,
  'i',
);
// Every CREATE POLICY on one of the tables that is not FOR SELECT (no FOR clause means FOR ALL).
const writePolicies = (sql: string) => (sql.match(new RegExp(`CREATE\\s+POLICY\\s+[^;]*\\bON\\s+${TABLE}[^;]*`, 'gi')) ?? [])
  .filter((statement) => !/\bFOR\s+SELECT\b/i.test(statement));

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    return /\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

describe('payment allocation tables: no direct browser writes (20261022040000)', () => {
  it('revokes every write privilege from the browser roles and drops all five write policies', () => {
    expect(lock).toMatch(new RegExp(
      'REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN\\s+ON TABLE public\\.allocation_sets, '
      + 'public\\.invoice_line_allocations, public\\.order_line_allocations\\s+FROM PUBLIC, anon, authenticated;',
    ));
    for (const [policy, table] of [
      ['allocation_sets_insert', 'allocation_sets'],
      ['allocation_sets_update', 'allocation_sets'],
      ['allocation_sets_admin_delete', 'allocation_sets'],
      ['invoice_line_alloc_insert', 'invoice_line_allocations'],
      ['order_line_alloc_insert', 'order_line_allocations'],
    ]) {
      expect(lock).toContain(`DROP POLICY IF EXISTS ${policy} ON public.${table};`);
    }
    // SELECT is untouched: the migration neither revokes nor drops a read.
    expect(lock).not.toMatch(/REVOKE[^;]*SELECT/i);
    expect(lock).not.toMatch(/DROP POLICY[^;]*_select/i);
  });

  it('the two migration checks catch a re-opening and ignore reads', () => {
    for (const sql of [
      'GRANT INSERT ON public.invoice_line_allocations TO authenticated;',
      'GRANT ALL ON TABLE allocation_sets TO anon;',
      'GRANT UPDATE (notes) ON public.allocation_sets TO authenticated;',
      'GRANT SELECT, DELETE ON public.order_line_allocations TO PUBLIC;',
      'GRANT INSERT ON ALL TABLES IN SCHEMA public TO authenticated;',
      'GRANT INSERT ON "public"."allocation_sets" TO authenticated;',
      'GRANT TRIGGER, MAINTAIN ON public.invoice_line_allocations TO authenticated;',
    ]) expect(GRANT_WRITE.test(sql), sql).toBe(true);
    for (const sql of [
      'GRANT SELECT ON public.allocation_sets TO authenticated;',
      'GRANT INSERT ON public.allocation_sets TO service_role;',
      'GRANT INSERT ON public.payments TO authenticated;',
      'GRANT SELECT ON ALL TABLES IN SCHEMA public TO authenticated;',
      'GRANT INSERT ON ALL TABLES IN SCHEMA private TO authenticated;',
    ]) expect(GRANT_WRITE.test(sql), sql).toBe(false);
    expect(writePolicies('CREATE POLICY x ON public.order_line_allocations FOR INSERT WITH CHECK (true);')).toHaveLength(1);
    expect(writePolicies('CREATE POLICY y ON allocation_sets USING (true);')).toHaveLength(1);
    expect(writePolicies('CREATE POLICY q ON "public"."invoice_line_allocations" FOR UPDATE USING (true);')).toHaveLength(1);
    expect(writePolicies('CREATE POLICY z ON public.allocation_sets FOR SELECT USING (true);')).toHaveLength(0);
    expect(writePolicies('CREATE POLICY w ON public.payments FOR INSERT WITH CHECK (true);')).toHaveLength(0);
  });

  it('no later migration grants a browser role a write privilege on them', () => {
    expect(later.filter(({ sql }) => GRANT_WRITE.test(sql)).map(({ name }) => name)).toEqual([]);
  });

  it('no later migration creates a write (or FOR ALL) policy on them', () => {
    expect(later.filter(({ sql }) => writePolicies(sql).length > 0).map(({ name }) => name)).toEqual([]);
  });

  it('no screen or library writes them through the Data API', () => {
    const write = new RegExp(`from\\(\\s*['"\`](?:${TABLES.join('|')})['"\`]\\s*\\)\\s*\\.\\s*(insert|upsert|update|delete)\\b`);
    expect(write.test("supabase.from('invoice_line_allocations').insert({})")).toBe(true);
    expect(write.test("supabase.from('allocation_sets').select('id')")).toBe(false);
    const offenders = walk(path.join(root, 'src'))
      .filter((file) => write.test(readFileSync(file, 'utf8')))
      .map((file) => path.relative(root, file));
    expect(offenders).toEqual([]);
  });
});

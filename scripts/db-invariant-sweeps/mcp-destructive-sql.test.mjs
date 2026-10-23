#!/usr/bin/env node
// Proves every printed sweep query gets past the Supabase MCP server's
// destructive-SQL confirmation.
//
// The hosted Supabase MCP server runs its own isDestructiveSql() on every
// execute_sql call. When it says "destructive" it asks the client for a form
// confirmation; this app cannot show one, so the call returns
// {"status":"declined"} with no prompt — and that predicate can never run in
// Claude mode. Its check is a heuristic: it splits on EVERY `;` (quotes
// included), and in any piece containing the word EXECUTE followed by
// whitespace it flags a later quote followed by DROP / DELETE / TRUNCATE. So a
// read-only reason string like 'must not hold EXECUTE on ...' followed by a
// has_table_privilege(..., 'DELETE') argument is enough. That is exactly how
// quote-versions-rpc-owned was declined on every run until 2026-10-21 (the
// two-string repro below was declined live the same day).
//
// The detector below is a port of supabase-community/supabase-mcp
// packages/mcp-server-supabase/src/tools/destructive-sql.ts (main, 2026-10-21;
// itself adapted from supabase/supabase apps/studio, Apache-2.0). If Supabase
// changes it, re-port it here rather than loosening the assertions.
//
// Run: node scripts/db-invariant-sweeps/mcp-destructive-sql.test.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------- port of destructive-sql.ts ----------
const sqlIdentifier = String.raw`(?:"(?:[^"]|"")+"|[a-z_\u0080-￿][\w$\u0080-￿]*)`;
const directDropColumnRegex = new RegExp(
  String.raw`^\s*alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?${sqlIdentifier}(?:\s*\.\s*${sqlIdentifier})?\s+drop\s+(?!constraint(?![\w$\u0080-￿]))(?:column\s+)?(?:if\s+exists\s+)?${sqlIdentifier}(?:\s+(?:cascade|restrict))?\s*$`,
  'i',
);
const quotedDestructiveStart = /['"]\s*(drop\b|delete\b|truncate\b|alter\s+table\b)/gi;
const dollarDestructiveStart = /execute\s+\$\w*\$\s*(drop\b|delete\b|truncate\b|alter\s+table\b)/gi;
const concatDestructiveStart = /\b(drop|delete|truncate|alter\s+table)\b/gi;

function hasDestructiveStart(sql, starts) {
  starts.lastIndex = 0;
  let firstAlterEnd = -1;
  let match;
  while ((match = starts.exec(sql)) !== null) {
    if (!/^alter/i.test(match[1])) return true;
    if (firstAlterEnd === -1) firstAlterEnd = starts.lastIndex;
  }
  return firstAlterEnd !== -1 && /\bdrop\s+column\b/i.test(sql.slice(firstAlterEnd));
}

const updateWithoutWhereRegex =
  /(?:^|;)\s*update\s+(?:"(?:[^"]|"")*"|[\w]+)(?:\.(?:"(?:[^"]|"")*"|[\w]+))?\s+set\s+[\w\W]+?(?!\s*where\s)/is;

function removeCommentsFromSql(sql) {
  let cleanedSql = sql.replace(/--.*$/gm, '');
  const parts = [];
  let offset = 0;
  let start = cleanedSql.indexOf('/*', offset);
  while (start !== -1) {
    const end = cleanedSql.indexOf('*/', start + 2);
    if (end === -1) break;
    parts.push(cleanedSql.slice(offset, start));
    offset = end + 2;
    start = cleanedSql.indexOf('/*', offset);
  }
  if (offset !== 0) {
    parts.push(cleanedSql.slice(offset));
    cleanedSql = parts.join('');
  }
  return cleanedSql;
}

function checkDestructiveQuery(sql) {
  const cleanedSql = removeCommentsFromSql(sql);
  const alter = /(?:^|;)\s*alter\s+table\s+/i.exec(cleanedSql);
  if (alter && /\sdrop\s+column\s/i.test(cleanedSql.slice(alter.index + alter[0].length))) return true;
  for (const statement of cleanedSql.split(';')) {
    if (/^\s*(drop|delete|truncate)\s/i.test(statement) || directDropColumnRegex.test(statement)) return true;
    const execute = /execute\s+/i.exec(statement);
    if (
      execute &&
      (hasDestructiveStart(statement.slice(execute.index + execute[0].length), quotedDestructiveStart) ||
        hasDestructiveStart(statement, dollarDestructiveStart))
    ) {
      return true;
    }
  }
  const calls = /execute\s+(format|concat(?:_ws)?)\s*\([^)]*(?:\)[^;]*|$)/gi;
  let call;
  while ((call = calls.exec(cleanedSql)) !== null) {
    if (hasDestructiveStart(call[0], call[1].toLowerCase() === 'format' ? quotedDestructiveStart : concatDestructiveStart)) {
      return true;
    }
  }
  return false;
}

function blankQuotedSpans(sql) {
  let out = '';
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    if (ch === "'" || ch === '"') {
      const backslashEscapes = ch === "'" && /e/i.test(sql[i - 1] ?? '') && !/[\w$\u0080-￿]/.test(sql[i - 2] ?? '');
      let j = i + 1;
      let closed = false;
      while (j < sql.length) {
        if (backslashEscapes && sql[j] === '\\') j += 2;
        else if (sql[j] === ch) {
          if (sql[j + 1] !== ch) { closed = true; break; }
          j += 2;
        } else j++;
      }
      out += ch === "'" ? "''" : '""';
      i = closed ? j + 1 : sql.length;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

const dollarQuoteTag = /\$(?:[a-z_\u0080-￿][\w\u0080-￿]*)?\$/iy;

function splitStatements(sql) {
  const statements = [];
  let blanked = '';
  let i = 0;
  let dollarUntil;
  let blockDepth = 0;
  let inLineComment = false;
  const push = () => { statements.push(blanked); blanked = ''; };
  while (i < sql.length) {
    const ch = sql[i];
    if (inLineComment) {
      if (ch === '\n' || ch === '\r') { inLineComment = false; blanked += ch; }
      i++;
      continue;
    }
    if (blockDepth > 0) {
      if (ch === ';') { push(); i++; continue; }
      if (ch === '/' && sql[i + 1] === '*') { blanked += '/*'; blockDepth++; i += 2; continue; }
      if (ch === '*' && sql[i + 1] === '/') { blanked += '*/'; blockDepth--; i += 2; continue; }
      i++;
      continue;
    }
    if (dollarUntil !== undefined) {
      if (ch === ';') { push(); i++; continue; }
      if (sql.startsWith(dollarUntil, i)) { blanked += dollarUntil; i += dollarUntil.length; dollarUntil = undefined; continue; }
      blanked += ch;
      i++;
      continue;
    }
    if (ch === ';') { push(); i++; continue; }
    if (ch === '$' && !/[\w$\u0080-￿]/.test(sql[i - 1] ?? '')) {
      dollarQuoteTag.lastIndex = i;
      const tag = dollarQuoteTag.exec(sql)?.[0];
      if (tag !== undefined) { blanked += tag; dollarUntil = tag; i += tag.length; continue; }
    }
    if (ch === '-' && sql[i + 1] === '-') { blanked += '--'; inLineComment = true; i += 2; continue; }
    if (ch === '/' && sql[i + 1] === '*') { blanked += '/*'; blockDepth = 1; i += 2; continue; }
    if (ch === "'" || ch === '"') {
      const backslashEscapes = ch === "'" && /e/i.test(sql[i - 1] ?? '') && !/[\w$\u0080-￿]/.test(sql[i - 2] ?? '');
      let j = i + 1;
      let closed = false;
      while (j < sql.length) {
        if (backslashEscapes && sql[j] === '\\') j += 2;
        else if (sql[j] === ch) {
          if (sql[j + 1] !== ch) { closed = true; break; }
          j += 2;
        } else j++;
      }
      if (!closed) return sql.split(';').map(blankQuotedSpans);
      blanked += ch === "'" ? "''" : '""';
      i = j + 1;
      continue;
    }
    blanked += ch;
    i++;
  }
  push();
  return statements;
}

function isUpdateWithoutWhere(sql) {
  return splitStatements(sql)
    .filter((statement) => statement.trim().toLowerCase().startsWith('update'))
    .some((statement) => updateWithoutWhereRegex.test(statement) && !/where\s/i.test(statement));
}

export function isDestructiveSql(sql) {
  return checkDestructiveQuery(sql) || isUpdateWithoutWhere(sql);
}

// ---------- assertions ----------
let pass = 0;
const ok = (condition, message) => { assert.ok(condition, message); pass++; };

// 1. The port reproduces the live behaviour it exists to predict (both observed 2026-10-21).
ok(isDestructiveSql("SELECT 'must not hold EXECUTE on x' AS a, 'DELETE' AS b"),
  'the two-string query the live server declined must be flagged by the port');
ok(!isDestructiveSql("SELECT 'no INSERT, UPDATE, DELETE, TRUNCATE here' AS txt"),
  'privilege words inside a string, with no EXECUTE before them, ran live and must not be flagged');
ok(!isDestructiveSql("SELECT 'must not be able to call x' AS a, 'DELETE' AS b"),
  'the reworded reason string must not be flagged');

// 2. Every query the Claude-mode runner prints — the exact text a session pastes
//    into execute_sql — must clear the server's check.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const printed = spawnSync(process.execPath, ['scripts/db-invariant-sweeps/run-sweeps.mjs'], {
  cwd: root,
  encoding: 'utf8',
  maxBuffer: 32 * 1024 * 1024,
  env: { ...process.env, SUPABASE_DB_URL: '', DB_SWEEPS_REQUIRE_LIVE: '' },
});
assert.equal(printed.status, 0, `run-sweeps.mjs print mode failed: ${printed.stderr}`);
const blocks = printed.stdout.split(/\r?\n┌─ PREDICATE: /).slice(1);
ok(blocks.length >= 29, `expected at least 29 printed predicates, found ${blocks.length}`);
for (const block of blocks) {
  const name = block.split(/\s/)[0];
  const afterBanner = block.split(/\r?\n└─+\r?\n/)[1];
  ok(afterBanner?.includes(') AS sweep_result;'), `${name}: could not find the printed query`);
  const query = `${afterBanner.split(') AS sweep_result;')[0]}) AS sweep_result;`;
  ok(!isDestructiveSql(query),
    `${name}: the Supabase MCP server would treat this read-only sweep as destructive SQL and decline it in Claude mode. `
    + 'Usually a reason string has the word EXECUTE followed by a space and, before the next semicolon, a quoted DELETE/TRUNCATE/DROP. '
    + 'Reword the string (for example "be able to call"); do not split the predicate to dodge this.');
}

console.log(`mcp-destructive-sql: ${pass} assertions passed (${blocks.length} printed predicates clear the Supabase MCP confirmation check)`);

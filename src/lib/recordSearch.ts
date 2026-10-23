/**
 * Quote a search term for a PostgREST `or=(...)` filter. Names such as "2,4-D"
 * or "Smith, John" contain commas and parentheses, which would otherwise end
 * the filter early. Typed `%`, `_` and `\` are first escaped for ILIKE (so
 * "100%" matches literally), then `\` and `"` are escaped for the PostgREST quotes.
 */
export function ilikeOrPattern(q: string): string {
  const likeEscaped = q.replace(/[\\%_]/g, (c) => `\\${c}`);
  const quoted = likeEscaped.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `"%${quoted}%"`;
}

/**
 * PostgREST `in` list for leaving ids out of a search, e.g. `.not('id', 'in', excludedIdList(ids))`.
 * Ids are UUIDs, so they need no quoting.
 */
export function excludedIdList(ids: readonly string[]): string {
  return `(${ids.join(',')})`;
}

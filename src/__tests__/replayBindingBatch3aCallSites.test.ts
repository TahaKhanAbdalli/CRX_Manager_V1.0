/**
 * Replay-binding batch 3a (migration 20261019200000): the five screens that call complete_delivery
 * or complete_job retire a refused retry key on ANY replay-binding refusal: 'intent' (the key
 * belongs to a different request), 'actor' (to another user) and 'receipt' (IDEMPOTENCY_RESULT_INVALID
 * / IDEMPOTENCY_RECEIPT_MISSING, a receipt that can never be used, so keeping the key would repeat
 * the same refusal forever; Codex on PR #954).
 *
 * This differs from batches 1 and 2, which keep the key on 'receipt' because a fresh key could
 * repeat a money action. A completion cannot repeat: the next try runs under a fresh key and the
 * body refuses a delivery or job that is no longer in_progress, so a retired key can never complete
 * the same record twice.
 *
 * Each check names the screen's own key hook, so it counts only the completion call site and is
 * unaffected by other batches' sites in the same file (Deliveries.tsx also cancels deliveries).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { completedAtForKey } from '../lib/paperTicket';

// File -> the key hook of its completion call.
const SITES: Array<[string, string]> = [
  ['src/pages/Deliveries.tsx', 'completeIdem'],
  ['src/pages/DeliveryDetail.tsx', 'completeIdem'],
  ['src/pages/FieldStop.tsx', 'completeIdem'],
  ['src/pages/FieldView.tsx', 'completeIdem'],
  ['src/pages/JobDetail.tsx', 'completeJobIdem'],
];

// The reset runs on any binding refusal (the helper returns 'intent', 'actor' or 'receipt', else null),
// first in a block that then reloads the record (CodeRabbit on PR #954).
const anyBindingReset = (hook: string) => new RegExp(
  `if \\(getIdempotencyBindingRejection\\((?:err|error)\\)\\) \\{\\n\\s*${hook}\\.resetKey(?:For\\(completeScope\\))?\\(?\\)?;`,
  'g',
);
// Each screen's reload in that block (the next 1-4 lines).
const RELOADS: Record<string, RegExp> = {
  'src/pages/Deliveries.tsx': /bindingRejected = true;[\s\S]*?if \(outcome !== 'completed' && bindingRejected\) \{[\s\S]{0,500}?closeCompleteDialog\(\);\n\s*await fetchDeliveries\(\);/,
  'src/pages/DeliveryDetail.tsx': /completeIdem\.resetKeyFor\(completeScope\);\n\s*fetchDelivery\(\);/,
  'src/pages/FieldStop.tsx': /completeIdem\.resetKeyFor\(completeScope\);\n\s*fetchStop\(\);/,
  'src/pages/FieldView.tsx': /completeIdem\.resetKey\(\);\n\s*\/\/[^\n]*\n\s*setCompleteFormOpenFor\(\(open\) => \(open === card\.job_id \? null : open\)\);\n\s*fetchCards\(\);/,
  'src/pages/JobDetail.tsx': /completeJobIdem\.resetKey\(\);\n\s*if \(stillOnThisJob\(\)\) \{\n\s*setShowCompleteModal\(false\);\n\s*fetchJob\(\);/,
};
// The narrower batch-1/2 form, which would leave a completion stuck on a 'receipt' refusal.
const INTENT_OR_ACTOR_ONLY = /bindingRejection === 'intent' \|\| bindingRejection === 'actor'\) complete(?:Job)?Idem\.resetKey/;

const read = (file: string) => readFileSync(file, 'utf8').replace(/\r\n/g, '\n');

describe('replay-binding batch 3a call sites retire the key on any binding refusal', () => {
  for (const [file, hook] of SITES) {
    it(`${file}: the completion retires ${hook} on intent, actor or receipt`, () => {
      const source = read(file);
      expect(source.match(anyBindingReset(hook))?.length ?? 0).toBe(1);
      expect(INTENT_OR_ACTOR_ONLY.test(source)).toBe(false);
      expect(source).toMatch(RELOADS[file]);
    });
  }

  // After 20261019200000 both refuse a keyless call (IDEMPOTENCY_KEY_REQUIRED); the generated types
  // still mark the key optional, so pin that every app call sends one.
  // Deliveries.tsx completes through start_and_complete_delivery (20261019220000), which also
  // requires a key and calls complete_delivery with a key derived from it.
  const KEYED_CALLS: Array<[string, string]> = [
    ['src/pages/Deliveries.tsx', 'start_and_complete_delivery'],
    ['src/pages/DeliveryDetail.tsx', 'complete_delivery'],
    ['src/pages/FieldStop.tsx', 'complete_delivery'],
    ['src/pages/FieldView.tsx', 'complete_job'],
    ['src/pages/JobDetail.tsx', 'complete_job'],
  ];
  for (const [file, rpc] of KEYED_CALLS) {
    it(`${file}: every ${rpc} call sends p_idempotency_key`, () => {
      const source = read(file);
      // Inline argument objects run to their closing '})'; DeliveryDetail, FieldStop and FieldView
      // pass (or spread) a named rpcParams object built just above the call.
      const inline = [...source.matchAll(new RegExp(`\\.rpc\\('${rpc}', \\{([\\s\\S]*?)\\n\\s*\\}\\)`, 'g'))];
      const named = [...source.matchAll(new RegExp(`\\.rpc\\('${rpc}', rpcParams\\)`, 'g'))];
      expect(inline.length + named.length).toBeGreaterThan(0);
      let usesRpcParams = named.length > 0;
      for (const call of inline) {
        if (/^\s*\.\.\.rpcParams,/.test(call[1])) { usesRpcParams = true; continue; }
        expect(call[1]).toMatch(/p_idempotency_key:\s*\S/);
        expect(call[1]).not.toMatch(/p_idempotency_key:[^,\n]*\b(?:undefined|null)\b/);
      }
      if (usesRpcParams) {
        const params = /const rpcParams[^=]*= \{([^;]*?)\};/.exec(source);
        expect(params?.[1]).toMatch(/p_idempotency_key:\s*(?:idemKey|completeIdem\.getKey(?:\(\)|For\(completeScope\)))/);
      }
    });
  }

  it('JobDetail maps the refusal codes to plain English (PostgREST errors are not Error instances)', () => {
    const source = read('src/pages/JobDetail.tsx');
    expect(source).toContain('const completeMsg = sanitizeError(err);');
  });

  it('the patterns tell the two forms apart', () => {
    const good = 'if (getIdempotencyBindingRejection(error)) {\n        completeIdem.resetKey();\n        fetchDelivery();\n      }';
    const narrow = "const bindingRejection = getIdempotencyBindingRejection(error);\n    if (bindingRejection === 'intent' || bindingRejection === 'actor') completeIdem.resetKey();";
    expect(good.match(anyBindingReset('completeIdem'))?.length).toBe(1);
    expect(narrow.match(anyBindingReset('completeIdem'))).toBeNull();
    expect(INTENT_OR_ACTOR_ONLY.test(narrow)).toBe(true);
    expect(INTENT_OR_ACTOR_ONLY.test(good)).toBe(false);
  });
});

// Both refuse a keyless call, so a browser test that leaves the key out fails once the migration is
// live. Every e2e call to one of them must send a key.
describe('replay-binding batch 3a e2e callers send a retry key', () => {
  const CALL = /(?:supabaseRpc|rpc)\(\s*page,\s*'(complete_delivery|complete_job)',\s*\{/g;
  const argsOf = (source: string, open: number) => {
    let depth = 1;
    let i = open;
    while (depth > 0 && i < source.length) {
      if (source[i] === '{') depth++;
      else if (source[i] === '}') depth--;
      i++;
    }
    return source.slice(open, i);
  };
  const keylessCalls = (source: string) =>
    [...source.matchAll(CALL)].filter((m) => !/p_idempotency_key/.test(argsOf(source, m.index + m[0].length)));

  it('no e2e spec calls complete_delivery or complete_job without p_idempotency_key', () => {
    const specs = readdirSync('tests/e2e').filter((f) => f.endsWith('.ts'));
    let calls = 0;
    for (const spec of specs) {
      const source = read(`tests/e2e/${spec}`);
      calls += [...source.matchAll(CALL)].length;
      expect(keylessCalls(source).map((m) => `${spec}: ${m[1]}`)).toEqual([]);
    }
    expect(calls).toBeGreaterThanOrEqual(9);
  });

  it('the check tells a keyless call from a keyed one', () => {
    expect(keylessCalls("await supabaseRpc(page, 'complete_delivery', { p_delivery_id: d, p_quantities: { a: 1 } });")).toHaveLength(1);
    expect(keylessCalls("await supabaseRpc(page, 'complete_delivery', { p_quantities: { a: 1 }, p_idempotency_key: k });")).toHaveLength(0);
  });
});

// complete_delivery's fingerprint includes p_completed_at, so a retry must resend the first send's
// completion time: a 'today' completion sends none, but after midnight 'today' is a past date that
// would send one, and that retry would be refused instead of replaying the saved result (Codex, PR #954).
describe('replay-binding batch 3a: a retry resends the completion time its key first sent', () => {
  it('completedAtForKey keeps the first value per key, even across midnight', () => {
    const sent = new Map<string, string | undefined>();
    // Before midnight: delivered 'today', so no p_completed_at.
    expect(completedAtForKey(sent, 'key-1', () => undefined)).toBeUndefined();
    // After midnight the same choice would compute a past-date timestamp; the retry keeps undefined.
    expect(completedAtForKey(sent, 'key-1', () => '2026-10-18T17:00:00.000Z')).toBeUndefined();
    // A fresh key computes its own value, and keeps it.
    expect(completedAtForKey(sent, 'key-2', () => '2026-10-17T17:00:00.000Z')).toBe('2026-10-17T17:00:00.000Z');
    expect(completedAtForKey(sent, 'key-2', () => undefined)).toBe('2026-10-17T17:00:00.000Z');
  });

  // Deliveries.tsx sends the chosen date (p_delivered_on) instead; the server derives the time,
  // and the date, not a time, is in the fingerprint, so a retry across midnight still replays.
  it('src/pages/Deliveries.tsx sends the chosen business date, never a completion time', () => {
    const source = read('src/pages/Deliveries.tsx');
    expect(source).toContain('p_delivered_on: deliveredOnDate,');
    expect(source).not.toMatch(/p_completed_at/);
    expect(source).not.toMatch(/\.rpc\('(?:confirm_delivery|complete_delivery)'/);
  });

  for (const [file, key] of [
    ['src/pages/DeliveryDetail.tsx', 'idemKey'],
    ['src/pages/FieldStop.tsx', 'rpcParams.p_idempotency_key'],
  ] as const) {
    it(`${file}: p_completed_at goes through completedAtForKey under the sent key`, () => {
      const source = read(file);
      expect(source).toContain('const sentCompletedAt = useRef(new Map<string, string | undefined>());');
      expect(source).toContain(`p_completed_at: completedAtForKey(sentCompletedAt.current, ${key}, () =>`);
      // No send computes the completion time directly any more.
      expect(source).not.toMatch(/p_completed_at: (?:usePaperTicket \?|deliveredOnDate &&)/);
    });
  }
});

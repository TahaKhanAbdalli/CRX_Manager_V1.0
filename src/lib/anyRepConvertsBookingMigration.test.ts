import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Mason 2026-10-27: any rep converts another rep's booking; the commission stays with the
// booking's rep. Behaviour is proven on a local replay (permission matrix + booking scenario);
// this pins the migration text so the owner gate is not quietly re-added or other checks lost.
const sql = readFileSync('supabase/migrations/20261027080400_any_rep_converts_booking.sql', 'utf8')
  .replace(/\r\n/g, '\n');
const body = sql.slice(
  sql.indexOf('CREATE OR REPLACE FUNCTION public._convert_quote_to_order_below_cost_impl_20260810('),
  sql.indexOf('DO $postflight$'),
);
const code = body.replace(/--.*$/gm, '');

describe('20261027080400 any rep converts a booking', () => {
  it('replaces only the convert implementation and has no owner gate', () => {
    expect(body.length).toBeGreaterThan(0);
    expect(sql.match(/CREATE OR REPLACE FUNCTION/g)).toHaveLength(1);
    expect(code).not.toContain('NOT_QUOTE_OWNER');
    expect(code).not.toContain('created_by');
  });

  it('keeps the auth, actor, role, stale-write, replay and sent-price checks', () => {
    for (const token of [
      "RAISE EXCEPTION 'AUTH_REQUIRED'",
      "RAISE EXCEPTION 'ACTOR_MISMATCH'",
      "AND role IN ('admin', 'sales_rep')",
      "RAISE EXCEPTION 'INSUFFICIENT_ROLE'",
      "RAISE EXCEPTION 'QUOTE_STALE_WRITE'",
      "public.check_idempotency(p_idempotency_key, 'convert_quote_to_order')",
      'FOR UPDATE',
      'public._assert_quote_prices_as_sent(p_quote_id)',
      'public._convert_quote_to_order_owner_impl(',
    ]) {
      expect(body).toContain(token);
    }
    expect(body).toMatch(/SECURITY DEFINER\s+SET search_path = public, pg_temp/);
  });

  it('runs one-transaction preflight and postflight pinned to the before and after bodies', () => {
    expect(sql).toContain("v_fn.body_md5 IS DISTINCT FROM '2ca6a730c8e7e89d3991a247403d82ec'");
    expect(sql).toContain("v_fn.body_md5 IS DISTINCT FROM 'b235027c4650936bad3c6b4701fc5249'");
    expect(sql).toContain("position('NOT_QUOTE_OWNER' IN v_fn.prosrc) > 0");
    expect(sql).toContain('POSTFLIGHT_OK');
  });
});

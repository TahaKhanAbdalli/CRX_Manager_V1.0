import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock supabase before importing
vi.mock('./db', () => {
  const createChain = () => {
    const chain: Record<string, ReturnType<typeof vi.fn>> = {};
    chain.select = vi.fn().mockReturnValue(chain);
    chain.eq = vi.fn().mockReturnValue(chain);
    chain.in = vi.fn().mockReturnValue(chain);
    chain.is = vi.fn().mockReturnValue(chain);
    chain.gt = vi.fn().mockReturnValue(chain);
    chain.gte = vi.fn().mockReturnValue(chain);
    chain.single = vi.fn();
    chain.maybeSingle = vi.fn();
    // Default: resolves to empty
    chain.then = vi.fn().mockImplementation((resolve) =>
      resolve({ data: [], error: null })
    );
    return chain;
  };
  return {
    supabase: {
      from: vi.fn().mockReturnValue(createChain()),
    },
    sanitizeError: vi.fn((e: unknown) => String(e)),
  };
});

import { checkRUPCompliance, rupRegisterDisposition, RUP_CHECK_FAILED_MESSAGE, type RUPComplianceResult } from './rupCompliance';
import { supabase } from './db';

function rupRes(p: Partial<RUPComplianceResult>): RUPComplianceResult {
  return {
    hasRUPProducts: false,
    hasValidLicense: false,
    expiredLicense: false,
    missingLicense: false,
    rupProductNames: [],
    warnings: [],
    checkFailed: false,
    ...p,
  };
}

function mockSupabaseFrom(responses: Record<string, { data: unknown; error: { message: string } | null } | 'throws'>) {
  (supabase.from as ReturnType<typeof vi.fn>).mockImplementation((table: string) => {
    const chain: Record<string, unknown> = {};
    const response = responses[table] || { data: [], error: null };

    chain.select = vi.fn().mockReturnValue(chain);
    chain.eq = vi.fn().mockReturnValue(chain);
    chain.in = vi.fn().mockReturnValue(chain);
    chain.is = vi.fn().mockReturnValue(chain);

    // Make the chain thenable (awaitable) returning the response
    (chain as { then: unknown }).then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
      response === 'throws' ? Promise.resolve(reject(new Error('Failed to fetch'))) : Promise.resolve(resolve(response));

    return chain;
  });
}

describe('checkRUPCompliance', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns no warnings when no products are RUP', async () => {
    mockSupabaseFrom({
      products: { data: [], error: null },
    });

    const result = await checkRUPCompliance('customer-1', ['prod-1', 'prod-2']);
    expect(result.hasRUPProducts).toBe(false);
    expect(result.warnings).toHaveLength(0);
  });

  it('returns no warnings when productIds is empty', async () => {
    const result = await checkRUPCompliance('customer-1', []);
    expect(result.hasRUPProducts).toBe(false);
    expect(result.warnings).toHaveLength(0);
  });

  it('warns when RUP product and customer has no license', async () => {
    mockSupabaseFrom({
      products: { data: [{ id: 'rup-1', product_name: 'Atrazine' }], error: null },
      applicator_licenses: { data: [], error: null },
    });

    const result = await checkRUPCompliance('customer-1', ['rup-1']);
    expect(result.hasRUPProducts).toBe(true);
    expect(result.missingLicense).toBe(true);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings[0]).toContain('Atrazine');
    expect(result.warnings[0]).toContain('No license on file');
  });

  it('warns when RUP product and customer license is expired', async () => {
    mockSupabaseFrom({
      products: { data: [{ id: 'rup-1', product_name: 'Paraquat' }], error: null },
      applicator_licenses: {
        data: [{ id: 'lic-1', expiry_date: '2020-01-01' }],
        error: null,
      },
    });

    const result = await checkRUPCompliance('customer-1', ['rup-1']);
    expect(result.hasRUPProducts).toBe(true);
    expect(result.expiredLicense).toBe(true);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings[0]).toContain('expired');
  });

  it('returns no warnings when RUP product and license is valid', async () => {
    mockSupabaseFrom({
      products: { data: [{ id: 'rup-1', product_name: 'Atrazine' }], error: null },
      applicator_licenses: {
        data: [{ id: 'lic-1', expiry_date: '2030-12-31' }],
        error: null,
      },
    });

    const result = await checkRUPCompliance('customer-1', ['rup-1']);
    expect(result.hasRUPProducts).toBe(true);
    expect(result.hasValidLicense).toBe(true);
    expect(result.warnings).toHaveLength(0);
  });

  it('returns multiple RUP product names in warnings', async () => {
    mockSupabaseFrom({
      products: {
        data: [
          { id: 'rup-1', product_name: 'Atrazine' },
          { id: 'rup-2', product_name: 'Paraquat' },
        ],
        error: null,
      },
      applicator_licenses: { data: [], error: null },
    });

    const result = await checkRUPCompliance('customer-1', ['rup-1', 'rup-2']);
    expect(result.rupProductNames).toEqual(['Atrazine', 'Paraquat']);
    expect(result.warnings[0]).toContain('Atrazine');
    expect(result.warnings[0]).toContain('Paraquat');
  });

  // To-Do 10.5 follow-up: a read that fails, throws, or answers with no list used to
  // come back as "no RUP products" (or, for the products read, a generic warning with
  // hasRUPProducts false), so an RUP sale could reach the post confirm looking clean.
  const FAILURES = {
    error: { data: null, error: { message: 'connection reset' } },
    nodata: { data: null, error: null },
    notlist: { data: { id: 'rup-1' }, error: null },
    throws: 'throws',
  } as const;

  for (const [mode, failure] of Object.entries(FAILURES)) {
    it(`a products read that ${mode} is a failed check, never a pass`, async () => {
      mockSupabaseFrom({ products: failure });
      const result = await checkRUPCompliance('customer-1', ['rup-1']);
      expect(result.checkFailed).toBe(true);
      expect(result.warnings).toEqual([RUP_CHECK_FAILED_MESSAGE]);
    });

    it(`a license read that ${mode} is a failed check, never "no license" or a pass`, async () => {
      mockSupabaseFrom({
        products: { data: [{ id: 'rup-1', product_name: 'Atrazine' }], error: null },
        applicator_licenses: failure,
      });
      const result = await checkRUPCompliance('customer-1', ['rup-1']);
      expect(result.checkFailed).toBe(true);
      expect(result.missingLicense).toBe(false);
      expect(result.hasValidLicense).toBe(false);
      expect(result.warnings).toEqual([RUP_CHECK_FAILED_MESSAGE]);
    });
  }

  it('a clean read is not a failed check', async () => {
    mockSupabaseFrom({ products: { data: [], error: null } });
    expect((await checkRUPCompliance('customer-1', ['p-1'])).checkFailed).toBe(false);
  });
});

// Mirrors the CASE in generate_rup_sales_records (migration 20260610185741):
//   missing -> non_compliant, expired -> warning, valid/none -> nothing.
describe('rupRegisterDisposition (#6 — UI disposition matches the DB record)', () => {
  it('no RUP products -> records nothing', () => {
    expect(rupRegisterDisposition(rupRes({ hasRUPProducts: false }))).toEqual({ status: null, label: null });
  });
  it('a check that could not run has no disposition, never an expired-license WARNING', () => {
    expect(rupRegisterDisposition(rupRes({ hasRUPProducts: true, checkFailed: true }))).toEqual({ status: null, label: null });
  });
  it('RUP + valid license -> records nothing', () => {
    expect(rupRegisterDisposition(rupRes({ hasRUPProducts: true, hasValidLicense: true }))).toEqual({ status: null, label: null });
  });
  it('RUP + MISSING license -> non_compliant / NON-COMPLIANT', () => {
    expect(rupRegisterDisposition(rupRes({ hasRUPProducts: true, missingLicense: true }))).toEqual({ status: 'non_compliant', label: 'NON-COMPLIANT' });
  });
  it('RUP + EXPIRED license -> warning / WARNING (NOT non-compliant)', () => {
    expect(rupRegisterDisposition(rupRes({ hasRUPProducts: true, expiredLicense: true }))).toEqual({ status: 'warning', label: 'WARNING' });
  });
});

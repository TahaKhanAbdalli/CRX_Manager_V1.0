/**
 * AccountsReceivable.businessDate.test.tsx — the summary strip and the AR Aging table ask for
 * the same day: Chicago's.
 *
 * The strip used to ask get_ar_aging for `new Date().toISOString().slice(0, 10)`, a UTC date.
 * From about 7pm Central UTC is already tomorrow, so the strip asked for tomorrow's aging
 * while the table under it asked for the browser's today. The clock below is pinned to 8:30pm
 * Central, and the computer's own timezone to UTC, so a screen reading either clock asks for
 * the wrong day here.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const H = vi.hoisted(() => ({
  rpcCalls: [] as Array<[string, unknown]>,
  functions: {} as Record<string, unknown[]>,
  // One toast function for the whole run, as the real useToast gives: ARaging reloads the
  // aging whenever `toast` changes, so a new one per render would reload it endlessly.
  toast: vi.fn(),
}));

// Every query chain, table or function, answers with its rows (none unless a test sets some).
const reply = (rows: unknown[] = []) => {
  const chain: object = new Proxy({}, {
    get: (_target, prop) => (prop === 'then'
      ? (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
        Promise.resolve({ data: rows, error: null, count: rows.length }).then(resolve, reject)
      : () => chain),
  });
  return chain;
};

vi.mock('../lib/db', async () => {
  const actual = await vi.importActual<typeof import('../lib/db')>('../lib/db');
  return {
    ...actual,
    supabase: {
      from: () => reply(),
      rpc: (name: string, args: unknown) => {
        H.rpcCalls.push([name, args]);
        return reply(H.functions[name]);
      },
    },
  };
});
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../lib/activityLogger', () => ({ logActivity: vi.fn() }));
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ profile: { id: 'user-1', role: 'admin', full_name: 'Admin' }, role: 'admin', deniedPages: [] }),
}));
vi.mock('../components/ui/Toast', () => ({ useToast: () => ({ toast: H.toast }) }));

import AccountsReceivable from './AccountsReceivable';
import ARaging from './ARaging';

const originalTz = process.env.TZ;
const agingDates = () => H.rpcCalls
  .filter(([name]) => name === 'get_ar_aging')
  .map(([, args]) => (args as { p_as_of_date: string }).p_as_of_date);

beforeEach(() => {
  H.rpcCalls = [];
  H.functions = {};
  // A computer set to UTC (as CI is, or a viewer's laptop could be).
  process.env.TZ = 'UTC';
  vi.useFakeTimers({ toFake: ['Date'] });
  // 8:30pm Central (CDT, UTC-5) on Tuesday 2026-10-20 is 01:30 UTC on Wednesday 2026-10-21.
  vi.setSystemTime(new Date('2026-10-21T01:30:00Z'));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  // Assigning undefined would set the string "undefined", not unset it.
  if (originalTz === undefined) delete process.env.TZ;
  else process.env.TZ = originalTz;
});

describe('Accounts Receivable in the evening, Central time', () => {
  it("the summary strip asks for Chicago's date, not tomorrow's", async () => {
    // On another tab only the strip asks for the aging.
    render(<MemoryRouter initialEntries={['/?tab=payments']}><AccountsReceivable /></MemoryRouter>);
    await waitFor(() => expect(agingDates()).toEqual(['2026-10-20']));
  });

  it("the AR Aging table asks for Chicago's date, not the computer's", async () => {
    render(<MemoryRouter><ARaging /></MemoryRouter>);
    await waitFor(() => expect(agingDates()).toEqual(['2026-10-20']));
  });

  it('on the AR Aging tab, the strip and the table ask for the same day', async () => {
    render(<MemoryRouter initialEntries={['/']}><AccountsReceivable /></MemoryRouter>);
    await waitFor(() => expect(agingDates()).toHaveLength(2));
    expect(agingDates()).toEqual(['2026-10-20', '2026-10-20']);
  });

  it('Batch Print starts on the same Chicago date that Email Statements uses', async () => {
    H.functions.get_ar_aging = [{
      customer_id: 'c1', farm_name: 'Big Farm', current_amount: 10, days_30: 0, days_60: 0, days_90: 0,
      over_90: 0, total_outstanding: 10, prepay_balance_cents: 0, open_credit_cents: 0,
    }];
    render(<MemoryRouter><ARaging /></MemoryRouter>);
    // The customer's row has the table's only checkbox.
    fireEvent.click((await screen.findAllByRole('checkbox'))[0]);
    fireEvent.click(await screen.findByRole('button', { name: /Batch Print \(1\)/ }));
    const dateBox = (await screen.findByText('Statement As-of Date')).parentElement!.querySelector('input[type="date"]') as HTMLInputElement;
    expect(dateBox.value).toBe('2026-10-20');
    // Loaded once: a reload would swap in the loading placeholder and take the pop-up with it.
    expect(agingDates()).toEqual(['2026-10-20']);
  });

  const oneCustomer = () => {
    H.functions.get_ar_aging = [{
      customer_id: 'c1', farm_name: 'Big Farm', current_amount: 10, days_30: 0, days_60: 0, days_90: 0,
      over_90: 0, total_outstanding: 10, prepay_balance_cents: 0, open_credit_cents: 0,
    }];
  };
  const printDialogDate = async () =>
    ((await screen.findByText('Statement As-of Date')).parentElement!.querySelector('input[type="date"]') as HTMLInputElement).value;

  it("Print Statement from an aging row starts on the table's date", async () => {
    oneCustomer();
    render(<MemoryRouter><ARaging /></MemoryRouter>);
    fireEvent.click((await screen.findAllByTitle('Print Statement'))[0]);
    expect(await printDialogDate()).toBe('2026-10-20');
  });

  it("Print Statement from the Customer Statement tab starts on that tab's end date", async () => {
    oneCustomer();
    render(<MemoryRouter><ARaging /></MemoryRouter>);
    // The customer's name opens their statement; its end date is the box on that tab.
    fireEvent.click((await screen.findAllByRole('button', { name: 'Big Farm' }))[0]);
    const printButton = await screen.findByRole('button', { name: /Print Statement/ });
    // Start and end boxes; the end date still follows the computer's clock (UTC here), so it
    // differs from the table's Chicago date and a pop-up on the wrong date would show.
    const dateBoxes = screen.getAllByDisplayValue(/^\d{4}-\d{2}-\d{2}$/) as HTMLInputElement[];
    expect(dateBoxes).toHaveLength(2);
    expect(dateBoxes[1].value).toBe('2026-10-21');
    fireEvent.click(printButton);
    expect(await printDialogDate()).toBe('2026-10-21');
  });

  it('after the As of Date is changed, Batch Print starts on the new date', async () => {
    H.functions.get_ar_aging = [{
      customer_id: 'c1', farm_name: 'Big Farm', current_amount: 10, days_30: 0, days_60: 0, days_90: 0,
      over_90: 0, total_outstanding: 10, prepay_balance_cents: 0, open_credit_cents: 0,
    }];
    const { container } = render(<MemoryRouter><ARaging /></MemoryRouter>);
    await screen.findAllByRole('checkbox');
    fireEvent.change(container.querySelector('input[type="date"]')!, { target: { value: '2026-09-30' } });
    await waitFor(() => expect(agingDates()).toEqual(['2026-10-20', '2026-09-30']));
    fireEvent.click((await screen.findAllByRole('checkbox'))[0]);
    fireEvent.click(await screen.findByRole('button', { name: /Batch Print \(1\)/ }));
    const dateBox = (await screen.findByText('Statement As-of Date')).parentElement!.querySelector('input[type="date"]') as HTMLInputElement;
    expect(dateBox.value).toBe('2026-09-30');
  });
});

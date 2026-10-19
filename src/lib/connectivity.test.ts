import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { hasSignal } from './connectivity';
import { countOrdinaryPhotos, hasPaperTicketPhoto, isValidDeliveredOn, PAPER_TICKET_PHOTO_CAPTION, paperDeliveredAt } from './paperTicket';
import { todayInBusinessTz } from './dateUtils';

function setOnline(value: boolean) {
  Object.defineProperty(window.navigator, 'onLine', { configurable: true, get: () => value });
}

describe('hasSignal (Goal 5: completing a delivery needs a signal)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    setOnline(true);
  });

  it('is false without touching the network when the phone reports offline', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    setOnline(false);
    expect(await hasSignal()).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('is false quickly when the phone says online but the request cannot reach the server', async () => {
    const fetchSpy = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    vi.stubGlobal('fetch', fetchSpy);
    const started = Date.now();
    expect(await hasSignal(2000)).toBe(false);
    // No automatic retries: one attempt, refused well inside the timeout.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('is false at the timeout even if the probe itself never settles', async () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => { /* ignores abort */ })));
    expect(await hasSignal(50)).toBe(false);
  });

  it('is false when the server never answers before the timeout', async () => {
    vi.stubGlobal('fetch', vi.fn((_url: string, init?: RequestInit) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    })));
    expect(await hasSignal(50)).toBe(false);
  });

  it('is true for any real HTTP answer, including a refusal', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 200 })));
    expect(await hasSignal()).toBe(true);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 401 })));
    expect(await hasSignal()).toBe(true);
  });
});

describe('paper ticket photo', () => {
  it('is found only by its exact caption', () => {
    expect(hasPaperTicketPhoto([{ caption: null }, { caption: 'Drop spot' }])).toBe(false);
    expect(hasPaperTicketPhoto([{ caption: PAPER_TICKET_PHOTO_CAPTION }])).toBe(true);
  });

  it('sends a delivered-on date only when it is not today', () => {
    expect(paperDeliveredAt(todayInBusinessTz())).toBeUndefined();
    expect(paperDeliveredAt('')).toBeUndefined();
    // Chicago midday, independent of the test machine's time zone.
    expect(paperDeliveredAt('2026-10-17')).toBe('2026-10-17T17:00:00.000Z');
    const chicagoDay = (iso: string) =>
      new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date(iso));
    expect(chicagoDay(paperDeliveredAt('2026-10-17') as string)).toBe('2026-10-17'); // CDT
    expect(chicagoDay(paperDeliveredAt('2026-01-15') as string)).toBe('2026-01-15'); // CST
  });

  it('accepts only real calendar dates, today or earlier', () => {
    expect(isValidDeliveredOn('2026-02-28')).toBe(true);
    expect(isValidDeliveredOn('2024-02-29')).toBe(true); // leap day
    expect(isValidDeliveredOn('2026-02-31')).toBe(false);
    expect(isValidDeliveredOn('2026-13-01')).toBe(false);
    expect(isValidDeliveredOn('2026-04-31')).toBe(false);
    expect(isValidDeliveredOn('')).toBe(false);
    expect(isValidDeliveredOn('9999-12-31')).toBe(false); // future
    expect(isValidDeliveredOn(todayInBusinessTz())).toBe(true);
  });

  it('does not count toward the 10-photo limit', () => {
    const ten = Array.from({ length: 10 }, () => ({ caption: null }));
    expect(countOrdinaryPhotos([...ten, { caption: PAPER_TICKET_PHOTO_CAPTION }])).toBe(10);
  });
});

describe('no delivery completion is queued offline', () => {
  it.each(['src/pages/DeliveryDetail.tsx', 'src/pages/FieldStop.tsx', 'src/pages/Deliveries.tsx'])(
    '%s neither queues work offline nor skips the signal check',
    (path) => {
      const source = readFileSync(path, 'utf8');
      expect(source).not.toMatch(/queueAction/);
      // The check must be real code that runs before the completion call, not a mention.
      const check = source.indexOf('if (!(await hasSignal()))');
      const complete = source.indexOf("supabase.rpc('complete_delivery'");
      expect(check).toBeGreaterThan(-1);
      expect(complete).toBeGreaterThan(check);
    },
  );
});

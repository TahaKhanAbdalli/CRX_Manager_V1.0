/**
 * Goal 5 — completing a delivery needs a signal (Mason, 2026-10-15: "we should
 * just be connected to internet to make sure no errors like this happen").
 *
 * Every delivery completion path calls hasSignal() before it changes anything and
 * refuses with NO_SIGNAL_MESSAGE when it fails. navigator.onLine alone is not
 * enough: a phone on farm Wi-Fi with no internet behind it reports "online".
 * So this also makes one tiny read from the database and only trusts a real HTTP
 * answer. postgrest-js reports a dropped or aborted request as status 0; any
 * HTTP status (even a refusal) proves the server is reachable.
 *
 * This is a pre-check, not a guarantee: signal can still drop mid-request.
 * That lost-reply case is Goal 3's retry handling (retained idempotency keys).
 */
import { supabase } from './db';

export const NO_SIGNAL_MESSAGE =
  'No signal. This delivery was NOT completed and nothing was saved. Move to where you have signal, then try again.';

const PROBE_TIMEOUT_MS = 6000;

export async function hasSignal(timeoutMs: number = PROBE_TIMEOUT_MS): Promise<boolean> {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return false;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  // The timer races the whole probe, not just the request: before sending, the client
  // may try to renew an expired sign-in, and that renewal has its own longer retries.
  const timedOut = new Promise<false>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(false);
    }, timeoutMs);
  });
  const probe = (async () => {
    try {
      const { status } = await supabase
        .from('deliveries')
        .select('id', { head: true })
        .limit(1)
        .retry(false)
        .abortSignal(controller.signal);
      return status > 0;
    } catch {
      return false;
    }
  })();
  try {
    return await Promise.race([probe, timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

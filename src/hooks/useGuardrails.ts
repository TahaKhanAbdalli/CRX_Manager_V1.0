import { useState, useCallback, useRef } from 'react';
import { supabase } from '../lib/db';
import { CREDIT_LIMIT_UNVERIFIED_MESSAGE, evaluateCreditLimit, type CreditLimitParams } from '../lib/creditLimitGuard';
import { Sentry } from '../lib/sentry';

// ── Types ──────────────────────────────────────────────────────────

export interface GuardrailWarning {
  id: string;
  severity: 'warning' | 'danger';
  message: string;
  dismissed: boolean;
  /** False when the warning offers no "Continue Anyway" (a check that could not run). */
  dismissible?: boolean;
}

// ── Credit Limit Check ─────────────────────────────────────────────

/**
 * `check` resolves true when the action may go ahead. An over-limit warning can be overridden:
 * after "Continue Anyway" the next check of an over-limit amount goes ahead once. A check that
 * could not run cannot be overridden (Mason, 2026-10-26: a hard stop, "try again").
 */
export function useCreditLimitCheck() {
  const [warning, setWarning] = useState<GuardrailWarning | null>(null);
  // Set by "Continue Anyway" on an over-limit warning; spent by the next over-limit check.
  const overrideRef = useRef(false);

  const check = useCallback(async (params: CreditLimitParams): Promise<boolean> => {
    const result = await evaluateCreditLimit(params);
    if (result.status === 'over') {
      if (overrideRef.current) {
        overrideRef.current = false;
        setWarning(null);
        return true;
      }
      setWarning({ id: 'credit-limit', severity: 'danger', message: result.message, dismissed: false });
      return false;
    }
    overrideRef.current = false;
    if (result.status === 'unverified') {
      // Audit #25 + To-Do 10.5: fail closed on guardrail-verification errors, with no override.
      // A pass-through here lets over-limit orders and posts through during a Supabase outage.
      setWarning({ id: 'credit-limit-error', severity: 'warning', message: CREDIT_LIMIT_UNVERIFIED_MESSAGE, dismissed: false, dismissible: false });
      return false;
    }
    setWarning(null);
    return true;
  }, []);

  const dismiss = useCallback(() => {
    setWarning((prev) => {
      if (!prev || prev.dismissible === false) return prev;
      overrideRef.current = true;
      return { ...prev, dismissed: true };
    });
  }, []);

  return { warning, check, dismiss };
}

// ── Stale Quote Check ──────────────────────────────────────────────

export function useStaleQuoteCheck() {
  const [warning, setWarning] = useState<GuardrailWarning | null>(null);

  const check = useCallback((createdAt: string): boolean => {
    const ageMs = Date.now() - new Date(createdAt).getTime();
    const ageDays = Math.floor(ageMs / 86_400_000);

    if (ageDays > 30) {
      setWarning({
        id: 'stale-quote',
        severity: 'warning',
        message: `This quote is ${ageDays} days old. Product prices may have changed since it was created.`,
        dismissed: false,
      });
      return false;
    }

    setWarning(null);
    return true;
  }, []);

  const dismiss = useCallback(() => {
    setWarning((prev) => (prev ? { ...prev, dismissed: true } : null));
  }, []);

  return { warning, check, dismiss };
}

// ── Overloaded Driver Check ────────────────────────────────────────

interface DriverCheckParams {
  driverId: string;
  scheduledDate: string;
  driverName?: string;
}

export function useOverloadedDriverCheck() {
  const [warning, setWarning] = useState<GuardrailWarning | null>(null);

  const check = useCallback(async ({ driverId, scheduledDate, driverName }: DriverCheckParams): Promise<boolean> => {
    if (!driverId || !scheduledDate) {
      setWarning(null);
      return true;
    }

    try {
      const { data, error } = await supabase
        .from('deliveries')
        .select('id')
        .eq('assigned_driver', driverId)
        .eq('scheduled_date', scheduledDate)
        .in('status', ['scheduled', 'in_progress']);

      if (error) throw error;

      const count = data?.length || 0;
      if (count >= 5) {
        setWarning({
          id: 'overloaded-driver',
          severity: 'warning',
          message: `${driverName || 'This driver'} already has ${count} deliveries scheduled for ${new Date(scheduledDate + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}.`,
          dismissed: false,
        });
        return false;
      }

      setWarning(null);
      return true;
    } catch (error) {
      // Audit #25: Fail-closed (see credit_limit comment above).
      Sentry.captureException(error, { tags: { guardrail: 'overloaded_driver' } });
      setWarning({
        id: 'overloaded-driver-error',
        severity: 'warning',
        message: 'Could not verify driver workload. Please refresh and try again before scheduling.',
        dismissed: false,
      });
      return false;
    }
  }, []);

  const dismiss = useCallback(() => {
    setWarning((prev) => (prev ? { ...prev, dismissed: true } : null));
  }, []);

  return { warning, check, dismiss };
}

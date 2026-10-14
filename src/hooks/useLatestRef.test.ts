import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useLatestRef } from './useLatestRef';

describe('useLatestRef', () => {
  it('holds the initial value and follows each committed value with a stable ref object', () => {
    const { result, rerender } = renderHook(({ value }) => useLatestRef(value), {
      initialProps: { value: 'first' },
    });
    const ref = result.current;
    expect(ref.current).toBe('first');

    rerender({ value: 'second' });
    expect(result.current).toBe(ref);
    expect(ref.current).toBe('second');
  });
});

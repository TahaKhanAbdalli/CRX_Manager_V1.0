import { useLayoutEffect, useRef, type RefObject } from 'react';

/**
 * A ref that holds the latest COMMITTED value. It is written in a layout effect,
 * never during render, so an event handler, subscription or later effect never
 * sees a value from a render React discarded (React 19 can interrupt renders).
 * Read `.current` only outside render.
 */
export function useLatestRef<T>(value: T): RefObject<T> {
  const ref = useRef(value);
  useLayoutEffect(() => {
    ref.current = value;
  });
  return ref;
}

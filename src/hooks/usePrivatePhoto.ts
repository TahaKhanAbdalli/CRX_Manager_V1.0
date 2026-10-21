/**
 * Download one private staff photo with the signed-in user's session and expose it as a
 * tab-local blob: URL (see src/lib/privatePhotos.ts for why). Field-safe: a dropped or stalled connection
 * ends in a retryable error (never an endless spinner), the photo retries by itself when the
 * device comes back online, an unmount aborts the download, and the blob URL is released when
 * the photo leaves the screen.
 */
import { useCallback, useEffect, useLayoutEffect, useState } from 'react';
import { supabase } from '../lib/db';
import { Sentry } from '../lib/sentry';
import type { PrivatePhotoBucket } from '../lib/privatePhotos';

export type PrivatePhotoState =
  | { status: 'loading' }
  | { status: 'ready'; url: string }
  | { status: 'error' };

export interface PrivatePhoto {
  state: PrivatePhotoState;
  /** Try the download again (after a failure). */
  retry: () => void;
}

// One report per object per page load: an offline page or a missing object must not send one
// Sentry event per thumbnail per mount.
const reported = new Set<string>();

// Long enough for a compressed photo on one bar of signal; short enough that a stalled request
// does not leave a spinner up indefinitely.
const DOWNLOAD_TIMEOUT_MS = 30_000;

export function usePrivatePhoto(bucket: PrivatePhotoBucket, path: string | null | undefined): PrivatePhoto {
  const key = path ? `${bucket}/${path}` : '';
  const [attempt, setAttempt] = useState(0);
  // The result is tagged with the key and attempt that produced it, so a result for another path
  // (or a blob already released by an earlier effect) is never shown.
  const [loaded, setLoaded] = useState<{ tag: string; state: PrivatePhotoState } | null>(null);
  const tag = `${key}#${attempt}`;

  useEffect(() => {
    if (!path) return undefined;
    const controller = new AbortController();
    let objectUrl: string | null = null;
    let settled = false;
    const fail = (error: unknown) => {
      if (settled || controller.signal.aborted) return;
      settled = true;
      setLoaded({ tag, state: { status: 'error' } });
      const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
      if (!offline && !reported.has(key)) {
        reported.add(key);
        Sentry.captureException(error instanceof Error ? error : new Error('Private photo download failed'), {
          level: 'warning',
          extra: { context: 'Private photo download failed', bucket },
        });
      }
    };
    // A stalled connection on weak field signal may never reject: give up after a while and offer
    // a retry instead of spinning forever.
    const timer = setTimeout(() => {
      if (settled) return;
      fail(new Error('Private photo download timed out'));
      controller.abort();
    }, DOWNLOAD_TIMEOUT_MS);
    // no-store: every view asks Storage again, so the read policy decides each time; a cached copy
    // must not outlive a sign-out, deactivation or reassignment on a shared device.
    supabase.storage.from(bucket).download(path, {}, { signal: controller.signal, cache: 'no-store' })
      .then(({ data, error }) => {
        if (settled || controller.signal.aborted) return;
        if (error || !data) {
          // A refusal (signed out, deactivated, not allowed) or a missing file.
          fail(error ?? new Error('empty photo download'));
          return;
        }
        settled = true;
        objectUrl = URL.createObjectURL(data);
        setLoaded({ tag, state: { status: 'ready', url: objectUrl } });
      })
      // A connection dropped mid-download rejects instead of returning an error.
      .catch(fail);
    return () => {
      clearTimeout(timer);
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [bucket, path, key, tag]);

  const failed = loaded?.tag === tag && loaded.state.status === 'error';
  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  // Back online after a failure: try again by itself. A layout effect listens from the same
  // commit that shows the failure, so a reconnect right after the placeholder appears is not
  // missed while a passive effect waits to run.
  useLayoutEffect(() => {
    if (!failed) return undefined;
    window.addEventListener('online', retry);
    return () => window.removeEventListener('online', retry);
  }, [failed, retry]);

  if (!path) return { state: { status: 'error' }, retry };
  return { state: loaded?.tag === tag ? loaded.state : { status: 'loading' }, retry };
}

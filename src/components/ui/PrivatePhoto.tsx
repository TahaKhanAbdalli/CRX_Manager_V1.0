import { useEffect, useRef, useState } from 'react';
import { ImageOff, Loader2, X, ZoomIn, ZoomOut } from 'lucide-react';
import { usePrivatePhoto, type PrivatePhotoState } from '../../hooks/usePrivatePhoto';
import type { PrivatePhotoBucket } from '../../lib/privatePhotos';

interface PrivatePhotoProps {
  bucket: PrivatePhotoBucket;
  path: string | null | undefined;
  alt: string;
  /** Classes for the image and its placeholder (size, fit, rounding, border). */
  className?: string;
  /** Background and text color of the loading/failed placeholder. */
  placeholderClassName?: string;
}

const DEFAULT_PLACEHOLDER = 'bg-gray-100 text-gray-400';

function PhotoContent({ state, alt, className = '', placeholderClassName = DEFAULT_PLACEHOLDER }: {
  state: PrivatePhotoState; alt: string; className?: string; placeholderClassName?: string;
}) {
  if (state.status === 'ready') return <img src={state.url} alt={alt} className={className} />;
  const loading = state.status === 'loading';
  return (
    <span
      className={`flex items-center justify-center ${placeholderClassName} ${className}`}
      role="img"
      aria-label={loading ? `Loading ${alt}` : `${alt} unavailable`}
    >
      {loading ? <Loader2 className="w-5 h-5 animate-spin" /> : <ImageOff className="w-5 h-5" />}
    </span>
  );
}

/**
 * Shows a private staff photo fetched with the signed-in user's session (see
 * hooks/usePrivatePhoto). Never renders a storage URL. A failed photo can be tapped to retry.
 */
export default function PrivatePhoto({ bucket, path, alt, className, placeholderClassName }: PrivatePhotoProps) {
  const { state, retry } = usePrivatePhoto(bucket, path);
  if (state.status === 'error' && path) {
    return (
      <button type="button" onClick={retry} className="block w-full" aria-label={`Retry loading ${alt}`}>
        <PhotoContent state={state} alt={alt} className={className} placeholderClassName={placeholderClassName} />
      </button>
    );
  }
  return <PhotoContent state={state} alt={alt} className={className} placeholderClassName={placeholderClassName} />;
}

interface PrivatePhotoButtonProps extends PrivatePhotoProps {
  /** Title of the full-size viewer. */
  viewerTitle?: string;
}

/**
 * A thumbnail that opens the full-size photo in an in-app viewer (replaces window.open(url):
 * there is no shareable URL, and a blob: URL in a new window misbehaves in the installed phone
 * app). The viewer reuses the thumbnail's download. A failed thumbnail retries instead.
 */
export function PrivatePhotoButton({ bucket, path, alt, className, placeholderClassName, viewerTitle = 'Photo' }: PrivatePhotoButtonProps) {
  const { state, retry } = usePrivatePhoto(bucket, path);
  const [open, setOpen] = useState(false);
  const failed = state.status === 'error' && Boolean(path);
  return (
    <>
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); if (failed) retry(); else if (state.status === 'ready') setOpen(true); }}
        disabled={state.status === 'loading' || !path}
        className="block w-full focus:outline-none focus:ring-2 focus:ring-crx-green rounded-lg disabled:cursor-default"
        aria-label={failed ? `Retry loading ${alt}` : `View ${alt}`}
      >
        <PhotoContent state={state} alt={alt} className={className} placeholderClassName={placeholderClassName} />
      </button>
      {open && state.status === 'ready' && (
        <PhotoViewer url={state.url} alt={alt} title={viewerTitle} onClose={() => setOpen(false)} />
      )}
    </>
  );
}

/**
 * Full-screen photo viewer. Its key handler runs in the capture phase on window and stops the
 * event there, so Escape closes only the viewer, not a dialog it was opened from (a Modal listens
 * on document), and Tab stays inside the viewer. Tap the image (or the zoom button) to switch
 * between fit-to-screen and full size.
 */
function PhotoViewer({ url, alt, title, onClose }: { url: string; alt: string; title: string; onClose: () => void }) {
  const [zoomed, setZoomed] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key === 'Tab' && panelRef.current) {
        e.stopPropagation();
        const focusable = panelRef.current.querySelectorAll<HTMLElement>('button:not([tabindex="-1"])');
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      previous?.focus?.();
    };
  }, [onClose]);

  return (
    <div ref={panelRef} className="fixed inset-0 z-[60] flex flex-col bg-black/90" role="dialog" aria-modal="true" aria-label={title}>
      <div className="flex items-center justify-between gap-2 p-3 pt-[calc(0.75rem+env(safe-area-inset-top))] text-white">
        <h2 className="truncate text-sm font-medium">{title}</h2>
        <div className="flex items-center gap-1">
          <button type="button" onClick={() => setZoomed((z) => !z)} className="p-2 rounded-lg hover:bg-white/10" aria-label={zoomed ? 'Fit photo to screen' : 'Show photo at full size'}>
            {zoomed ? <ZoomOut className="w-5 h-5" /> : <ZoomIn className="w-5 h-5" />}
          </button>
          <button ref={closeRef} type="button" onClick={onClose} className="p-2 rounded-lg hover:bg-white/10" aria-label="Close photo">
            <X className="w-5 h-5" />
          </button>
        </div>
      </div>
      <div className={`flex-1 min-h-0 overflow-auto overscroll-contain ${zoomed ? '' : 'flex items-center justify-center'}`}>
        <button
          type="button"
          tabIndex={-1}
          onClick={() => setZoomed((z) => !z)}
          className={zoomed ? 'block cursor-zoom-out' : 'flex max-w-full max-h-full cursor-zoom-in'}
        >
          <img
            src={url}
            alt={alt}
            className={zoomed ? 'max-w-none' : 'max-w-full max-h-full object-contain'}
          />
        </button>
      </div>
    </div>
  );
}

/**
 * Staff photos (delivery, receiving and team-note photos) are private (Goal 1, Mason 2026-10-13).
 * The app never shows a storage URL: it downloads each file with the signed-in user's session
 * (the bucket's storage policy decides, per request, against the live profile) and shows a
 * blob: URL that exists only inside this tab (src/hooks/usePrivatePhoto.ts,
 * src/components/ui/PrivatePhoto.tsx).
 *
 * Deploy order: those downloads need the storage read policies of migration 20261015230000, so
 * the migration is applied before this code ships (ship.md applies it before the merge). The
 * buckets stay public until a later migration makes them private.
 *
 * Accepted limitation (Mason, 2026-10-14, option A): a staff member who may view a photo can
 * still deliberately mint a temporary signed link to it through the storage API. That is no more
 * than saving and forwarding the file itself; ordinary app use never creates such a link.
 */

export type PrivatePhotoBucket = 'delivery-photos' | 'receiving-photos' | 'team-note-attachments';

/**
 * The object path inside `bucket` for a row that stored only the old public URL
 * (team_note_attachments.file_url). Returns null when the URL is not a public object URL of
 * that bucket.
 */
export function storagePathFromPublicUrl(url: string | null | undefined, bucket: PrivatePhotoBucket): string | null {
  if (!url) return null;
  const marker = `/storage/v1/object/public/${bucket}/`;
  const at = url.indexOf(marker);
  if (at === -1) return null;
  const path = url.slice(at + marker.length).split(/[?#]/)[0];
  if (!path) return null;
  try {
    return decodeURIComponent(path);
  } catch {
    return null;
  }
}

const TEAM_NOTE_PHOTO_ROLES: readonly string[] = ['admin', 'sales_rep', 'driver', 'applicator'];

/**
 * Whether this profile may view and add team-note photos: the same active-staff roles the
 * team-note-attachments storage rules allow (migration 20261015230000). Anyone else, such as an
 * entity_recipient service login or a deactivated account, would only ever be refused, so the
 * screen hides the photos and the Add Photos button from them.
 */
export function canUseTeamNotePhotos(profile: { role?: string | null; is_active?: boolean | null } | null | undefined): boolean {
  return !!profile?.is_active && TEAM_NOTE_PHOTO_ROLES.includes(profile.role ?? '');
}

// <epoch ms>_<n>.<ext>, as NotePhotoUpload names a file; the row insert policy requires the same.
const TEAM_NOTE_FILE_NAME = /^[A-Za-z0-9_-]+\.[A-Za-z0-9]{1,10}$/;

/**
 * A team-note photo's object path, only when it lies in its uploader's own folder
 * (team-note-attachments/<uploaded_by>/<file>). The app deletes the file a row names, so a row
 * pointing at another uploader's photo must never resolve to it (migration 20261015230000 refuses
 * such rows; this also covers one written before it).
 */
export function teamNotePhotoPath(attachment: { file_url?: string | null; uploaded_by?: string | null }): string | null {
  const path = storagePathFromPublicUrl(attachment.file_url, 'team-note-attachments');
  if (!path || !attachment.uploaded_by) return null;
  const [bucketFolder, owner, file, ...rest] = path.split('/');
  if (bucketFolder !== 'team-note-attachments' || owner !== attachment.uploaded_by || rest.length > 0) return null;
  return file && TEAM_NOTE_FILE_NAME.test(file) ? path : null;
}

/** A team-note photo file extension safe to store: letters and digits only, else jpg. */
export function teamNotePhotoExtension(fileName: string): string {
  const ext = fileName.includes('.') ? fileName.split('.').pop() ?? '' : '';
  return /^[A-Za-z0-9]{1,10}$/.test(ext) ? ext : 'jpg';
}

/** A delivery photo's object path: storage_path, or the old public URL for a row without one. */
export function deliveryPhotoPath(photo: { storage_path?: string | null; image_url?: string | null }): string | null {
  return photo.storage_path || storagePathFromPublicUrl(photo.image_url, 'delivery-photos');
}

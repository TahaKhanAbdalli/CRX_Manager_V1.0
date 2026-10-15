/**
 * NoteAttachments: Delete appears on exactly the photos the storage and table policies let this
 * user delete (their own uploads, or any photo for an active admin), whoever owns the note, and a
 * delete removes only a file in the row's uploader's own folder.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';

const H = vi.hoisted(() => ({
  profile: { current: { id: 'me', role: 'driver', is_active: true } as { id: string; role: string; is_active: boolean } },
  remove: vi.fn(),
  ops: [] as string[],
  // What the row delete and the follow-up "is the row still there?" read return.
  deleteResult: null as unknown,
  recheckResult: null as unknown,
}));

const URL_BASE = 'https://x.supabase.co/storage/v1/object/public/team-note-attachments/team-note-attachments';
const ROWS = [
  { id: 'a1', note_id: 'n1', uploaded_by: 'me', file_name: 'mine.jpg', file_type: 'image/jpeg', file_url: `${URL_BASE}/me/1.jpg`, created_at: '2026-10-15T00:00:00Z' },
  { id: 'a2', note_id: 'n1', uploaded_by: 'someone-else', file_name: 'theirs.jpg', file_type: 'image/jpeg', file_url: `${URL_BASE}/someone-else/2.jpg`, created_at: '2026-10-15T00:00:01Z' },
  // A row that names another uploader's photo (written by hand, not by the app).
  { id: 'a3', note_id: 'n1', uploaded_by: 'mallory', file_name: 'forged.jpg', file_type: 'image/jpeg', file_url: `${URL_BASE}/someone-else/2.jpg`, created_at: '2026-10-15T00:00:02Z' },
];

vi.mock('../../lib/db', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  // One query chain per from(); it answers by what the chain did.
  const chain = () => {
    const calls: string[] = [];
    const builder: Record<string, unknown> = new Proxy({}, {
      get(_target, prop) {
        if (prop === 'then') {
          const result = calls.includes('delete') ? H.deleteResult
            : calls.includes('maybeSingle') ? H.recheckResult
            : { data: ROWS, error: null };
          return (resolve: (v: unknown) => unknown) => resolve(result);
        }
        return () => { calls.push(String(prop)); H.ops.push(String(prop)); return builder; };
      },
    });
    return builder;
  };
  return {
    ...actual,
    supabase: {
      from: chain,
      storage: { from: () => ({ download: () => new Promise(() => {}), remove: (paths: string[]) => { H.ops.push('remove'); H.remove(paths); return Promise.resolve({ data: [], error: null }); } }) },
    },
  };
});
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => ({ profile: H.profile.current, role: H.profile.current.role }) }));
const STABLE_TOAST = { toast: vi.fn() };
vi.mock('../ui/Toast', () => ({ useToast: () => STABLE_TOAST }));
vi.mock('../../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));

import NoteAttachments from './NoteAttachments';

const deleteButtons = () => screen.queryAllByTitle('Delete photo');
const deleteButtonFor = (fileName: string) =>
  deleteButtons().find((b) => b.closest('.group')?.textContent?.includes(fileName));

beforeEach(() => {
  H.profile.current = { id: 'me', role: 'driver', is_active: true };
  H.remove.mockClear();
  H.ops.length = 0;
  H.deleteResult = { data: [ROWS[0]], error: null };
  H.recheckResult = { data: null, error: null };
  STABLE_TOAST.toast.mockClear();
});
afterEach(cleanup);

async function deleteAsAdmin(fileName: string) {
  H.profile.current = { id: 'boss', role: 'admin', is_active: true };
  render(<NoteAttachments noteId="n1" />);
  await screen.findByText(fileName);
  fireEvent.click(deleteButtonFor(fileName)!);
  fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));
  await waitFor(() => expect(STABLE_TOAST.toast).toHaveBeenCalledWith('success', 'Photo deleted'));
}

describe('NoteAttachments delete control', () => {
  it('lets an uploader delete their own photo on a note they do not own, and nobody else\'s', async () => {
    render(<NoteAttachments noteId="n1" />);
    await screen.findByText('mine.jpg');
    expect(deleteButtons()).toHaveLength(1);
    expect(deleteButtons()[0].closest('.group')?.textContent).toContain('mine.jpg');
  });

  it('lets an active admin delete every photo', async () => {
    H.profile.current = { id: 'boss', role: 'admin', is_active: true };
    render(<NoteAttachments noteId="n1" />);
    await screen.findByText('theirs.jpg');
    expect(deleteButtons()).toHaveLength(3);
  });

  it('gives a deactivated admin no delete on photos they did not upload', async () => {
    H.profile.current = { id: 'boss', role: 'admin', is_active: false };
    render(<NoteAttachments noteId="n1" />);
    await screen.findByText('theirs.jpg');
    expect(deleteButtons()).toHaveLength(0);
  });
});

describe('NoteAttachments delete', () => {
  it('removes the row, then the file in its uploader\'s own folder', async () => {
    await deleteAsAdmin('theirs.jpg');
    expect(H.remove).toHaveBeenCalledWith(['team-note-attachments/someone-else/2.jpg']);
    expect(H.ops.indexOf('delete')).toBeGreaterThan(-1);
    expect(H.ops.indexOf('remove')).toBeGreaterThan(H.ops.indexOf('delete'));
  });

  async function refusedDelete() {
    H.profile.current = { id: 'boss', role: 'admin', is_active: true };
    H.recheckResult = { data: { id: 'a2' }, error: null }; // the row is still there
    render(<NoteAttachments noteId="n1" />);
    await screen.findByText('theirs.jpg');
    fireEvent.click(deleteButtonFor('theirs.jpg')!);
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(STABLE_TOAST.toast).toHaveBeenCalledWith('error', 'Failed to delete photo'));
    expect(H.remove).not.toHaveBeenCalled();
    expect(screen.getByText('theirs.jpg')).toBeTruthy();
  }

  it('keeps the file when the row delete is refused with an error, and says the delete failed', async () => {
    H.deleteResult = { data: null, error: { message: 'permission denied' } };
    await refusedDelete();
  });

  it('keeps the file when the row delete is refused silently (no rows, no error)', async () => {
    H.deleteResult = { data: [], error: null };
    await refusedDelete();
  });

  it('reports the file path when neither the delete nor the re-read answers, and keeps the photo listed', async () => {
    const { Sentry } = await import('../../lib/sentry');
    H.deleteResult = { data: null, error: { message: 'TypeError: Failed to fetch' } };
    H.recheckResult = { data: null, error: { message: 'TypeError: Failed to fetch' } };
    H.profile.current = { id: 'boss', role: 'admin', is_active: true };
    render(<NoteAttachments noteId="n1" />);
    await screen.findByText('theirs.jpg');
    fireEvent.click(deleteButtonFor('theirs.jpg')!);
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(STABLE_TOAST.toast).toHaveBeenCalledWith('error', 'Failed to delete photo'));
    expect(H.remove).not.toHaveBeenCalled();
    expect(Sentry.captureException).toHaveBeenCalledWith(expect.any(Error), {
      extra: expect.objectContaining({ storagePath: 'team-note-attachments/someone-else/2.jpg' }),
    });
  });

  it('still removes the file when the delete committed but its response was lost', async () => {
    H.deleteResult = { data: null, error: { message: 'TypeError: Failed to fetch' } };
    H.recheckResult = { data: null, error: null }; // the row is gone
    await deleteAsAdmin('theirs.jpg');
    expect(H.remove).toHaveBeenCalledWith(['team-note-attachments/someone-else/2.jpg']);
    expect(screen.queryByText('theirs.jpg')).toBeNull();
  });

  it('never removes another uploader\'s file through a row that names it; only the row goes', async () => {
    await deleteAsAdmin('forged.jpg');
    expect(H.remove).not.toHaveBeenCalled();
    expect(H.ops).toContain('delete');
  });
});

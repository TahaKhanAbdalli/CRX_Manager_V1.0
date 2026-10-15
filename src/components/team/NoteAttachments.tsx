import { useCallback, useEffect, useState } from 'react';
import { X, Loader2, Image } from 'lucide-react';
import { supabase, checkMutationResult } from '../../lib/db';
import { Sentry } from '../../lib/sentry';
import { useToast } from '../ui/Toast';
import { useAuth } from '../../contexts/AuthContext';
import ConfirmModal from '../ui/ConfirmModal';
import { PrivatePhotoButton } from '../ui/PrivatePhoto';
import { teamNotePhotoPath } from '../../lib/privatePhotos';
import type { TeamNoteAttachment } from '../../types';

interface NoteAttachmentsProps {
  noteId: string;
  refreshKey?: number;
}

export default function NoteAttachments({ noteId, refreshKey }: NoteAttachmentsProps) {
  const { toast } = useToast();
  const { profile } = useAuth();
  // The photo file and its row may be deleted only by their uploader or an admin (storage and
  // table policies), so Delete shows on exactly those photos, whoever owns the note.
  const isAdmin = profile?.role === 'admin' && profile.is_active;
  const [attachments, setAttachments] = useState<TeamNoteAttachment[]>([]);
  const [loading, setLoading] = useState(true);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<TeamNoteAttachment | null>(null);

  const fetchAttachments = useCallback(async () => {
    const { data, error } = await supabase
      .from('team_note_attachments')
      .select('*')
      .eq('note_id', noteId)
      .order('created_at', { ascending: true });

    if (error) {
      Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { extra: { context: 'Failed to fetch attachments' } });
    } else {
      setAttachments(data ?? []);
    }
    setLoading(false);
  }, [noteId]);

  useEffect(() => {
    fetchAttachments();
  }, [fetchAttachments, refreshKey]);

  const handleDelete = async (attachment: TeamNoteAttachment) => {
    setDeletingId(attachment.id);

    try {
      // Only a file in this row's uploader's own folder: a row naming someone else's photo must
      // never delete that photo (the row itself is still removed).
      const storagePath = teamNotePhotoPath(attachment);

      // The row first: if it is refused, the photo and its file are both still there. Once the row
      // is gone, a failed file removal leaves only an unlisted file, never a row pointing at a
      // missing photo.
      let result: { data: unknown[] | null; error: unknown };
      try {
        result = await supabase.from('team_note_attachments').delete().eq('id', attachment.id).select();
      } catch (err) {
        result = { data: null, error: err instanceof Error ? err : new Error(String(err)) };
      }
      if (result.error || !result.data?.length) {
        // A refusal, or a response lost after the delete committed: look again before deciding,
        // so a committed delete still removes its file.
        const recheck = await supabase.from('team_note_attachments').select('id').eq('id', attachment.id).maybeSingle();
        if (recheck.error && storagePath) {
          // Neither the delete nor the re-read answered: the row may be gone with its file left
          // behind. Report the path so that file can be found and removed later.
          Sentry.captureException(new Error('Team-note photo delete unconfirmed'), {
            extra: { context: 'Delete attachment unconfirmed: possible orphaned team-note file', storagePath },
          });
        }
        if (recheck.error || recheck.data) checkMutationResult(result, 'Delete note attachment');
      } else {
        checkMutationResult(result, 'Delete note attachment');
      }
      setAttachments((prev) => prev.filter((a) => a.id !== attachment.id));

      if (storagePath) {
        try {
          const { error: storageErr } = await supabase.storage
            .from('team-note-attachments')
            .remove([storagePath]);
          if (storageErr) throw storageErr;
        } catch (storageErr) {
          // The photo is already gone from the note; the leftover file is reported with its path
          // so it can be removed later, and is never shown.
          Sentry.captureException(storageErr instanceof Error ? storageErr : new Error(String(storageErr)), {
            extra: { context: 'Storage delete error: orphaned team-note file', storagePath },
          });
        }
      }
      toast('success', 'Photo deleted');
    } catch (err) {
      Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { extra: { context: 'Delete attachment error' } });
      toast('error', 'Failed to delete photo');
    } finally {
      setDeletingId(null);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-4">
        <Loader2 className="w-5 h-5 animate-spin text-gray-400" />
      </div>
    );
  }

  if (attachments.length === 0) return null;

  return (
    <>
    <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
      {attachments.map((attachment) => (
        <div key={attachment.id} className="group relative">
          {attachment.file_type.startsWith('image/') ? (
            <PrivatePhotoButton
              bucket="team-note-attachments"
              path={teamNotePhotoPath(attachment)}
              alt={attachment.file_name}
              viewerTitle={attachment.file_name}
              className="w-full aspect-square rounded-lg object-cover"
            />
          ) : (
            <div className="w-full aspect-square rounded-lg bg-gray-100 flex items-center justify-center">
              <Image className="w-8 h-8 text-gray-400" />
            </div>
          )}

          {(isAdmin || attachment.uploaded_by === profile?.id) && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setConfirmDelete(attachment);
              }}
              disabled={deletingId === attachment.id}
              className="absolute top-1 right-1 p-1 bg-red-600 text-white rounded-full opacity-0 group-hover:opacity-100 transition-opacity hover:bg-red-700 disabled:opacity-50"
              title="Delete photo"
            >
              {deletingId === attachment.id ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <X className="w-3.5 h-3.5" />
              )}
            </button>
          )}

          <p className="mt-1 text-xs text-gray-500 truncate" title={attachment.file_name}>
            {attachment.file_name}
          </p>
        </div>
      ))}
    </div>

      <ConfirmModal
        open={!!confirmDelete}
        title="Delete Photo"
        message={`Are you sure you want to delete "${confirmDelete?.file_name}"? This cannot be undone.`}
        confirmLabel="Delete"
        variant="danger"
        onConfirm={() => {
          if (confirmDelete) handleDelete(confirmDelete);
          setConfirmDelete(null);
        }}
        onClose={() => setConfirmDelete(null)}
      />
    </>
  );
}

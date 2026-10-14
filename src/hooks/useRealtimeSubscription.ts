import { useEffect } from 'react';
import { supabase } from '../lib/db';
import { useLatestRef } from './useLatestRef';
import type { RealtimeChannel, RealtimePostgresChangesPayload } from '@supabase/supabase-js';

type RealtimePayload = RealtimePostgresChangesPayload<Record<string, unknown>>;
type SubscriptionCallback = (payload: RealtimePayload) => void;

interface SubscriptionConfig {
  table: string;
  event?: 'INSERT' | 'UPDATE' | 'DELETE' | '*';
  filter?: string;
  disabled?: boolean;
  onInsert?: SubscriptionCallback;
  onUpdate?: SubscriptionCallback;
  onDelete?: SubscriptionCallback;
  onChange?: SubscriptionCallback;
}

export function useRealtimeSubscription(config: SubscriptionConfig) {
  // Latest committed callbacks, read only inside the channel's postgres_changes listener, so the
  // subscription is not torn down and re-created every time a parent passes a new inline callback.
  const onChangeRef = useLatestRef(config.onChange);
  const onInsertRef = useLatestRef(config.onInsert);
  const onUpdateRef = useLatestRef(config.onUpdate);
  const onDeleteRef = useLatestRef(config.onDelete);

  useEffect(() => {
    if (config.disabled) return;

    let channel: RealtimeChannel;

    const setupSubscription = () => {
      const channelName = `${config.table}-changes-${Date.now()}`;
      channel = supabase.channel(channelName);

      const eventType = config.event || '*';

      channel
        .on(
          'postgres_changes' as 'system',
          {
            event: eventType,
            schema: 'public',
            table: config.table,
            filter: config.filter,
          } as Record<string, string | undefined>,
          (payload: RealtimePayload) => {
            onChangeRef.current?.(payload);

            if (payload.eventType === 'INSERT') {
              onInsertRef.current?.(payload);
            } else if (payload.eventType === 'UPDATE') {
              onUpdateRef.current?.(payload);
            } else if (payload.eventType === 'DELETE') {
              onDeleteRef.current?.(payload);
            }
          }
        )
        .subscribe();
    };

    setupSubscription();

    return () => {
      if (channel) {
        supabase.removeChannel(channel);
      }
    };
  }, [config.table, config.event, config.filter, config.disabled, onChangeRef, onInsertRef, onUpdateRef, onDeleteRef]);
}

export function useRealtimeNotes(onNotesChange: () => void) {
  useRealtimeSubscription({
    table: 'team_notes',
    onChange: onNotesChange,
  });
}

export function useRealtimeComments(noteId: string | null, onCommentsChange: () => void) {
  useRealtimeSubscription({
    table: 'team_note_comments',
    filter: noteId ? `note_id=eq.${noteId}` : undefined,
    disabled: !noteId,
    onChange: onCommentsChange,
  });
}

export function useRealtimeNotifications(userId: string, onNotificationChange: () => void) {
  useRealtimeSubscription({
    table: 'notifications',
    filter: `user_id=eq.${userId}`,
    onChange: onNotificationChange,
  });
}

export function useRealtimeActivity(noteId: string | null, onActivityChange: () => void) {
  useRealtimeSubscription({
    table: 'note_activity_log',
    filter: noteId ? `note_id=eq.${noteId}` : undefined,
    disabled: !noteId,
    onChange: onActivityChange,
  });
}

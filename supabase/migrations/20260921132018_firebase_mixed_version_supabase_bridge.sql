-- Keep legacy and Firebase v2 clients interoperable during the mixed-version
-- observation window. Removing this bridge requires a later reviewed forward
-- migration after capability evidence and the mixed-version matrix pass; there
-- is deliberately no calendar-driven runtime cutoff.
begin;

-- Legacy RPCs already centralize membership, epoch and rate-limit checks before
-- reaching this router. During the mixed-version window Supabase Broadcast is
-- the shared transient plane for released and Firebase-aware clients. The
-- existing live outbox remains the staging experiment's non-authoritative path;
-- it is not the compact /v2/l client contract. Non-transient routing and
-- structure_changed control semantics remain unchanged apart from retaining the
-- legacy invalidation Broadcast throughout the compatibility window.
create or replace function private.route_realtime(
  p_payload jsonb,
  p_event text,
  p_topic text,
  p_private boolean
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  rid uuid;
  ep bigint;
  live boolean;
  transient boolean;
  source_event_id uuid;
begin
  rid := split_part(p_topic, ':', 2)::uuid;
  ep := split_part(p_topic, ':', 3)::bigint;
  live := private.firebase_room_is_live(rid);
  transient := p_event in (
    'typing_start',
    'typing_stop',
    'character_pulse',
    'character_throw'
  );
  -- During the compatibility window old clients still depend on Broadcast for
  -- durable invalidation, structural invalidation and transient events alike.
  perform realtime.send(p_payload, p_event, p_topic, p_private);

  if live or (
    p_event = 'structure_changed'
    and exists (
      select 1
      from private.firebase_live_rooms
      where room_id = rid
    )
  ) then
    if transient
       and coalesce(p_payload->>'event_id', '')
         ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      source_event_id := (p_payload->>'event_id')::uuid;
    end if;

    insert into private.firebase_live_outbox(
      event_id,
      room_id,
      epoch,
      kind,
      payload,
      publication_revision
    ) values (
      coalesce(source_event_id, gen_random_uuid()),
      rid,
      ep,
      case when live then p_event else 'control' end,
      p_payload,
      case
        when live and transient
          then nextval('private.firebase_live_revision_seq')
        else null
      end
    );
  end if;
end;
$$;

revoke all on function private.route_realtime(jsonb, text, text, boolean)
  from public, anon, authenticated, service_role;

-- The staging-only direct-event experiment writes Firebase exactly once in its
-- Edge Function after this authorization RPC returns. Wrap the existing
-- authorization implementation so an explicitly enabled experiment cannot
-- strand mixed-version peers. Production clients use the shared Supabase RPC
-- plane during this window. Retried event IDs still fail in the inner function
-- before Broadcast, preserving its deduplication contract.
alter function public.authorize_firebase_direct_event(uuid, bigint, uuid, text, uuid, text)
  set schema private;
alter function private.authorize_firebase_direct_event(uuid, bigint, uuid, text, uuid, text)
  rename to authorize_firebase_direct_event_before_mixed_bridge;

revoke all on function private.authorize_firebase_direct_event_before_mixed_bridge(
  uuid,
  bigint,
  uuid,
  text,
  uuid,
  text
) from public, anon, authenticated, service_role;

create function public.authorize_firebase_direct_event(
  p_room_id uuid,
  p_epoch bigint,
  p_event_id uuid,
  p_kind text,
  p_target_user_id uuid default null,
  p_sequence text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  authorized jsonb;
begin
  authorized := private.authorize_firebase_direct_event_before_mixed_bridge(
    p_room_id,
    p_epoch,
    p_event_id,
    p_kind,
    p_target_user_id,
    p_sequence
  );

  if exists (
    select 1
    from private.firebase_live_config as config
    where config.id
      and config.enabled
      and config.direct_events_enabled
  ) then
    perform realtime.send(
      authorized->'payload',
      authorized->>'kind',
      private.room_topic(
        (authorized->>'room_id')::uuid,
        (authorized->>'epoch')::bigint,
        'ephemeral'
      ),
      true
    );
  end if;

  return authorized;
end;
$$;

revoke all on function public.authorize_firebase_direct_event(
  uuid,
  bigint,
  uuid,
  text,
  uuid,
  text
) from public, anon;
grant execute on function public.authorize_firebase_direct_event(
  uuid,
  bigint,
  uuid,
  text,
  uuid,
  text
) to authenticated;

commit;

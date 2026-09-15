-- Transient character-to-character throw events. The server, not the client,
-- supplies actor identity and character selection.
create or replace function public.broadcast_character_throw(
  p_room_id uuid,
  p_realtime_epoch bigint,
  p_event_id uuid,
  p_target_user_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := auth.uid();
  current_epoch bigint;
  source_character_id text;
  recent_attempts integer;
begin
  if current_user_id is null then
    raise exception using errcode = '42501', message = 'authentication_required';
  end if;
  if p_event_id is null then
    raise exception using errcode = '22023', message = 'event_id_required';
  end if;
  if p_target_user_id is null then
    raise exception using errcode = '22023', message = 'target_user_id_required';
  end if;
  if p_target_user_id = current_user_id then
    raise exception using errcode = '22023', message = 'self_target_forbidden';
  end if;

  select rooms.realtime_epoch into current_epoch
  from public.rooms
  where rooms.id = p_room_id
    and private.is_room_member(rooms.id, current_user_id);
  if not found then
    raise exception using errcode = '42501', message = 'membership_required';
  end if;
  if current_epoch != p_realtime_epoch then
    raise exception using errcode = '40001', message = 'stale_realtime_epoch';
  end if;
  if not private.is_room_member(p_room_id, p_target_user_id) then
    raise exception using errcode = '42501', message = 'target_membership_required';
  end if;

  select profiles.character_id into source_character_id
  from public.profiles
  where profiles.id = current_user_id;
  if source_character_id is null then
    raise exception using errcode = 'P0001', message = 'profile_required';
  end if;

  -- The lock and count are global per sender, matching the client's 0.5 s
  -- cooldown even when the sender changes rooms quickly.
  perform pg_advisory_xact_lock(hashtextextended(
    'event:' || current_user_id::text || ':character_throw',
    0
  ));
  select count(*) into recent_attempts
  from private.realtime_event_attempts
  where user_id = current_user_id
    and event_name = 'character_throw'
    and attempted_at >= now() - interval '10 seconds';
  if recent_attempts >= 20 then
    raise exception using errcode = 'P0001', message = 'realtime_event_rate_limited';
  end if;
  insert into private.realtime_event_attempts (user_id, room_id, event_name)
  values (current_user_id, p_room_id, 'character_throw');

  perform realtime.send(
    jsonb_build_object(
      'schema_version', 1,
      'room_id', p_room_id,
      'event_id', p_event_id,
      'actor_user_id', current_user_id,
      'target_user_id', p_target_user_id,
      'source_character_id', source_character_id
    ),
    'character_throw',
    private.room_topic(p_room_id, current_epoch, 'ephemeral'),
    true
  );
end;
$$;

revoke all on function public.broadcast_character_throw(uuid, bigint, uuid, uuid)
from public, anon;
grant execute on function public.broadcast_character_throw(uuid, bigint, uuid, uuid)
to authenticated;

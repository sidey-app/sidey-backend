begin;
set local lock_timeout = '5s';
set local statement_timeout = '10min';

-- public.messages gained the internal Firebase sequence column. Freeze the
-- released six-field response in a named scalar composite so PostgREST keeps
-- returning one JSON object (RETURNS TABLE would return an array).
do $$
begin
  if not exists (
    select 1
    from pg_type
    where typnamespace = 'public'::regnamespace
      and typname = 'legacy_message_response'
  ) then
    create type public.legacy_message_response as (
      id uuid,
      room_id uuid,
      sender_id uuid,
      body text,
      created_at timestamptz,
      bubble_style_id text
    );
  end if;
end;
$$;
drop function public.send_message(uuid, uuid, text);
create function public.send_message(
  p_id uuid,
  p_room_id uuid,
  p_body text
)
returns public.legacy_message_response
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := auth.uid();
  saved_message public.messages;
begin
  if current_user_id is null then
    raise exception using errcode = '42501', message = 'authentication_required';
  end if;
  saved_message := private.persist_message_for_user(
    current_user_id,
    p_id,
    p_room_id,
    p_body
  );
  return row(
    saved_message.id,
    saved_message.room_id,
    saved_message.sender_id,
    saved_message.body,
    saved_message.created_at,
    saved_message.bubble_style_id
  )::public.legacy_message_response;
end;
$$;
revoke all on function public.send_message(uuid, uuid, text) from public, anon;
grant execute on function public.send_message(uuid, uuid, text) to authenticated;

commit;

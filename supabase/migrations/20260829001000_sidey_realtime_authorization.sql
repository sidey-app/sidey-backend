do $$
begin
  if to_regclass('realtime.messages') is null then
    raise exception using
      errcode = '55000',
      message = 'realtime_messages_not_provisioned',
      hint = 'Enable Realtime private channels and wait for Supabase to provision realtime.messages before applying this migration.';
  end if;
  if to_regprocedure('realtime.broadcast_changes(text,text,text,text,text,record,record,text)') is null then
    raise exception using
      errcode = '55000',
      message = 'realtime_broadcast_changes_not_provisioned',
      hint = 'Wait for Supabase Realtime tenant migrations to finish before applying this migration.';
  end if;
end;
$$;

create or replace function private.broadcast_room_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  changed_room_id uuid := coalesce(new.room_id, old.room_id);
begin
  perform realtime.broadcast_changes(
    'room:' || changed_room_id::text,
    tg_op,
    tg_op,
    tg_table_name,
    tg_table_schema,
    new,
    old
  );
  return null;
end;
$$;

create or replace function private.broadcast_room_record_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  changed_room_id uuid := coalesce(new.id, old.id);
begin
  perform realtime.broadcast_changes(
    'room:' || changed_room_id::text,
    tg_op,
    tg_op,
    tg_table_name,
    tg_table_schema,
    new,
    old
  );
  return null;
end;
$$;

create or replace function private.broadcast_profile_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  member_room_id uuid;
begin
  for member_room_id in
    select room_id from public.room_members where user_id = coalesce(new.id, old.id)
  loop
    perform realtime.broadcast_changes(
      'room:' || member_room_id::text,
      tg_op,
      tg_op,
      tg_table_name,
      tg_table_schema,
      new,
      old
    );
  end loop;
  return null;
end;
$$;

drop trigger if exists messages_broadcast_change on public.messages;
create trigger messages_broadcast_change
after insert or update or delete on public.messages
for each row execute function private.broadcast_room_change();

drop trigger if exists room_members_broadcast_change on public.room_members;
create trigger room_members_broadcast_change
after insert or update or delete on public.room_members
for each row execute function private.broadcast_room_change();

drop trigger if exists rooms_broadcast_change on public.rooms;
create trigger rooms_broadcast_change
after update or delete on public.rooms
for each row execute function private.broadcast_room_record_change();

drop trigger if exists profiles_broadcast_change on public.profiles;
create trigger profiles_broadcast_change
after update or delete on public.profiles
for each row execute function private.broadcast_profile_change();

drop policy if exists sidey_room_channels_select on realtime.messages;
create policy sidey_room_channels_select
on realtime.messages for select to authenticated
using (
  realtime.messages.extension in ('broadcast', 'presence')
  and private.can_access_room_topic((select realtime.topic()), (select auth.uid()))
);

drop policy if exists sidey_room_channels_insert on realtime.messages;
create policy sidey_room_channels_insert
on realtime.messages for insert to authenticated
with check (
  realtime.messages.extension in ('broadcast', 'presence')
  and private.can_access_room_topic((select realtime.topic()), (select auth.uid()))
);

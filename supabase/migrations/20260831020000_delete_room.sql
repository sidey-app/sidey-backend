create or replace function public.delete_room(p_room_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'authentication_required';
  end if;

  delete from public.rooms
  where id = p_room_id and owner_id = auth.uid();

  if not found then
    raise exception using errcode = '42501', message = 'owner_required';
  end if;
end;
$$;

revoke all on function public.delete_room(uuid) from public, anon;
grant execute on function public.delete_room(uuid) to authenticated;

begin;
set local lock_timeout = '5s';
set local statement_timeout = '10min';

-- A worker may hold a stale pending-list entry while smoke cleanup finalizes
-- and removes the corresponding tombstone. Lock only an existing outbox row
-- before delegating to the canonical snapshot function; unlike bootstrap, a
-- delivery retry must never recreate a finalized row.
create function public.firebase_access_delivery_snapshot(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_user_id is null then
    raise exception 'invalid_user_id';
  end if;

  perform 1
  from private.firebase_access_outbox as access_outbox
  where access_outbox.user_id = p_user_id
  for update;

  if not found then
    return null;
  end if;

  return public.firebase_access_snapshot(p_user_id);
end;
$$;

revoke all on function public.firebase_access_delivery_snapshot(uuid)
  from public, anon, authenticated;
grant execute on function public.firebase_access_delivery_snapshot(uuid)
  to service_role;

commit;

begin;

alter table public.profiles
  add column tree_movement_paused boolean not null default false,
  add column tree_movement_revision bigint not null default 0,
  add constraint profiles_tree_movement_revision_nonnegative
    check (tree_movement_revision >= 0);

comment on column public.profiles.tree_movement_revision is
  'Account-wide tree movement CAS revision. Zero means the legacy local preference has not been initialized.';

-- Profile writes already use SECURITY DEFINER RPCs. Keep both columns behind
-- that boundary: neither a profile PATCH nor an INSERT may bypass the revision.
revoke insert, update on public.profiles from public, anon, authenticated;
revoke insert (tree_movement_paused, tree_movement_revision),
       update (tree_movement_paused, tree_movement_revision)
  on public.profiles from public, anon, authenticated;

create function public.set_tree_movement_paused(
  p_paused boolean,
  p_expected_revision bigint
)
returns setof public.profiles
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := auth.uid();
  saved_profile public.profiles;
begin
  if current_user_id is null then
    raise exception using errcode = '42501', message = 'authentication_required';
  end if;
  if p_paused is null or p_expected_revision is null or p_expected_revision < 0 then
    raise exception using errcode = '22023', message = 'invalid_tree_movement_state';
  end if;

  -- Serialize devices before comparing the revision. A stale retry returns the
  -- committed winner, without toggling or overriding a more recent preference.
  select * into saved_profile
  from public.profiles
  where id = current_user_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'profile_required';
  end if;
  if saved_profile.tree_movement_revision <> p_expected_revision then
    return next saved_profile;
    return;
  end if;
  if saved_profile.tree_movement_revision > 0
     and saved_profile.tree_movement_paused = p_paused then
    return next saved_profile;
    return;
  end if;

  update public.profiles
  set tree_movement_paused = p_paused,
      tree_movement_revision = tree_movement_revision + 1,
      updated_at = now()
  where id = current_user_id
  returning * into saved_profile;
  -- Existing profiles_broadcast_change publishes structure_changed to each
  -- joined room. Peers refetch profiles through existing membership RLS.
  return next saved_profile;
  return;
end;
$$;

revoke all on function public.set_tree_movement_paused(boolean, bigint) from public, anon;
grant execute on function public.set_tree_movement_paused(boolean, bigint) to authenticated;

commit;

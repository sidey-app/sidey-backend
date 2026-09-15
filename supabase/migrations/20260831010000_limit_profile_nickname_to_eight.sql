begin;

-- Preserve existing profiles while bringing previously valid 9-12 character
-- nicknames into the new display contract before tightening the constraint.
update public.profiles
set nickname = left(btrim(nickname), 8),
    updated_at = now()
where char_length(btrim(nickname)) > 8;

alter table public.profiles
drop constraint if exists profiles_nickname_length;

alter table public.profiles
add constraint profiles_nickname_length
check (char_length(btrim(nickname)) between 2 and 8);

create or replace function public.upsert_profile(p_nickname text, p_character_id text default 'minty_pup')
returns public.profiles
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
  if char_length(btrim(p_nickname)) not between 2 and 8 or p_nickname ~ E'[\n\r\t]' then
    raise exception using errcode = '22023', message = 'invalid_nickname';
  end if;
  if p_character_id !~ '^[a-z0-9_]{1,40}$' then
    raise exception using errcode = '22023', message = 'invalid_character_id';
  end if;

  insert into public.profiles (id, nickname, character_id)
  values (current_user_id, btrim(p_nickname), p_character_id)
  on conflict (id) do update
  set nickname = excluded.nickname,
      character_id = excluded.character_id,
      updated_at = now()
  returning * into saved_profile;

  return saved_profile;
end;
$$;

commit;

begin;

-- The approved gray reference is a chinchilla, not a koala. Keep the old id
-- as an input alias so installed development builds and saved profiles remain
-- compatible while all newly stored values use the corrected canonical id.
update public.profiles
set character_id = 'pixel_chinchilla',
    updated_at = now()
where character_id = 'pixel_koala';

create or replace function public.upsert_profile(
  p_nickname text,
  p_character_id text default 'pixel_hamster'
)
returns public.profiles
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := auth.uid();
  normalized_character_id text := case
    when p_character_id = 'minty_pup' then 'pixel_hamster'
    when p_character_id = 'pixel_koala' then 'pixel_chinchilla'
    else p_character_id
  end;
  saved_profile public.profiles;
begin
  if current_user_id is null then
    raise exception using errcode = '42501', message = 'authentication_required';
  end if;
  if char_length(btrim(p_nickname)) not between 2 and 8 or p_nickname ~ E'[\n\r\t]' then
    raise exception using errcode = '22023', message = 'invalid_nickname';
  end if;
  if normalized_character_id not in (
    'pixel_hamster', 'pixel_cat', 'pixel_puppy', 'pixel_rabbit', 'pixel_penguin',
    'pixel_guinea_pig', 'pixel_monkey', 'pixel_chinchilla',
    'pixel_starlight_upalupa'
  ) then
    raise exception using errcode = '22023', message = 'invalid_character_id';
  end if;
  if normalized_character_id = 'pixel_starlight_upalupa' and not exists (
    select 1 from public.commerce_entitlements
    where user_id = current_user_id
      and entitlement_key = 'character:pixel_starlight_upalupa'
      and status = 'active'
  ) then
    raise exception using errcode = '42501', message = 'character_ownership_required';
  end if;

  insert into public.profiles (id, nickname, character_id)
  values (current_user_id, btrim(p_nickname), normalized_character_id)
  on conflict (id) do update
  set nickname = excluded.nickname,
      character_id = excluded.character_id,
      updated_at = now()
  returning * into saved_profile;
  return saved_profile;
end;
$$;

revoke all on function public.upsert_profile(text, text) from public, anon;
grant execute on function public.upsert_profile(text, text) to authenticated;

commit;

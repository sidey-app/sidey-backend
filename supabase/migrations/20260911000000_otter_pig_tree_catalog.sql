begin;

-- Catalog only: never change sales_enabled or existing entitlements.
insert into public.commerce_products (id, display_name, product_description, character_id, entitlement_key, product_kind, catalog_item_id, sort_order, active) values
  ('character_otter', '아기 수달', '크림색 배와 보라 목도리를 두른 수달이에요. 조개를 던져요.', 'pixel_otter', 'character:pixel_otter', 'character', 'pixel_otter', 50, true),
  ('character_pig', '아기 돼지', '동그란 코와 보라 목도리의 돼지예요. 돼지고기를 던져요.', 'pixel_pig', 'character:pixel_pig', 'character', 'pixel_pig', 60, true),
  ('character_tree', '나무', '둥근 초록 잎과 보라 목도리의 작은 나무예요.', 'pixel_tree', 'character:pixel_tree', 'character', 'pixel_tree', 70, true),
  ('throwable_snowflake', '눈송이', '맞으면 작은 결정 조각으로 흩어지는 눈송이예요.', null, 'throwable:throwable_snowflake', 'throwable', 'throwable_snowflake', 240, true),
  ('throwable_baseball', '야구공', '붉은 실밥이 있는 공이 눌렸다 튕겨요.', null, 'throwable:throwable_baseball', 'throwable', 'throwable_baseball', 250, true),
  ('throwable_wakkuball', '왁뿌볼', '와그작! 왁뿌볼이 조각조각 부서지는 바삭한 소리를 느껴보세요.', null, 'throwable:throwable_wakkuball', 'throwable', 'throwable_wakkuball', 260, true),
  ('throwable_dujjonku', '두쫀쿠', '코코아 겉피와 초록색 속이 눌리며 바삭한 소리가 나요.', null, 'throwable:throwable_dujjonku', 'throwable', 'throwable_dujjonku', 270, true)
on conflict (id) do update set display_name=excluded.display_name, product_description=excluded.product_description, updated_at=now();

insert into public.commerce_prices (product_id, amount_krw, currency, tax_inclusive, active)
select catalog.id, catalog.amount, 'KRW', true, true
from (values
  ('character_otter', 990),
  ('character_pig', 990),
  ('character_tree', 1900),
  ('throwable_snowflake', 990),
  ('throwable_baseball', 990),
  ('throwable_wakkuball', 1900),
  ('throwable_dujjonku', 1900)
) as catalog(id, amount)
where not exists (select 1 from public.commerce_prices price where price.product_id=catalog.id and price.active);

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
  required_entitlement text;
  saved_profile public.profiles;
begin
  if current_user_id is null then
    raise exception using errcode = '42501', message = 'authentication_required';
  end if;
  if char_length(btrim(p_nickname)) not between 2 and 8
     or p_nickname ~ E'[\n\r\t]' then
    raise exception using errcode = '22023', message = 'invalid_nickname';
  end if;
  if normalized_character_id is null or normalized_character_id not in (
    'pixel_hamster', 'pixel_cat', 'pixel_puppy', 'pixel_rabbit', 'pixel_penguin',
    'pixel_guinea_pig', 'pixel_monkey', 'pixel_chinchilla',
    'pixel_starlight_upalupa', 'pixel_otter', 'pixel_pig', 'pixel_tree'
  ) then
    raise exception using errcode = '22023', message = 'invalid_character_id';
  end if;

  select products.entitlement_key into required_entitlement
  from public.commerce_products products
  where products.character_id = normalized_character_id
    and products.active is true;

  -- Only the five bundled characters are free. Missing/inactive catalog rows
  -- must never turn a paid character into a free selection.
  if normalized_character_id not in (
    'pixel_hamster', 'pixel_cat', 'pixel_puppy', 'pixel_rabbit', 'pixel_penguin'
  ) and (required_entitlement is null or not exists (
    select 1 from public.commerce_entitlements entitlements
    where entitlements.user_id = current_user_id
      and entitlements.entitlement_key = required_entitlement
      and entitlements.status = 'active'
  )) then
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

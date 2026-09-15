begin;

-- Reviewed public catalog source: 57ac0ff65824103c19b62f2da31391e2d341a7d6.
-- Source SHA and snapshot hashes are recorded in SOURCE.json; production deployment is separate.
-- No order, payment, Apple transaction or entitlement history is rewritten.
insert into public.commerce_products (id, display_name, product_description, character_id, entitlement_key, product_kind, catalog_item_id, sort_order, related_character_product_id, render_asset_id)
values ('character_shiba', '시바견', '산책은 다녀왔어요. 시바는 그 사실을 인정하지 않아요.', 'pixel_shiba', 'character:pixel_shiba', 'character', 'pixel_shiba', 80, null, null)
on conflict (id) do update set display_name=excluded.display_name, product_description=excluded.product_description, sort_order=excluded.sort_order, related_character_product_id=excluded.related_character_product_id, render_asset_id=excluded.render_asset_id, updated_at=now();
insert into public.commerce_products (id, display_name, product_description, character_id, entitlement_key, product_kind, catalog_item_id, sort_order, related_character_product_id, render_asset_id)
values ('character_duck', '오리', '오리발 내미는 데는 자신 있어요. 진짜 오리발이거든요.', 'pixel_duck', 'character:pixel_duck', 'character', 'pixel_duck', 81, null, null)
on conflict (id) do update set display_name=excluded.display_name, product_description=excluded.product_description, sort_order=excluded.sort_order, related_character_product_id=excluded.related_character_product_id, render_asset_id=excluded.render_asset_id, updated_at=now();
insert into public.commerce_products (id, display_name, product_description, character_id, entitlement_key, product_kind, catalog_item_id, sort_order, related_character_product_id, render_asset_id)
values ('character_poop', '똥', '누가 불렀는지는 모르겠지만, 일단 나왔어요.', 'pixel_poop', 'character:pixel_poop', 'character', 'pixel_poop', 82, null, null)
on conflict (id) do update set display_name=excluded.display_name, product_description=excluded.product_description, sort_order=excluded.sort_order, related_character_product_id=excluded.related_character_product_id, render_asset_id=excluded.render_asset_id, updated_at=now();
insert into public.commerce_products (id, display_name, product_description, character_id, entitlement_key, product_kind, catalog_item_id, sort_order, related_character_product_id, render_asset_id)
values ('character_tteokbokki', '떡볶이', '순한맛이라더니요. 누구 기준인지는 안 알려줬어요.', 'pixel_tteokbokki', 'character:pixel_tteokbokki', 'character', 'pixel_tteokbokki', 83, null, null)
on conflict (id) do update set display_name=excluded.display_name, product_description=excluded.product_description, sort_order=excluded.sort_order, related_character_product_id=excluded.related_character_product_id, render_asset_id=excluded.render_asset_id, updated_at=now();
insert into public.commerce_products (id, display_name, product_description, character_id, entitlement_key, product_kind, catalog_item_id, sort_order, related_character_product_id, render_asset_id)
values ('character_quokka', '쿼카', '항상 웃고 있어요. 방금 잎사귀를 던진 것도 얘예요.', 'pixel_quokka', 'character:pixel_quokka', 'character', 'pixel_quokka', 84, null, null)
on conflict (id) do update set display_name=excluded.display_name, product_description=excluded.product_description, sort_order=excluded.sort_order, related_character_product_id=excluded.related_character_product_id, render_asset_id=excluded.render_asset_id, updated_at=now();
insert into public.commerce_products (id, display_name, product_description, character_id, entitlement_key, product_kind, catalog_item_id, sort_order, related_character_product_id, render_asset_id)
values ('throwable_tennis_ball', '테니스공', '던질 사람은 정했어요. 주워 올 사람은 아직이요.', null, 'throwable:throwable_tennis_ball', 'throwable', 'throwable_tennis_ball', 370, 'character_shiba', 'tennis_ball')
on conflict (id) do update set display_name=excluded.display_name, product_description=excluded.product_description, sort_order=excluded.sort_order, related_character_product_id=excluded.related_character_product_id, render_asset_id=excluded.render_asset_id, updated_at=now();
insert into public.commerce_products (id, display_name, product_description, character_id, entitlement_key, product_kind, catalog_item_id, sort_order, related_character_product_id, render_asset_id)
values ('throwable_tissue_ball', '휴지 뭉치', '똥휴지인지 아닌지는 모르겠어요. 일단 피하세요!', null, 'throwable:throwable_tissue_ball', 'throwable', 'throwable_tissue_ball', 390, 'character_poop', 'tissue_ball')
on conflict (id) do update set display_name=excluded.display_name, product_description=excluded.product_description, sort_order=excluded.sort_order, related_character_product_id=excluded.related_character_product_id, render_asset_id=excluded.render_asset_id, updated_at=now();
insert into public.commerce_products (id, display_name, product_description, character_id, entitlement_key, product_kind, catalog_item_id, sort_order, related_character_product_id, render_asset_id)
values ('throwable_fish_cake_skewer', '어묵꼬치', '드시라고 드린 건데 왜 휘두르세요?', null, 'throwable:throwable_fish_cake_skewer', 'throwable', 'throwable_fish_cake_skewer', 400, 'character_tteokbokki', 'fish_cake_skewer')
on conflict (id) do update set display_name=excluded.display_name, product_description=excluded.product_description, sort_order=excluded.sort_order, related_character_product_id=excluded.related_character_product_id, render_asset_id=excluded.render_asset_id, updated_at=now();
insert into public.commerce_products (id, display_name, product_description, character_id, entitlement_key, product_kind, catalog_item_id, sort_order, related_character_product_id, render_asset_id)
values ('throwable_leaf', '잎사귀', '쿼카의 도시락이에요. 던져도 되는지는 안 물어봤어요.', null, 'throwable:throwable_leaf', 'throwable', 'throwable_leaf', 410, 'character_quokka', 'leaf')
on conflict (id) do update set display_name=excluded.display_name, product_description=excluded.product_description, sort_order=excluded.sort_order, related_character_product_id=excluded.related_character_product_id, render_asset_id=excluded.render_asset_id, updated_at=now();

-- Reuse the existing squeaky duck entitlement; the relationship grants nothing.
update public.commerce_products set related_character_product_id='character_duck', product_description='오리가 오리를 던져요. 가족 문제는 아닌 것 같아요.', updated_at=now() where id='throwable_squeaky_duck';

-- Preserve every existing Apple sale/restoration ID and its legacy inclusion semantics.
insert into private.app_store_product_offers (store_product_id, product_id, current_offer, includes_related_throwable) values
  ('character_shiba', 'character_shiba', true, false),
  ('throwable_tennis_ball', 'throwable_tennis_ball', true, false),
  ('character_duck', 'character_duck', true, false),
  ('character_poop', 'character_poop', true, false),
  ('throwable_tissue_ball', 'throwable_tissue_ball', true, false),
  ('character_tteokbokki', 'character_tteokbokki', true, false),
  ('throwable_fish_cake_skewer', 'throwable_fish_cake_skewer', true, false),
  ('character_quokka', 'character_quokka', true, false),
  ('throwable_leaf', 'throwable_leaf', true, false)
on conflict (store_product_id) do nothing;

-- Retire price rows in place and append replacements; existing orders retain
-- their original price_id and amount, including pending pre-migration orders.
create temporary table content_catalog_prices (product_id text primary key, amount_krw integer not null) on commit drop;
insert into content_catalog_prices values
  ('character_starlight_upalupa', 1100),
  ('character_guinea_pig', 1100),
  ('character_monkey', 1100),
  ('character_chinchilla', 1100),
  ('character_otter', 1100),
  ('character_pig', 1100),
  ('character_tree', 1100),
  ('bubble_bunny_pink', 2200),
  ('bubble_butter_chick', 2200),
  ('bubble_starry_cat', 2200),
  ('throwable_bouncy_heart', 1100),
  ('throwable_toy_cannon', 3300),
  ('throwable_squeaky_duck', 1100),
  ('throwable_snowflake', 1100),
  ('throwable_baseball', 1100),
  ('throwable_wakkuball', 2200),
  ('throwable_dujjonku', 2200),
  ('throwable_mini_paprika', 1100),
  ('throwable_banana', 1100),
  ('throwable_dust_bath_pouch', 1100),
  ('throwable_starlight_orb', 1100),
  ('throwable_clam', 1100),
  ('throwable_pork', 1100),
  ('throwable_timber', 1100),
  ('character_shiba', 1100),
  ('throwable_tennis_ball', 1100),
  ('character_duck', 1100),
  ('character_poop', 1100),
  ('throwable_tissue_ball', 1100),
  ('character_tteokbokki', 1100),
  ('throwable_fish_cake_skewer', 1100),
  ('character_quokka', 1100),
  ('throwable_leaf', 1100);
update public.commerce_prices prices set active=false, retired_at=now()
from content_catalog_prices expected
where prices.product_id=expected.product_id and prices.active and prices.amount_krw<>expected.amount_krw;
insert into public.commerce_prices(product_id, amount_krw, currency, tax_inclusive, active)
select expected.product_id, expected.amount_krw, 'KRW', true, true from content_catalog_prices expected
where not exists (select 1 from public.commerce_prices prices where prices.product_id=expected.product_id and prices.active);

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
    'pixel_starlight_upalupa', 'pixel_otter', 'pixel_pig', 'pixel_tree',
    'pixel_shiba', 'pixel_duck', 'pixel_poop', 'pixel_tteokbokki', 'pixel_quokka'
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

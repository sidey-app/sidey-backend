begin;
-- Sale catalog and renderer metadata are separate from account ownership.
alter table public.commerce_products
  add column related_character_product_id text references public.commerce_products(id),
  add column render_asset_id text;
create table private.app_store_product_offers (
  store_product_id text primary key,
  product_id text not null references public.commerce_products(id),
  current_offer boolean not null,
  includes_related_throwable boolean not null default false
);
create unique index app_store_current_offer on private.app_store_product_offers(product_id) where current_offer;
alter table private.app_store_product_offers enable row level security;
revoke all on private.app_store_product_offers from public, anon, authenticated;
create table private.character_item_transition (
  singleton boolean primary key default true check (singleton),
  cutover_at timestamptz not null default now()
);
alter table private.character_item_transition enable row level security;
revoke all on private.character_item_transition from public, anon, authenticated;
insert into private.character_item_transition(singleton) values (true);
insert into public.commerce_products (id, display_name, product_description, character_id, entitlement_key, product_kind, catalog_item_id, sort_order, active, related_character_product_id, render_asset_id) values ('character_starlight_upalupa', '별빛 우파루파', '진주빛 몸과 별빛 아가미를 가진 우파루파 캐릭터', 'pixel_starlight_upalupa', 'character:pixel_starlight_upalupa', 'character', 'pixel_starlight_upalupa', 10, true, null, null) on conflict (id) do update set display_name=excluded.display_name, product_description=excluded.product_description, sort_order=excluded.sort_order, related_character_product_id=excluded.related_character_product_id, render_asset_id=excluded.render_asset_id, updated_at=now();
update public.commerce_prices set active=false, retired_at=now() where product_id='character_starlight_upalupa' and active and amount_krw != 1900;
insert into public.commerce_prices(product_id, amount_krw, currency, tax_inclusive, active) select 'character_starlight_upalupa', 1900, 'KRW', true, true where not exists (select 1 from public.commerce_prices where product_id='character_starlight_upalupa' and active);
insert into private.app_store_product_offers values ('character_starlight_upalupa_solo', 'character_starlight_upalupa', true, false);
insert into private.app_store_product_offers values ('character_starlight_upalupa', 'character_starlight_upalupa', false, true);
insert into public.commerce_products (id, display_name, product_description, character_id, entitlement_key, product_kind, catalog_item_id, sort_order, active, related_character_product_id, render_asset_id) values ('character_guinea_pig', '아기 기니피그', '비대칭 삼색 무늬의 아기 기니피그 캐릭터', 'pixel_guinea_pig', 'character:pixel_guinea_pig', 'character', 'pixel_guinea_pig', 20, true, null, null) on conflict (id) do update set display_name=excluded.display_name, product_description=excluded.product_description, sort_order=excluded.sort_order, related_character_product_id=excluded.related_character_product_id, render_asset_id=excluded.render_asset_id, updated_at=now();
update public.commerce_prices set active=false, retired_at=now() where product_id='character_guinea_pig' and active and amount_krw != 990;
insert into public.commerce_prices(product_id, amount_krw, currency, tax_inclusive, active) select 'character_guinea_pig', 990, 'KRW', true, true where not exists (select 1 from public.commerce_prices where product_id='character_guinea_pig' and active);
insert into private.app_store_product_offers values ('character_guinea_pig_solo', 'character_guinea_pig', true, false);
insert into private.app_store_product_offers values ('character_guinea_pig', 'character_guinea_pig', false, true);
insert into public.commerce_products (id, display_name, product_description, character_id, entitlement_key, product_kind, catalog_item_id, sort_order, active, related_character_product_id, render_asset_id) values ('character_monkey', '아기 원숭이', '시안 목도리를 두른 아기 원숭이 캐릭터', 'pixel_monkey', 'character:pixel_monkey', 'character', 'pixel_monkey', 30, true, null, null) on conflict (id) do update set display_name=excluded.display_name, product_description=excluded.product_description, sort_order=excluded.sort_order, related_character_product_id=excluded.related_character_product_id, render_asset_id=excluded.render_asset_id, updated_at=now();
update public.commerce_prices set active=false, retired_at=now() where product_id='character_monkey' and active and amount_krw != 990;
insert into public.commerce_prices(product_id, amount_krw, currency, tax_inclusive, active) select 'character_monkey', 990, 'KRW', true, true where not exists (select 1 from public.commerce_prices where product_id='character_monkey' and active);
insert into private.app_store_product_offers values ('character_monkey_solo', 'character_monkey', true, false);
insert into private.app_store_product_offers values ('character_monkey', 'character_monkey', false, true);
insert into public.commerce_products (id, display_name, product_description, character_id, entitlement_key, product_kind, catalog_item_id, sort_order, active, related_character_product_id, render_asset_id) values ('character_chinchilla', '아기 친칠라', '파란 목도리를 두른 아기 친칠라 캐릭터', 'pixel_chinchilla', 'character:pixel_chinchilla', 'character', 'pixel_chinchilla', 40, true, null, null) on conflict (id) do update set display_name=excluded.display_name, product_description=excluded.product_description, sort_order=excluded.sort_order, related_character_product_id=excluded.related_character_product_id, render_asset_id=excluded.render_asset_id, updated_at=now();
update public.commerce_prices set active=false, retired_at=now() where product_id='character_chinchilla' and active and amount_krw != 990;
insert into public.commerce_prices(product_id, amount_krw, currency, tax_inclusive, active) select 'character_chinchilla', 990, 'KRW', true, true where not exists (select 1 from public.commerce_prices where product_id='character_chinchilla' and active);
insert into private.app_store_product_offers values ('character_chinchilla_solo', 'character_chinchilla', true, false);
insert into private.app_store_product_offers values ('character_chinchilla', 'character_chinchilla', false, true);
insert into public.commerce_products (id, display_name, product_description, character_id, entitlement_key, product_kind, catalog_item_id, sort_order, active, related_character_product_id, render_asset_id) values ('character_otter', '아기 수달', '크림색 배와 보라 목도리를 두른 수달이에요.', 'pixel_otter', 'character:pixel_otter', 'character', 'pixel_otter', 50, true, null, null) on conflict (id) do update set display_name=excluded.display_name, product_description=excluded.product_description, sort_order=excluded.sort_order, related_character_product_id=excluded.related_character_product_id, render_asset_id=excluded.render_asset_id, updated_at=now();
update public.commerce_prices set active=false, retired_at=now() where product_id='character_otter' and active and amount_krw != 990;
insert into public.commerce_prices(product_id, amount_krw, currency, tax_inclusive, active) select 'character_otter', 990, 'KRW', true, true where not exists (select 1 from public.commerce_prices where product_id='character_otter' and active);
insert into private.app_store_product_offers values ('character_otter', 'character_otter', true, false);
insert into public.commerce_products (id, display_name, product_description, character_id, entitlement_key, product_kind, catalog_item_id, sort_order, active, related_character_product_id, render_asset_id) values ('character_pig', '아기 돼지', '동그란 코와 보라 목도리의 돼지예요.', 'pixel_pig', 'character:pixel_pig', 'character', 'pixel_pig', 60, true, null, null) on conflict (id) do update set display_name=excluded.display_name, product_description=excluded.product_description, sort_order=excluded.sort_order, related_character_product_id=excluded.related_character_product_id, render_asset_id=excluded.render_asset_id, updated_at=now();
update public.commerce_prices set active=false, retired_at=now() where product_id='character_pig' and active and amount_krw != 990;
insert into public.commerce_prices(product_id, amount_krw, currency, tax_inclusive, active) select 'character_pig', 990, 'KRW', true, true where not exists (select 1 from public.commerce_prices where product_id='character_pig' and active);
insert into private.app_store_product_offers values ('character_pig', 'character_pig', true, false);
insert into public.commerce_products (id, display_name, product_description, character_id, entitlement_key, product_kind, catalog_item_id, sort_order, active, related_character_product_id, render_asset_id) values ('character_tree', '나무', '둥근 초록 잎과 보라 목도리의 작은 나무예요.', 'pixel_tree', 'character:pixel_tree', 'character', 'pixel_tree', 70, true, null, null) on conflict (id) do update set display_name=excluded.display_name, product_description=excluded.product_description, sort_order=excluded.sort_order, related_character_product_id=excluded.related_character_product_id, render_asset_id=excluded.render_asset_id, updated_at=now();
update public.commerce_prices set active=false, retired_at=now() where product_id='character_tree' and active and amount_krw != 1900;
insert into public.commerce_prices(product_id, amount_krw, currency, tax_inclusive, active) select 'character_tree', 1900, 'KRW', true, true where not exists (select 1 from public.commerce_prices where product_id='character_tree' and active);
insert into private.app_store_product_offers values ('character_tree', 'character_tree', true, false);
insert into public.commerce_products (id, display_name, product_description, character_id, entitlement_key, product_kind, catalog_item_id, sort_order, active, related_character_product_id, render_asset_id) values ('bubble_bunny_pink', '핑크 토끼 말풍선', '토끼 장식이 있는 분홍 말풍선', null, 'bubble:bubble_bunny_pink', 'bubble', 'bubble_bunny_pink', 110, true, null, null) on conflict (id) do update set display_name=excluded.display_name, product_description=excluded.product_description, sort_order=excluded.sort_order, related_character_product_id=excluded.related_character_product_id, render_asset_id=excluded.render_asset_id, updated_at=now();
update public.commerce_prices set active=false, retired_at=now() where product_id='bubble_bunny_pink' and active and amount_krw != 1900;
insert into public.commerce_prices(product_id, amount_krw, currency, tax_inclusive, active) select 'bubble_bunny_pink', 1900, 'KRW', true, true where not exists (select 1 from public.commerce_prices where product_id='bubble_bunny_pink' and active);
insert into private.app_store_product_offers values ('bubble_bunny_pink', 'bubble_bunny_pink', true, false);
insert into public.commerce_products (id, display_name, product_description, character_id, entitlement_key, product_kind, catalog_item_id, sort_order, active, related_character_product_id, render_asset_id) values ('bubble_butter_chick', '버터 병아리 말풍선', '병아리 장식이 있는 버터색 말풍선', null, 'bubble:bubble_butter_chick', 'bubble', 'bubble_butter_chick', 120, true, null, null) on conflict (id) do update set display_name=excluded.display_name, product_description=excluded.product_description, sort_order=excluded.sort_order, related_character_product_id=excluded.related_character_product_id, render_asset_id=excluded.render_asset_id, updated_at=now();
update public.commerce_prices set active=false, retired_at=now() where product_id='bubble_butter_chick' and active and amount_krw != 1900;
insert into public.commerce_prices(product_id, amount_krw, currency, tax_inclusive, active) select 'bubble_butter_chick', 1900, 'KRW', true, true where not exists (select 1 from public.commerce_prices where product_id='bubble_butter_chick' and active);
insert into private.app_store_product_offers values ('bubble_butter_chick', 'bubble_butter_chick', true, false);
insert into public.commerce_products (id, display_name, product_description, character_id, entitlement_key, product_kind, catalog_item_id, sort_order, active, related_character_product_id, render_asset_id) values ('bubble_starry_cat', '별밤 고양이 말풍선', '별고양이 장식이 있는 남보라 말풍선', null, 'bubble:bubble_starry_cat', 'bubble', 'bubble_starry_cat', 130, true, null, null) on conflict (id) do update set display_name=excluded.display_name, product_description=excluded.product_description, sort_order=excluded.sort_order, related_character_product_id=excluded.related_character_product_id, render_asset_id=excluded.render_asset_id, updated_at=now();
update public.commerce_prices set active=false, retired_at=now() where product_id='bubble_starry_cat' and active and amount_krw != 1900;
insert into public.commerce_prices(product_id, amount_krw, currency, tax_inclusive, active) select 'bubble_starry_cat', 1900, 'KRW', true, true where not exists (select 1 from public.commerce_prices where product_id='bubble_starry_cat' and active);
insert into private.app_store_product_offers values ('bubble_starry_cat', 'bubble_starry_cat', true, false);
insert into public.commerce_products (id, display_name, product_description, character_id, entitlement_key, product_kind, catalog_item_id, sort_order, active, related_character_product_id, render_asset_id) values ('throwable_bouncy_heart', '통통 하트', '통통 튀며 날아가는 하트 투척물', null, 'throwable:throwable_bouncy_heart', 'throwable', 'throwable_bouncy_heart', 210, true, null, 'throwable_bouncy_heart') on conflict (id) do update set display_name=excluded.display_name, product_description=excluded.product_description, sort_order=excluded.sort_order, related_character_product_id=excluded.related_character_product_id, render_asset_id=excluded.render_asset_id, updated_at=now();
update public.commerce_prices set active=false, retired_at=now() where product_id='throwable_bouncy_heart' and active and amount_krw != 990;
insert into public.commerce_prices(product_id, amount_krw, currency, tax_inclusive, active) select 'throwable_bouncy_heart', 990, 'KRW', true, true where not exists (select 1 from public.commerce_prices where product_id='throwable_bouncy_heart' and active);
insert into private.app_store_product_offers values ('throwable_bouncy_heart', 'throwable_bouncy_heart', true, false);
insert into public.commerce_products (id, display_name, product_description, character_id, entitlement_key, product_kind, catalog_item_id, sort_order, active, related_character_product_id, render_asset_id) values ('throwable_toy_cannon', '미니 대포', '심지탄을 쏘는 미니 대포 투척물', null, 'throwable:throwable_toy_cannon', 'throwable', 'throwable_toy_cannon', 220, true, null, 'throwable_toy_cannon') on conflict (id) do update set display_name=excluded.display_name, product_description=excluded.product_description, sort_order=excluded.sort_order, related_character_product_id=excluded.related_character_product_id, render_asset_id=excluded.render_asset_id, updated_at=now();
update public.commerce_prices set active=false, retired_at=now() where product_id='throwable_toy_cannon' and active and amount_krw != 2900;
insert into public.commerce_prices(product_id, amount_krw, currency, tax_inclusive, active) select 'throwable_toy_cannon', 2900, 'KRW', true, true where not exists (select 1 from public.commerce_prices where product_id='throwable_toy_cannon' and active);
insert into private.app_store_product_offers values ('throwable_toy_cannon', 'throwable_toy_cannon', true, false);
insert into public.commerce_products (id, display_name, product_description, character_id, entitlement_key, product_kind, catalog_item_id, sort_order, active, related_character_product_id, render_asset_id) values ('throwable_squeaky_duck', '삑삑 오리', '노란 오리가 빙글빙글 날아가는 투척물', null, 'throwable:throwable_squeaky_duck', 'throwable', 'throwable_squeaky_duck', 230, true, null, 'throwable_squeaky_duck') on conflict (id) do update set display_name=excluded.display_name, product_description=excluded.product_description, sort_order=excluded.sort_order, related_character_product_id=excluded.related_character_product_id, render_asset_id=excluded.render_asset_id, updated_at=now();
update public.commerce_prices set active=false, retired_at=now() where product_id='throwable_squeaky_duck' and active and amount_krw != 990;
insert into public.commerce_prices(product_id, amount_krw, currency, tax_inclusive, active) select 'throwable_squeaky_duck', 990, 'KRW', true, true where not exists (select 1 from public.commerce_prices where product_id='throwable_squeaky_duck' and active);
insert into private.app_store_product_offers values ('throwable_squeaky_duck', 'throwable_squeaky_duck', true, false);
insert into public.commerce_products (id, display_name, product_description, character_id, entitlement_key, product_kind, catalog_item_id, sort_order, active, related_character_product_id, render_asset_id) values ('throwable_snowflake', '눈송이', '맞으면 작은 결정 조각으로 흩어지는 눈송이예요.', null, 'throwable:throwable_snowflake', 'throwable', 'throwable_snowflake', 240, true, null, 'throwable_snowflake') on conflict (id) do update set display_name=excluded.display_name, product_description=excluded.product_description, sort_order=excluded.sort_order, related_character_product_id=excluded.related_character_product_id, render_asset_id=excluded.render_asset_id, updated_at=now();
update public.commerce_prices set active=false, retired_at=now() where product_id='throwable_snowflake' and active and amount_krw != 990;
insert into public.commerce_prices(product_id, amount_krw, currency, tax_inclusive, active) select 'throwable_snowflake', 990, 'KRW', true, true where not exists (select 1 from public.commerce_prices where product_id='throwable_snowflake' and active);
insert into private.app_store_product_offers values ('throwable_snowflake', 'throwable_snowflake', true, false);
insert into public.commerce_products (id, display_name, product_description, character_id, entitlement_key, product_kind, catalog_item_id, sort_order, active, related_character_product_id, render_asset_id) values ('throwable_baseball', '야구공', '붉은 실밥이 있는 공이 눌렸다 튕겨요.', null, 'throwable:throwable_baseball', 'throwable', 'throwable_baseball', 250, true, null, 'throwable_baseball') on conflict (id) do update set display_name=excluded.display_name, product_description=excluded.product_description, sort_order=excluded.sort_order, related_character_product_id=excluded.related_character_product_id, render_asset_id=excluded.render_asset_id, updated_at=now();
update public.commerce_prices set active=false, retired_at=now() where product_id='throwable_baseball' and active and amount_krw != 990;
insert into public.commerce_prices(product_id, amount_krw, currency, tax_inclusive, active) select 'throwable_baseball', 990, 'KRW', true, true where not exists (select 1 from public.commerce_prices where product_id='throwable_baseball' and active);
insert into private.app_store_product_offers values ('throwable_baseball', 'throwable_baseball', true, false);
insert into public.commerce_products (id, display_name, product_description, character_id, entitlement_key, product_kind, catalog_item_id, sort_order, active, related_character_product_id, render_asset_id) values ('throwable_wakkuball', '왁뿌볼', '와그작! 왁뿌볼이 조각조각 부서지는 바삭한 소리를 느껴보세요.', null, 'throwable:throwable_wakkuball', 'throwable', 'throwable_wakkuball', 260, true, null, 'throwable_wakkuball') on conflict (id) do update set display_name=excluded.display_name, product_description=excluded.product_description, sort_order=excluded.sort_order, related_character_product_id=excluded.related_character_product_id, render_asset_id=excluded.render_asset_id, updated_at=now();
update public.commerce_prices set active=false, retired_at=now() where product_id='throwable_wakkuball' and active and amount_krw != 1900;
insert into public.commerce_prices(product_id, amount_krw, currency, tax_inclusive, active) select 'throwable_wakkuball', 1900, 'KRW', true, true where not exists (select 1 from public.commerce_prices where product_id='throwable_wakkuball' and active);
insert into private.app_store_product_offers values ('throwable_wakkuball', 'throwable_wakkuball', true, false);
insert into public.commerce_products (id, display_name, product_description, character_id, entitlement_key, product_kind, catalog_item_id, sort_order, active, related_character_product_id, render_asset_id) values ('throwable_dujjonku', '두쫀쿠', '코코아 겉피와 초록색 속이 눌리며 바삭한 소리가 나요.', null, 'throwable:throwable_dujjonku', 'throwable', 'throwable_dujjonku', 270, true, null, 'throwable_dujjonku') on conflict (id) do update set display_name=excluded.display_name, product_description=excluded.product_description, sort_order=excluded.sort_order, related_character_product_id=excluded.related_character_product_id, render_asset_id=excluded.render_asset_id, updated_at=now();
update public.commerce_prices set active=false, retired_at=now() where product_id='throwable_dujjonku' and active and amount_krw != 1900;
insert into public.commerce_prices(product_id, amount_krw, currency, tax_inclusive, active) select 'throwable_dujjonku', 1900, 'KRW', true, true where not exists (select 1 from public.commerce_prices where product_id='throwable_dujjonku' and active);
insert into private.app_store_product_offers values ('throwable_dujjonku', 'throwable_dujjonku', true, false);
insert into public.commerce_products (id, display_name, product_description, character_id, entitlement_key, product_kind, catalog_item_id, sort_order, active, related_character_product_id, render_asset_id) values ('throwable_mini_paprika', '기니피그의 미니 파프리카', '작고 아삭한 파프리카를 던져요. 모든 캐릭터가 사용할 수 있어요.', null, 'throwable:throwable_mini_paprika', 'throwable', 'throwable_mini_paprika', 300, true, 'character_guinea_pig', 'mini_paprika') on conflict (id) do update set display_name=excluded.display_name, product_description=excluded.product_description, sort_order=excluded.sort_order, related_character_product_id=excluded.related_character_product_id, render_asset_id=excluded.render_asset_id, updated_at=now();
update public.commerce_prices set active=false, retired_at=now() where product_id='throwable_mini_paprika' and active and amount_krw != 990;
insert into public.commerce_prices(product_id, amount_krw, currency, tax_inclusive, active) select 'throwable_mini_paprika', 990, 'KRW', true, true where not exists (select 1 from public.commerce_prices where product_id='throwable_mini_paprika' and active);
insert into private.app_store_product_offers values ('throwable_mini_paprika', 'throwable_mini_paprika', true, false);
insert into public.commerce_products (id, display_name, product_description, character_id, entitlement_key, product_kind, catalog_item_id, sort_order, active, related_character_product_id, render_asset_id) values ('throwable_banana', '원숭이의 바나나', '잘 익은 바나나가 빙글빙글 날아가요. 모든 캐릭터가 사용할 수 있어요.', null, 'throwable:throwable_banana', 'throwable', 'throwable_banana', 310, true, 'character_monkey', 'banana') on conflict (id) do update set display_name=excluded.display_name, product_description=excluded.product_description, sort_order=excluded.sort_order, related_character_product_id=excluded.related_character_product_id, render_asset_id=excluded.render_asset_id, updated_at=now();
update public.commerce_prices set active=false, retired_at=now() where product_id='throwable_banana' and active and amount_krw != 990;
insert into public.commerce_prices(product_id, amount_krw, currency, tax_inclusive, active) select 'throwable_banana', 990, 'KRW', true, true where not exists (select 1 from public.commerce_prices where product_id='throwable_banana' and active);
insert into private.app_store_product_offers values ('throwable_banana', 'throwable_banana', true, false);
insert into public.commerce_products (id, display_name, product_description, character_id, entitlement_key, product_kind, catalog_item_id, sort_order, active, related_character_product_id, render_asset_id) values ('throwable_dust_bath_pouch', '친칠라의 모래주머니', '보송한 모래주머니가 톡 터져요. 모든 캐릭터가 사용할 수 있어요.', null, 'throwable:throwable_dust_bath_pouch', 'throwable', 'throwable_dust_bath_pouch', 320, true, 'character_chinchilla', 'dust_bath_pouch') on conflict (id) do update set display_name=excluded.display_name, product_description=excluded.product_description, sort_order=excluded.sort_order, related_character_product_id=excluded.related_character_product_id, render_asset_id=excluded.render_asset_id, updated_at=now();
update public.commerce_prices set active=false, retired_at=now() where product_id='throwable_dust_bath_pouch' and active and amount_krw != 990;
insert into public.commerce_prices(product_id, amount_krw, currency, tax_inclusive, active) select 'throwable_dust_bath_pouch', 990, 'KRW', true, true where not exists (select 1 from public.commerce_prices where product_id='throwable_dust_bath_pouch' and active);
insert into private.app_store_product_offers values ('throwable_dust_bath_pouch', 'throwable_dust_bath_pouch', true, false);
insert into public.commerce_products (id, display_name, product_description, character_id, entitlement_key, product_kind, catalog_item_id, sort_order, active, related_character_product_id, render_asset_id) values ('throwable_starlight_orb', '별빛 우파루파의 별빛 구슬', '반짝이는 별빛 구슬을 던져요. 모든 캐릭터가 사용할 수 있어요.', null, 'throwable:throwable_starlight_orb', 'throwable', 'throwable_starlight_orb', 330, true, 'character_starlight_upalupa', 'starlight_orb') on conflict (id) do update set display_name=excluded.display_name, product_description=excluded.product_description, sort_order=excluded.sort_order, related_character_product_id=excluded.related_character_product_id, render_asset_id=excluded.render_asset_id, updated_at=now();
update public.commerce_prices set active=false, retired_at=now() where product_id='throwable_starlight_orb' and active and amount_krw != 990;
insert into public.commerce_prices(product_id, amount_krw, currency, tax_inclusive, active) select 'throwable_starlight_orb', 990, 'KRW', true, true where not exists (select 1 from public.commerce_prices where product_id='throwable_starlight_orb' and active);
insert into private.app_store_product_offers values ('throwable_starlight_orb', 'throwable_starlight_orb', true, false);
insert into public.commerce_products (id, display_name, product_description, character_id, entitlement_key, product_kind, catalog_item_id, sort_order, active, related_character_product_id, render_asset_id) values ('throwable_clam', '수달의 조개', '달그락 소리가 나는 조개를 던져요. 모든 캐릭터가 사용할 수 있어요.', null, 'throwable:throwable_clam', 'throwable', 'throwable_clam', 340, true, 'character_otter', 'clam') on conflict (id) do update set display_name=excluded.display_name, product_description=excluded.product_description, sort_order=excluded.sort_order, related_character_product_id=excluded.related_character_product_id, render_asset_id=excluded.render_asset_id, updated_at=now();
update public.commerce_prices set active=false, retired_at=now() where product_id='throwable_clam' and active and amount_krw != 990;
insert into public.commerce_prices(product_id, amount_krw, currency, tax_inclusive, active) select 'throwable_clam', 990, 'KRW', true, true where not exists (select 1 from public.commerce_prices where product_id='throwable_clam' and active);
insert into private.app_store_product_offers values ('throwable_clam', 'throwable_clam', true, false);
insert into public.commerce_products (id, display_name, product_description, character_id, entitlement_key, product_kind, catalog_item_id, sort_order, active, related_character_product_id, render_asset_id) values ('throwable_pork', '아기 돼지의 돼지고기', '찰진 촵 소리와 함께 돼지고기를 던져요. 모든 캐릭터가 사용할 수 있어요.', null, 'throwable:throwable_pork', 'throwable', 'throwable_pork', 350, true, 'character_pig', 'pork') on conflict (id) do update set display_name=excluded.display_name, product_description=excluded.product_description, sort_order=excluded.sort_order, related_character_product_id=excluded.related_character_product_id, render_asset_id=excluded.render_asset_id, updated_at=now();
update public.commerce_prices set active=false, retired_at=now() where product_id='throwable_pork' and active and amount_krw != 990;
insert into public.commerce_prices(product_id, amount_krw, currency, tax_inclusive, active) select 'throwable_pork', 990, 'KRW', true, true where not exists (select 1 from public.commerce_prices where product_id='throwable_pork' and active);
insert into private.app_store_product_offers values ('throwable_pork', 'throwable_pork', true, false);
insert into public.commerce_products (id, display_name, product_description, character_id, entitlement_key, product_kind, catalog_item_id, sort_order, active, related_character_product_id, render_asset_id) values ('throwable_timber', '나무의 작은 나무', '작은 나무 한 그루가 빙글빙글 날아가요. 모든 캐릭터가 사용할 수 있어요.', null, 'throwable:throwable_timber', 'throwable', 'throwable_timber', 360, true, 'character_tree', 'timber') on conflict (id) do update set display_name=excluded.display_name, product_description=excluded.product_description, sort_order=excluded.sort_order, related_character_product_id=excluded.related_character_product_id, render_asset_id=excluded.render_asset_id, updated_at=now();
update public.commerce_prices set active=false, retired_at=now() where product_id='throwable_timber' and active and amount_krw != 990;
insert into public.commerce_prices(product_id, amount_krw, currency, tax_inclusive, active) select 'throwable_timber', 990, 'KRW', true, true where not exists (select 1 from public.commerce_prices where product_id='throwable_timber' and active);
insert into private.app_store_product_offers values ('throwable_timber', 'throwable_timber', true, false);

alter table private.app_store_transactions add column store_product_id text;
update private.app_store_transactions set store_product_id=product_id;
alter table private.app_store_transactions alter column store_product_id set not null;
alter table private.app_store_transactions add constraint app_store_transaction_offer foreign key (store_product_id) references private.app_store_product_offers(store_product_id);
create or replace function private.refresh_commerce_entitlement(
  target_user_id uuid,
  target_entitlement_key text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  effective_status text;
  first_granted_at timestamptz;
  effective_revoked_at timestamptz;
begin
  if target_user_id is null then
    return;
  end if;

  -- Deleting or unbinding the final source removes effective ownership entirely.
  if not exists (select 1 from private.commerce_grants
                 where user_id=target_user_id and entitlement_key=target_entitlement_key) then
    delete from public.commerce_entitlements
    where user_id=target_user_id and entitlement_key=target_entitlement_key;
    return;
  end if;

  select case
           when bool_or(grants.status = 'active') then 'active'
           when bool_or(grants.status = 'refunded') then 'refunded'
           else 'revoked'
         end,
         min(grants.granted_at),
         case when bool_or(grants.status = 'active') then null
              else max(grants.revoked_at)
         end
  into effective_status, first_granted_at, effective_revoked_at
  from private.commerce_grants grants
  where grants.user_id = target_user_id
    and grants.entitlement_key = target_entitlement_key;

  if effective_status is null then
    delete from public.commerce_entitlements
    where user_id = target_user_id
      and entitlement_key = target_entitlement_key;
    return;
  end if;

  insert into public.commerce_entitlements (
    user_id, entitlement_key, source_order_id, status, grant_kind,
    grant_reference, granted_at, revoked_at, updated_at
  ) values (
    target_user_id, target_entitlement_key, null, effective_status, null,
    null, first_granted_at, effective_revoked_at, now()
  )
  on conflict (user_id, entitlement_key) do update
  set source_order_id = null,
      status = excluded.status,
      grant_kind = null,
      grant_reference = null,
      granted_at = excluded.granted_at,
      revoked_at = excluded.revoked_at,
      updated_at = now();
end;
$$;

revoke all on function private.refresh_commerce_entitlement(uuid, text)
from public, anon, authenticated;

-- Keep one primary grant and an independently revocable included-item grant.
alter table private.commerce_grants
  add column included_entitlement_key text references public.commerce_products(entitlement_key),
  add column parent_grant_id uuid references private.commerce_grants(id) on delete cascade;
create unique index commerce_grant_one_included_item on private.commerce_grants(parent_grant_id) where parent_grant_id is not null;
create function private.mark_legacy_character_inclusion()
returns trigger language plpgsql security definer set search_path='' as $$
declare item_key text; eligible boolean := false;
begin
  if new.parent_grant_id is not null then return new; end if;
  select item.entitlement_key into item_key
  from public.commerce_products character
  join public.commerce_products item on item.related_character_product_id=character.id
  where character.entitlement_key=new.entitlement_key;
  if item_key is null then return new; end if;
  if new.source_kind='app_store' then
    select offer.includes_related_throwable into eligible
    from private.app_store_transactions tx
    join private.app_store_product_offers offer on offer.store_product_id=tx.store_product_id
    where 'transaction:' || tx.transaction_id=new.source_reference;
  elsif new.source_kind='portone' then
    select orders.created_at < transition.cutover_at into eligible
    from public.commerce_orders orders cross join private.character_item_transition transition
    where 'order:' || orders.id::text=new.source_reference;
  end if;
  if coalesce(eligible,false) then new.included_entitlement_key:=item_key; end if;
  return new;
end $$;
revoke all on function private.mark_legacy_character_inclusion() from public, anon, authenticated;
create trigger commerce_grants_mark_inclusion before insert or update on private.commerce_grants
for each row execute function private.mark_legacy_character_inclusion();
create function private.sync_included_character_item()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if TG_OP='DELETE' then
    perform private.refresh_commerce_entitlement(old.user_id,old.entitlement_key);
    return null;
  end if;
  if new.parent_grant_id is null and new.included_entitlement_key is not null then
    insert into private.commerce_grants(user_id,entitlement_key,source_kind,source_reference,status,granted_at,revoked_at,parent_grant_id)
    values(new.user_id,new.included_entitlement_key,'complimentary','included:' || new.id::text,
      new.status,new.granted_at,new.revoked_at,new.id)
    on conflict(source_kind,source_reference) do update set
      user_id=excluded.user_id,status=excluded.status,revoked_at=excluded.revoked_at,updated_at=now();
  end if;
  perform private.refresh_commerce_entitlement(new.user_id,new.entitlement_key);
  if TG_OP='UPDATE' and old.user_id is distinct from new.user_id then
    perform private.refresh_commerce_entitlement(old.user_id,old.entitlement_key);
  end if;
  return null;
end $$;
revoke all on function private.sync_included_character_item() from public, anon, authenticated;
create trigger commerce_grants_sync_inclusion after insert or update or delete on private.commerce_grants
for each row execute function private.sync_included_character_item();
-- A one-time snapshot preserves all existing active owners, including gifts.
update private.commerce_grants grants set included_entitlement_key=item.entitlement_key
from public.commerce_products character
join public.commerce_products item on item.related_character_product_id=character.id
where grants.entitlement_key=character.entitlement_key and grants.status='active' and grants.parent_grant_id is null;
update public.profiles profile set equipped_throwable_id=item.catalog_item_id, updated_at=now()
from public.commerce_products character
join public.commerce_products item on item.related_character_product_id=character.id
where profile.character_id=character.character_id and profile.equipped_throwable_id is null
  and exists(select 1 from public.commerce_entitlements owned where owned.user_id=profile.id and owned.entitlement_key=item.entitlement_key and owned.status='active');
create or replace function public.admin_apply_app_store_transaction(
  p_user_id uuid,
  p_transaction_id text,
  p_original_transaction_id text,
  p_product_id text,
  p_app_account_token uuid,
  p_environment text,
  p_status text,
  p_purchased_at timestamptz,
  p_revoked_at timestamptz,
  p_signed_at timestamptz,
  p_signed_data_sha256_hex text
)
returns table (entitlement_key text, entitlement_status text, binding_state text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  existing_transaction private.app_store_transactions;
  target_user_id uuid;
  target_entitlement_key text;
  target_character_id text;
  canonical_product_id text;
begin
  if p_environment not in ('Sandbox', 'Production')
     or p_status not in ('active', 'refunded', 'revoked')
     or char_length(coalesce(p_transaction_id, '')) not between 1 and 128
     or char_length(coalesce(p_original_transaction_id, '')) not between 1 and 128
     or p_signed_data_sha256_hex !~ '^[0-9a-f]{64}$'
     or (p_status = 'active' and p_revoked_at is not null)
     or (p_status != 'active' and p_revoked_at is null) then
    raise exception using errcode = '22023', message = 'invalid_app_store_transaction';
  end if;

  select offer.product_id into canonical_product_id from private.app_store_product_offers offer where offer.store_product_id=p_product_id;
  if canonical_product_id is null then raise exception using errcode='22023', message='unknown_app_store_product'; end if;

  select products.entitlement_key, products.character_id
  into target_entitlement_key, target_character_id
  from public.commerce_products products
  where products.id = canonical_product_id;
  if target_entitlement_key is null then
    raise exception using errcode = '22023', message = 'unknown_app_store_product';
  end if;

  select * into existing_transaction
  from private.app_store_transactions transactions
  where transactions.transaction_id = p_transaction_id
  for update;

  if found and existing_transaction.store_product_id != p_product_id then
    raise exception using errcode='23505', message='app_store_transaction_product_mismatch';
  end if;
  if existing_transaction.transaction_id is not null and p_signed_at < existing_transaction.signed_at then
    return query
    select target_entitlement_key,
           existing_transaction.status,
           existing_transaction.binding_state;
    return;
  end if;

  if existing_transaction.transaction_id is not null
     and existing_transaction.user_id is not null
     and p_user_id is not null
     and existing_transaction.user_id != p_user_id then
    raise exception using errcode = '23505', message = 'app_store_transaction_already_bound';
  end if;

  target_user_id := coalesce(existing_transaction.user_id, p_user_id);
  if existing_transaction.transaction_id is null
     and target_user_id is not null
     and p_app_account_token is distinct from target_user_id then
    raise exception using errcode = '42501', message = 'app_account_token_mismatch';
  end if;

  insert into private.app_store_transactions (
    transaction_id, original_transaction_id, product_id, store_product_id, user_id,
    app_account_token, environment, status, binding_state, purchased_at,
    revoked_at, signed_at, signed_data_sha256, updated_at
  ) values (
    p_transaction_id, p_original_transaction_id, canonical_product_id, p_product_id, target_user_id,
    p_app_account_token, p_environment, p_status,
    case when target_user_id is null then 'unbound' else 'bound' end,
    p_purchased_at, p_revoked_at, p_signed_at,
    decode(p_signed_data_sha256_hex, 'hex'), now()
  )
  on conflict (transaction_id) do update
  set original_transaction_id = excluded.original_transaction_id,
      product_id = excluded.product_id,
      user_id = excluded.user_id,
      app_account_token = coalesce(private.app_store_transactions.app_account_token,
                                   excluded.app_account_token),
      environment = excluded.environment,
      status = excluded.status,
      binding_state = excluded.binding_state,
      purchased_at = excluded.purchased_at,
      revoked_at = excluded.revoked_at,
      signed_at = excluded.signed_at,
      signed_data_sha256 = excluded.signed_data_sha256,
      updated_at = now();

  if target_user_id is not null then
    insert into private.commerce_grants (
      user_id, entitlement_key, source_kind, source_reference,
      status, granted_at, revoked_at, updated_at
    ) values (
      target_user_id, target_entitlement_key, 'app_store',
      'transaction:' || p_transaction_id, p_status, p_purchased_at,
      p_revoked_at, now()
    )
    on conflict (source_kind, source_reference) do update
    set user_id = excluded.user_id,
        entitlement_key = excluded.entitlement_key,
        status = excluded.status,
        granted_at = excluded.granted_at,
        revoked_at = excluded.revoked_at,
        updated_at = now();

    perform private.refresh_commerce_entitlement(target_user_id, target_entitlement_key);

    if p_status != 'active' and not exists (
      select 1 from private.commerce_grants grants
      where grants.user_id = target_user_id
        and grants.entitlement_key = target_entitlement_key
        and grants.status = 'active'
    ) then
      update public.profiles
      set character_id = 'pixel_hamster', updated_at = now()
      where id = target_user_id and character_id = target_character_id;
    end if;
  end if;

  return query
  select target_entitlement_key,
         p_status,
         case when target_user_id is null then 'unbound' else 'bound' end;
end;
$$;

revoke all on function public.admin_apply_app_store_transaction(
  uuid, text, text, text, uuid, text, text, timestamptz, timestamptz,
  timestamptz, text
) from public, anon, authenticated;
grant execute on function public.admin_apply_app_store_transaction(
  uuid, text, text, text, uuid, text, text, timestamptz, timestamptz,
  timestamptz, text
) to service_role;

drop function public.get_store_state();
create or replace function public.get_store_state()
returns table (
  product_id text,
  display_name text,
  product_description text,
  product_kind text,
  catalog_item_id text,
  character_id text,
  entitlement_key text,
  sort_order integer,
  amount_krw integer,
  currency text,
  tax_inclusive boolean,
  google_connected boolean,
  entitlement_status text,
  latest_order_status text,
  is_equipped boolean,
  related_character_product_id text,
  render_asset_id text,
  app_store_product_id text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := auth.uid();
begin
  if current_user_id is null then
    raise exception using errcode = '42501', message = 'authentication_required';
  end if;

  return query
  select products.id,
         products.display_name,
         products.product_description,
         products.product_kind,
         products.catalog_item_id,
         products.character_id,
         products.entitlement_key,
         products.sort_order,
         prices.amount_krw,
         prices.currency,
         prices.tax_inclusive,
         private.has_google_identity(current_user_id),
         (select entitlements.status
          from public.commerce_entitlements entitlements
          where entitlements.user_id = current_user_id
            and entitlements.entitlement_key = products.entitlement_key),
         (select orders.status
          from public.commerce_orders orders
          where orders.user_id = current_user_id
            and orders.product_id = products.id
          order by orders.created_at desc
          limit 1),
         coalesce(
           case products.product_kind
             when 'bubble' then products.catalog_item_id = profiles.equipped_bubble_style_id
             when 'throwable' then products.catalog_item_id = profiles.equipped_throwable_id
             when 'character' then products.catalog_item_id = profiles.character_id
             else false
           end,
           false
         ),
         products.related_character_product_id,
         products.render_asset_id,
         (select offer.store_product_id from private.app_store_product_offers offer where offer.product_id=products.id and offer.current_offer)
  from public.commerce_products products
  join public.commerce_prices prices
    on prices.product_id = products.id and prices.active is true
  left join public.profiles profiles on profiles.id = current_user_id
  where products.active is true
  order by products.sort_order, products.id;
end;
$$;

revoke all on function public.get_store_state() from public, anon;
grant execute on function public.get_store_state() to authenticated;
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
  selected_throwable_id text;
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
    raise exception using errcode = 'PT409', message = 'stale_realtime_epoch';
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
  select coalesce((select products.render_asset_id from public.commerce_products products
    where products.catalog_item_id=private.owned_equipped_catalog_item(current_user_id,'throwable')
      and products.product_kind='throwable' and products.active), 'patch_soft_ball') into selected_throwable_id;

  perform pg_advisory_xact_lock(hashtextextended(
    'event:' || current_user_id::text || ':character_throw', 0
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
    jsonb_strip_nulls(jsonb_build_object(
      'schema_version', 1,
      'room_id', p_room_id,
      'event_id', p_event_id,
      'actor_user_id', current_user_id,
      'target_user_id', p_target_user_id,
      'source_character_id', source_character_id,
      'throwable_id', selected_throwable_id
    )),
    'character_throw',
    private.room_topic(p_room_id, current_epoch, 'ephemeral'),
    true
  );
end;
$$;
commit;

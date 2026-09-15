begin;
set local role postgres;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
select plan(6);

select is((select amount_krw from public.commerce_prices
  where product_id='character_starlight_upalupa' and active),2200,'new upalupa price is 2200 KRW');
select is((select count(*)::integer from public.commerce_prices
  where product_id='character_starlight_upalupa' and not active and amount_krw=1100 and retired_at is not null),
  1,'superseded 1100 KRW price is retained');
select is((select count(*)::integer from public.commerce_prices
  where product_id='character_starlight_upalupa' and not active and amount_krw=1900),
  1,'historical 1900 KRW price is retained');
select is((select amount_krw from public.commerce_prices
  where product_id='throwable_starlight_orb' and active),1100,'independent starlight orb stays 1100 KRW');
select is((select count(*)::integer from public.commerce_products where active),33,'product count stays 33');
select is((select count(*)::integer from private.app_store_product_offers),43,'Apple current and restoration IDs stay 43');

select * from finish();
rollback;

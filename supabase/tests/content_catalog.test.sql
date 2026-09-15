begin;
set local role postgres;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
select plan(8);
select is((select count(*)::integer from public.commerce_products where active),33,'33 independent products');
select is((select count(*)::integer from private.app_store_product_offers),43,'43 current and restoration Apple IDs');
select is((select count(*)::integer from private.app_store_product_offers where current_offer),33,'one current Apple offer per product');
select is((select count(*)::integer from private.app_store_product_offers
  where product_id in ('character_shiba','character_duck','character_poop','character_tteokbokki','character_quokka')
  and includes_related_throwable),0,'new Apple characters never include keepsakes');
select is((select count(*)::integer from public.commerce_products where id='throwable_squeaky_duck'),1,'existing squeaky duck product is reused once');
select is((select related_character_product_id from public.commerce_products where id='throwable_squeaky_duck'),'character_duck','duck relationship is presentation metadata');
select is((select amount_krw from public.commerce_prices where product_id='character_tree' and active),1100,'tree price is 1100 KRW');
select is((select count(*)::integer from public.commerce_prices where product_id='character_tree' and not active and amount_krw=1900),1,'previous tree price row is retained');
select * from finish();
rollback;

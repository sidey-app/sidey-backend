begin;

-- Retain all historical transaction IDs and their original keepsake semantics.
-- Only the Apple sale offers change; logical products, prices and grants do not.
update private.app_store_product_offers
set current_offer = false
where product_id in ('character_monkey', 'throwable_clam', 'throwable_pork')
  and current_offer;

insert into private.app_store_product_offers
  (store_product_id, product_id, current_offer, includes_related_throwable)
values
  ('character_monkey_solo_2', 'character_monkey', true, false),
  ('throwable_clam_2', 'throwable_clam', true, false),
  ('throwable_pork_2', 'throwable_pork', true, false)
on conflict (store_product_id) do update
set current_offer = excluded.current_offer;

commit;

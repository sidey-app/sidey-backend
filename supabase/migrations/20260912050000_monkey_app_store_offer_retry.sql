begin;

-- Compare a new monkey-only Apple offer without changing other sale offers.
update private.app_store_product_offers
set current_offer = false
where product_id = 'character_monkey' and current_offer;

insert into private.app_store_product_offers
  (store_product_id, product_id, current_offer, includes_related_throwable)
values ('character_monkey_solo_3', 'character_monkey', true, false)
on conflict (store_product_id) do update
set current_offer = excluded.current_offer;

commit;

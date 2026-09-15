begin;

-- Replace only the Apple sale offer; preserve the product and all ownership.
update private.app_store_product_offers
set current_offer = false
where product_id = 'character_tree' and current_offer;

insert into private.app_store_product_offers
  (store_product_id, product_id, current_offer, includes_related_throwable)
values ('character_tree_2', 'character_tree', true, false)
on conflict (store_product_id) do update
set current_offer = excluded.current_offer;

commit;

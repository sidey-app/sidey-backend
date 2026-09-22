begin;
set local role postgres;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
select no_plan();

select results_eq(
  $$select product_kind, id, catalog_item_id, wire_code
    from public.commerce_products
    where product_kind in ('bubble', 'throwable')
    order by product_kind, wire_code$$,
  $$values
    ('bubble'::text, 'bubble_bunny_pink'::text, 'bubble_bunny_pink'::text, 1),
    ('bubble', 'bubble_butter_chick', 'bubble_butter_chick', 2),
    ('bubble', 'bubble_starry_cat', 'bubble_starry_cat', 3),
    ('throwable', 'throwable_bouncy_heart', 'throwable_bouncy_heart', 1),
    ('throwable', 'throwable_toy_cannon', 'throwable_toy_cannon', 2),
    ('throwable', 'throwable_squeaky_duck', 'throwable_squeaky_duck', 3),
    ('throwable', 'throwable_snowflake', 'throwable_snowflake', 4),
    ('throwable', 'throwable_baseball', 'throwable_baseball', 5),
    ('throwable', 'throwable_wakkuball', 'throwable_wakkuball', 6),
    ('throwable', 'throwable_dujjonku', 'throwable_dujjonku', 7),
    ('throwable', 'throwable_mini_paprika', 'throwable_mini_paprika', 8),
    ('throwable', 'throwable_banana', 'throwable_banana', 9),
    ('throwable', 'throwable_dust_bath_pouch', 'throwable_dust_bath_pouch', 10),
    ('throwable', 'throwable_starlight_orb', 'throwable_starlight_orb', 11),
    ('throwable', 'throwable_clam', 'throwable_clam', 12),
    ('throwable', 'throwable_pork', 'throwable_pork', 13),
    ('throwable', 'throwable_timber', 'throwable_timber', 14),
    ('throwable', 'throwable_tennis_ball', 'throwable_tennis_ball', 15),
    ('throwable', 'throwable_tissue_ball', 'throwable_tissue_ball', 16),
    ('throwable', 'throwable_fish_cake_skewer', 'throwable_fish_cake_skewer', 17),
    ('throwable', 'throwable_leaf', 'throwable_leaf', 18)$$,
  'Firebase v2 wire codes match the catalog-pinned cross-platform contract'
);

select * from finish();
rollback;

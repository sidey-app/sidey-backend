begin;

-- Wire codes are a permanent cross-platform protocol, not a presentation
-- order. This mapping is pinned to assets/v1/commerce-catalog.json SHA-256
-- 54e2f0298c4652d113e34374bc748fda829300e327ff9dd682df316fc149884b.
-- Production baseline phases must create this exact mapping. The standard
-- staging/fresh path reaches the same values through the historical migration;
-- abort instead of silently renumbering a divergent catalog.
do $$
begin
  if exists (
    with expected(product_kind, product_id, catalog_item_id, wire_code) as (
      values
        ('bubble', 'bubble_bunny_pink', 'bubble_bunny_pink', 1),
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
        ('throwable', 'throwable_leaf', 'throwable_leaf', 18)
    ), actual as (
      select products.product_kind,
             products.id as product_id,
             products.catalog_item_id,
             products.wire_code
      from public.commerce_products as products
      where products.product_kind in ('bubble', 'throwable')
    )
    select 1
    from expected
    full join actual using (product_kind, product_id, catalog_item_id, wire_code)
    where expected.product_id is null or actual.product_id is null
  ) then
    raise exception using
      errcode = 'P0001',
      message = 'firebase_wire_code_contract_mismatch';
  end if;
end;
$$;

comment on column public.commerce_products.wire_code is
  'Permanent per-product-kind Firebase v2 wire code; never derive again from sort order.';

commit;

-- Snapshot the historical offer promise independently of current renderer/catalog links.
alter table app_store_product_offers add column included_entitlement_key text
    references commerce_products(entitlement_key) on delete restrict;
update app_store_product_offers o set included_entitlement_key=p.entitlement_key
from commerce_products p where o.includes_related_throwable and p.related_character_product_id=o.product_id;
alter table app_store_product_offers add constraint offer_inclusion_snapshot
    check (includes_related_throwable = (included_entitlement_key is not null));

-- This migration must stay outside an explicit transaction. PostgreSQL does
-- not permit CREATE INDEX CONCURRENTLY inside a transaction block.
-- Dropping first makes a retry recover an invalid index left by a failed
-- concurrent build; the index name is new on the first production run.
set lock_timeout = '5s';

drop index concurrently if exists public.commerce_orders_admin_purchase_idx;

create index concurrently commerce_orders_admin_purchase_idx
on public.commerce_orders (approved_at desc, product_id, user_id)
where approved_at is not null and status in ('approved', 'refunded');

reset lock_timeout;

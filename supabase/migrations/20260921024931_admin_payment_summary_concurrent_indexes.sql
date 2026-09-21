-- This migration must stay outside an explicit transaction. PostgreSQL does
-- not permit CREATE INDEX CONCURRENTLY inside a transaction block.
--
-- The existing environment/purchase index already serves the App Store
-- summary range. Add only the user-history lookup without blocking writes.
-- Dropping first makes a retry recover an invalid index left by a failed
-- concurrent build; the index name is new on the first production run.
set lock_timeout = '5s';

drop index concurrently if exists private.app_store_transactions_user_production_history_idx;

create index concurrently app_store_transactions_user_production_history_idx
on private.app_store_transactions (user_id, purchased_at desc)
where environment = 'Production' and user_id is not null;

reset lock_timeout;

begin;

-- App Store transactions use the same server-owned catalog and entitlement
-- projection as PortOne. Product allowlisting still happens in the dedicated
-- verifier before this service-role-only function is called.
drop trigger if exists app_store_transactions_character_only
on private.app_store_transactions;

drop function if exists private.enforce_app_store_character_product();

commit;

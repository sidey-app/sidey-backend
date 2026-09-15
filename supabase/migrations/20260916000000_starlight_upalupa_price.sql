begin;

-- Correct only the price used by new starlight upalupa orders.
-- Existing orders retain their price_id and amount; Apple reports signed transaction money.
update public.commerce_prices
set active = false, retired_at = now()
where product_id = 'character_starlight_upalupa'
  and active and amount_krw <> 2200;

insert into public.commerce_prices (product_id, amount_krw, currency, tax_inclusive, active)
select 'character_starlight_upalupa', 2200, 'KRW', true, true
where not exists (
  select 1 from public.commerce_prices
  where product_id = 'character_starlight_upalupa' and active
);

commit;

begin;
-- Presentation copy only; ownership, prices and availability are unchanged.
update public.commerce_products
set product_description = '아껴 둔 간식이에요. 던진 뒤엔 3초 안에 주우면 괜찮겠죠?', updated_at = now()
where id = 'throwable_mini_paprika';
update public.commerce_products
set product_description = '원숭이가 양보한 바나나예요. 양보한 게 맞는지는 아직 못 물어봤어요.', updated_at = now()
where id = 'throwable_banana';
update public.commerce_products
set product_description = '친칠라의 목욕 모래예요. 씻으라고 던지는 건… 아마 아닐 거예요.', updated_at = now()
where id = 'throwable_dust_bath_pouch';
update public.commerce_products
set product_description = '별빛을 꾹꾹 뭉쳤어요. 하늘에서 별 하나가 없어졌다는데요?', updated_at = now()
where id = 'throwable_starlight_orb';
update public.commerce_products
set product_description = '수달이 품고 다니던 조개예요. 진주는 없고, 미련은 좀 있어요.', updated_at = now()
where id = 'throwable_clam';
update public.commerce_products
set product_description = '찰진 촵! 근데 옆집 꿀꿀이가 며칠 전부터 안 보이던데…?', updated_at = now()
where id = 'throwable_pork';
update public.commerce_products
set product_description = '나무가 작은 나무를 던져요. 일단 족보부터 확인해 볼까요?', updated_at = now()
where id = 'throwable_timber';
commit;

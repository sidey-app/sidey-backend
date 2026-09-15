-- Keep character introductions aligned with the shared catalog.
BEGIN;

UPDATE public.commerce_products
SET product_description = '길 잃은 별 하나를 데려왔어요. 잘 때도 품에 꼭 안고 잔대요.', updated_at = now()
WHERE id = 'character_starlight_upalupa';

UPDATE public.commerce_products
SET product_description = '간식을 숨긴 곳을 잊어버렸어요. 볼이 빵빵한 걸 보니 멀리 있진 않네요.', updated_at = now()
WHERE id = 'character_guinea_pig';

UPDATE public.commerce_products
SET product_description = '바나나를 나눠 주러 왔어요. 오는 길에 한 입만 먹었다는데… 반쪽이네요?', updated_at = now()
WHERE id = 'character_monkey';

UPDATE public.commerce_products
SET product_description = '모래 목욕을 마치고 놀러 왔어요. 인사보다 먼저 뽀송한 털 자랑부터 해요.', updated_at = now()
WHERE id = 'character_chinchilla';

UPDATE public.commerce_products
SET product_description = '마음에 드는 조개를 보여 주러 왔어요. 구경은 되지만 가져가면 삐져요.', updated_at = now()
WHERE id = 'character_otter';

UPDATE public.commerce_products
SET product_description = '간식 냄새를 따라왔다가 눌러앉았어요. 이제 여기가 자기 집인 줄 알아요.', updated_at = now()
WHERE id = 'character_pig';

UPDATE public.commerce_products
SET product_description = '산책 나온 작은 나무예요. 잠깐 쉬랬더니 뿌리내릴 자리를 고르고 있어요.', updated_at = now()
WHERE id = 'character_tree';

COMMIT;

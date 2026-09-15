-- Keep checkout disclosure text user-facing while preserving an immutable
-- policy-version trail for orders that accepted the previous wording.

update private.commerce_runtime_settings
set policy_version = '2026-09-02-v2',
    policy_notice = '표시 가격은 부가세가 포함된 990원이며 구매 전 Google 계정 연결이 필요합니다. 결제가 완료되면 별빛 우파루파를 바로 사용할 수 있습니다. 사용권 제공이 시작된 뒤에는 단순 변심에 따른 청약철회가 제한됩니다. 상품 미제공, 계약 내용 불일치, 중복 결제, 본인이 승인하지 않은 결제 등 법정 사유가 확인되면 전액 환불합니다.',
    updated_at = now()
where singleton is true;

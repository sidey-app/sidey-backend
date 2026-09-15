begin;

-- Existing orders retain their immutable consent text. New checkouts receive
-- the current policy version and notice from runtime settings.
update private.commerce_runtime_settings
set policy_version = '2026-09-03-portone-v2',
    policy_notice = '표시 가격은 부가세 포함 금액이며 구매 전 Google 계정 연결이 필요합니다. 결제창은 PortOne을 통해 연결된 결제대행사가 제공합니다. SIDEY 서버가 결제 금액과 상태를 다시 확인한 뒤 디지털 캐릭터 사용권 제공이 즉시 시작됩니다. 제공 시작 뒤 단순 변심에 따른 청약철회와 환불은 불가합니다. 다만 사용권 미제공, 표시·계약 내용 불일치, 중복 결제, 본인이 승인하지 않은 결제 등 관련 법령상 사유가 확인되면 전액 환불합니다.',
    updated_at = now()
where singleton is true;

commit;

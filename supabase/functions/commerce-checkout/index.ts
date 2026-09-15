import {
  assertPortOneConfiguration,
  checkoutRedirectURL,
  corsHeaders,
  jsonResponse,
  portOneChannelKey,
  portOneStoreID,
  publicError,
  serviceRPC,
  sha256Hex,
  type CommerceOrder,
} from "../_shared/commerce.ts";

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return jsonResponse({ error: "method_not_allowed" }, 405);

  try {
    assertPortOneConfiguration();
    const payload = await request.json().catch(() => ({}));
    const token = typeof payload?.token === "string" ? payload.token : "";
    const action = payload?.action === "authorize" ? "authorize" : "prepare";
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) {
      return jsonResponse({ error: "invalid_checkout_token" }, 400);
    }

    const tokenHash = await sha256Hex(token);
    const rows = await serviceRPC<CommerceOrder[]>("commerce_portone_checkout_prepare", {
      p_checkout_token_hash_hex: tokenHash,
    });
    const order = rows[0];
    if (!order) return jsonResponse({ error: "checkout_expired" }, 410);

    const publicOrder = {
      product_id: order.product_id,
      character_id: order.character_id,
      order_name: order.display_name,
      amount: order.amount_krw,
      currency: order.currency,
      policy_version: order.policy_version,
      policy_notice: order.policy_notice,
      payment_environment: order.payment_environment,
    };
    if (action === "prepare") {
      return jsonResponse({ ...publicOrder, requires_consent: order.policy_consented_at == null });
    }

    if (payload?.policy_version !== order.policy_version) {
      return jsonResponse({ error: "commerce_policy_version_mismatch" }, 409);
    }
    await serviceRPC("commerce_record_policy_consent", {
      p_checkout_token_hash_hex: tokenHash,
      p_policy_version: order.policy_version,
    });

    return jsonResponse({
      ...publicOrder,
      store_id: portOneStoreID(),
      channel_key: portOneChannelKey(),
      payment_id: order.payment_id,
      pay_method: "EASY_PAY",
      portone_currency: "CURRENCY_KRW",
      redirect_url: checkoutRedirectURL(token, order.product_id),
    });
  } catch (error) {
    return publicError(error);
  }
});

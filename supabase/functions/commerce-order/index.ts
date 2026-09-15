import {
  assertPortOneConfiguration,
  authenticatedUser,
  checkoutPageURL,
  corsHeaders,
  jsonResponse,
  SUPPORTED_PRODUCT_IDS,
  publicError,
  randomToken,
  sha256Hex,
  userRPC,
} from "../_shared/commerce.ts";

type CreatedOrder = {
  order_id: string;
  provider_order_id: string;
};

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return jsonResponse({ error: "method_not_allowed" }, 405);

  try {
    const authorization = request.headers.get("authorization");
    await authenticatedUser(authorization);
    assertPortOneConfiguration();
    const payload = await request.json().catch(() => ({}));
    const productID = typeof payload?.product_id === "string" ? payload.product_id : "";
    if (!SUPPORTED_PRODUCT_IDS.has(productID)) {
      return jsonResponse({ error: "commerce_product_unavailable" }, 400);
    }

    const checkoutToken = randomToken();
    const tokenHash = await sha256Hex(checkoutToken);
    const rows = await userRPC<CreatedOrder[]>(
      "create_commerce_order",
      { p_product_id: productID, p_checkout_token_hash_hex: tokenHash },
      authorization!,
    );
    const order = rows[0];
    if (!order) throw new Error("commerce_order_missing");

    return jsonResponse({
      order_id: order.order_id,
      checkout_url: checkoutPageURL(checkoutToken),
    }, 201);
  } catch (error) {
    return publicError(error);
  }
});

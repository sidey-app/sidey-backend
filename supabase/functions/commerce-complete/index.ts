import {
  applyPortOnePayment,
  checkoutResultURL,
  corsHeaders,
  jsonResponse,
  portOneRequest,
  publicError,
  serviceRPC,
  sha256Hex,
  validatePortOnePayment,
  type CommerceOrder,
  type PortOnePayment,
} from "../_shared/commerce.ts";

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return jsonResponse({ error: "method_not_allowed" }, 405);

  try {
    const payload = await request.json().catch(() => ({}));
    const token = typeof payload?.token === "string" ? payload.token : "";
    const paymentID = typeof payload?.payment_id === "string" ? payload.payment_id : "";
    if (!/^[A-Za-z0-9_-]{43}$/.test(token) || paymentID.length < 6 || paymentID.length > 200) {
      return jsonResponse({ error: "invalid_completion_request" }, 400);
    }

    const rows = await serviceRPC<CommerceOrder[]>("commerce_portone_completion_order", {
      p_checkout_token_hash_hex: await sha256Hex(token),
      p_payment_id: paymentID,
    });
    const order = rows[0];
    if (!order) return jsonResponse({ error: "checkout_expired" }, 410);

    const payment = validatePortOnePayment(
      await portOneRequest<PortOnePayment>(`/payments/${encodeURIComponent(paymentID)}`),
      order,
      "PAID",
    );
    const status = await applyPortOnePayment(
      order,
      payment,
      `complete:${order.order_id}:${payment.transactionId ?? "paid"}`,
      "SIDEY_COMPLETE",
    );
    if (status !== "approved") {
      return jsonResponse({ error: "payment_not_approved" }, 409);
    }
    return jsonResponse({
      completed: true,
      status,
      result_url: checkoutResultURL("success", order.product_id),
    });
  } catch (error) {
    return publicError(error);
  }
});

import {
  applyPortOnePayment,
  constantTimeEqual,
  HttpError,
  jsonResponse,
  portOneRequest,
  portOneStoreID,
  publicError,
  serviceRPC,
  validatePortOnePayment,
  type CommerceOrder,
  type PortOnePayment,
} from "../_shared/commerce.ts";

type RefundTarget = CommerceOrder & { request_id: string };

Deno.serve(async (request) => {
  if (request.method !== "POST") return jsonResponse({ error: "method_not_allowed" }, 405);
  try {
    const configuredKey = Deno.env.get("SIDEY_COMMERCE_OPS_KEY") ?? "";
    const suppliedKey = request.headers.get("x-sidey-commerce-ops-key") ?? "";
    if (!configuredKey || !suppliedKey || !(await constantTimeEqual(configuredKey, suppliedKey))) {
      throw new HttpError(401, "operations_authentication_required", "운영 인증이 필요합니다.");
    }

    const payload = await request.json().catch(() => ({}));
    if (typeof payload?.order_id !== "string" || typeof payload?.reason_code !== "string") {
      throw new HttpError(400, "invalid_refund_request");
    }
    const requestID = typeof payload?.request_id === "string" ? payload.request_id : crypto.randomUUID();
    const targets = await serviceRPC<RefundTarget[]>("commerce_refund_target", {
      p_order_id: payload.order_id,
      p_reason_code: payload.reason_code,
      p_request_id: requestID,
      p_requested_by: typeof payload?.requested_by === "string" ? payload.requested_by : "sidey-operator",
      p_reason_detail: typeof payload?.reason_detail === "string" ? payload.reason_detail : null,
    });
    const target = targets[0];
    if (!target) throw new HttpError(409, "refund_not_available");

    const before = validatePortOnePayment(
      await portOneRequest<PortOnePayment>(`/payments/${encodeURIComponent(target.payment_id)}`),
      target,
      "PAID",
    );
    await portOneRequest(`/payments/${encodeURIComponent(target.payment_id)}/cancel`, {
      method: "POST",
      idempotencyKey: `refund-${requestID}`,
      body: {
        storeId: portOneStoreID(),
        reason: typeof payload?.reason_detail === "string" ? payload.reason_detail : "SIDEY 전액 환불",
        currentCancellableAmount: before.amount.total,
      },
    });
    await serviceRPC("commerce_record_refund_result", {
      p_order_id: payload.order_id,
      p_processing_status: "provider_canceled",
      p_result_code: "portone_cancel_requested",
      p_provider_status: "CANCELLED",
    });

    const payment = validatePortOnePayment(
      await portOneRequest<PortOnePayment>(`/payments/${encodeURIComponent(target.payment_id)}`),
      target,
      "CANCELLED",
    );
    if ((payment.amount.cancelled ?? 0) !== payment.amount.total) {
      throw new HttpError(409, "refund_verification_failed");
    }
    const status = await applyPortOnePayment(
      target,
      payment,
      `refund:${requestID}`,
      "SIDEY_REFUND",
    );
    await serviceRPC("commerce_record_refund_result", {
      p_order_id: payload.order_id,
      p_processing_status: status === "refunded" ? "completed" : "failed",
      p_result_code: status,
      p_provider_status: payment.status,
    });
    return jsonResponse({ refunded: status === "refunded", status });
  } catch (error) {
    return publicError(error);
  }
});

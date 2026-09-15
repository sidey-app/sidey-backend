import { Webhook } from "jsr:@portone/server-sdk@0.19.0";
import {
  applyPortOnePayment,
  HttpError,
  jsonResponse,
  portOneRequest,
  portOneWebhookSecret,
  publicError,
  serviceRPC,
  sha256Hex,
  type CommerceOrder,
  type PortOnePayment,
} from "../_shared/commerce.ts";

Deno.serve(async (request) => {
  if (request.method !== "POST") return jsonResponse({ error: "method_not_allowed" }, 405);
  try {
    const rawBody = await request.text();
    const secret = portOneWebhookSecret();
    let webhook: { type?: string; data?: { paymentId?: string } };
    try {
      webhook = await Webhook.verify(
        secret,
        rawBody,
        Object.fromEntries(request.headers.entries()),
      ) as typeof webhook;
    } catch {
      throw new HttpError(400, "invalid_webhook_signature", "웹훅 서명이 올바르지 않습니다.");
    }

    const paymentID = webhook.data?.paymentId;
    if (typeof paymentID !== "string") {
      return jsonResponse({ accepted: true, ignored: true });
    }
    const orders = await serviceRPC<CommerceOrder[]>("commerce_portone_order_by_payment_id", {
      p_payment_id: paymentID,
    });
    const order = orders[0];
    if (!order) return jsonResponse({ accepted: true, ignored: true });

    const payment = await portOneRequest<PortOnePayment>(
      `/payments/${encodeURIComponent(paymentID)}`,
    );
    if (!["PAID", "FAILED", "CANCELLED", "PARTIAL_CANCELLED"].includes(payment.status)) {
      return jsonResponse({ accepted: true, ignored: true, status: payment.status });
    }

    const webhookID = request.headers.get("webhook-id");
    if (!webhookID || webhookID.length > 180) throw new HttpError(400, "invalid_webhook_id");
    const status = await applyPortOnePayment(
      order,
      payment,
      `portone:${webhookID}`,
      webhook.type ?? "UNKNOWN",
      await sha256Hex(rawBody),
    );
    return jsonResponse({ accepted: true, status });
  } catch (error) {
    const response = publicError(error);
    return response.status >= 500
      ? jsonResponse({ accepted: false, error: "webhook_processing_failed" }, 500)
      : response;
  }
});
